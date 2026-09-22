import { Connection, PublicKey } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import outcryIdl from "./idl/outcry.json";
import { createBaseRpcConnection } from "./baseRpc";

const bytes = (name: string) => Uint8Array.from(outcryIdl.accounts.find((account) => account.name === name)?.discriminator ?? []);
const MATCH_DISCRIMINATOR = bytes("MatchV2");
const RUNTIME_DISCRIMINATOR = bytes("MatchRuntime");
const RESULT_DISCRIMINATOR = bytes("MatchResult");
const PROGRAM_ID = new PublicKey(outcryIdl.address);
const MAX_PLAYERS = 4;
export const MAX_ROUNDS = 8;
export const MATCH_V2_BYTES = 205;
export const MATCH_STATE_TIMEOUT_MS = 8_000;
export const ORACLE_FEED_ID = Uint8Array.from("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d".match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
export const ORACLE_FEED_ID_HEX = Array.from(ORACLE_FEED_ID, (byte) => byte.toString(16).padStart(2, "0")).join("");
export const PYTH_SOL_USD_PUSH_FEED_ADDRESS = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
export const PYTH_SOL_USD_PUSH_FEED = new PublicKey(PYTH_SOL_USD_PUSH_FEED_ADDRESS);

type RoundStatus = "PREPARED" | "OPEN" | "RESOLVED" | "SKIPPED";

export type PublicResolvedRound = {
  round: number;
  taker: string;
  side: "BUY" | "SELL";
  quantityLots: number;
  winningDealer: string;
  clearingPriceE6: bigint;
  notionalE6: bigint;
};

export type PublicMatchSnapshot = {
  matchAddress: string;
  accountOwner?: string;
  roundOwner?: string;
  stateSource?: "base" | "tee" | "tee-unavailable";
  authority: string;
  pit: string;
  /** V2 Match accounts are nonce-free; callers should retain the bootstrap nonce separately. */
  matchNonce: bigint;
  host?: string;
  resultAddress?: string;
  status: "WAITING" | "STARTED" | "FINISHED";
  capacity: number;
  playerCount: number;
  currentRound: number;
  roundCount: number;
  lastResolvedRound?: number;
  lastRoundWinner?: string;
  lastRoundResult?: PublicResolvedRound;
  players: string[];
  taker?: string;
  side?: "BUY" | "SELL";
  quantityLots?: number;
  roundStatus?: RoundStatus;
  oraclePriceE6?: number;
  quoteCount: number;
  dealerCount: number;
  deadlineAt?: number;
  winner?: string;
  finalScoresE6?: number[];
  settled: boolean;
};

export function currentRoundTaker(
  snapshot: Pick<PublicMatchSnapshot, "authority" | "host" | "players" | "currentRound" | "taker">,
) {
  if (snapshot.taker) return snapshot.taker;
  if (snapshot.players.length === 0) return undefined;
  const hostIndex = snapshot.players.indexOf(snapshot.host ?? snapshot.authority);
  if (hostIndex < 0) return undefined;
  return snapshot.players[(hostIndex + snapshot.currentRound) % snapshot.players.length];
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isDefaultKey(key: PublicKey) {
  return key.equals(PublicKey.default);
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

function assertAccount(data: Uint8Array, discriminator: Uint8Array, length: number, label: string) {
  if (data.length !== length || !sameBytes(data.slice(0, 8), discriminator)) throw new Error(`${label}_account_invalid`);
}

function assertOwner(owner: PublicKey, programId: PublicKey) {
  if (!owner.equals(programId) && !owner.equals(DELEGATION_PROGRAM_ID)) throw new Error("account_program_mismatch");
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
  assertAccount(data, MATCH_DISCRIMINATOR, MATCH_V2_BYTES, "match");
  const status = data[72];
  if (status > 2) throw new Error("match_status_invalid");
  const capacity = data[73];
  const playerCount = data[74];
  const roundCount = data[75];
  if (capacity < 1 || capacity > MAX_PLAYERS) throw new Error("match_capacity_invalid");
  if (playerCount > capacity || playerCount > MAX_PLAYERS) throw new Error("match_player_count_invalid");
  if (roundCount < 1 || roundCount > MAX_ROUNDS) throw new Error("match_round_count_invalid");
  const authority = keyAt(data, 8);
  const pit = keyAt(data, 40);
  const players = Array.from({ length: playerCount }, (_, index) => keyAt(data, 76 + index * 32));
  if (authority.equals(PublicKey.default) || pit.equals(PublicKey.default) || players.some(isDefaultKey)) throw new Error("match_key_invalid");
  return {
    matchAddress,
    authority: authority.toBase58(),
    pit: pit.toBase58(),
    matchNonce: 0n,
    host: authority.toBase58(),
    status: status === 0 ? "WAITING" : status === 1 ? "STARTED" : "FINISHED",
    capacity,
    playerCount,
    currentRound: 0,
    roundCount,
    players: players.map((player) => player.toBase58()),
    quoteCount: 0,
    dealerCount: Math.max(playerCount - 1, 0),
    settled: false,
  };
}

function applyRuntime(snapshot: PublicMatchSnapshot, data: Uint8Array, owner: PublicKey) {
  assertAccount(data, RUNTIME_DISCRIMINATOR, 286, "runtime");
  if (!keyAt(data, 8).equals(new PublicKey(snapshot.matchAddress))) throw new Error("runtime_match_mismatch");
  const round = data[40];
  if (round >= snapshot.roundCount) throw new Error("runtime_round_invalid");
  const taker = keyAt(data, 41);
  const side = data[73];
  const quantityLots = Number(readU64(data, 74));
  const status = data[99];
  if (side > 1) throw new Error("runtime_side_invalid");
  if (![0, 1, 3, 4, 5].includes(status)) throw new Error("runtime_status_invalid");
  if (status === 0 || status === 1) {
    if (taker.equals(PublicKey.default) || !snapshot.players.includes(taker.toBase58())) throw new Error("runtime_taker_invalid");
    if (![1, 2, 5].includes(quantityLots)) throw new Error("runtime_quantity_invalid");
    snapshot.taker = taker.toBase58();
    snapshot.side = side === 0 ? "BUY" : "SELL";
    snapshot.quantityLots = quantityLots;
    snapshot.oraclePriceE6 = Number(readI64(data, 132));
    if (!Number.isSafeInteger(snapshot.oraclePriceE6) || snapshot.oraclePriceE6 <= 0) throw new Error("runtime_oracle_price_invalid");
  }
  snapshot.currentRound = round;
  snapshot.quoteCount = Math.min(data[98], snapshot.dealerCount);
  snapshot.deadlineAt = Number(readI64(data, 90)) * 1000 || undefined;
  snapshot.roundStatus = status === 0 ? "OPEN" : status === 1 ? "RESOLVED" : status === 3 ? "SKIPPED" : status === 4 ? "PREPARED" : undefined;
  snapshot.roundOwner = owner.toBase58();
  const lastResolvedRound = data[180];
  const lastWinner = keyAt(data, 181);
  if (lastResolvedRound !== 255 && !lastWinner.equals(PublicKey.default)) {
    snapshot.lastResolvedRound = lastResolvedRound;
    snapshot.lastRoundWinner = lastWinner.toBase58();
  }
  if ((status === 1 || status === 5) && snapshot.lastResolvedRound !== undefined && !isDefaultKey(lastWinner)) {
    const clearingPriceE6 = readI64(data, 172);
    if (clearingPriceE6 > 0n && snapshot.taker && snapshot.side && snapshot.quantityLots) {
      snapshot.lastRoundResult = {
        round: snapshot.lastResolvedRound,
        taker: snapshot.taker,
        side: snapshot.side,
        quantityLots: snapshot.quantityLots,
        winningDealer: lastWinner.toBase58(),
        clearingPriceE6,
        notionalE6: BigInt(snapshot.quantityLots) * clearingPriceE6,
      };
    }
  }
  const winner = keyAt(data, 221);
  if (!winner.equals(PublicKey.default)) {
    if (!snapshot.players.includes(winner.toBase58())) throw new Error("runtime_winner_invalid");
    snapshot.winner = winner.toBase58();
  }
  if (status === 5) snapshot.finalScoresE6 = Array.from({ length: MAX_PLAYERS }, (_, index) => Number(readI64(data, 253 + index * 8)));
}

function applyResult(snapshot: PublicMatchSnapshot, data: Uint8Array) {
  assertAccount(data, RESULT_DISCRIMINATOR, 114, "result");
  if (!keyAt(data, 8).equals(new PublicKey(snapshot.matchAddress))) throw new Error("result_match_mismatch");
  const winner = keyAt(data, 40);
  if (!winner.equals(PublicKey.default) && !snapshot.players.includes(winner.toBase58())) throw new Error("result_winner_invalid");
  snapshot.resultAddress = resultPda(snapshot.matchAddress).toBase58();
  snapshot.winner = winner.equals(PublicKey.default) ? undefined : winner.toBase58();
  snapshot.finalScoresE6 = Array.from({ length: MAX_PLAYERS }, (_, index) => Number(readI64(data, 72 + index * 8)));
  const settled = data[112];
  if (settled !== 0 && settled !== 1) throw new Error("result_settled_invalid");
  snapshot.settled = settled === 1;
}

async function loadSnapshotFromConnection(connection: Connection, match: PublicKey, programId: PublicKey, timeoutMs: number) {
  const matchInfo = await readWithTimeout(connection.getAccountInfo(match, "confirmed"), timeoutMs);
  if (!matchInfo) throw new Error("match_account_unavailable");
  assertOwner(matchInfo.owner, programId);
  const snapshot = decodePublicMatchAccount(match.toBase58(), matchInfo.data);
  snapshot.accountOwner = matchInfo.owner.toBase58();
  const runtime = runtimePda(match.toBase58(), programId);
  const result = resultPda(match.toBase58(), programId);
  const [runtimeInfo, resultInfo] = await readWithTimeout(connection.getMultipleAccountsInfo([runtime, result], "confirmed"), timeoutMs);
  if (runtimeInfo) {
    assertOwner(runtimeInfo.owner, programId);
    applyRuntime(snapshot, runtimeInfo.data, runtimeInfo.owner);
  }
  if (resultInfo) {
    assertOwner(resultInfo.owner, programId);
    applyResult(snapshot, resultInfo.data);
  } else {
    snapshot.resultAddress = result.toBase58();
  }
  return snapshot;
}

export async function loadPublicMatchState(input: {
  rpcUrl: string;
  matchAddress: string;
  programId?: string;
  connection?: Connection;
  timeoutMs?: number;
}): Promise<PublicMatchSnapshot> {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  const connection = input.connection ?? createBaseRpcConnection(input.rpcUrl);
  return loadSnapshotFromConnection(connection, new PublicKey(input.matchAddress), programId, input.timeoutMs ?? MATCH_STATE_TIMEOUT_MS);
}

/** Base owns MatchV2; a delegated MatchRuntime is read from the caller-supplied ER connection. */
export async function loadRuntimeMatchState(input: {
  rpcUrl: string;
  matchAddress: string;
  programId?: string;
  baseConnection?: Connection;
  teeConnection?: Connection;
  timeoutMs?: number;
}): Promise<PublicMatchSnapshot> {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  const baseConnection = input.baseConnection ?? createBaseRpcConnection(input.rpcUrl);
  const timeoutMs = input.timeoutMs ?? MATCH_STATE_TIMEOUT_MS;
  const base = await loadSnapshotFromConnection(baseConnection, new PublicKey(input.matchAddress), programId, timeoutMs);
  const runtimeAddress = runtimePda(input.matchAddress, programId);
  const baseRuntime = await readWithTimeout(baseConnection.getAccountInfo(runtimeAddress, "confirmed"), timeoutMs);
  if (!baseRuntime || !baseRuntime.owner.equals(DELEGATION_PROGRAM_ID)) return { ...base, stateSource: "base" };
  if (!input.teeConnection) return { ...base, stateSource: "tee-unavailable" };
  try {
    const teeRuntime = await readWithTimeout(input.teeConnection.getAccountInfo(runtimeAddress, "confirmed"), timeoutMs);
    if (!teeRuntime) return { ...base, stateSource: "tee-unavailable" };
    const live = { ...base };
    applyRuntime(live, teeRuntime.data, teeRuntime.owner);
    return { ...live, accountOwner: base.accountOwner, stateSource: "tee" };
  } catch {
    return { ...base, stateSource: "tee-unavailable" };
  }
}

export function oraclePda(programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("oracle"), ORACLE_FEED_ID], programId)[0];
}

export function runtimePda(matchAddress: string, programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("runtime"), new PublicKey(matchAddress).toBytes()], programId)[0];
}

export function resultPda(matchAddress: string, programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("result"), new PublicKey(matchAddress).toBytes()], programId)[0];
}

export function escrowPda(matchAddress: string, programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("escrow"), new PublicKey(matchAddress).toBytes()], programId)[0];
}
