import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { SolanaMatchMembershipReader } from "../apps/world-server/src/chain/match-membership.ts";
import { WorldRoom } from "../apps/world-server/src/world/WorldRoom.ts";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const rpcUrl = "http://127.0.0.1:8899";
const programSo = resolve("target/deploy/outcry.so");
const idlPath = resolve("target/idl/outcry.json");
const systemProgram = SystemProgram.programId;

const idl = JSON.parse(await readFile(idlPath, "utf8"));
const programId = new PublicKey(idl.address);
const instruction = (name) => {
  const value = idl.instructions.find((entry) => entry.name === name);
  assert.ok(value, `missing IDL instruction: ${name}`);
  return Buffer.from(value.discriminator);
};

const encodeU64 = (value) => {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64LE(BigInt(value));
  return encoded;
};

const encodeU8 = (value) => Buffer.from([value]);
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });

function createInstruction(name, keys, args = []) {
  return new TransactionInstruction({
    programId,
    keys,
    data: Buffer.concat([instruction(name), ...args]),
  });
}

function initializePitInstruction(pit, authority, pitId, capacity) {
  return createInstruction("initialize_pit", [
    meta(pit, true),
    meta(authority, true, true),
    meta(systemProgram),
  ], [pitId, encodeU8(capacity)]);
}

function createMatchInstruction(pit, matchState, authority, nonce) {
  return createInstruction("create_match", [
    meta(pit, true),
    meta(matchState, true),
    meta(authority, true, true),
    meta(systemProgram),
  ], [encodeU64(nonce)]);
}

function joinInstruction(matchState, player, seatIndex) {
  return createInstruction("join_match", [
    meta(matchState, true),
    meta(player, false, true),
  ], [encodeU8(seatIndex)]);
}

function startInstruction(matchState, authority) {
  return createInstruction("start_match", [
    meta(matchState, true),
    meta(authority, false, true),
  ]);
}

function resultInstruction(matchState, result, authority) {
  return createInstruction("initialize_match_result", [
    meta(matchState, true),
    meta(result, true),
    meta(authority, true, true),
    meta(systemProgram),
  ]);
}

async function waitForRpc(connection, validator) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await connection.getVersion();
      return;
    } catch {
      if (validator.exitCode !== null) throw new Error("local validator exited before RPC became ready");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  throw new Error("local validator RPC did not become ready within 15 seconds");
}

async function airdrop(connection, keypair) {
  const signature = await connection.requestAirdrop(keypair.publicKey, 2 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(signature, "confirmed");
}

async function buildTransaction(connection, instructions, feePayer) {
  const transaction = new Transaction().add(...instructions);
  transaction.feePayer = feePayer.publicKey;
  const blockhash = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash.blockhash;
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
  return transaction;
}

async function submit(connection, label, instructions, signers, expectSuccess = true) {
  const transaction = await buildTransaction(connection, instructions, signers[0]);
  const simulation = await connection.simulateTransaction(transaction, signers);
  const failed = simulation.value.err !== null;
  if (!expectSuccess) {
    assert.equal(failed, true, `${label} unexpectedly simulated successfully`);
    console.log(`localnet: ${label} rejected as expected`);
    return;
  }
  assert.equal(failed, false, `${label} simulation failed: ${JSON.stringify(simulation.value.err)}`);
  await sendAndConfirmTransaction(connection, transaction, signers, { commitment: "confirmed" });
  console.log(`localnet: ${label} committed`);
}

function pitIdBytes(value) {
  const bytes = Buffer.alloc(32);
  Buffer.from(value, "utf8").copy(bytes);
  return bytes;
}

function readMatchAccount(account) {
  assert.ok(account, "match account missing");
  assert.equal(account.owner.toBase58(), programId.toBase58());
  const data = account.data;
  assert.equal(data.length, 372);
  return {
    status: data.readUInt8(80),
    capacity: data.readUInt8(81),
    playerCount: data.readUInt8(82),
    players: Array.from({ length: 4 }, (_, index) => new PublicKey(data.subarray(83 + index * 32, 115 + index * 32))),
  };
}

const ledger = await mkdtemp(join(tmpdir(), "outcry-phase5-"));
const validator = spawn("solana-test-validator", [
  "--reset",
  "--quiet",
  "--ledger",
  ledger,
  "--rpc-port",
  "8899",
  "--faucet-port",
  "9900",
  "--bpf-program",
  programId.toBase58(),
  programSo,
], { stdio: ["ignore", "ignore", "pipe"] });
let validatorError = "";
validator.stderr.on("data", (chunk) => {
  validatorError += chunk.toString();
});

const connection = new Connection(rpcUrl, "confirmed");
let worldRoom;
let restartedWorldRoom;
const previousChainEnv = {
  NEXT_PUBLIC_SOLANA_RPC: process.env.NEXT_PUBLIC_SOLANA_RPC,
  OUTCRY_PROGRAM_ID: process.env.OUTCRY_PROGRAM_ID,
  OUTCRY_MATCH_ADDRESS: process.env.OUTCRY_MATCH_ADDRESS,
};
try {
  await waitForRpc(connection, validator);
  const authority = Keypair.generate();
  const players = Array.from({ length: 5 }, () => Keypair.generate());
  await Promise.all([authority, ...players].map((keypair) => airdrop(connection, keypair)));

  const pitId = pitIdBytes("wall-street-01");
  const nonce = 42n;
  const [pit] = PublicKey.findProgramAddressSync([Buffer.from("pit"), pitId], programId);
  const nonceBytes = encodeU64(nonce);
  const [matchState] = PublicKey.findProgramAddressSync([Buffer.from("match"), pit.toBuffer(), nonceBytes], programId);
  const [result] = PublicKey.findProgramAddressSync([Buffer.from("result"), matchState.toBuffer()], programId);

  await submit(connection, "initialize pit", [initializePitInstruction(pit, authority.publicKey, pitId, 4)], [authority]);
  await submit(connection, "create match", [createMatchInstruction(pit, matchState, authority.publicKey, nonce)], [authority]);

  const pitAccount = await connection.getAccountInfo(pit, "confirmed");
  assert.ok(pitAccount, "pit account missing after initialization");
  assert.equal(new PublicKey(pitAccount.data.subarray(73, 105)).toBase58(), matchState.toBase58());

  for (const [index, player] of players.slice(0, 3).entries()) {
    await submit(connection, `player ${index} joins seat ${index}`, [joinInstruction(matchState, player.publicKey, index)], [authority, player]);
  }
  await submit(connection, "duplicate wallet", [joinInstruction(matchState, players[0].publicKey, 3)], [authority, players[0]], false);
  await submit(connection, "duplicate seat", [joinInstruction(matchState, players[3].publicKey, 1)], [authority, players[3]], false);
  await submit(connection, "invalid seat", [joinInstruction(matchState, players[3].publicKey, 4)], [authority, players[3]], false);
  await submit(connection, "player 3 joins seat 3", [joinInstruction(matchState, players[3].publicKey, 3)], [authority, players[3]]);
  await submit(connection, "fifth player", [joinInstruction(matchState, players[4].publicKey, 0)], [authority, players[4]], false);

  const membershipReader = new SolanaMatchMembershipReader(rpcUrl, programId.toBase58());
  assert.equal(await membershipReader.isConfirmed({
    matchAddress: matchState.toBase58(),
    walletAddress: players[0].publicKey.toBase58(),
    seatIndex: 0,
  }), true);

  process.env.NEXT_PUBLIC_SOLANA_RPC = rpcUrl;
  process.env.OUTCRY_PROGRAM_ID = programId.toBase58();
  process.env.OUTCRY_MATCH_ADDRESS = matchState.toBase58();
  worldRoom = new WorldRoom();
  await worldRoom.onCreate({ worldId: "wall-street" });
  const worldClient = {
    sessionId: "world-chain-session",
    send: () => undefined,
  };
  worldRoom.onJoin(worldClient, { userId: "localnet-player" });
  const worldPlayer = worldRoom.state.players.get(worldClient.sessionId);
  const worldPit = worldRoom.state.pits.get("wall-street-01");
  const worldSeat = worldPit?.seats.get("0");
  assert.ok(worldPlayer && worldPit && worldSeat, "world state fixture missing");
  const positionAtSeat = () => {
    worldPlayer.x = worldSeat.x;
    worldPlayer.y = worldSeat.y;
    worldPlayer.mode = "WALKING";
    worldPlayer.pitId = "";
    worldPlayer.seatIndex = -1;
  };
  for (let scenario = 0; scenario < 25; scenario += 1) {
    positionAtSeat();
    worldRoom.interact(worldClient, { pitId: worldPit.pitId, seatIndex: worldSeat.seatIndex });
    assert.equal(worldPlayer.mode, "SEATED");
    await worldRoom.confirmSeat(worldClient, {
      confirmed: true,
      matchAddress: matchState.toBase58(),
      walletAddress: players[0].publicKey.toBase58(),
    });
    assert.equal(worldPlayer.mode, "SEATED");
    assert.equal(worldPit.seats.get("0")?.status, "CONFIRMED");
    worldRoom.releaseSeat(worldClient);
    assert.equal(worldPit.seats.get("0")?.status, "FREE");
  }
  for (let scenario = 0; scenario < 25; scenario += 1) {
    positionAtSeat();
    worldRoom.interact(worldClient, { pitId: worldPit.pitId, seatIndex: worldSeat.seatIndex });
    assert.equal(worldPlayer.mode, "SEATED");
    await worldRoom.confirmSeat(worldClient, {
      confirmed: true,
      matchAddress: matchState.toBase58(),
      walletAddress: players[4].publicKey.toBase58(),
    });
    assert.equal(worldPlayer.mode, "WALKING");
    assert.equal(worldPit.seats.get("0")?.status, "FREE");
  }
  worldRoom.setSimulationInterval();
  worldRoom.onLeave(worldClient);
  restartedWorldRoom = new WorldRoom();
  await restartedWorldRoom.onCreate({ worldId: "wall-street" });
  const restartedClient = {
    sessionId: "restarted-world-session",
    send: () => undefined,
  };
  restartedWorldRoom.onJoin(restartedClient, { userId: "localnet-player" });
  await restartedWorldRoom.reconcileSeat(restartedClient, {
    matchAddress: matchState.toBase58(),
    walletAddress: players[0].publicKey.toBase58(),
  });
  const restartedPlayer = restartedWorldRoom.state.players.get(restartedClient.sessionId);
  assert.equal(restartedPlayer?.mode, "SEATED");
  assert.equal(restartedWorldRoom.state.pits.get("wall-street-01")?.seats.get("0")?.status, "CONFIRMED");
  restartedWorldRoom.onLeave(restartedClient);
  console.log("phase 5 reconciliation: actual WorldRoom 25 success + 25 failed leases, restart reconstruction pass");

  await submit(connection, "unauthorized start", [startInstruction(matchState, players[1].publicKey)], [players[1]], false);
  await submit(connection, "authority starts match", [startInstruction(matchState, authority.publicKey)], [authority]);
  await submit(connection, "initialize MatchResult", [resultInstruction(matchState, result, authority.publicKey)], [authority]);

  const match = readMatchAccount(await connection.getAccountInfo(matchState, "confirmed"));
  assert.equal(match.status, 1);
  assert.equal(match.capacity, 4);
  assert.equal(match.playerCount, 4);
  assert.deepEqual(match.players.map((player) => player.toBase58()), players.slice(0, 4).map((player) => player.publicKey.toBase58()));

  const resultAccount = await connection.getAccountInfo(result, "confirmed");
  assert.ok(resultAccount, "MatchResult account missing");
  assert.equal(new PublicKey(resultAccount.data.subarray(8, 40)).toBase58(), matchState.toBase58());
  assert.equal(resultAccount.data.readUInt8(112), 0);

  assert.equal(await membershipReader.isConfirmed({
    matchAddress: matchState.toBase58(),
    walletAddress: players[0].publicKey.toBase58(),
    seatIndex: 0,
  }), true);
  assert.equal(await membershipReader.isConfirmed({
    matchAddress: matchState.toBase58(),
    walletAddress: players[0].publicKey.toBase58(),
    seatIndex: 1,
  }), false);
  assert.equal(await membershipReader.isConfirmed({
    matchAddress: matchState.toBase58(),
    walletAddress: players[4].publicKey.toBase58(),
    seatIndex: 0,
  }), false);
  console.log("phase 5 localnet: membership, rejection matrix, authority start, MatchResult, and server verifier pass");
} catch (error) {
  if (validatorError) console.error(validatorError.trim());
  throw error;
} finally {
  if (worldRoom) worldRoom.setSimulationInterval();
  if (restartedWorldRoom) restartedWorldRoom.setSimulationInterval();
  if (previousChainEnv.NEXT_PUBLIC_SOLANA_RPC === undefined) delete process.env.NEXT_PUBLIC_SOLANA_RPC;
  else process.env.NEXT_PUBLIC_SOLANA_RPC = previousChainEnv.NEXT_PUBLIC_SOLANA_RPC;
  if (previousChainEnv.OUTCRY_PROGRAM_ID === undefined) delete process.env.OUTCRY_PROGRAM_ID;
  else process.env.OUTCRY_PROGRAM_ID = previousChainEnv.OUTCRY_PROGRAM_ID;
  if (previousChainEnv.OUTCRY_MATCH_ADDRESS === undefined) delete process.env.OUTCRY_MATCH_ADDRESS;
  else process.env.OUTCRY_MATCH_ADDRESS = previousChainEnv.OUTCRY_MATCH_ADDRESS;
  connection._rpcWebSocket?.close();
  validator.kill("SIGTERM");
  await rm(ledger, { recursive: true, force: true });
}
