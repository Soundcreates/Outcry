import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import { createBaseRpcConnection } from "./baseRpc";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import outcryIdl from "./idl/outcry.json";
import { decodePublicMatchAccount, oraclePda, runtimePda } from "./matchState";
import {
  createAuthorizeSessionInstruction,
  createInitializeEscrowInstruction,
  createInitializeMatchResultInstruction,
  createInitializeOracleUnpricedInstruction,
  createRenewSessionInstruction,
  DEFAULT_SESSION_DURATION_SECONDS,
  replaceSessionKeypairForMatch,
  sessionGrantPda,
  sessionKeypairForMatch,
} from "./matchActions";
import {
  createDelegateRuntimeInstruction,
  createInitializePrivateInventoryInstruction,
  createInitializePrivateQuoteInstruction,
  ensurePrivateState,
  teeValidatorForRpc,
} from "./privacy";

const joinMatchIdl = outcryIdl.instructions.find((instruction) => instruction.name === "join_match");
if (!joinMatchIdl) throw new Error("outcry_idl_missing_join_match");
const JOIN_MATCH_DISCRIMINATOR = Uint8Array.from(joinMatchIdl.discriminator);
const MIN_JOIN_BALANCE_LAMPORTS = 5_000;
// The session signer pays only normal base-layer session transactions. The
// sponsored Pyth push feed is already funded and updated by Pyth; the server
// relayer only pays the small update_oracle transaction.
const SESSION_BASE_FEE_BUFFER_LAMPORTS = 2_000_000;
const PYTH_SOL_USD_FEED_ID = Uint8Array.from("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d".match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
const initializePitIdl = outcryIdl.instructions.find((instruction) => instruction.name === "initialize_pit");
if (!initializePitIdl) throw new Error("outcry_idl_missing_initialize_pit");
const INITIALIZE_PIT_DISCRIMINATOR = Uint8Array.from(initializePitIdl.discriminator);
const createMatchIdl = outcryIdl.instructions.find((instruction) => instruction.name === "create_match");
if (!createMatchIdl) throw new Error("outcry_idl_missing_create_match");
const CREATE_MATCH_DISCRIMINATOR = Uint8Array.from(createMatchIdl.discriminator);
const migrateLegacyMatchIdl = outcryIdl.instructions.find((instruction) => instruction.name === "migrate_legacy_match");
if (!migrateLegacyMatchIdl) throw new Error("outcry_idl_missing_migrate_legacy_match");
const MIGRATE_LEGACY_MATCH_DISCRIMINATOR = Uint8Array.from(migrateLegacyMatchIdl.discriminator);
const releaseActiveMatchIdl = outcryIdl.instructions.find((instruction) => instruction.name === "release_active_match");
if (!releaseActiveMatchIdl) throw new Error("outcry_idl_missing_release_active_match");
const RELEASE_ACTIVE_MATCH_DISCRIMINATOR = Uint8Array.from(releaseActiveMatchIdl.discriminator);
const LEGACY_MATCH_DISCRIMINATOR = Uint8Array.from([236, 63, 169, 38, 15, 56, 196, 162]);
const LEGACY_MATCH_BYTES = new Set([372, 373, 407]);
const MATCH_V2_DISCRIMINATOR = Uint8Array.from(outcryIdl.accounts.find((account) => account.name === "MatchV2")?.discriminator ?? []);
const SESSION_GRANT_DISCRIMINATOR = Uint8Array.from(outcryIdl.accounts.find((account) => account.name === "SessionGrant")?.discriminator ?? []);
const SESSION_GRANT_BYTES = 115;
const MAX_V2_MATCH_NONCE_RECOVERY = 1024n;

type WalletProvider = {
  publicKey: PublicKey | null;
  connect: () => Promise<{ publicKey: PublicKey }>;
  signTransaction?: <T extends Transaction | VersionedTransaction>(transaction: T) => Promise<T>;
  signAllTransactions?: <T extends Transaction | VersionedTransaction>(transactions: T[]) => Promise<T[]>;
  signAndSendTransaction: (transaction: Transaction) => Promise<string | { signature: string }>;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array | { signature: Uint8Array }>;
};

declare global {
  interface Window {
    solana?: WalletProvider;
  }
}

export function connectedWalletAddress() {
  return window.solana?.publicKey?.toBase58();
}

export type MatchOwnership = "base" | "delegated";

export function classifyMatchOwnership(owner: PublicKey, programId: PublicKey): MatchOwnership {
  if (owner.equals(programId)) return "base";
  if (owner.equals(DELEGATION_PROGRAM_ID)) return "delegated";
  throw new Error("match_account_program_mismatch");
}

export function createJoinMatchInstruction(input: {
  matchAddress: string;
  playerAddress: string;
  programId: string;
}) {
  const match = new PublicKey(input.matchAddress);
  const player = new PublicKey(input.playerAddress);
  return new TransactionInstruction({
    programId: new PublicKey(input.programId),
    keys: [
      { pubkey: match, isWritable: true, isSigner: false },
      { pubkey: player, isWritable: false, isSigner: true },
    ],
    data: Uint8Array.from(JOIN_MATCH_DISCRIMINATOR) as unknown as Buffer,
  });
}

function pitIdBytes(pitId: string) {
  const encoded = new TextEncoder().encode(pitId);
  if (encoded.length === 0 || encoded.length > 32) throw new Error("invalid_pit_id");
  const bytes = new Uint8Array(32);
  bytes.set(encoded);
  return bytes;
}

function u64Bytes(value: bigint) {
  if (value < 0n) throw new Error("invalid_match_nonce");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

export function matchBootstrapAddresses(input: { pitId: string; nonce: bigint; programId: string }) {
  const programId = new PublicKey(input.programId);
  const pitId = pitIdBytes(input.pitId);
  const [pit] = PublicKey.findProgramAddressSync([new TextEncoder().encode("pit"), pitId], programId);
  const [match] = PublicKey.findProgramAddressSync([new TextEncoder().encode("match_v2"), pit.toBytes(), u64Bytes(input.nonce)], programId);
  return { pitId, pit, match };
}

export function recoverV2MatchNonce(input: {
  pitAddress: PublicKey | string;
  activeMatchAddress: PublicKey | string;
  programId: PublicKey | string;
  preferredNonce?: bigint;
}) {
  const pit = new PublicKey(input.pitAddress);
  const activeMatch = new PublicKey(input.activeMatchAddress);
  const programId = new PublicKey(input.programId);
  const matches = (nonce: bigint) => PublicKey.findProgramAddressSync([
    new TextEncoder().encode("match_v2"),
    pit.toBytes(),
    u64Bytes(nonce),
  ], programId)[0].equals(activeMatch);

  if (input.preferredNonce !== undefined && matches(input.preferredNonce)) return input.preferredNonce;
  // ponytail: bounded local recovery avoids a PitConfig migration; persist the
  // active nonce if a pit can realistically exceed this many V2 lifecycles.
  for (let nonce = 0n; nonce <= MAX_V2_MATCH_NONCE_RECOVERY; nonce += 1n) {
    if (nonce !== input.preferredNonce && matches(nonce)) return nonce;
  }
  throw new Error("active_v2_match_nonce_unrecoverable");
}

export function legacyMatchPda(input: { pitAddress: string; nonce: bigint; programId: string }) {
  return PublicKey.findProgramAddressSync([
    new TextEncoder().encode("match"),
    new PublicKey(input.pitAddress).toBytes(),
    u64Bytes(input.nonce),
  ], new PublicKey(input.programId))[0];
}

export function createInitializePitInstruction(input: {
  pitAddress: string;
  authorityAddress: string;
  pitId: string;
  capacity: number;
  programId: string;
}) {
  if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 4) throw new Error("invalid_pit_capacity");
  return new TransactionInstruction({
    programId: new PublicKey(input.programId),
    keys: [
      { pubkey: new PublicKey(input.pitAddress), isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.authorityAddress), isWritable: true, isSigner: true },
      { pubkey: new PublicKey("11111111111111111111111111111111"), isWritable: false, isSigner: false },
    ],
    data: Uint8Array.from([...INITIALIZE_PIT_DISCRIMINATOR, ...pitIdBytes(input.pitId), input.capacity]) as unknown as Buffer,
  });
}

export function createCreateMatchInstruction(input: {
  pitAddress: string;
  matchAddress: string;
  authorityAddress: string;
  nonce: bigint;
  programId: string;
}) {
  return new TransactionInstruction({
    programId: new PublicKey(input.programId),
    keys: [
      { pubkey: new PublicKey(input.pitAddress), isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.matchAddress), isWritable: true, isSigner: false },
      { pubkey: runtimePda(input.matchAddress, new PublicKey(input.programId)), isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.authorityAddress), isWritable: true, isSigner: true },
      { pubkey: new PublicKey("11111111111111111111111111111111"), isWritable: false, isSigner: false },
    ],
    data: Uint8Array.from([...CREATE_MATCH_DISCRIMINATOR, ...u64Bytes(input.nonce)]) as unknown as Buffer,
  });
}

export function createMigrateLegacyMatchInstruction(input: {
  pitAddress: string;
  legacyMatchAddress: string;
  matchAddress: string;
  authorityAddress: string;
  nonce: bigint;
  programId: string;
}) {
  const programId = new PublicKey(input.programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(input.pitAddress), isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.legacyMatchAddress), isWritable: false, isSigner: false },
      { pubkey: new PublicKey(input.matchAddress), isWritable: true, isSigner: false },
      { pubkey: runtimePda(input.matchAddress, programId), isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.authorityAddress), isWritable: true, isSigner: true },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
    ],
    data: Uint8Array.from([...MIGRATE_LEGACY_MATCH_DISCRIMINATOR, ...u64Bytes(input.nonce)]) as unknown as Buffer,
  });
}

export function createReleaseActiveMatchInstruction(input: {
  pitAddress: string;
  matchAddress: string;
  authorityAddress: string;
  nonce: bigint;
  programId: string;
  force?: boolean;
}) {
  return new TransactionInstruction({
    programId: new PublicKey(input.programId),
    keys: [
      { pubkey: new PublicKey(input.pitAddress), isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.matchAddress), isWritable: false, isSigner: false },
      { pubkey: new PublicKey(input.authorityAddress), isWritable: false, isSigner: true },
    ],
    data: Uint8Array.from([...RELEASE_ACTIVE_MATCH_DISCRIMINATOR, ...u64Bytes(input.nonce), input.force ? 1 : 0]) as unknown as Buffer,
  });
}

function isSupportedReleaseLayout(data: Uint8Array) {
  return isLegacyMatchAccount(data) || isMatchV2Account(data);
}

export function isLegacyMatchAccount(data: Uint8Array) {
  return LEGACY_MATCH_BYTES.has(data.length)
    && data.slice(0, 8).every((value, index) => value === LEGACY_MATCH_DISCRIMINATOR[index]);
}

function isMatchV2Account(data: Uint8Array) {
  return data.length === 205
    && data.slice(0, 8).every((value, index) => value === MATCH_V2_DISCRIMINATOR[index]);
}

function legacyMatchNonce(data: Uint8Array) {
  if (!isLegacyMatchAccount(data) || data.length < 80) throw new Error("legacy_match_invalid");
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(72, true);
}

async function simulateUnsignedTransaction(connection: Connection, transaction: Transaction) {
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "simulateTransaction",
    params: [transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), {
      encoding: "base64",
      commitment: "confirmed",
      sigVerify: false,
      replaceRecentBlockhash: true,
    }],
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(connection.rpcEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: request,
    });
    if (response.status === 429 && attempt < 2) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 1_000 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    if (!response.ok) throw new Error(`match_bootstrap_simulation_rpc_http_${response.status}`);
    const payload = await response.json() as {
      error?: { message?: string };
      result?: { value?: { err: unknown; logs?: string[] } };
    };
    if (payload.error) throw new Error(`match_bootstrap_simulation_rpc_${payload.error.message ?? "failed"}`);
    const value = payload.result?.value;
    if (!value) throw new Error("match_bootstrap_simulation_rpc_malformed");
    return value;
  }
  throw new Error("match_bootstrap_simulation_rpc_http_429");
}

function simulationError(value: { err: unknown; logs?: string[] }) {
  const relevantLog = value.logs?.find((log) => /Error|failed|constraint|insufficient/i.test(log));
  return `match_bootstrap_simulation_failed: ${relevantLog ?? JSON.stringify(value.err)}`;
}

async function sendAndConfirmWalletTransaction(
  connection: Connection,
  wallet: WalletProvider,
  transaction: Transaction,
  blockhash: { blockhash: string; lastValidBlockHeight: number },
) {
  let signature: string;
  if (wallet.signTransaction) {
    const signed = await wallet.signTransaction(transaction);
    signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 5 });
  } else {
    const sent = await wallet.signAndSendTransaction(transaction);
    signature = typeof sent === "string" ? sent : sent.signature;
  }
  try {
    const confirmation = await connection.confirmTransaction({
      signature,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    }, "confirmed");
    if (confirmation.value.err) throw new Error(`wallet_transaction_failed: ${JSON.stringify(confirmation.value.err)}`);
  } catch (reason) {
    if (reason instanceof Error && /expired|block height exceeded/i.test(reason.message)) {
      const status = await connection.getSignatureStatuses([signature]);
      if (!status.value[0]?.confirmationStatus) throw new Error("wallet_transaction_expired_retry");
    } else {
      throw reason;
    }
  }
  return signature;
}

export function sessionGrantState(
  info: { owner: PublicKey; data: Uint8Array } | null,
  programId: PublicKey,
  expected: { matchAddress: PublicKey; authority: PublicKey; sessionKey: PublicKey },
  now: number,
) {
  if (!info) return "missing" as const;
  if (!info.owner.equals(programId)
    || info.data.length !== SESSION_GRANT_BYTES
    || !info.data.slice(0, 8).every((value, index) => value === SESSION_GRANT_DISCRIMINATOR[index])) {
    return "invalid" as const;
  }
  if (!info.data.slice(8, 40).every((value, index) => value === expected.matchAddress.toBytes()[index])
    || !info.data.slice(40, 72).every((value, index) => value === expected.authority.toBytes()[index])
    || !info.data.slice(72, 104).every((value, index) => value === expected.sessionKey.toBytes()[index])) {
    return "invalid" as const;
  }
  if (info.data[113] !== 0) return "invalid" as const;
  const expiresAt = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength).getBigInt64(104, true);
  return BigInt(now) < expiresAt ? "valid" as const : "expired" as const;
}

async function ensureSessionGrantOnBase(input: {
  connection: Connection;
  wallet: WalletProvider;
  matchAddress: PublicKey;
  authority: PublicKey;
  session: Keypair;
  programId: PublicKey;
  onWalletApprovalRequested?: () => void;
}) {
  let session = input.session;
  const grant = sessionGrantPda({
    matchAddress: input.matchAddress.toBase58(),
    authorityAddress: input.authority.toBase58(),
    sessionKey: session.publicKey,
    programId: input.programId,
  });
  const info = await input.connection.getAccountInfo(grant, "confirmed");
  const state = sessionGrantState(info, input.programId, {
    matchAddress: input.matchAddress,
    authority: input.authority,
    sessionKey: session.publicKey,
  }, Math.floor(Date.now() / 1_000));
  if (state === "valid") return session;

  if (state === "invalid") {
    session = replaceSessionKeypairForMatch(input.matchAddress.toBase58());
  }

  const transaction = new Transaction().add(
    state === "expired"
      ? createRenewSessionInstruction({
        matchAddress: input.matchAddress.toBase58(),
        authorityAddress: input.authority.toBase58(),
        sessionKey: session.publicKey,
        expiresInSeconds: DEFAULT_SESSION_DURATION_SECONDS,
        programId: input.programId,
      })
      : createAuthorizeSessionInstruction({
        matchAddress: input.matchAddress.toBase58(),
        authorityAddress: input.authority.toBase58(),
        sessionKey: session.publicKey,
        expiresInSeconds: DEFAULT_SESSION_DURATION_SECONDS,
        programId: input.programId,
      }),
    SystemProgram.transfer({
      fromPubkey: input.authority,
      toPubkey: session.publicKey,
      lamports: SESSION_BASE_FEE_BUFFER_LAMPORTS,
    }),
  );
  transaction.feePayer = input.authority;
  const blockhash = await input.connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
  const simulation = await simulateUnsignedTransaction(input.connection, transaction);
  if (simulation.err) throw new Error(`session_grant_setup_simulation_failed: ${simulationError(simulation)}`);
  input.onWalletApprovalRequested?.();
  await sendAndConfirmWalletTransaction(input.connection, input.wallet, transaction, blockhash);
  return session;
}

async function ensureRuntimeDelegated(input: {
  connection: Connection;
  wallet: WalletProvider;
  matchAddress: PublicKey;
  authority: PublicKey;
  programId: PublicKey;
  teeRpcUrl: string;
  teeValidator?: string;
}) {
  const runtime = runtimePda(input.matchAddress.toBase58(), input.programId);
  const info = await input.connection.getAccountInfo(runtime, "confirmed");
  if (!info) throw new Error("runtime_account_unavailable");
  if (info.owner.equals(DELEGATION_PROGRAM_ID)) return;
  if (!info.owner.equals(input.programId)) throw new Error("runtime_account_program_mismatch");
  const validator = input.teeValidator
    ? new PublicKey(input.teeValidator)
    : teeValidatorForRpc(input.teeRpcUrl);
  const transaction = new Transaction().add(createDelegateRuntimeInstruction({
    matchAddress: input.matchAddress,
    payer: input.authority,
    validator,
    programId: input.programId,
  }));
  transaction.feePayer = input.authority;
  const blockhash = await input.connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
  const simulation = await simulateUnsignedTransaction(input.connection, transaction);
  if (simulation.err) throw new Error(simulationError(simulation));
  await sendAndConfirmWalletTransaction(input.connection, input.wallet, transaction, blockhash);
}

export async function renewSessionOnchain(input: {
  rpcUrl: string;
  matchAddress: string;
  authorityAddress: string;
  programId: string;
  onWalletApprovalRequested?: () => void;
}) {
  const wallet = window.solana;
  if (!wallet) throw new Error("solana_wallet_not_found");
  const connected = wallet.publicKey ? { publicKey: wallet.publicKey } : await wallet.connect();
  const authority = new PublicKey(connected.publicKey);
  if (!authority.equals(new PublicKey(input.authorityAddress))) throw new Error("session_renewal_wallet_mismatch");
  if (!wallet.signTransaction && !wallet.signAndSendTransaction) throw new Error("wallet_transaction_signing_unavailable");
  const session = sessionKeypairForMatch(input.matchAddress);
  const connection = createBaseRpcConnection(input.rpcUrl);
  const transaction = new Transaction().add(createRenewSessionInstruction({
    matchAddress: input.matchAddress,
    authorityAddress: authority.toBase58(),
    sessionKey: session.publicKey,
    expiresInSeconds: DEFAULT_SESSION_DURATION_SECONDS,
    programId: input.programId,
  }));
  transaction.feePayer = authority;
  const blockhash = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
  const simulation = await simulateUnsignedTransaction(connection, transaction);
  if (simulation.err) throw new Error(`session_renewal_simulation_failed: ${simulationError(simulation)}`);
  input.onWalletApprovalRequested?.();
  return sendAndConfirmWalletTransaction(connection, wallet, transaction, blockhash);
}

async function ensureOracleInitialized(input: {
  connection: Connection;
  wallet: WalletProvider;
  authority: PublicKey;
  programId: PublicKey;
  onWalletApprovalRequested?: () => void;
}) {
  const oracle = oraclePda(input.programId);
  const existing = await input.connection.getAccountInfo(oracle, "confirmed");
  if (existing) {
    if (!existing.owner.equals(input.programId)) throw new Error("oracle_account_program_mismatch");
    return;
  }
  const transaction = new Transaction().add(createInitializeOracleUnpricedInstruction({
    authorityAddress: input.authority.toBase58(),
    feedId: PYTH_SOL_USD_FEED_ID,
    programId: input.programId,
  }));
  transaction.feePayer = input.authority;
  const blockhash = await input.connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
  const simulation = await simulateUnsignedTransaction(input.connection, transaction);
  if (simulation.err) throw new Error(`oracle_initialization_simulation_failed: ${simulationError(simulation)}`);
  input.onWalletApprovalRequested?.();
  await sendAndConfirmWalletTransaction(input.connection, input.wallet, transaction, blockhash);
}

export async function bootstrapMatchOnchain(input: {
  pitId: string;
  nonce: bigint;
  capacity: number;
  rpcUrl: string;
  programId: string;
  expectedMatchAddress?: string;
  onWalletApprovalRequested?: () => void;
}) {
  const wallet = window.solana;
  if (!wallet) throw new Error("solana_wallet_not_found");
  const connected = wallet.publicKey ? { publicKey: wallet.publicKey } : await wallet.connect();
  const authority = new PublicKey(connected.publicKey);
  const programId = new PublicKey(input.programId);
  const { pit, match } = matchBootstrapAddresses(input);
  const connection = createBaseRpcConnection(input.rpcUrl);
  const [programInfo, pitInfo, matchInfo] = await Promise.all([
    connection.getAccountInfo(programId, "confirmed"),
    connection.getAccountInfo(pit, "confirmed"),
    connection.getAccountInfo(match, "confirmed"),
  ]);
  if (!programInfo?.executable) throw new Error("outcry_program_not_deployed");
  if (matchInfo?.owner.equals(programId)) return { status: "already_initialized" as const, matchAddress: match.toBase58() };
  if (pitInfo && !pitInfo.owner.equals(programId)) throw new Error("pit_account_program_mismatch");
  let activeMatch: PublicKey | undefined;
  if (pitInfo) {
    if (pitInfo.data.length < 40) throw new Error("pit_account_invalid");
    const pitAuthority = new PublicKey(pitInfo.data.subarray(8, 40));
    if (!pitAuthority.equals(authority)) throw new Error(`pit_authority_mismatch: connect ${pitAuthority.toBase58()}`);
    if (pitInfo.data.length < 105) throw new Error("pit_account_invalid");
    activeMatch = new PublicKey(pitInfo.data.subarray(73, 105));
  }
  if (input.expectedMatchAddress && !match.equals(new PublicKey(input.expectedMatchAddress))) {
    if (activeMatch && activeMatch.equals(new PublicKey(input.expectedMatchAddress))) {
      throw new Error(`pit_has_active_match:${activeMatch.toBase58()}`);
    }
    throw new Error("match_bootstrap_address_mismatch");
  }
  if (activeMatch && !activeMatch.equals(PublicKey.default)) {
    throw new Error(`pit_has_active_match:${activeMatch.toBase58()}`);
  }
  if (matchInfo) throw new Error("match_account_program_mismatch");

  const transaction = new Transaction();
  if (!pitInfo) transaction.add(createInitializePitInstruction({
    pitAddress: pit.toBase58(),
    authorityAddress: authority.toBase58(),
    pitId: input.pitId,
    capacity: input.capacity,
    programId: input.programId,
  }));
  transaction.add(createCreateMatchInstruction({
    pitAddress: pit.toBase58(),
    matchAddress: match.toBase58(),
    authorityAddress: authority.toBase58(),
    nonce: input.nonce,
    programId: input.programId,
  }));
  transaction.feePayer = authority;
  const blockhash = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
  const simulation = await simulateUnsignedTransaction(connection, transaction);
  if (simulation.err) throw new Error(simulationError(simulation));
  input.onWalletApprovalRequested?.();
  const signature = await sendAndConfirmWalletTransaction(connection, wallet, transaction, blockhash);
  return { status: "initialized" as const, matchAddress: match.toBase58(), signature };
}

export async function readActivePitMatchOnchain(input: {
  pitId: string;
  rpcUrl: string;
  programId: string;
}) {
  const connection = createBaseRpcConnection(input.rpcUrl);
  const { pit } = matchBootstrapAddresses({ pitId: input.pitId, nonce: 0n, programId: input.programId });
  const pitInfo = await connection.getAccountInfo(pit, "confirmed");
  if (!pitInfo) return undefined;
  if (!pitInfo.owner.equals(new PublicKey(input.programId))) throw new Error("pit_account_program_mismatch");
  if (pitInfo.data.length < 105) throw new Error("pit_account_invalid");
  const activeMatch = new PublicKey(pitInfo.data.subarray(73, 105));
  return activeMatch.equals(PublicKey.default) ? undefined : activeMatch.toBase58();
}

export async function releaseActiveMatchOnchain(input: {
  pitId: string;
  activeMatchAddress: string;
  preferredMatchNonce?: bigint;
  rpcUrl: string;
  programId: string;
  onWalletApprovalRequested?: () => void;
}) {
  const wallet = window.solana;
  if (!wallet) throw new Error("solana_wallet_not_found");
  if (!wallet.signTransaction || !wallet.signMessage) throw new Error("wallet_transaction_and_message_signing_required");
  const connected = wallet.publicKey ? { publicKey: wallet.publicKey } : await wallet.connect();
  const authority = new PublicKey(connected.publicKey);
  const programId = new PublicKey(input.programId);
  const connection = createBaseRpcConnection(input.rpcUrl);
  const { pit } = matchBootstrapAddresses({ pitId: input.pitId, nonce: 0n, programId: input.programId });
  const pitInfo = await connection.getAccountInfo(pit, "confirmed");
  if (!pitInfo) throw new Error("pit_account_not_initialized");
  if (!pitInfo.owner.equals(new PublicKey(input.programId))) throw new Error("pit_account_program_mismatch");
  if (pitInfo.data.length < 105) throw new Error("pit_account_invalid");
  const pitAuthority = new PublicKey(pitInfo.data.subarray(8, 40));
  if (!pitAuthority.equals(authority)) throw new Error(`pit_authority_mismatch: connect ${pitAuthority.toBase58()}`);
  const activeMatch = new PublicKey(pitInfo.data.subarray(73, 105));
  const requestedMatch = new PublicKey(input.activeMatchAddress);
  if (!activeMatch.equals(requestedMatch)) throw new Error("pit_active_match_changed");

  const matchInfo = await connection.getAccountInfo(requestedMatch, "confirmed");
  if (!matchInfo) throw new Error("match_account_unavailable");
  if (!matchInfo.owner.equals(programId) && !matchInfo.owner.equals(DELEGATION_PROGRAM_ID)) throw new Error("match_account_program_mismatch");
  if (!isSupportedReleaseLayout(matchInfo.data)) throw new Error("match_account_invalid");
  const releaseNonce = isLegacyMatchAccount(matchInfo.data)
    ? legacyMatchNonce(matchInfo.data)
    : recoverV2MatchNonce({
      pitAddress: pit,
      activeMatchAddress: requestedMatch,
      programId,
      preferredNonce: input.preferredMatchNonce,
    });
  const nextNonce = releaseNonce + 1n;
  if (nextNonce > 18_446_744_073_709_551_615n) throw new Error("match_nonce_exhausted");
  const { match: nextMatch } = matchBootstrapAddresses({ pitId: input.pitId, nonce: nextNonce, programId: input.programId });

  const transaction = new Transaction().add(createReleaseActiveMatchInstruction({
    pitAddress: pit.toBase58(),
    matchAddress: requestedMatch.toBase58(),
    authorityAddress: authority.toBase58(),
    nonce: releaseNonce,
    programId: input.programId,
    force: true,
  }), createCreateMatchInstruction({
    pitAddress: pit.toBase58(),
    matchAddress: nextMatch.toBase58(),
    authorityAddress: authority.toBase58(),
    nonce: nextNonce,
    programId: input.programId,
  }));
  transaction.feePayer = authority;
  const blockhash = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
  const simulation = await simulateUnsignedTransaction(connection, transaction);
  if (simulation.err) throw new Error(`release_active_match_simulation_failed: ${simulationError(simulation)}`);
  input.onWalletApprovalRequested?.();
  const signature = await sendAndConfirmWalletTransaction(connection, wallet, transaction, blockhash);
  return { status: "released" as const, signature, matchAddress: nextMatch.toBase58(), matchNonce: nextNonce };
}

export async function migrateLegacyMatchOnchain(input: {
  pitId: string;
  legacyMatchAddress: string;
  rpcUrl: string;
  programId: string;
  onWalletApprovalRequested?: () => void;
}) {
  const wallet = window.solana;
  if (!wallet) throw new Error("solana_wallet_not_found");
  const connected = wallet.publicKey ? { publicKey: wallet.publicKey } : await wallet.connect();
  const authority = new PublicKey(connected.publicKey);
  const programId = new PublicKey(input.programId);
  const connection = createBaseRpcConnection(input.rpcUrl);
  const { pit } = matchBootstrapAddresses({ pitId: input.pitId, nonce: 0n, programId: input.programId });
  const [programInfo, pitInfo, legacyInfo] = await Promise.all([
    connection.getAccountInfo(programId, "confirmed"),
    connection.getAccountInfo(pit, "confirmed"),
    connection.getAccountInfo(new PublicKey(input.legacyMatchAddress), "confirmed"),
  ]);
  if (!programInfo?.executable) throw new Error("outcry_program_not_deployed");
  if (!pitInfo || !pitInfo.owner.equals(programId) || pitInfo.data.length < 105) throw new Error("pit_account_invalid");
  if (!legacyInfo || !legacyInfo.owner.equals(programId)) throw new Error("legacy_match_must_be_on_base");
  if (!isLegacyMatchAccount(legacyInfo.data)) throw new Error("legacy_match_invalid");

  const nonce = legacyMatchNonce(legacyInfo.data);
  const legacyPda = legacyMatchPda({ pitAddress: pit.toBase58(), nonce, programId: input.programId });
  if (!legacyPda.equals(new PublicKey(input.legacyMatchAddress))) throw new Error("legacy_match_pda_invalid");
  const activeMatch = new PublicKey(pitInfo.data.subarray(73, 105));
  if (!activeMatch.equals(legacyPda)) throw new Error("pit_active_match_changed");
  const pitAuthority = new PublicKey(pitInfo.data.subarray(8, 40));
  if (!pitAuthority.equals(authority)) throw new Error(`pit_authority_mismatch: ${pitAuthority.toBase58()}`);
  const legacyAuthority = new PublicKey(legacyInfo.data.subarray(8, 40));
  if (!legacyAuthority.equals(authority)) throw new Error("legacy_match_host_required");

  const { match } = matchBootstrapAddresses({ pitId: input.pitId, nonce, programId: input.programId });
  if (await connection.getAccountInfo(match, "confirmed")) throw new Error("v2_match_already_initialized");
  const transaction = new Transaction().add(createMigrateLegacyMatchInstruction({
    pitAddress: pit.toBase58(),
    legacyMatchAddress: legacyPda.toBase58(),
    matchAddress: match.toBase58(),
    authorityAddress: authority.toBase58(),
    nonce,
    programId: input.programId,
  }));
  transaction.feePayer = authority;
  const blockhash = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
  const simulation = await simulateUnsignedTransaction(connection, transaction);
  if (simulation.err) throw new Error(`legacy_migration_simulation_failed: ${simulationError(simulation)}`);
  input.onWalletApprovalRequested?.();
  const signature = await sendAndConfirmWalletTransaction(connection, wallet, transaction, blockhash);
  return { status: "migrated" as const, signature, matchAddress: match.toBase58(), matchNonce: nonce };
}

export function validateJoinAccounts(
  programInfo: { executable: boolean } | null,
  matchInfo: { owner: PublicKey } | null,
  programId: PublicKey,
) {
  if (!programInfo?.executable) throw new Error("outcry_program_not_deployed");
  if (!matchInfo) throw new Error("match_account_not_initialized");
  if (!matchInfo.owner.equals(programId) && !matchInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
    throw new Error("match_account_program_mismatch");
  }
}

export function validateWalletBalance(balanceLamports: number) {
  if (!Number.isSafeInteger(balanceLamports) || balanceLamports < MIN_JOIN_BALANCE_LAMPORTS) {
    throw new Error("wallet_fee_payer_unfunded");
  }
}

function joinSimulationError(value: { err: unknown; logs?: string[] | null }) {
  const relevantLog = value.logs?.find((log) => /Error|failed|constraint|insufficient|Duplicate/i.test(log));
  return `join_match_simulation_failed: ${relevantLog ?? JSON.stringify(value.err)}`;
}

export async function joinMatchOnchain(input: {
  matchAddress: string;
  rpcUrl: string;
  programId: string;
  teeRpcUrl?: string;
  teeValidator?: string;
  onWalletApprovalRequested?: () => void;
}) {
  const wallet = window.solana;
  if (!wallet) throw new Error("solana_wallet_not_found");

  const connected = wallet.publicKey ? { publicKey: wallet.publicKey } : await wallet.connect();
  const player = new PublicKey(connected.publicKey);
  const programId = new PublicKey(input.programId);
  const matchAddress = new PublicKey(input.matchAddress);

  const connection = createBaseRpcConnection(input.rpcUrl);
  const [programInfo, matchInfo, balanceLamports] = await Promise.all([
    connection.getAccountInfo(programId, "confirmed"),
    connection.getAccountInfo(matchAddress, "confirmed"),
    connection.getBalance(player, "confirmed"),
  ]);
  validateJoinAccounts(programInfo, matchInfo, programId);
  if (isLegacyMatchAccount(matchInfo!.data)) throw new Error("legacy_match_requires_migration");
  const snapshot = decodePublicMatchAccount(input.matchAddress, matchInfo!.data);
  if (snapshot.players.includes(player.toBase58())) {
    const session = await ensureSessionGrantOnBase({
      connection,
      wallet,
      matchAddress,
      authority: player,
      session: sessionKeypairForMatch(input.matchAddress),
      programId,
      onWalletApprovalRequested: input.onWalletApprovalRequested,
    });
    if (snapshot.authority === player.toBase58()) {
      await ensureOracleInitialized({
        connection,
        wallet,
        authority: player,
        programId,
        onWalletApprovalRequested: input.onWalletApprovalRequested,
      });
    }
    if (input.teeRpcUrl && snapshot.authority === player.toBase58()) {
      await ensureRuntimeDelegated({
        connection,
        wallet,
        matchAddress,
        authority: player,
        programId,
        teeRpcUrl: input.teeRpcUrl,
        teeValidator: input.teeValidator,
      });
    }
    if (input.teeRpcUrl) {
      await ensurePrivateState({
        baseRpcUrl: input.rpcUrl,
        teeRpcUrl: input.teeRpcUrl,
        matchAddress,
        player,
        sessionKeypair: session,
        sessionGrantAddress: sessionGrantPda({ matchAddress: input.matchAddress, authorityAddress: player.toBase58(), sessionKey: session.publicKey, programId }),
        wallet,
        programId,
        teeValidator: input.teeValidator ? new PublicKey(input.teeValidator) : undefined,
      });
    }
    return { walletAddress: player.toBase58(), alreadyJoined: true as const, sessionKey: session.publicKey.toBase58() };
  }
  if (snapshot.status === "FINISHED") throw new Error("match_finished_release_required");
  validateWalletBalance(balanceLamports);
  const session = sessionKeypairForMatch(input.matchAddress);
  const sessionGrant = sessionGrantPda({
    matchAddress: input.matchAddress,
    authorityAddress: player.toBase58(),
    sessionKey: session.publicKey,
    programId,
  });
  const [runtimeInfo, resultInfo, escrowInfo, oracleInfo] = await Promise.all([
    connection.getAccountInfo(runtimePda(input.matchAddress, programId), "confirmed"),
    snapshot.authority === player.toBase58()
      ? connection.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("result"), new PublicKey(input.matchAddress).toBuffer()], programId)[0], "confirmed")
      : Promise.resolve(null),
    snapshot.authority === player.toBase58()
      ? connection.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("escrow"), new PublicKey(input.matchAddress).toBuffer()], programId)[0], "confirmed")
      : Promise.resolve(null),
    snapshot.authority === player.toBase58()
      ? connection.getAccountInfo(oraclePda(programId), "confirmed")
      : Promise.resolve(null),
  ]);
  const transaction = new Transaction().add(createJoinMatchInstruction({
    matchAddress: input.matchAddress,
    playerAddress: player.toBase58(),
    programId: input.programId,
  }), createInitializePrivateInventoryInstruction({ matchAddress, player, programId }), createInitializePrivateQuoteInstruction({ matchAddress, dealer: player, programId }), createAuthorizeSessionInstruction({
    matchAddress: input.matchAddress,
    authorityAddress: player.toBase58(),
    sessionKey: session.publicKey,
    expiresInSeconds: DEFAULT_SESSION_DURATION_SECONDS,
    programId,
  }), SystemProgram.transfer({
    fromPubkey: player,
    toPubkey: session.publicKey,
    lamports: SESSION_BASE_FEE_BUFFER_LAMPORTS,
  }));
  if (snapshot.authority === player.toBase58()) {
    if (!resultInfo) transaction.add(createInitializeMatchResultInstruction({ matchAddress: input.matchAddress, authorityAddress: player.toBase58(), programId }));
    if (!escrowInfo) transaction.add(createInitializeEscrowInstruction({ matchAddress: input.matchAddress, authorityAddress: player.toBase58(), programId }));
    if (!oracleInfo) transaction.add(createInitializeOracleUnpricedInstruction({ authorityAddress: player.toBase58(), feedId: PYTH_SOL_USD_FEED_ID, programId }));
    if (input.teeRpcUrl) {
      if (!runtimeInfo) throw new Error("runtime_account_unavailable");
      if (runtimeInfo.owner.equals(programId)) {
        transaction.add(createDelegateRuntimeInstruction({
          matchAddress: new PublicKey(input.matchAddress),
          payer: player,
          validator: input.teeValidator ? new PublicKey(input.teeValidator) : teeValidatorForRpc(input.teeRpcUrl),
          programId,
        }));
      } else if (!runtimeInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
        throw new Error("runtime_account_program_mismatch");
      }
    }
  }
  transaction.feePayer = player;
  const blockhash = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;

  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) throw new Error(joinSimulationError(simulation.value));

  input.onWalletApprovalRequested?.();
  const signature = await sendAndConfirmWalletTransaction(connection, wallet, transaction, blockhash);
  if (input.teeRpcUrl) {
    await ensurePrivateState({
      baseRpcUrl: input.rpcUrl,
      teeRpcUrl: input.teeRpcUrl,
      matchAddress,
      player,
      sessionKeypair: session,
      sessionGrantAddress: sessionGrant,
      wallet,
      programId,
      teeValidator: input.teeValidator ? new PublicKey(input.teeValidator) : undefined,
    });
  }
  return { walletAddress: player.toBase58(), signature, sessionKey: session.publicKey.toBase58() };
}
