import { Connection, PublicKey } from "@solana/web3.js";
import outcryIdl from "./idl/outcry.json";

const MATCH_DISCRIMINATOR = Uint8Array.from(outcryIdl.accounts.find((account) => account.name === "Match")?.discriminator ?? []);
const ROUND_DISCRIMINATOR = Uint8Array.from(outcryIdl.accounts.find((account) => account.name === "RfqRound")?.discriminator ?? []);
const RESULT_DISCRIMINATOR = Uint8Array.from(outcryIdl.accounts.find((account) => account.name === "MatchResult")?.discriminator ?? []);
const PROGRAM_ID = new PublicKey(outcryIdl.address);
const MAX_PLAYERS = 4;
const MAX_ROUNDS = 8;
const LEGACY_MATCH_BYTES = 372;
const CURRENT_MATCH_BYTES = 373;
const ORACLE_FEED_ID = Uint8Array.from("c6ad3e841d9c0f248adff90cf776f839fd59f1cbd8ffbc8f9402883ea16e8420".match(/../g)!.map((byte) => Number.parseInt(byte, 16)));

export type PublicMatchSnapshot = {
  matchAddress: string;
  resultAddress?: string;
  status: "WAITING" | "STARTED" | "FINISHED";
  capacity: number;
  playerCount: number;
  currentRound: number;
  players: string[];
  taker?: string;
  side?: "BUY" | "SELL";
  quantityLots?: number;
  roundStatus?: "OPEN" | "RESOLVED";
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

export function decodePublicMatchAccount(matchAddress: string, data: Uint8Array): PublicMatchSnapshot {
  const isCurrentLayout = data.length === CURRENT_MATCH_BYTES;
  assertMatchAccount(data);
  const status = data[80];
  if (status !== 0 && status !== 1 && status !== 2) throw new Error("match_status_invalid");
  const capacity = data[81];
  if (capacity < 1 || capacity > MAX_PLAYERS) throw new Error("match_capacity_invalid");
  const playerCount = Math.min(data[82], MAX_PLAYERS);
  if (playerCount > capacity) throw new Error("match_player_count_invalid");
  const playersOffset = isCurrentLayout ? 84 : 83;
  const playerKeys = Array.from({ length: playerCount }, (_, index) => keyAt(data, playersOffset + index * 32));
  if (playerKeys.some((player) => player.equals(PublicKey.default))) throw new Error("match_player_key_invalid");
  return {
    matchAddress,
    status: status === 0 ? "WAITING" : status === 1 ? "STARTED" : "FINISHED",
    capacity,
    playerCount,
    currentRound: isCurrentLayout ? Math.min(data[83], MAX_ROUNDS - 1) : 0,
    players: playerKeys.map((player) => player.toBase58()),
    quoteCount: 0,
    dealerCount: Math.max(playerCount - 1, 0),
    settled: false,
  };
}

function decodeRound(snapshot: PublicMatchSnapshot, data: Uint8Array) {
  assertAccount(data, ROUND_DISCRIMINATOR, 181, "round");
  if (!keyAt(data, 8).equals(new PublicKey(snapshot.matchAddress)) || data[40] !== snapshot.currentRound) throw new Error("round_match_mismatch");
  const side = data[73];
  if (side !== 0 && side !== 1) throw new Error("round_side_invalid");
  const quantityLots = Number(readU64(data, 74));
  if (![1, 2, 5].includes(quantityLots)) throw new Error("round_quantity_invalid");
  const roundStatus = data[99];
  if (roundStatus !== 0 && roundStatus !== 1) throw new Error("round_status_invalid");
  const taker = keyAt(data, 41);
  if (!snapshot.players.includes(taker.toBase58())) throw new Error("round_taker_invalid");
  snapshot.taker = taker.toBase58();
  snapshot.side = side === 0 ? "BUY" : "SELL";
  snapshot.quantityLots = quantityLots;
  snapshot.roundStatus = roundStatus === 0 ? "OPEN" : "RESOLVED";
  snapshot.quoteCount = Math.min(data[98], snapshot.dealerCount);
  snapshot.deadlineAt = Number(readI64(data, 90)) * 1000;
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
}): Promise<PublicMatchSnapshot> {
  const programId = new PublicKey(input.programId ?? PROGRAM_ID);
  const match = new PublicKey(input.matchAddress);
  const connection = new Connection(input.rpcUrl, "confirmed");
  const matchInfo = await connection.getAccountInfo(match, "confirmed");
  if (!matchInfo || !matchInfo.owner.equals(programId)) throw new Error("match_account_unavailable");
  const snapshot = decodePublicMatchAccount(match.toBase58(), matchInfo.data);

  if (snapshot.status === "STARTED") {
    const [round] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode("round"), match.toBytes(), Uint8Array.of(snapshot.currentRound)],
      programId,
    );
    const roundInfo = await connection.getAccountInfo(round, "confirmed");
    if (roundInfo && roundInfo.owner.equals(programId)) decodeRound(snapshot, roundInfo.data);
  }

  const resultKey = keyAt(matchInfo.data, matchInfo.data.length === CURRENT_MATCH_BYTES ? 340 : 339);
  if (!isDefaultKey(resultKey.toBytes())) {
    snapshot.resultAddress = resultKey.toBase58();
    const resultInfo = await connection.getAccountInfo(resultKey, "confirmed");
    if (resultInfo && resultInfo.owner.equals(programId)) decodeResult(snapshot, resultInfo.data);
  }
  return snapshot;
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
