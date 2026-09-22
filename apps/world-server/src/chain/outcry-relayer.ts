import { createHash, createPrivateKey, sign as signEd25519 } from "node:crypto";
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

export const OUTCRY_CRANK_OPERATIONS = [
  "resolve_round",
  "skip_empty_round",
  "advance_round",
  "settle_match",
] as const;
export type OutcryCrankOperation = typeof OUTCRY_CRANK_OPERATIONS[number];

const RUNTIME_SEED = Buffer.from("runtime");
const QUOTE_SEED = Buffer.from("quote");
const INVENTORY_SEED = Buffer.from("inventory");
const RESULT_SEED = Buffer.from("result");
const ESCROW_SEED = Buffer.from("escrow");
const ORACLE_SEED = Buffer.from("oracle");
const ORACLE_FEED_ID = Buffer.from("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", "hex");
const PYTH_RECEIVER_PROGRAM_ID = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const PYTH_SOL_USD_PUSH_FEED = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const PIT_ACTIVE_MATCH_OFFSET = 73;
const MATCH_V2_DISCRIMINATOR = Buffer.from([62, 55, 226, 63, 20, 119, 49, 118]);
const MATCH_RUNTIME_DISCRIMINATOR = Buffer.from([33, 50, 28, 7, 38, 136, 51, 28]);
const MATCH_RESULT_DISCRIMINATOR = accountDiscriminator("MatchResult");
const MATCH_V2_BYTES = 205;
const RUNTIME_BYTES = 286;
const MAX_PLAYERS = 4;
const MATCH_PIT_OFFSET = 40;
const RUNTIME_ROUND_OFFSET = 40;
const RUNTIME_STATUS_OFFSET = 99;
const RUNTIME_FINALIZED_AT_OFFSET = 213;
const MATCH_ROUND_COUNT_OFFSET = 75;
const ROUND_TERMINAL = 5;
const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const MAGIC_PROGRAM_ID = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT_ID = new PublicKey("MagicContext1111111111111111111111111111111");
const DEVNET_ROUTER_RPC = "https://devnet-router.magicblock.app";
const TEE_RELAYER_MIN_LAMPORTS = 10_000_000;
const TEE_TOKEN_REFRESH_MARGIN_MS = 30_000;
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const teeAuthCache = new Map<string, { token: string; expiresAtMs: number }>();

export function base58Encode(bytes: Uint8Array) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const value = digits[index]! * 256 + carry;
      digits[index] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let result = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    result += BASE58_ALPHABET[0];
  }
  let highest = digits.length - 1;
  while (highest > 0 && digits[highest] === 0) highest -= 1;
  if (highest > 0 || digits[highest] !== 0) {
    for (let index = highest; index >= 0; index -= 1) result += BASE58_ALPHABET[digits[index]!];
  }
  return result;
}

function signTeeChallenge(signer: Keypair, challenge: string) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(signer.secretKey.subarray(0, 32))]),
    format: "der",
    type: "pkcs8",
  });
  return signEd25519(null, Buffer.from(challenge, "utf8"), privateKey);
}

async function getTeeAuthToken(baseUrl: string, signer: Keypair) {
  const challengeResponse = await fetch(`${baseUrl}/auth/challenge?pubkey=${encodeURIComponent(signer.publicKey.toBase58())}`);
  const challengePayload = await challengeResponse.json().catch(() => undefined) as { challenge?: unknown; error?: unknown } | undefined;
  if (!challengeResponse.ok || typeof challengePayload?.challenge !== "string" || challengePayload.challenge.length === 0) {
    throw new Error(typeof challengePayload?.error === "string" ? challengePayload.error : "tee_challenge_failed");
  }
  const loginResponse = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pubkey: signer.publicKey.toBase58(),
      challenge: challengePayload.challenge,
      signature: base58Encode(signTeeChallenge(signer, challengePayload.challenge)),
    }),
  });
  const loginPayload = await loginResponse.json().catch(() => undefined) as { token?: unknown; expiresAt?: unknown; error?: unknown } | undefined;
  if (!loginResponse.ok || typeof loginPayload?.token !== "string" || loginPayload.token.length === 0) {
    throw new Error(typeof loginPayload?.error === "string" ? loginPayload.error : "tee_login_failed");
  }
  const expiresAt = typeof loginPayload.expiresAt === "number" ? loginPayload.expiresAt : Date.now() + 86_400_000;
  return { token: loginPayload.token, expiresAt };
}

export type OutcryCrankRequest = {
  operation: OutcryCrankOperation;
  matchAddress: string;
  programId?: string;
  winnerAddress?: string;
};

export class OutcryRelayerError extends Error {
  constructor(public readonly code: string, public readonly status = 400, public readonly stage?: string) {
    super(code);
    this.name = "OutcryRelayerError";
  }
}

export type OutcryCrankResult = { signature?: string; applied?: true };

type DelegationRoute = {
  isDelegated: boolean;
  fqdn?: string;
  authority?: PublicKey;
  owner?: PublicKey;
};

export type CrankRelayerReadiness =
  | { ready: true; relayer: string; teeRelayer: string }
  | { ready: false; code: "relayer_not_configured" | "tee_relayer_not_configured" | "program_id_invalid" | "relayer_keypair_invalid" | "tee_relayer_keypair_invalid" | "tee_relayer_must_be_distinct" };

function accountDiscriminator(name: string) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

function instructionDiscriminator(name: string) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function publicKey(value: string, label: string) {
  try {
    return new PublicKey(value);
  } catch {
    throw new OutcryRelayerError(`${label}_invalid`);
  }
}

function pda(seeds: Buffer[], programId: PublicKey) {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function keyAt(data: Buffer, offset: number) {
  if (data.length < offset + 32) throw new OutcryRelayerError("account_layout_invalid", 502);
  return new PublicKey(data.subarray(offset, offset + 32));
}

function readI64(data: Buffer, offset: number) {
  if (data.length < offset + 8) throw new OutcryRelayerError("account_layout_invalid", 502);
  return data.readBigInt64LE(offset);
}

function accountIsOwnedBy(info: { owner: PublicKey }, programId: PublicKey) {
  return info.owner.equals(programId) || info.owner.equals(DELEGATION_PROGRAM_ID);
}

function readPlayers(data: Buffer) {
  if (data.length !== MATCH_V2_BYTES || !data.subarray(0, 8).equals(MATCH_V2_DISCRIMINATOR)) {
    throw new OutcryRelayerError("match_v2_required", 409);
  }
  const capacity = data[73];
  const playerCount = data[74];
  if (capacity < 1 || capacity > MAX_PLAYERS || playerCount < 1 || playerCount > capacity) {
    throw new OutcryRelayerError("match_layout_invalid", 409);
  }
  return Array.from({ length: playerCount }, (_, index) => keyAt(data, 76 + index * 32));
}

function assertCanonical(expected: PublicKey, actual: PublicKey, label: string) {
  if (!expected.equals(actual)) throw new OutcryRelayerError(`${label}_pda_invalid`);
}

async function getRequiredAccount(connection: Connection, address: PublicKey, programId: PublicKey, label: string) {
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) throw new OutcryRelayerError(`${label}_unavailable`, 409);
  if (!accountIsOwnedBy(info, programId)) throw new OutcryRelayerError(`${label}_owner_invalid`, 409);
  return info;
}

function meta(pubkey: PublicKey, isWritable = false) {
  return { pubkey, isWritable, isSigner: false };
}

function signerMeta(pubkey: PublicKey, isWritable = true) {
  return { pubkey, isWritable, isSigner: true };
}

function noArgInstruction(programId: PublicKey, name: string, keys: Array<{ pubkey: PublicKey; isWritable: boolean; isSigner: boolean }>) {
  return new TransactionInstruction({ programId, keys, data: instructionDiscriminator(name) });
}

function derivePrivateAccounts(match: PublicKey, players: PublicKey[], taker: PublicKey, programId: PublicKey) {
  const dealers = players.filter((player) => !player.equals(taker));
  return {
    quotes: dealers.map((dealer) => pda([QUOTE_SEED, match.toBuffer(), dealer.toBuffer()], programId)),
    inventories: players.filter((player) => !player.equals(taker)).map((player) => pda([INVENTORY_SEED, match.toBuffer(), player.toBuffer()], programId)),
    takerInventory: pda([INVENTORY_SEED, match.toBuffer(), taker.toBuffer()], programId),
  };
}

async function resolveInstruction(runtimeConnection: Connection, matchConnection: Connection, match: PublicKey, runtime: PublicKey, programId: PublicKey) {
  const matchInfo = await getRequiredAccount(matchConnection, match, programId, "match");
  const players = readPlayers(matchInfo.data);
  const runtimeInfo = await getRequiredAccount(runtimeConnection, runtime, programId, "runtime");
  if (runtimeInfo.data.length !== RUNTIME_BYTES || !runtimeInfo.data.subarray(0, 8).equals(MATCH_RUNTIME_DISCRIMINATOR)) {
    throw new OutcryRelayerError("runtime_layout_invalid", 409);
  }
  assertCanonical(match, keyAt(runtimeInfo.data, 8), "runtime_match");
  const taker = keyAt(runtimeInfo.data, 41);
  if (!players.some((player) => player.equals(taker))) throw new OutcryRelayerError("runtime_taker_invalid", 409);
  const accounts = derivePrivateAccounts(match, players, taker, programId);
  return noArgInstruction(programId, "resolve_round", [
    meta(match),
    meta(runtime, true),
    meta(accounts.takerInventory, true),
    ...accounts.quotes.map((quote) => meta(quote)),
    ...accounts.inventories.map((inventory) => meta(inventory, true)),
  ]);
}

async function finalizationInstructions(connection: Connection, match: PublicKey, runtime: PublicKey, programId: PublicKey) {
  const matchInfo = await getRequiredAccount(connection, match, programId, "match");
  const players = readPlayers(matchInfo.data);
  const inventories = players.map((player) => pda([INVENTORY_SEED, match.toBuffer(), player.toBuffer()], programId));
  const oracle = pda([ORACLE_SEED, ORACLE_FEED_ID], programId);
  const result = pda([RESULT_SEED, match.toBuffer()], programId);
  return [
    noArgInstruction(programId, "finalize_runtime", [
      meta(match),
      meta(runtime, true),
      meta(oracle),
      ...inventories.map((inventory) => meta(inventory)),
    ]),
    noArgInstruction(programId, "finalize_match", [
      meta(match, true),
      meta(runtime),
      meta(result, true),
    ]),
  ];
}

function isTeeRpc(fqdn: string) {
  return /(?:^|-)tee(?:-as)?\.magicblock\.app$/.test(new URL(fqdn).hostname);
}

async function authenticatedRpcUrl(fqdn: string, signer?: Keypair) {
  const endpoint = new URL(fqdn);
  endpoint.searchParams.delete("token");
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
  if (!isTeeRpc(endpoint.toString())) return endpoint.toString();
  if (!signer) throw new OutcryRelayerError("tee_auth_signer_required", 503, "tee_auth");

  const baseUrl = endpoint.toString();
  const cacheKey = `${baseUrl}:${signer.publicKey.toBase58()}`;
  const cached = teeAuthCache.get(cacheKey);
  if (cached && cached.expiresAtMs > Date.now() + TEE_TOKEN_REFRESH_MARGIN_MS) {
    endpoint.searchParams.set("token", cached.token);
    return endpoint.toString();
  }

  let auth: { token: string; expiresAt: number };
  try {
    auth = await getTeeAuthToken(baseUrl, signer);
  } catch (reason) {
    console.error("[outcry][relayer:tee_auth]", reason);
    throw new OutcryRelayerError("tee_auth_failed", 503, "tee_auth");
  }
  const expiresAtMs = auth.expiresAt < 1_000_000_000_000 ? auth.expiresAt * 1_000 : auth.expiresAt;
  teeAuthCache.set(cacheKey, { token: auth.token, expiresAtMs });
  endpoint.searchParams.set("token", auth.token);
  return endpoint.toString();
}

async function routerConnection(fqdn: string, signer?: Keypair) {
  return new Connection(await authenticatedRpcUrl(fqdn, signer), { commitment: "confirmed", disableRetryOnRateLimit: true });
}

async function delegationRoute(routerRpcUrl: string, account: PublicKey, label: string): Promise<DelegationRoute> {
  let response: Response;
  try {
    response = await fetch(routerRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [account.toBase58()] }),
    });
  } catch (reason) {
    console.error(`[outcry][relayer:router:${label}]`, reason);
    throw new OutcryRelayerError(label === "runtime" ? "runtime_router_unavailable" : "private_state_router_unavailable", 503, "router");
  }
  if (!response.ok) throw new OutcryRelayerError(label === "runtime" ? "runtime_router_unavailable" : "private_state_router_unavailable", 503, "router");
  const payload = await response.json().catch(() => undefined) as { result?: { isDelegated?: unknown; fqdn?: unknown; delegationRecord?: { authority?: unknown; owner?: unknown } } } | undefined;
  const result = payload?.result;
  if (!result || typeof result.isDelegated !== "boolean") throw new OutcryRelayerError(label === "runtime" ? "runtime_router_invalid" : "private_state_router_invalid", 502, "router");
  if (!result.isDelegated) return { isDelegated: false };
  if (typeof result.fqdn !== "string") throw new OutcryRelayerError(label === "runtime" ? "runtime_router_invalid" : "private_state_router_invalid", 502, "router");
  try {
    const fqdn = new URL(result.fqdn).toString();
    return {
      isDelegated: true,
      fqdn,
      authority: typeof result.delegationRecord?.authority === "string" ? new PublicKey(result.delegationRecord.authority) : undefined,
      owner: typeof result.delegationRecord?.owner === "string" ? new PublicKey(result.delegationRecord.owner) : undefined,
    };
  } catch {
    throw new OutcryRelayerError(label === "runtime" ? "runtime_router_invalid" : "private_state_router_invalid", 502, "router");
  }
}

type PrivateExecutionAccount = {
  address: PublicKey;
};

function privateExecutionAccounts(match: PublicKey, players: PublicKey[], taker: PublicKey, programId: PublicKey): PrivateExecutionAccount[] {
  const accounts = derivePrivateAccounts(match, players, taker, programId);
  return [
    ...accounts.quotes.map((address) => ({ address })),
    { address: accounts.takerInventory },
    ...accounts.inventories.map((address) => ({ address })),
  ];
}

async function requirePrivateExecutionRoutes(input: {
  base: Connection;
  routerRpcUrl: string;
  runtimeRoute: DelegationRoute;
  accounts: PrivateExecutionAccount[];
  programId: PublicKey;
}) {
  if (!input.runtimeRoute.fqdn || !input.runtimeRoute.authority) {
    throw new OutcryRelayerError("runtime_route_mismatch", 503, "router");
  }
  const runtimeFqdn = input.runtimeRoute.fqdn;
  const runtimeAuthority = input.runtimeRoute.authority;
  await Promise.all(input.accounts.map(async ({ address }) => {
    const baseInfo = await input.base.getAccountInfo(address, "confirmed");
    if (!baseInfo) throw new OutcryRelayerError("private_state_unavailable", 409, "private_state");
    if (!baseInfo.owner.equals(DELEGATION_PROGRAM_ID)) throw new OutcryRelayerError("private_state_not_delegated", 409, "private_state");
    const route = await delegationRoute(input.routerRpcUrl, address, "private_state");
    if (!route.isDelegated || !route.fqdn || !route.authority || !route.owner?.equals(input.programId)) {
      throw new OutcryRelayerError("private_state_route_mismatch", 503, "private_state");
    }
    if (route.fqdn !== runtimeFqdn || !route.authority.equals(runtimeAuthority)) {
      throw new OutcryRelayerError("private_state_route_mismatch", 503, "private_state");
    }
    // PER visibility is not relayer authorization. Do not read a player's
    // private account here; the ER simulation verifies program access without
    // exposing quote or inventory contents to this HTTP service.
  }));
}

async function selectRuntimeConnection(base: Connection, routerRpcUrl: string, runtime: PublicKey, programId: PublicKey, teeRelayer?: Keypair) {
  const baseInfo = await base.getAccountInfo(runtime, "confirmed");
  if (!baseInfo) throw new OutcryRelayerError("runtime_unavailable", 409);
  if (baseInfo.owner.equals(programId)) return { connection: base, info: baseInfo, delegated: false };
  if (!baseInfo.owner.equals(DELEGATION_PROGRAM_ID)) throw new OutcryRelayerError("runtime_owner_invalid", 409);
  const route = await delegationRoute(routerRpcUrl, runtime, "runtime");
  if (!route.isDelegated || !route.fqdn || !route.authority || !route.owner?.equals(programId)) {
    throw new OutcryRelayerError("runtime_route_mismatch", 503, "router");
  }
  const connection = await routerConnection(route.fqdn, teeRelayer);
  const info = await getRequiredAccount(connection, runtime, programId, "runtime");
  if (!info.owner.equals(programId)) throw new OutcryRelayerError("runtime_route_mismatch", 503, "router");
  return { connection, info, delegated: true, route };
}

function assertRuntimeLayout(data: Buffer) {
  if (data.length !== RUNTIME_BYTES || !data.subarray(0, 8).equals(MATCH_RUNTIME_DISCRIMINATOR)) {
    throw new OutcryRelayerError("runtime_layout_invalid", 409);
  }
}

function magicFeeVaultPda(validator: PublicKey) {
  return pda([Buffer.from("magic-fee-vault"), validator.toBuffer()], DELEGATION_PROGRAM_ID);
}

function undelegateRuntimeInstruction(programId: PublicKey, runtime: PublicKey, payer: PublicKey, validator: PublicKey) {
  return noArgInstruction(programId, "undelegate_runtime", [
    signerMeta(payer),
    meta(runtime, true),
    meta(magicFeeVaultPda(validator), true),
    meta(MAGIC_PROGRAM_ID),
    meta(MAGIC_CONTEXT_ID, true),
  ]);
}

async function sendTransaction(input: { connection: Connection; feePayer: Keypair; instructions: TransactionInstruction[]; additionalSigners?: Keypair[]; stage: string; ephemeral?: boolean }) {
  try {
    const additionalSigners = input.additionalSigners ?? [];
    const blockhash = await input.connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({ feePayer: input.feePayer.publicKey, recentBlockhash: blockhash.blockhash }).add(...input.instructions);
    transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
    transaction.sign(input.feePayer, ...additionalSigners);
    const simulation = await input.connection.simulateTransaction(transaction);
    if (simulation.value.err) {
      console.error(`[outcry][relayer:${input.stage}:simulation]`, simulation.value.err, simulation.value.logs?.slice(-8));
      throw new OutcryRelayerError("relayer_simulation_failed", 422, input.stage);
    }
    // The explicit simulation above preserves program diagnostics. MagicBlock ER submission
    // then skips the duplicate RPC preflight, which can target a stale bank on router-backed ERs.
    const signature = await input.connection.sendRawTransaction(transaction.serialize(), { skipPreflight: input.ephemeral === true, maxRetries: 5 });
    const confirmation = await input.connection.confirmTransaction({ signature, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight }, "confirmed");
    if (confirmation.value.err) {
      console.error(`[outcry][relayer:${input.stage}:confirmation]`, confirmation.value.err, signature);
      throw new OutcryRelayerError("relayer_confirmation_failed", 502, input.stage);
    }
    return signature;
  } catch (reason) {
    if (reason instanceof OutcryRelayerError) throw reason;
    console.error(`[outcry][relayer:${input.stage}:transport]`, reason);
    throw new OutcryRelayerError("relayer_rpc_failed", 502, input.stage);
  }
}

async function requireTeeFeePayer(base: Connection, routerRpcUrl: string, tee: Connection, teeRelayer: Keypair, runtimeRoute: DelegationRoute) {
  const baseInfo = await base.getAccountInfo(teeRelayer.publicKey, "confirmed");
  if (!baseInfo || !baseInfo.owner.equals(DELEGATION_PROGRAM_ID)) throw new OutcryRelayerError("tee_relayer_not_delegated", 503);
  if (baseInfo.lamports < TEE_RELAYER_MIN_LAMPORTS) throw new OutcryRelayerError("tee_relayer_underfunded", 503);
  const feePayerRoute = await delegationRoute(routerRpcUrl, teeRelayer.publicKey, "tee_relayer");
  if (!feePayerRoute.isDelegated || !feePayerRoute.authority || !runtimeRoute.authority || !feePayerRoute.authority.equals(runtimeRoute.authority)) {
    throw new OutcryRelayerError("tee_relayer_route_mismatch", 503, "router");
  }
  const teeInfo = await tee.getAccountInfo(teeRelayer.publicKey, "confirmed");
  if (!teeInfo) throw new OutcryRelayerError("tee_relayer_unavailable", 503);
  if (!teeInfo.owner.equals(SystemProgram.programId)) throw new OutcryRelayerError("tee_relayer_owner_invalid", 503);
}

async function waitForBaseRuntime(base: Connection, runtime: PublicKey, programId: PublicKey) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const info = await base.getAccountInfo(runtime, "confirmed");
    if (info?.owner.equals(programId)) return info;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new OutcryRelayerError("runtime_undelegation_pending", 409);
}

async function finalizeTerminalMatch(input: {
  base: Connection;
  tee?: Connection;
  match: PublicKey;
  runtime: PublicKey;
  programId: PublicKey;
  relayer: Keypair;
  teeRelayer?: Keypair;
  delegated: boolean;
  teeValidator?: PublicKey;
}) {
  const execution = input.delegated
    ? input.tee
    : input.base;
  if (!execution) throw new OutcryRelayerError("tee_rpc_required", 503);
  const runtimeInfo = await getRequiredAccount(execution, input.runtime, input.programId, "runtime");
  assertRuntimeLayout(runtimeInfo.data);
  assertCanonical(input.match, keyAt(runtimeInfo.data, 8), "runtime_match");
  if (readI64(runtimeInfo.data, RUNTIME_FINALIZED_AT_OFFSET) === 0n) {
    const [finalizeRuntime] = await finalizationInstructions(input.base, input.match, input.runtime, input.programId);
    await sendTransaction({ connection: execution, feePayer: input.delegated ? input.teeRelayer! : input.relayer, instructions: [finalizeRuntime], stage: "finalize_runtime", ephemeral: input.delegated });
  }
  if (input.delegated) {
    if (!input.tee) throw new OutcryRelayerError("tee_rpc_required", 503);
    if (!input.teeRelayer) throw new OutcryRelayerError("tee_relayer_not_configured", 503);
    if (!input.teeValidator) throw new OutcryRelayerError("runtime_route_mismatch", 503, "router");
    await sendTransaction({
      connection: input.tee,
      feePayer: input.teeRelayer,
      instructions: [undelegateRuntimeInstruction(input.programId, input.runtime, input.relayer.publicKey, input.teeValidator)],
      additionalSigners: [input.relayer],
      stage: "undelegate_runtime",
      ephemeral: true,
    });
    await waitForBaseRuntime(input.base, input.runtime, input.programId);
  }
  const [, finalizeMatch] = await finalizationInstructions(input.base, input.match, input.runtime, input.programId);
  return sendTransaction({ connection: input.base, feePayer: input.relayer, instructions: [finalizeMatch], stage: "finalize_match" });
}

async function buildSettleInstruction(connection: Connection, request: OutcryCrankRequest, programId: PublicKey) {
  const match = publicKey(request.matchAddress, "match");
  const result = pda([RESULT_SEED, match.toBuffer()], programId);
  const escrow = pda([ESCROW_SEED, match.toBuffer()], programId);
  const resultInfo = await getRequiredAccount(connection, result, programId, "result");
  if (resultInfo.data.length < 114 || !resultInfo.data.subarray(0, 8).equals(MATCH_RESULT_DISCRIMINATOR)) throw new OutcryRelayerError("result_layout_invalid", 409);
  const winner = keyAt(resultInfo.data, 40);
  if (winner.equals(PublicKey.default)) throw new OutcryRelayerError("winner_unavailable", 409);
  if (request.winnerAddress && !winner.equals(publicKey(request.winnerAddress, "winner"))) throw new OutcryRelayerError("wrong_winner", 409);
  return [noArgInstruction(programId, "settle_match", [
    meta(match),
    meta(result, true),
    meta(escrow, true),
    meta(winner, true),
  ])];
}

function loadKeypair(path: string | undefined, missingCode: string, invalidCode: string) {
  if (!path) throw new OutcryRelayerError(missingCode, 503);
  try {
    const bytes = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error("invalid");
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch {
    throw new OutcryRelayerError(invalidCode, 503);
  }
}

export function crankRelayerReadiness(input: { programId?: string; keypairPath?: string; teeKeypairPath?: string }): CrankRelayerReadiness {
  if (!input.keypairPath) return { ready: false, code: "relayer_not_configured" };
  if (!input.teeKeypairPath) return { ready: false, code: "tee_relayer_not_configured" };
  try {
    new PublicKey(input.programId ?? "");
  } catch {
    return { ready: false, code: "program_id_invalid" };
  }
  let relayer: Keypair;
  let teeRelayer: Keypair;
  try {
    relayer = loadKeypair(input.keypairPath, "relayer_not_configured", "relayer_keypair_invalid");
  } catch {
    return { ready: false, code: "relayer_keypair_invalid" };
  }
  try {
    teeRelayer = loadKeypair(input.teeKeypairPath, "tee_relayer_not_configured", "tee_relayer_keypair_invalid");
  } catch {
    return { ready: false, code: "tee_relayer_keypair_invalid" };
  }
  if (relayer.publicKey.equals(teeRelayer.publicKey)) return { ready: false, code: "tee_relayer_must_be_distinct" };
  return { ready: true, relayer: relayer.publicKey.toBase58(), teeRelayer: teeRelayer.publicKey.toBase58() };
}

export async function refreshOracleFromPushFeed(input: {
  baseRpcUrl: string;
  programId: string;
  keypairPath?: string;
}) {
  const programId = publicKey(input.programId, "program");
  const relayer = loadKeypair(input.keypairPath, "relayer_not_configured", "relayer_keypair_invalid");
  const connection = new Connection(input.baseRpcUrl, { commitment: "confirmed", disableRetryOnRateLimit: true });
  const oracle = pda([ORACLE_SEED, ORACLE_FEED_ID], programId);
  const oracleInfo = await connection.getAccountInfo(oracle, "confirmed");
  if (!oracleInfo || !oracleInfo.owner.equals(programId)) throw new OutcryRelayerError("oracle_not_initialized", 409, "oracle");
  const feedInfo = await connection.getAccountInfo(PYTH_SOL_USD_PUSH_FEED, "confirmed");
  if (!feedInfo || !feedInfo.owner.equals(PYTH_RECEIVER_PROGRAM_ID)) throw new OutcryRelayerError("oracle_push_feed_unavailable", 503, "oracle");
  const signature = await sendTransaction({
    connection,
    feePayer: relayer,
    instructions: [noArgInstruction(programId, "update_oracle", [
      meta(oracle, true),
      meta(PYTH_SOL_USD_PUSH_FEED),
    ])],
    stage: "update_oracle",
  });
  return { signature, feed: PYTH_SOL_USD_PUSH_FEED.toBase58() };
}

async function resolveWasApplied(connection: Connection, runtime: PublicKey, programId: PublicKey, round: number) {
  try {
    const info = await getRequiredAccount(connection, runtime, programId, "runtime");
    assertRuntimeLayout(info.data);
    return info.data[RUNTIME_ROUND_OFFSET] !== round || info.data[RUNTIME_STATUS_OFFSET] === 1;
  } catch (reason) {
    console.error("[outcry][relayer:resolve_round:reconcile]", reason);
    return false;
  }
}

async function privateRouteDiagnostic(input: {
  base: Connection;
  routerRpcUrl: string;
  account: PrivateExecutionAccount;
  programId: PublicKey;
}) {
  try {
    const [baseInfo, route] = await Promise.all([
      input.base.getAccountInfo(input.account.address, "confirmed"),
      delegationRoute(input.routerRpcUrl, input.account.address, "private_state"),
    ]);
    return {
      address: input.account.address.toBase58(),
      baseOwner: baseInfo?.owner.toBase58(),
      delegated: route.isDelegated,
      erRpc: route.fqdn,
      validator: route.authority?.toBase58(),
      valid: Boolean(
        baseInfo?.owner.equals(DELEGATION_PROGRAM_ID)
        && route.isDelegated
        && route.owner?.equals(input.programId)
      ),
    };
  } catch (reason) {
    return {
      address: input.account.address.toBase58(),
      valid: false,
      error: reason instanceof OutcryRelayerError ? reason.code : "private_state_diagnostic_failed",
    };
  }
}

export async function crankDiagnostics(input: { baseRpcUrl: string; routerRpcUrl?: string; programId: string; matchAddress: string; teeKeypairPath?: string }) {
  const programId = publicKey(input.programId, "program");
  const match = publicKey(input.matchAddress, "match");
  const runtime = pda([RUNTIME_SEED, match.toBuffer()], programId);
  const base = new Connection(input.baseRpcUrl, { commitment: "confirmed", disableRetryOnRateLimit: true });
  const routerRpcUrl = input.routerRpcUrl ?? DEVNET_ROUTER_RPC;
  const teeRelayer = input.teeKeypairPath ? loadKeypair(input.teeKeypairPath, "tee_relayer_not_configured", "tee_relayer_keypair_invalid") : undefined;
  const [baseInfo, route] = await Promise.all([
    base.getAccountInfo(runtime, "confirmed"),
    delegationRoute(routerRpcUrl, runtime, "runtime"),
  ]);
  let erOwner: string | undefined;
  let runtimeInfo: { owner: PublicKey; data: Buffer } | null = null;
  if (route.isDelegated && route.fqdn) {
    runtimeInfo = await (await routerConnection(route.fqdn, teeRelayer)).getAccountInfo(runtime, "confirmed");
    erOwner = runtimeInfo?.owner.toBase58();
  }
  const matchInfo = await getRequiredAccount(base, match, programId, "match");
  const players = readPlayers(matchInfo.data);
  const pit = keyAt(matchInfo.data, MATCH_PIT_OFFSET);
  const pitInfo = await base.getAccountInfo(pit, "confirmed");
  const pitActiveMatch = pitInfo && pitInfo.owner.equals(programId) && pitInfo.data.length >= PIT_ACTIVE_MATCH_OFFSET + 32
    ? keyAt(pitInfo.data, PIT_ACTIVE_MATCH_OFFSET)
    : undefined;
  const privateStates = runtimeInfo?.owner.equals(programId)
    ? await Promise.all(privateExecutionAccounts(match, players, keyAt(runtimeInfo.data, 41), programId).map((account) => privateRouteDiagnostic({
      base,
      routerRpcUrl,
      account,
      programId,
    })))
    : [];
  return {
    match: match.toBase58(),
    pit: pit.toBase58(),
    pitActiveMatch: pitActiveMatch?.toBase58(),
    activeMatch: pitActiveMatch?.equals(match) ?? false,
    runtime: runtime.toBase58(),
    baseOwner: baseInfo?.owner.toBase58(),
    delegated: route.isDelegated,
    erRpc: route.fqdn,
    validator: route.authority?.toBase58(),
    erOwner,
    privateStates,
  };
}

async function crankOutcryUnchecked(input: {
  request: OutcryCrankRequest;
  baseRpcUrl: string;
  routerRpcUrl?: string;
  programId: string;
  keypairPath?: string;
  teeKeypairPath?: string;
}): Promise<OutcryCrankResult> {
  const programId = publicKey(input.programId, "program");
  const base = new Connection(input.baseRpcUrl, { commitment: "confirmed", disableRetryOnRateLimit: true });
  const routerRpcUrl = input.routerRpcUrl ?? DEVNET_ROUTER_RPC;
  const relayer = loadKeypair(input.keypairPath, "relayer_not_configured", "relayer_keypair_invalid");
  const match = publicKey(input.request.matchAddress, "match");
  const runtime = pda([RUNTIME_SEED, match.toBuffer()], programId);
  if (input.request.operation === "settle_match") {
    const [instruction] = await buildSettleInstruction(base, input.request, programId);
    return { signature: await sendTransaction({ connection: base, feePayer: relayer, instructions: [instruction], stage: "settle_match" }) };
  }
  const teeRelayer = input.teeKeypairPath
    ? loadKeypair(input.teeKeypairPath, "tee_relayer_not_configured", "tee_relayer_keypair_invalid")
    : undefined;
  const runtimeLocation = await selectRuntimeConnection(base, routerRpcUrl, runtime, programId, teeRelayer);
  if (teeRelayer?.publicKey.equals(relayer.publicKey)) throw new OutcryRelayerError("tee_relayer_must_be_distinct", 503);
  if (runtimeLocation.delegated) {
    if (!teeRelayer || !runtimeLocation.route) throw new OutcryRelayerError("runtime_route_mismatch", 503, "router");
    await requireTeeFeePayer(base, routerRpcUrl, runtimeLocation.connection, teeRelayer, runtimeLocation.route);
  }
  const runtimeFeePayer = teeRelayer ?? relayer;
  assertRuntimeLayout(runtimeLocation.info.data);
  assertCanonical(match, keyAt(runtimeLocation.info.data, 8), "runtime_match");
  if (input.request.operation === "resolve_round") {
    const round = runtimeLocation.info.data[RUNTIME_ROUND_OFFSET];
    try {
      if (runtimeLocation.delegated && runtimeLocation.route) {
        const matchInfo = await getRequiredAccount(base, match, programId, "match");
        const players = readPlayers(matchInfo.data);
        const taker = keyAt(runtimeLocation.info.data, 41);
        if (!players.some((player) => player.equals(taker))) throw new OutcryRelayerError("runtime_taker_invalid", 409);
        await requirePrivateExecutionRoutes({
          base,
          routerRpcUrl,
          runtimeRoute: runtimeLocation.route,
          accounts: privateExecutionAccounts(match, players, taker, programId),
          programId,
        });
      }
      return { signature: await sendTransaction({ connection: runtimeLocation.connection, feePayer: runtimeFeePayer, instructions: [await resolveInstruction(runtimeLocation.connection, base, match, runtime, programId)], stage: "resolve_round", ephemeral: runtimeLocation.delegated }) };
    } catch (reason) {
      if (reason instanceof OutcryRelayerError && (reason.code === "relayer_rpc_failed" || reason.code === "relayer_confirmation_failed")
        && await resolveWasApplied(runtimeLocation.connection, runtime, programId, round)) {
        return { applied: true };
      }
      throw reason;
    }
  }
  if (input.request.operation === "skip_empty_round") {
    return { signature: await sendTransaction({ connection: runtimeLocation.connection, feePayer: runtimeFeePayer, instructions: [noArgInstruction(programId, "skip_empty_round", [meta(match), meta(runtime, true)])], stage: "skip_empty_round", ephemeral: runtimeLocation.delegated }) };
  }
  const status = runtimeLocation.info.data[RUNTIME_STATUS_OFFSET];
  if (status === ROUND_TERMINAL) {
    return { signature: await finalizeTerminalMatch({
      base,
      tee: runtimeLocation.connection,
      match,
      runtime,
      programId,
      relayer,
      teeRelayer,
      delegated: runtimeLocation.delegated,
      teeValidator: runtimeLocation.route?.authority,
    }) };
  }
  // MatchV2 is deliberately persistent on base; only the reusable runtime is
  // delegated, so never require the ER endpoint to index MatchV2 for advance.
  const matchInfo = await getRequiredAccount(base, match, programId, "match");
  const round = runtimeLocation.info.data[RUNTIME_ROUND_OFFSET];
  const roundCount = matchInfo.data[MATCH_ROUND_COUNT_OFFSET];
  const advanceSignature = await sendTransaction({ connection: runtimeLocation.connection, feePayer: runtimeFeePayer, instructions: [noArgInstruction(programId, "advance_round", [meta(match), meta(runtime, true)])], stage: "advance_round", ephemeral: runtimeLocation.delegated });
  if (round + 1 < roundCount) return { signature: advanceSignature };
  return { signature: await finalizeTerminalMatch({
    base,
    tee: runtimeLocation.connection,
    match,
    runtime,
    programId,
    relayer,
    teeRelayer,
    delegated: runtimeLocation.delegated,
    teeValidator: runtimeLocation.route?.authority,
  }) };
}

export async function crankOutcry(input: {
  request: OutcryCrankRequest;
  baseRpcUrl: string;
  routerRpcUrl?: string;
  programId: string;
  keypairPath?: string;
  teeKeypairPath?: string;
}): Promise<OutcryCrankResult> {
  try {
    return await crankOutcryUnchecked(input);
  } catch (reason) {
    if (reason instanceof OutcryRelayerError) throw reason;
    console.error(`[outcry][relayer:${input.request.operation}:prepare]`, reason);
    throw new OutcryRelayerError("relayer_rpc_failed", 502, "prepare");
  }
}
