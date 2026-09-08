import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import { createBaseRpcConnection } from "./baseRpc";
import { DELEGATION_PROGRAM_ID, MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID, magicFeeVaultPdaFromValidator } from "@magicblock-labs/ephemeral-rollups-sdk";
import outcryIdl from "./idl/outcry.json";
import { decodePublicMatchAccount } from "./matchState";
import { createPrivateConnection, ensureTeeFeePayer, sendTeeTransaction, teeValidatorForRpc } from "./privacy";

const joinMatchIdl = outcryIdl.instructions.find((instruction) => instruction.name === "join_match");
if (!joinMatchIdl) throw new Error("outcry_idl_missing_join_match");
const JOIN_MATCH_DISCRIMINATOR = Uint8Array.from(joinMatchIdl.discriminator);
const MIN_JOIN_BALANCE_LAMPORTS = 5_000;
const initializePitIdl = outcryIdl.instructions.find((instruction) => instruction.name === "initialize_pit");
if (!initializePitIdl) throw new Error("outcry_idl_missing_initialize_pit");
const INITIALIZE_PIT_DISCRIMINATOR = Uint8Array.from(initializePitIdl.discriminator);
const createMatchIdl = outcryIdl.instructions.find((instruction) => instruction.name === "create_match");
if (!createMatchIdl) throw new Error("outcry_idl_missing_create_match");
const CREATE_MATCH_DISCRIMINATOR = Uint8Array.from(createMatchIdl.discriminator);
const releaseActiveMatchIdl = outcryIdl.instructions.find((instruction) => instruction.name === "release_active_match");
if (!releaseActiveMatchIdl) throw new Error("outcry_idl_missing_release_active_match");
const RELEASE_ACTIVE_MATCH_DISCRIMINATOR = Uint8Array.from(releaseActiveMatchIdl.discriminator);
const undelegateMatchIdl = outcryIdl.instructions.find((instruction) => instruction.name === "undelegate_match");
if (!undelegateMatchIdl) throw new Error("outcry_idl_missing_undelegate_match");
const UNDELEGATE_MATCH_DISCRIMINATOR = Uint8Array.from(undelegateMatchIdl.discriminator);

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
  seatIndex: number;
}) {
  if (!Number.isInteger(input.seatIndex) || input.seatIndex < 0 || input.seatIndex > 3) {
    throw new Error("invalid_seat");
  }
  const match = new PublicKey(input.matchAddress);
  const player = new PublicKey(input.playerAddress);
  return new TransactionInstruction({
    programId: new PublicKey(input.programId),
    keys: [
      { pubkey: match, isWritable: true, isSigner: false },
      { pubkey: player, isWritable: false, isSigner: true },
    ],
    data: Uint8Array.from([...JOIN_MATCH_DISCRIMINATOR, input.seatIndex]) as unknown as Buffer,
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
  const [match] = PublicKey.findProgramAddressSync([new TextEncoder().encode("match"), pit.toBytes(), u64Bytes(input.nonce)], programId);
  return { pitId, pit, match };
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
      { pubkey: new PublicKey(input.authorityAddress), isWritable: true, isSigner: true },
      { pubkey: new PublicKey("11111111111111111111111111111111"), isWritable: false, isSigner: false },
    ],
    data: Uint8Array.from([...CREATE_MATCH_DISCRIMINATOR, ...u64Bytes(input.nonce)]) as unknown as Buffer,
  });
}

export function createReleaseActiveMatchInstruction(input: {
  pitAddress: string;
  matchAddress: string;
  authorityAddress: string;
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
    data: Uint8Array.from([...RELEASE_ACTIVE_MATCH_DISCRIMINATOR, input.force ? 1 : 0]) as unknown as Buffer,
  });
}

export function createUndelegateMatchInstruction(input: {
  matchAddress: string;
  payer: PublicKey;
  authorityAddress: string;
  magicFeeVaultAddress: string;
  programId: string;
}) {
  return new TransactionInstruction({
    programId: new PublicKey(input.programId),
    keys: [
      { pubkey: input.payer, isWritable: true, isSigner: true },
      { pubkey: new PublicKey(input.matchAddress), isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.magicFeeVaultAddress), isWritable: true, isSigner: false },
      { pubkey: new PublicKey(input.authorityAddress), isWritable: false, isSigner: true },
      { pubkey: MAGIC_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: MAGIC_CONTEXT_ID, isWritable: true, isSigner: false },
    ],
    data: Uint8Array.from(UNDELEGATE_MATCH_DISCRIMINATOR) as unknown as Buffer,
  });
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

async function waitForBaseProgramAccount(connection: Connection, address: PublicKey, programId: PublicKey) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const info = await connection.getAccountInfo(address, "confirmed");
    if (info?.owner.equals(programId)) return;
    if (attempt + 1 < 20) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("match_undelegation_not_confirmed");
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
  rpcUrl: string;
  teeRpcUrl?: string;
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
  const ownership = classifyMatchOwnership(matchInfo.owner, programId);
  const snapshot = decodePublicMatchAccount(requestedMatch.toBase58(), matchInfo.data);
  const nextNonce = snapshot.matchNonce + 1n;
  if (nextNonce > 18_446_744_073_709_551_615n) throw new Error("match_nonce_exhausted");
  const { match: nextMatch } = matchBootstrapAddresses({ pitId: input.pitId, nonce: nextNonce, programId: input.programId });

  if (ownership === "delegated") {
    const teeRpcUrl = input.teeRpcUrl ?? "https://devnet-tee.magicblock.app";
    const magicFeeVault = magicFeeVaultPdaFromValidator(teeValidatorForRpc(teeRpcUrl));
    const teeSession = await createPrivateConnection({
      teeRpcUrl,
      publicKey: authority,
      signMessage: async (message) => {
        const signed = await wallet.signMessage!(message);
        return signed instanceof Uint8Array ? signed : signed.signature;
      },
    });
    const feePayer = await ensureTeeFeePayer({
      baseRpcUrl: input.rpcUrl,
      teeRpcUrl,
      teeConnection: teeSession.connection,
      player: authority,
      wallet,
      programId,
    });
    await sendTeeTransaction({
      connection: teeSession.connection,
      wallet,
      feePayer,
      label: "undelegate_match",
      instructions: [createUndelegateMatchInstruction({
        matchAddress: requestedMatch.toBase58(),
        payer: feePayer.publicKey,
        authorityAddress: authority.toBase58(),
        magicFeeVaultAddress: magicFeeVault.toBase58(),
        programId: input.programId,
      })],
    });
    await waitForBaseProgramAccount(connection, requestedMatch, programId);
  }

  const transaction = new Transaction().add(createReleaseActiveMatchInstruction({
    pitAddress: pit.toBase58(),
    matchAddress: requestedMatch.toBase58(),
    authorityAddress: authority.toBase58(),
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

export async function restoreDelegatedMatchOnchain(input: {
  matchAddress: string;
  rpcUrl: string;
  teeRpcUrl?: string;
  programId: string;
  onWalletApprovalRequested?: () => void;
}) {
  const wallet = window.solana;
  if (!wallet?.signTransaction || !wallet.signMessage) throw new Error("wallet_transaction_and_message_signing_required");
  const connected = wallet.publicKey ? { publicKey: wallet.publicKey } : await wallet.connect();
  const authority = new PublicKey(connected.publicKey);
  const programId = new PublicKey(input.programId);
  const connection = createBaseRpcConnection(input.rpcUrl);
  const match = new PublicKey(input.matchAddress);
  const matchInfo = await connection.getAccountInfo(match, "confirmed");
  if (!matchInfo) throw new Error("match_account_unavailable");
  if (classifyMatchOwnership(matchInfo.owner, programId) === "base") return { status: "already_restored" as const };

  const snapshot = decodePublicMatchAccount(match.toBase58(), matchInfo.data);
  if (!snapshot.host || !new PublicKey(snapshot.host).equals(authority)) throw new Error("match_host_wallet_mismatch");
  const teeRpcUrl = input.teeRpcUrl ?? "https://devnet-tee.magicblock.app";
  const teeSession = await createPrivateConnection({
    teeRpcUrl,
    publicKey: authority,
    signMessage: async (message) => {
      const signed = await wallet.signMessage!(message);
      return signed instanceof Uint8Array ? signed : signed.signature;
    },
  });
  const feePayer = await ensureTeeFeePayer({
    baseRpcUrl: input.rpcUrl,
    teeRpcUrl,
    teeConnection: teeSession.connection,
    player: authority,
    wallet,
    programId,
  });
  input.onWalletApprovalRequested?.();
  const signature = await sendTeeTransaction({
    connection: teeSession.connection,
    wallet,
    feePayer,
    label: "restore_delegated_match",
    instructions: [createUndelegateMatchInstruction({
      matchAddress: match.toBase58(),
      payer: feePayer.publicKey,
      authorityAddress: authority.toBase58(),
      magicFeeVaultAddress: magicFeeVaultPdaFromValidator(teeValidatorForRpc(teeRpcUrl)).toBase58(),
      programId: input.programId,
    })],
  });
  await waitForBaseProgramAccount(connection, match, programId);
  return { status: "restored" as const, signature };
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
  seatIndex: number;
  rpcUrl: string;
  programId: string;
}) {
  const wallet = window.solana;
  if (!wallet) throw new Error("solana_wallet_not_found");

  const connected = wallet.publicKey ? { publicKey: wallet.publicKey } : await wallet.connect();
  const player = new PublicKey(connected.publicKey);

  const connection = createBaseRpcConnection(input.rpcUrl);
  const [programInfo, matchInfo, balanceLamports] = await Promise.all([
    connection.getAccountInfo(new PublicKey(input.programId), "confirmed"),
    connection.getAccountInfo(new PublicKey(input.matchAddress), "confirmed"),
    connection.getBalance(player, "confirmed"),
  ]);
  validateJoinAccounts(programInfo, matchInfo, new PublicKey(input.programId));
  const snapshot = decodePublicMatchAccount(input.matchAddress, matchInfo!.data);
  const existingSeat = snapshot.players.findIndex((walletAddress) => walletAddress === player.toBase58());
  if (existingSeat >= 0) {
    return { walletAddress: player.toBase58(), alreadyJoined: true as const, seatIndex: existingSeat };
  }
  validateWalletBalance(balanceLamports);
  const transaction = new Transaction().add(createJoinMatchInstruction({
    matchAddress: input.matchAddress,
    playerAddress: player.toBase58(),
    programId: input.programId,
    seatIndex: input.seatIndex,
  }));
  transaction.feePayer = player;
  const blockhash = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;

  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) throw new Error(joinSimulationError(simulation.value));

  const sent = await wallet.signAndSendTransaction(transaction);
  const signature = typeof sent === "string" ? sent : sent.signature;
  await connection.confirmTransaction({
    signature,
    blockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  }, "confirmed");
  return { walletAddress: player.toBase58(), signature };
}
