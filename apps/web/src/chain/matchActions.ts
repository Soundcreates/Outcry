import nacl from "tweetnacl";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import outcryIdl from "./idl/outcry.json";
import { createBaseRpcConnection } from "./baseRpc";
import { createPrivateConnection, privateInventoryPda, privateQuotePda, teeFeePayerForRpc } from "./privacy";
import { escrowPda, oraclePda, PYTH_SOL_USD_PUSH_FEED, resultPda, runtimePda } from "./matchState";
import type { PublicMatchSnapshot } from "./matchState";
import type { TradeIntent } from "../match/tradeIntent";

const PROGRAM_ID = new PublicKey(outcryIdl.address);
const SYSTEM_PROGRAM_ID = SystemProgram.programId;
const SESSION_GRANT_DISCRIMINATOR = Uint8Array.from(outcryIdl.accounts.find((account) => account.name === "SessionGrant")?.discriminator ?? []);
const SESSION_GRANT_BYTES = 115;
export const DEFAULT_QUOTE_WINDOW_SECONDS = 30;
export const DEFAULT_MATCH_PAYOUT_LAMPORTS = 1_000_000;
export const DEFAULT_SESSION_DURATION_SECONDS = 24 * 60 * 60;
export const SESSION_ACTION_OPEN_RFQ = 1;
export const SESSION_ACTION_SUBMIT_QUOTE = 2;
export const SESSION_ACTION_START_MATCH = 4;
export const SESSION_ACTION_SETUP_PRIVATE_STATE = 8;
export const DEFAULT_SESSION_ACTION_MASK = SESSION_ACTION_OPEN_RFQ | SESSION_ACTION_SUBMIT_QUOTE | SESSION_ACTION_START_MATCH | SESSION_ACTION_SETUP_PRIVATE_STATE;

const instructionDiscriminator = (name: string) => {
  const instruction = outcryIdl.instructions.find((value) => value.name === name);
  if (!instruction) throw new Error(`outcry_idl_missing_${name}`);
  return Uint8Array.from(instruction.discriminator);
};

const OPEN_RFQ_DISCRIMINATOR = instructionDiscriminator("open_rfq");
const SUBMIT_QUOTE_DISCRIMINATOR = instructionDiscriminator("submit_quote");
const START_MATCH_DISCRIMINATOR = instructionDiscriminator("start_match");
const AUTHORIZE_SESSION_DISCRIMINATOR = instructionDiscriminator("authorize_session");
const RENEW_SESSION_DISCRIMINATOR = instructionDiscriminator("renew_session");
const INITIALIZE_ORACLE_DISCRIMINATOR = instructionDiscriminator("initialize_oracle");
const INITIALIZE_ORACLE_UNPRICED_DISCRIMINATOR = instructionDiscriminator("initialize_oracle_unpriced");
const UPDATE_ORACLE_DISCRIMINATOR = instructionDiscriminator("update_oracle");
const INITIALIZE_MATCH_RESULT_DISCRIMINATOR = instructionDiscriminator("initialize_match_result");
const INITIALIZE_ESCROW_DISCRIMINATOR = instructionDiscriminator("initialize_escrow");
const RESOLVE_ROUND_DISCRIMINATOR = instructionDiscriminator("resolve_round");
const SKIP_EMPTY_ROUND_DISCRIMINATOR = instructionDiscriminator("skip_empty_round");
const ADVANCE_ROUND_DISCRIMINATOR = instructionDiscriminator("advance_round");
const FINALIZE_RUNTIME_DISCRIMINATOR = instructionDiscriminator("finalize_runtime");
const FINALIZE_MATCH_DISCRIMINATOR = instructionDiscriminator("finalize_match");
const SETTLE_MATCH_DISCRIMINATOR = instructionDiscriminator("settle_match");

function worldApiBaseUrl() {
  return (
    import.meta.env?.VITE_API_BASE_URL
    || import.meta.env?.VITE_WORLD_HTTP
    || (import.meta.env?.VITE_WORLD_WS || "ws://localhost:2567").replace(/^ws/, "http")
  ).replace(/\/+$/, "");
}

export type RfqProgress = (status: string) => void;

export class RfqSubmissionError extends Error {
  constructor(public readonly stage: "session" | "state" | "relay" | "confirmation", public readonly code: string, public readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "RfqSubmissionError";
  }
}

export function normalizeRfqError(reason: unknown) {
  if (reason instanceof RfqSubmissionError) return reason;
  const detail = reason instanceof Error ? reason.message : String(reason);
  const customError = detail.match(/custom program error:\s*(0x[\da-f]+)/i);
  const errorNumber = customError ? Number.parseInt(customError[1]!, 16) : undefined;
  if (errorNumber === 6041) return new RfqSubmissionError("session", "session_expired");
  if (errorNumber === 6040) return new RfqSubmissionError("session", "session_invalid");
  if (errorNumber === 6042) return new RfqSubmissionError("session", "session_action_not_allowed");
  return new RfqSubmissionError("state", "rfq_submit_failed", detail);
}

function seed(value: string) {
  return new TextEncoder().encode(value);
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function validateOpenRfqSession(input: { baseRpcUrl: string; matchAddress: string; authorityAddress: string; session: Keypair; programId: PublicKey }) {
  const grant = sessionGrantPda({
    matchAddress: input.matchAddress,
    authorityAddress: input.authorityAddress,
    sessionKey: input.session.publicKey,
    programId: input.programId,
  });
  const account = await createBaseRpcConnection(input.baseRpcUrl).getAccountInfo(grant, "confirmed");
  if (!account || !account.owner.equals(input.programId) || account.data.length !== SESSION_GRANT_BYTES || !sameBytes(account.data.slice(0, 8), SESSION_GRANT_DISCRIMINATOR)) {
    throw new RfqSubmissionError("session", "session_invalid");
  }
  const match = new PublicKey(input.matchAddress);
  const authority = new PublicKey(input.authorityAddress);
  const expiresAt = Number(new DataView(account.data.buffer, account.data.byteOffset, account.data.byteLength).getBigInt64(104, true));
  const actionMask = account.data[112]!;
  const revoked = account.data[113] !== 0;
  if (!sameBytes(account.data.slice(8, 40), match.toBytes())
    || !sameBytes(account.data.slice(40, 72), authority.toBytes())
    || !sameBytes(account.data.slice(72, 104), input.session.publicKey.toBytes())
    || revoked) throw new RfqSubmissionError("session", "session_invalid");
  if (Math.floor(Date.now() / 1_000) >= expiresAt) throw new RfqSubmissionError("session", "session_expired");
  if ((actionMask & SESSION_ACTION_OPEN_RFQ) === 0) throw new RfqSubmissionError("session", "session_action_not_allowed");
}

function u8(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error("invalid_u8");
  return Uint8Array.of(value);
}

function u64(value: bigint | number) {
  const result = BigInt(value);
  if (result < 0n || result > 18_446_744_073_709_551_615n) throw new Error("invalid_u64");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, result, true);
  return bytes;
}

function i64(value: bigint | number) {
  const result = BigInt(value);
  if (result < -9_223_372_036_854_775_808n || result > 9_223_372_036_854_775_807n) throw new Error("invalid_i64");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, result, true);
  return bytes;
}

function bytes32(value: Uint8Array) {
  if (value.length !== 32) throw new Error("invalid_bytes32");
  return value;
}

function sideValue(side: "BUY" | "SELL" | number) {
  if (side === "BUY" || side === 0) return 0;
  if (side === "SELL" || side === 1) return 1;
  throw new Error("invalid_side");
}

const sessionFallback = new Map<string, Keypair>();

export function sessionKeypairForMatch(matchAddress: string) {
  const key = `outcry:session:${matchAddress}`;
  const existing = sessionFallback.get(key);
  if (existing) return existing;
  try {
    const encoded = globalThis.sessionStorage?.getItem(key);
    if (encoded) {
      const secretKey = Uint8Array.from(encoded.split(",").map((value) => Number(value)));
      if (secretKey.length === 64) {
        const session = Keypair.fromSecretKey(secretKey);
        sessionFallback.set(key, session);
        return session;
      }
    }
  } catch {
    // Fall through to a fresh in-memory session for non-browser callers.
  }
  const session = Keypair.generate();
  sessionFallback.set(key, session);
  try {
    globalThis.sessionStorage?.setItem(key, Array.from(session.secretKey).join(","));
  } catch {
    // A caller can still pass this keypair explicitly to setup helpers.
  }
  return session;
}

export function replaceSessionKeypairForMatch(matchAddress: string) {
  const key = `outcry:session:${matchAddress}`;
  const session = Keypair.generate();
  sessionFallback.set(key, session);
  try {
    globalThis.sessionStorage?.setItem(key, Array.from(session.secretKey).join(","));
  } catch {
    // The in-memory key remains usable for the current page.
  }
  return session;
}

export function sessionGrantPda(input: {
  matchAddress: string;
  authorityAddress: string;
  sessionKey: PublicKey;
  programId?: PublicKey;
}) {
  return PublicKey.findProgramAddressSync([
    seed("session"),
    new PublicKey(input.matchAddress).toBytes(),
    new PublicKey(input.authorityAddress).toBytes(),
    input.sessionKey.toBytes(),
  ], input.programId ?? PROGRAM_ID)[0];
}

function sessionGrantAddress(input: { matchAddress: string; authorityAddress: string; sessionKey: PublicKey; sessionGrantAddress?: string; programId: PublicKey }) {
  return input.sessionGrantAddress
    ? new PublicKey(input.sessionGrantAddress)
    : sessionGrantPda({ matchAddress: input.matchAddress, authorityAddress: input.authorityAddress, sessionKey: input.sessionKey, programId: input.programId });
}

function instruction(programId: PublicKey, data: Uint8Array, keys: Array<{ pubkey: PublicKey; isWritable: boolean; isSigner: boolean }>) {
  return new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
}

export function createAuthorizeSessionInstruction(input: {
  matchAddress: string;
  authorityAddress: string;
  sessionKey: PublicKey;
  expiresInSeconds: bigint | number;
  actionMask?: number;
  programId?: string | PublicKey;
}) {
  const programId = typeof input.programId === "string" ? new PublicKey(input.programId) : input.programId ?? PROGRAM_ID;
  const match = new PublicKey(input.matchAddress);
  const authority = new PublicKey(input.authorityAddress);
  const grant = sessionGrantPda({ matchAddress: input.matchAddress, authorityAddress: input.authorityAddress, sessionKey: input.sessionKey, programId });
  return instruction(programId, new Uint8Array([
    ...AUTHORIZE_SESSION_DISCRIMINATOR,
    ...input.sessionKey.toBytes(),
    ...i64(input.expiresInSeconds),
    ...u8(input.actionMask ?? DEFAULT_SESSION_ACTION_MASK),
  ]), [
    { pubkey: match, isWritable: false, isSigner: false },
    { pubkey: grant, isWritable: true, isSigner: false },
    { pubkey: authority, isWritable: true, isSigner: true },
    { pubkey: SYSTEM_PROGRAM_ID, isWritable: false, isSigner: false },
  ]);
}

export function createRenewSessionInstruction(input: {
  matchAddress: string;
  authorityAddress: string;
  sessionKey: PublicKey;
  expiresInSeconds?: bigint | number;
  programId?: string | PublicKey;
}) {
  const programId = typeof input.programId === "string" ? new PublicKey(input.programId) : input.programId ?? PROGRAM_ID;
  return instruction(programId, new Uint8Array([
    ...RENEW_SESSION_DISCRIMINATOR,
    ...i64(input.expiresInSeconds ?? DEFAULT_SESSION_DURATION_SECONDS),
  ]), [
    { pubkey: new PublicKey(input.matchAddress), isWritable: false, isSigner: false },
    { pubkey: sessionGrantPda({ matchAddress: input.matchAddress, authorityAddress: input.authorityAddress, sessionKey: input.sessionKey, programId }), isWritable: true, isSigner: false },
    { pubkey: new PublicKey(input.authorityAddress), isWritable: false, isSigner: true },
  ]);
}

export function createStartMatchInstruction(input: {
  matchAddress: string;
  hostAddress: string;
  sessionKey?: PublicKey;
  sessionGrantAddress?: string;
  roundCount?: number;
  programId?: string | PublicKey;
}) {
  const programId = typeof input.programId === "string" ? new PublicKey(input.programId) : input.programId ?? PROGRAM_ID;
  const sessionKey = input.sessionKey ?? sessionKeypairForMatch(input.matchAddress).publicKey;
  const grant = sessionGrantAddress({ matchAddress: input.matchAddress, authorityAddress: input.hostAddress, sessionKey, sessionGrantAddress: input.sessionGrantAddress, programId });
  const roundCount = input.roundCount ?? 3;
  if (!Number.isInteger(roundCount) || roundCount < 1 || roundCount > 8) throw new Error("invalid_round_count");
  return instruction(programId, new Uint8Array([...START_MATCH_DISCRIMINATOR, ...u8(roundCount)]), [
    { pubkey: new PublicKey(input.matchAddress), isWritable: true, isSigner: false },
    { pubkey: new PublicKey(input.hostAddress), isWritable: false, isSigner: false },
    { pubkey: sessionKey, isWritable: false, isSigner: true },
    { pubkey: grant, isWritable: false, isSigner: false },
  ]);
}

export function createOpenRfqInstruction(input: {
  matchAddress: string;
  authorityAddress: string;
  sessionKey: PublicKey;
  sessionGrantAddress?: string;
  side: "BUY" | "SELL" | number;
  quantityLots: bigint | number;
  quoteWindowSeconds?: bigint | number;
  oracleAddress?: string;
  programId?: string | PublicKey;
}) {
  const programId = typeof input.programId === "string" ? new PublicKey(input.programId) : input.programId ?? PROGRAM_ID;
  const grant = sessionGrantAddress({ matchAddress: input.matchAddress, authorityAddress: input.authorityAddress, sessionKey: input.sessionKey, sessionGrantAddress: input.sessionGrantAddress, programId });
  const quantity = BigInt(input.quantityLots);
  if (![1n, 2n, 5n].includes(quantity)) throw new Error("invalid_quantity");
  const oracle = input.oracleAddress ? new PublicKey(input.oracleAddress) : oraclePda(programId);
  return instruction(programId, new Uint8Array([
    ...OPEN_RFQ_DISCRIMINATOR,
    ...u8(sideValue(input.side)),
    ...u64(quantity),
    ...i64(input.quoteWindowSeconds ?? DEFAULT_QUOTE_WINDOW_SECONDS),
  ]), [
    { pubkey: new PublicKey(input.matchAddress), isWritable: false, isSigner: false },
    { pubkey: runtimePda(input.matchAddress, programId), isWritable: true, isSigner: false },
    { pubkey: oracle, isWritable: false, isSigner: false },
    { pubkey: new PublicKey(input.authorityAddress), isWritable: false, isSigner: false },
    { pubkey: input.sessionKey, isWritable: false, isSigner: true },
    { pubkey: grant, isWritable: false, isSigner: false },
  ]);
}

export function createSubmitQuoteInstruction(input: {
  matchAddress: string;
  authorityAddress: string;
  sessionKey: PublicKey;
  sessionGrantAddress?: string;
  quoteAddress?: string;
  priceE6: bigint | number;
  programId?: string | PublicKey;
}) {
  const programId = typeof input.programId === "string" ? new PublicKey(input.programId) : input.programId ?? PROGRAM_ID;
  const quote = input.quoteAddress ? new PublicKey(input.quoteAddress) : privateQuotePda({ matchAddress: new PublicKey(input.matchAddress), dealer: new PublicKey(input.authorityAddress), programId });
  return instruction(programId, new Uint8Array([...SUBMIT_QUOTE_DISCRIMINATOR, ...i64(input.priceE6)]), [
    { pubkey: new PublicKey(input.matchAddress), isWritable: false, isSigner: false },
    { pubkey: runtimePda(input.matchAddress, programId), isWritable: true, isSigner: false },
    { pubkey: new PublicKey(input.authorityAddress), isWritable: false, isSigner: false },
    { pubkey: quote, isWritable: true, isSigner: false },
    { pubkey: input.sessionKey, isWritable: false, isSigner: true },
    { pubkey: sessionGrantAddress({ matchAddress: input.matchAddress, authorityAddress: input.authorityAddress, sessionKey: input.sessionKey, sessionGrantAddress: input.sessionGrantAddress, programId }), isWritable: false, isSigner: false },
  ]);
}

export function createInitializeOracleInstruction(input: { authorityAddress: string; priceFeedAddress?: string; feedId: Uint8Array; programId?: string | PublicKey }) {
  const programId = typeof input.programId === "string" ? new PublicKey(input.programId) : input.programId ?? PROGRAM_ID;
  return instruction(programId, new Uint8Array([...INITIALIZE_ORACLE_DISCRIMINATOR, ...bytes32(input.feedId)]), [
    { pubkey: oraclePda(programId), isWritable: true, isSigner: false },
    { pubkey: new PublicKey(input.priceFeedAddress ?? PYTH_SOL_USD_PUSH_FEED.toBase58()), isWritable: false, isSigner: false },
    { pubkey: new PublicKey(input.authorityAddress), isWritable: true, isSigner: true },
    { pubkey: SYSTEM_PROGRAM_ID, isWritable: false, isSigner: false },
  ]);
}

export function createInitializeOracleUnpricedInstruction(input: { authorityAddress: string; feedId: Uint8Array; programId?: string | PublicKey }) {
  const programId = typeof input.programId === "string" ? new PublicKey(input.programId) : input.programId ?? PROGRAM_ID;
  return instruction(programId, new Uint8Array([...INITIALIZE_ORACLE_UNPRICED_DISCRIMINATOR, ...bytes32(input.feedId)]), [
    { pubkey: oraclePda(programId), isWritable: true, isSigner: false },
    { pubkey: new PublicKey(input.authorityAddress), isWritable: true, isSigner: true },
    { pubkey: SYSTEM_PROGRAM_ID, isWritable: false, isSigner: false },
  ]);
}

export function createUpdateOracleInstruction(input: { priceFeedAddress?: string; programId?: string | PublicKey }) {
  const programId = typeof input.programId === "string" ? new PublicKey(input.programId) : input.programId ?? PROGRAM_ID;
  return instruction(programId, UPDATE_ORACLE_DISCRIMINATOR, [
    { pubkey: oraclePda(programId), isWritable: true, isSigner: false },
    { pubkey: new PublicKey(input.priceFeedAddress ?? PYTH_SOL_USD_PUSH_FEED.toBase58()), isWritable: false, isSigner: false },
  ]);
}

export function createInitializeMatchResultInstruction(input: { matchAddress: string; authorityAddress: string; programId?: string | PublicKey }) {
  const programId = typeof input.programId === "string" ? new PublicKey(input.programId) : input.programId ?? PROGRAM_ID;
  return instruction(programId, INITIALIZE_MATCH_RESULT_DISCRIMINATOR, [
    { pubkey: new PublicKey(input.matchAddress), isWritable: false, isSigner: false },
    { pubkey: resultPda(input.matchAddress, programId), isWritable: true, isSigner: false },
    { pubkey: new PublicKey(input.authorityAddress), isWritable: true, isSigner: true },
    { pubkey: SYSTEM_PROGRAM_ID, isWritable: false, isSigner: false },
  ]);
}

export function createInitializeEscrowInstruction(input: { matchAddress: string; authorityAddress: string; payoutLamports?: bigint | number; programId?: string | PublicKey }) {
  const programId = typeof input.programId === "string" ? new PublicKey(input.programId) : input.programId ?? PROGRAM_ID;
  return instruction(programId, new Uint8Array([...INITIALIZE_ESCROW_DISCRIMINATOR, ...u64(input.payoutLamports ?? DEFAULT_MATCH_PAYOUT_LAMPORTS)]), [
    { pubkey: new PublicKey(input.matchAddress), isWritable: false, isSigner: false },
    { pubkey: escrowPda(input.matchAddress, programId), isWritable: true, isSigner: false },
    { pubkey: new PublicKey(input.authorityAddress), isWritable: true, isSigner: true },
    { pubkey: SYSTEM_PROGRAM_ID, isWritable: false, isSigner: false },
  ]);
}

export function createResolveRoundInstruction(input: { matchAddress: string; takerAddress: string; quoteAddresses: string[]; inventoryAddresses: string[]; programId?: string | PublicKey }) {
  const programId = typeof input.programId === "string" ? new PublicKey(input.programId) : input.programId ?? PROGRAM_ID;
  const match = new PublicKey(input.matchAddress);
  return instruction(programId, RESOLVE_ROUND_DISCRIMINATOR, [
    { pubkey: match, isWritable: false, isSigner: false },
    { pubkey: runtimePda(input.matchAddress, programId), isWritable: true, isSigner: false },
    { pubkey: privateInventoryPda({ matchAddress: match, player: new PublicKey(input.takerAddress), programId }), isWritable: true, isSigner: false },
    ...input.quoteAddresses.map((address) => ({ pubkey: new PublicKey(address), isWritable: false, isSigner: false })),
    ...input.inventoryAddresses.map((address) => ({ pubkey: new PublicKey(address), isWritable: true, isSigner: false })),
  ]);
}

export function createSkipEmptyRoundInstruction(input: { matchAddress: string; programId?: string | PublicKey }) {
  const programId = typeof input.programId === "string" ? new PublicKey(input.programId) : input.programId ?? PROGRAM_ID;
  return instruction(programId, SKIP_EMPTY_ROUND_DISCRIMINATOR, [
    { pubkey: new PublicKey(input.matchAddress), isWritable: false, isSigner: false },
    { pubkey: runtimePda(input.matchAddress, programId), isWritable: true, isSigner: false },
  ]);
}

export function createAdvanceRoundInstruction(input: { matchAddress: string; programId?: string | PublicKey }) {
  const programId = typeof input.programId === "string" ? new PublicKey(input.programId) : input.programId ?? PROGRAM_ID;
  return instruction(programId, ADVANCE_ROUND_DISCRIMINATOR, [
    { pubkey: new PublicKey(input.matchAddress), isWritable: false, isSigner: false },
    { pubkey: runtimePda(input.matchAddress, programId), isWritable: true, isSigner: false },
  ]);
}

export const createNextRoundInstruction = createAdvanceRoundInstruction;

export function createFinalizeRuntimeInstruction(input: { matchAddress: string; inventoryAddresses: string[]; programId?: string | PublicKey }) {
  const programId = typeof input.programId === "string" ? new PublicKey(input.programId) : input.programId ?? PROGRAM_ID;
  return instruction(programId, FINALIZE_RUNTIME_DISCRIMINATOR, [
    { pubkey: new PublicKey(input.matchAddress), isWritable: false, isSigner: false },
    { pubkey: runtimePda(input.matchAddress, programId), isWritable: true, isSigner: false },
    ...input.inventoryAddresses.map((address) => ({ pubkey: new PublicKey(address), isWritable: false, isSigner: false })),
  ]);
}

export function createFinalizeMatchInstruction(input: { matchAddress: string; programId?: string | PublicKey }) {
  const programId = typeof input.programId === "string" ? new PublicKey(input.programId) : input.programId ?? PROGRAM_ID;
  return instruction(programId, FINALIZE_MATCH_DISCRIMINATOR, [
    { pubkey: new PublicKey(input.matchAddress), isWritable: true, isSigner: false },
    { pubkey: runtimePda(input.matchAddress, programId), isWritable: false, isSigner: false },
    { pubkey: resultPda(input.matchAddress, programId), isWritable: true, isSigner: false },
  ]);
}

export function createSettleMatchInstruction(input: { matchAddress: string; winnerAddress: string; programId?: string | PublicKey }) {
  const programId = typeof input.programId === "string" ? new PublicKey(input.programId) : input.programId ?? PROGRAM_ID;
  return instruction(programId, SETTLE_MATCH_DISCRIMINATOR, [
    { pubkey: new PublicKey(input.matchAddress), isWritable: false, isSigner: false },
    { pubkey: resultPda(input.matchAddress, programId), isWritable: true, isSigner: false },
    { pubkey: escrowPda(input.matchAddress, programId), isWritable: true, isSigner: false },
    { pubkey: new PublicKey(input.winnerAddress), isWritable: true, isSigner: false },
  ]);
}

async function authenticatedConnection(input: { baseRpcUrl: string; teeRpcUrl?: string; session: Keypair; programId: PublicKey }) {
  if (!input.teeRpcUrl) return { connection: createBaseRpcConnection(input.baseRpcUrl), feePayer: input.session };
  const session = input.session;
  const authenticated = await createPrivateConnection({
    teeRpcUrl: input.teeRpcUrl,
    publicKey: session.publicKey,
    signMessage: async (message) => nacl.sign.detached(message, session.secretKey),
  });
  const feePayer = teeFeePayerForRpc(input.teeRpcUrl, input.programId);
  if (!feePayer) throw new RfqSubmissionError("state", "tee_fee_payer_setup_required");
  return { connection: authenticated.connection, feePayer };
}

async function sendSessionTransaction(connection: Connection, session: Keypair, feePayer: Keypair, instructions: TransactionInstruction[]) {
  const blockhash = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({ feePayer: feePayer.publicKey, recentBlockhash: blockhash.blockhash }).add(...instructions);
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
  transaction.partialSign(feePayer);
  if (!feePayer.publicKey.equals(session.publicKey)) transaction.partialSign(session);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, maxRetries: 5 });
  const confirmation = await connection.confirmTransaction({ signature, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight }, "confirmed");
  if (confirmation.value.err) throw new RfqSubmissionError("confirmation", "session_transaction_failed", JSON.stringify(confirmation.value.err));
  return signature;
}

async function requestCrank(input: { operation: string; baseRpcUrl: string; programId: string; matchAddress: string; payload?: Record<string, unknown> }) {
  const relayUrl = (import.meta.env?.VITE_OUTCRY_RELAYER_URL || worldApiBaseUrl()).replace(/\/$/, "");
  let response: Response;
  try {
    response = await fetch(`${relayUrl}/v1/outcry/crank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: input.operation, baseRpcUrl: input.baseRpcUrl, programId: input.programId, matchAddress: input.matchAddress, ...input.payload }),
    });
  } catch {
    throw new RfqSubmissionError("relay", "permissionless_relayer_unreachable");
  }
  const body = await response.json().catch(() => ({})) as { signature?: string; applied?: boolean; error?: string; stage?: string };
  if (!response.ok || (!body.signature && body.applied !== true)) throw new RfqSubmissionError("relay", body.error ?? "permissionless_relayer_failed", body.stage);
  return body.signature ?? "applied";
}

export async function startMatchOnchain(input: { rpcUrl: string; matchAddress: string; hostAddress: string; roundCount?: number; programId: string; sessionKeypair?: Keypair }) {
  const session = input.sessionKeypair ?? sessionKeypairForMatch(input.matchAddress);
  const signature = await sendSessionTransaction(createBaseRpcConnection(input.rpcUrl), session, session, [createStartMatchInstruction({ matchAddress: input.matchAddress, hostAddress: input.hostAddress, sessionKey: session.publicKey, roundCount: input.roundCount, programId: input.programId })]);
  return { signature, sessionKey: session.publicKey.toBase58() };
}

export async function openRfqOnchain(input: {
  baseRpcUrl: string;
  teeRpcUrl?: string;
  matchAddress: string;
  matchId: string;
  sessionId: string;
  authorityAddress: string;
  programId: string;
  intent: TradeIntent;
  quoteWindowSeconds?: number;
  onProgress?: RfqProgress;
  sessionKeypair?: Keypair;
}) {
  const session = input.sessionKeypair ?? sessionKeypairForMatch(input.matchAddress);
  await validateOpenRfqSession({
    baseRpcUrl: input.baseRpcUrl,
    matchAddress: input.matchAddress,
    authorityAddress: input.authorityAddress,
    session,
    programId: new PublicKey(input.programId),
  });
  input.onProgress?.("Refreshing the sponsored Pyth push feed…");
  let oracleResponse: Response;
  try {
    oracleResponse = await fetch(`${worldApiBaseUrl()}/api/oracle/sol-usd-update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-outcry-session-id": input.sessionId,
        "x-outcry-match-id": input.matchId,
      },
    });
  } catch {
    throw new RfqSubmissionError("relay", "oracle_relayer_unreachable");
  }
  const oracleBody = await oracleResponse.json().catch(() => ({})) as { signature?: string; error?: string; stage?: string };
  if (!oracleResponse.ok || !oracleBody.signature) {
    throw new RfqSubmissionError("relay", oracleBody.error ?? "oracle_relayer_failed", oracleBody.stage);
  }
  input.onProgress?.("Submitting the RFQ through your authorized session…");
  const authenticated = await authenticatedConnection({ baseRpcUrl: input.baseRpcUrl, teeRpcUrl: input.teeRpcUrl, session, programId: new PublicKey(input.programId) });
  try {
    const signature = await sendSessionTransaction(authenticated.connection, session, authenticated.feePayer, [createOpenRfqInstruction({
      matchAddress: input.matchAddress,
      authorityAddress: input.authorityAddress,
      sessionKey: session.publicKey,
      side: input.intent.side,
      quantityLots: input.intent.quantity,
      quoteWindowSeconds: input.quoteWindowSeconds,
      programId: input.programId,
    })]);
    return { signature, sessionKey: session.publicKey.toBase58() };
  } catch (reason) {
    throw normalizeRfqError(reason);
  }
}

export async function submitPrivateQuoteOnchain(input: { baseRpcUrl: string; teeRpcUrl?: string; matchAddress: string; dealerAddress: string; priceE6: number; programId: string; sessionKeypair?: Keypair }) {
  const session = input.sessionKeypair ?? sessionKeypairForMatch(input.matchAddress);
  const authenticated = await authenticatedConnection({ baseRpcUrl: input.baseRpcUrl, teeRpcUrl: input.teeRpcUrl, session, programId: new PublicKey(input.programId) });
  const signature = await sendSessionTransaction(authenticated.connection, session, authenticated.feePayer, [createSubmitQuoteInstruction({
    matchAddress: input.matchAddress,
    authorityAddress: input.dealerAddress,
    sessionKey: session.publicKey,
    priceE6: input.priceE6,
    programId: input.programId,
  })]);
  return { signature, sessionKey: session.publicKey.toBase58() };
}

export async function resolveRoundOnchain(input: { baseRpcUrl: string; teeRpcUrl?: string; matchAddress: string; snapshot: PublicMatchSnapshot; programId: string }) {
  if (input.snapshot.roundStatus !== "OPEN") throw new Error("round_not_open");
  const dealers = input.snapshot.players.filter((player) => player !== input.snapshot.taker);
  const match = new PublicKey(input.matchAddress);
  const programId = new PublicKey(input.programId);
  const quoteAddresses = dealers.map((dealer) => privateQuotePda({ matchAddress: match, dealer: new PublicKey(dealer), programId }).toBase58());
  const inventories = input.snapshot.players.map((player) => privateInventoryPda({ matchAddress: match, player: new PublicKey(player), programId }).toBase58());
  return requestCrank({
    operation: "resolve_round",
    baseRpcUrl: input.baseRpcUrl,
    programId: input.programId,
    matchAddress: input.matchAddress,
    payload: { quoteAddresses, inventoryAddresses: inventories },
  });
}

export async function skipEmptyRoundOnchain(input: { baseRpcUrl: string; matchAddress: string; programId: string; snapshot: PublicMatchSnapshot }) {
  if (input.snapshot.roundStatus !== "OPEN" || input.snapshot.quoteCount !== 0) throw new Error("empty_round_required");
  return requestCrank({ operation: "skip_empty_round", baseRpcUrl: input.baseRpcUrl, programId: input.programId, matchAddress: input.matchAddress });
}

export async function resumeSkippedRoundOnchain(input: { baseRpcUrl: string; matchAddress: string; programId: string; snapshot: PublicMatchSnapshot }) {
  if (input.snapshot.roundStatus !== "SKIPPED") throw new Error("skipped_round_required");
  return requestCrank({ operation: "advance_round", baseRpcUrl: input.baseRpcUrl, programId: input.programId, matchAddress: input.matchAddress });
}

export async function settleMatchOnchain(input: { rpcUrl: string; matchAddress: string; resultAddress?: string; winnerAddress: string; programId: string }) {
  return requestCrank({ operation: "settle_match", baseRpcUrl: input.rpcUrl, programId: input.programId, matchAddress: input.matchAddress, payload: { winnerAddress: input.winnerAddress } });
}

export function createSessionSetupBundle(input: { matchAddress: string; authorityAddress: string; sessionKey?: PublicKey; programId?: string | PublicKey; expiresInSeconds?: number }) {
  const sessionKey = input.sessionKey ?? sessionKeypairForMatch(input.matchAddress).publicKey;
  return { sessionKey, sessionGrant: sessionGrantPda({ matchAddress: input.matchAddress, authorityAddress: input.authorityAddress, sessionKey, programId: typeof input.programId === "string" ? new PublicKey(input.programId) : input.programId }), instruction: createAuthorizeSessionInstruction({ ...input, sessionKey, expiresInSeconds: input.expiresInSeconds ?? DEFAULT_SESSION_DURATION_SECONDS }) };
}

export const createInitializeOracleInstructionForDefaultFeed = (input: { authorityAddress: string; priceFeedAddress?: string; programId?: string | PublicKey }) => createInitializeOracleInstruction({ ...input, feedId: Uint8Array.from("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d".match(/../g)!.map((byte) => Number.parseInt(byte, 16))) });

export { escrowPda, oraclePda, resultPda, runtimePda };
