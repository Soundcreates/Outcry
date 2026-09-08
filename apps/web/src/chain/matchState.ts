import { Connection, PublicKey } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import outcryIdl from "./idl/outcry.json";
import { createBaseRpcConnection } from "./baseRpc";

const MATCH_DISCRIMINATOR = Uint8Array.from(outcryIdl.accounts.find((account) => account.name === "Match")?.discriminator ?? []);
const ROUND_DISCRIMINATOR = Uint8Array.from(outcryIdl.accounts.find((account) => account.name === "RfqRound")?.discriminator ?? []);
const RESULT_DISCRIMINATOR = Uint8Array.from(outcryIdl.accounts.find((account) => account.name === "MatchResult")?.discriminator ?? []);
const PROGRAM_ID = new PublicKey(outcryIdl.address);
const MAX_PLAYERS = 4;
const MAX_ROUNDS = 8;
const LEGACY_MATCH_BYTES = 372;
const CURRENT_MATCH_BYTES = 373;
export const MATCH_STATE_TIMEOUT_MS = 8_000;
export const ORACLE_FEED_ID = Uint8Array.from("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d".match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
export const ORACLE_FEED_ID_HEX = Array.from(ORACLE_FEED_ID, (byte) => byte.toString(16).padStart(2, "0")).join("");

export type PublicMatchSnapshot = {
  matchAddress: string;
  accountOwner?: string;
  roundOwner?: string;
  /** Base is durable state; TEE is authoritative while a match is delegated. */
  stateSource?: "base" | "tee" | "tee-unavailable";
  authority: string;
  pit: string;
  matchNonce: bigint;
  host?: string;
  resultAddress?: string;
  status: "WAITING" | "STARTED" | "FINISHED";
  capacity: number;
  playerCount: number;
  currentRound: number;
  players: string[];
  taker?: string;
  side?: "BUY" | "SELL";
  quantityLots?: number;
  roundStatus?: "PREPARED" | "OPEN" | "RESOLVED" | "SKIPPED";
  oraclePriceE6?: number;
  quoteCount: number;
  dealerCount: number;
  deadlineAt?: number;
  winner?: string;
  finalScoresE6?: number[];
  settled: boolean;
};

function sameBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isDefaultKey(bytes: Uint8Array) {
  return bytes.every((value) => value === 0);
}

function keyAt(data: Uint8Array, offset: number) {
  return new PublicKey(data.slice(offset, offset + 32));
}

function readU64(data: Uint8Array, offset: number) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

function readI64(data: Uint8Array, offset: number) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(offset, true);
}

function assertAccount(data: Uint8Array, discriminator: Uint8Array, minimumLength: number, label: string) {
  if (data.length < minimumLength || !sameBytes(data.slice(0, 8), discriminator)) throw new Error(`${label}_account_invalid`);
}

function assertMatchAccount(data: Uint8Array) {
  if ((data.length !== LEGACY_MATCH_BYTES && data.length !== CURRENT_MATCH_BYTES) || !sameBytes(data.slice(0, 8), MATCH_DISCRIMINATOR)) {
    throw new Error("match_account_invalid");
  }
}

function readWithTimeout<T>(operation: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("match_state_rpc_timeout")), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function decodePublicMatchAccount(matchAddress: string, data: Uint8Array): PublicMatchSnapshot {
  const isCurrentLayout = data.length === CURRENT_MATCH_BYTES;
  assertMatchAccount(data);
  const status = data[80];
  if (status !== 0 && status !== 1 && status !== 2) throw new Error("match_status_invalid");
  const capacity = data[81];
  if (capacity < 1 || capacity > MAX_PLAYERS) throw new Error("match_capacity_invalid");
  const playerCount = Math.min(data[82], MAX_PLAYERS);
  if (playerCount > capacity) throw new Error("match_player_count_invalid");
  const authority = keyAt(data, 8);
  const pit = keyAt(data, 40);
  const matchNonce = readU64(data, 72);
  if (authority.equals(PublicKey.default)) throw new Error("match_authority_invalid");
  const playersOffset = isCurrentLayout ? 84 : 83;
  const playerKeys = Array.from({ length: playerCount }, (_, index) => keyAt(data, playersOffset + index * 32));
  if (playerKeys.some((player) => player.equals(PublicKey.default))) throw new Error("match_player_key_invalid");
  const snapshot: PublicMatchSnapshot = {
    matchAddress,
    authority: authority.toBase58(),
    pit: pit.toBase58(),
    matchNonce,
    status: status === 0 ? "WAITING" : status === 1 ? "STARTED" : "FINISHED",
    capacity,
    playerCount,
    currentRound: isCurrentLayout ? Math.min(data[83], MAX_ROUNDS - 1) : 0,
    players: playerKeys.map((player) => player.toBase58()),
    quoteCount: 0,
    dealerCount: Math.max(playerCount - 1, 0),
    settled: false,
  };
  if (snapshot.status === "STARTED" && snapshot.playerCount > 0) {
    snapshot.host = snapshot.players[0];
    snapshot.taker = snapshot.players[snapshot.currentRound % snapshot.playerCount];
  } else if (snapshot.playerCount > 0) {
    snapshot.host = snapshot.players[0];
  }
  return snapshot;
}

function decodeRound(snapshot: PublicMatchSnapshot, data: Uint8Array) {
  assertAccount(data, ROUND_DISCRIMINATOR, 181, "round");
  if (!keyAt(data, 8).equals(new PublicKey(snapshot.matchAddress)) || data[40] !== snapshot.currentRound) throw new Error("round_match_mismatch");
  const side = data[73];
  if (side !== 0 && side !== 1) throw new Error("round_side_invalid");
  const roundStatus = data[99];
  if (roundStatus !== 0 && roundStatus !== 1 && roundStatus !== 2 && roundStatus !== 3) throw new Error("round_status_invalid");
  const quantityLots = Number(readU64(data, 74));
  const taker = keyAt(data, 41);
  if (!snapshot.players.includes(taker.toBase58())) throw new Error("round_taker_invalid");
  snapshot.taker = taker.toBase58();
  if (quantityLots === 0) {
    const isPrepared = roundStatus === 2;
    const isLegacyPrepared = roundStatus === 0
      && readI64(data, 82) === 0n
      && readI64(data, 90) === 0n
      && data[98] === 0
      && isDefaultKey(data.slice(100, 132))
      && readI64(data, 132) === 0n
      && isDefaultKey(data.slice(140, 172))
      && readI64(data, 172) === 0n;
    if (!isPrepared && !isLegacyPrepared) throw new Error("round_quantity_invalid");
    snapshot.roundStatus = "PREPARED";
    return;
  }
  if (![1, 2, 5].includes(quantityLots) || roundStatus === 2) throw new Error("round_quantity_invalid");
  snapshot.side = side === 0 ? "BUY" : "SELL";
  snapshot.quantityLots = quantityLots;
  snapshot.roundStatus = roundStatus === 0 ? "OPEN" : roundStatus === 1 ? "RESOLVED" : "SKIPPED";
  snapshot.quoteCount = Math.min(data[98], snapshot.dealerCount);
  snapshot.deadlineAt = Number(readI64(data, 90)) * 1000;
  const oraclePriceE6 = Number(readI64(data, 132));
  if (!Number.isSafeInteger(oraclePriceE6) || oraclePriceE6 <= 0) throw new Error("round_oracle_price_invalid");
  snapshot.oraclePriceE6 = oraclePriceE6;
}

function decodeResult(snapshot: PublicMatchSnapshot, data: Uint8Array) {
  assertAccount(data, RESULT_DISCRIMINATOR, 114, "result");
  if (!keyAt(data, 8).equals(new PublicKey(snapshot.matchAddress))) throw new Error("result_match_mismatch");
  const winner = keyAt(data, 40);
  if (!winner.equals(PublicKey.default) && !snapshot.players.includes(winner.toBase58())) throw new Error("result_winner_invalid");
  snapshot.winner = winner.equals(PublicKey.default) ? undefined : winner.toBase58();
  snapshot.finalScoresE6 = Array.from({ length: MAX_PLAYERS }, (_, index) => Number(readI64(data, 72 + index * 8)));
  if (data[112] !== 0 && data[112] !== 1) throw new Error("result_settled_invalid");
  snapshot.settled = data[112] === 1;
}

export async function loadPublicMatchState(input: {
  rpcUrl: string;
  matchAddress: string;
  programId?: string;
  connection?: Connection;
  timeoutMs?: number;
}): Promise<PublicMatchSnapshot> {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  const match = new PublicKey(input.matchAddress);
  const connection = input.connection ?? createBaseRpcConnection(input.rpcUrl);
  const timeoutMs = input.timeoutMs ?? MATCH_STATE_TIMEOUT_MS;
  const matchInfo = await readWithTimeout(connection.getAccountInfo(match, "confirmed"), timeoutMs);
  const matchOwnerIsValid = matchInfo?.owner.equals(programId) || matchInfo?.owner.equals(DELEGATION_PROGRAM_ID);
  if (!matchInfo || !matchOwnerIsValid) throw new Error("match_account_unavailable");
  const snapshot = decodePublicMatchAccount(match.toBase58(), matchInfo.data);
  snapshot.accountOwner = matchInfo.owner.toBase58();

  const resultKey = keyAt(matchInfo.data, matchInfo.data.length === CURRENT_MATCH_BYTES ? 340 : 339);
  const roundKey = snapshot.status === "STARTED"
    ? PublicKey.findProgramAddressSync(
      [new TextEncoder().encode("round"), match.toBytes(), Uint8Array.of(snapshot.currentRound)],
      programId,
    )[0]
    : undefined;
  const relatedKeys = [roundKey, isDefaultKey(resultKey.toBytes()) ? undefined : resultKey].filter(
    (key): key is PublicKey => Boolean(key),
  );
  const relatedAccounts = relatedKeys.length > 0
    ? await readWithTimeout(connection.getMultipleAccountsInfo(relatedKeys, "confirmed"), timeoutMs)
    : [];

  if (snapshot.status === "STARTED") {
    const roundInfo = relatedAccounts[roundKey ? relatedKeys.indexOf(roundKey) : -1];
    if (roundInfo && (roundInfo.owner.equals(programId) || roundInfo.owner.equals(DELEGATION_PROGRAM_ID))) {
      snapshot.roundOwner = roundInfo.owner.toBase58();
      decodeRound(snapshot, roundInfo.data);
    }
  }

  if (!isDefaultKey(resultKey.toBytes())) {
    snapshot.resultAddress = resultKey.toBase58();
    const resultInfo = relatedAccounts[relatedKeys.indexOf(resultKey)];
    if (resultInfo && (resultInfo.owner.equals(programId) || resultInfo.owner.equals(DELEGATION_PROGRAM_ID))) decodeResult(snapshot, resultInfo.data);
  }
  return snapshot;
}

/** Reads durable ownership from Base, then live public Match/RfqRound state from TEE. */
export async function loadRuntimeMatchState(input: {
  rpcUrl: string;
  matchAddress: string;
  programId?: string;
  baseConnection?: Connection;
  teeConnection?: Connection;
  timeoutMs?: number;
}): Promise<PublicMatchSnapshot> {
  const base = await loadPublicMatchState({
    rpcUrl: input.rpcUrl,
    matchAddress: input.matchAddress,
    programId: input.programId,
    connection: input.baseConnection,
    timeoutMs: input.timeoutMs,
  });
  // RFQ execution delegates the Round account while Match remains on Base.
  if (base.roundOwner !== DELEGATION_PROGRAM_ID.toBase58()) return { ...base, stateSource: "base" };
  if (!input.teeConnection) return { ...base, stateSource: "tee-unavailable" };

  try {
    const tee = await loadPublicMatchState({
      rpcUrl: input.rpcUrl,
      matchAddress: input.matchAddress,
      programId: input.programId,
      connection: input.teeConnection,
      timeoutMs: input.timeoutMs,
    });
    // Base ownership is the durable delegation signal; TEE supplies live values.
    return { ...tee, accountOwner: base.accountOwner, stateSource: "tee" };
  } catch {
    return { ...base, stateSource: "tee-unavailable" };
  }
}

export function oraclePda(programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("oracle"), ORACLE_FEED_ID], programId)[0];
}

export function resultPda(matchAddress: string, programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("result"), new PublicKey(matchAddress).toBytes()],
    programId,
  )[0];
}

export function escrowPda(matchAddress: string, programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("escrow"), new PublicKey(matchAddress).toBytes()],
    programId,
  )[0];
}

export function roundPda(matchAddress: string, round: number, programId = PROGRAM_ID) {
  if (!Number.isInteger(round) || round < 0 || round >= MAX_ROUNDS) throw new Error("invalid_round");
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("round"), new PublicKey(matchAddress).toBytes(), Uint8Array.of(round)],
    programId,
  )[0];
}
