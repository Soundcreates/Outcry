import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
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

// V2 localnet coverage: setup wallets create durable state once; session keys
// sign player decisions; the relayer alone cranks deterministic transitions.
const rpcUrl = "http://127.0.0.1:8899";
const sourceRpc = process.env.OUTCRY_ORACLE_RPC
  ?? process.env.OUTCRY_BASE_RPC
  ?? "https://api.devnet.solana.com";
const matches = Number(process.env.OUTCRY_PHASE7_MATCHES ?? 1);
const programSo = resolve("target/deploy/outcry.so");
const idl = JSON.parse(await readFile("target/idl/outcry.json", "utf8"));
const programId = new PublicKey(idl.address);
const systemProgram = SystemProgram.programId;
const oracleFeed = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const oracleFeedId = Buffer.from("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", "hex");
const [oracle] = PublicKey.findProgramAddressSync([Buffer.from("oracle"), oracleFeedId], programId);

assert.ok(Number.isInteger(matches) && matches > 0, "OUTCRY_PHASE7_MATCHES must be positive");

const discriminator = (name) => {
  const entry = idl.instructions.find((instruction) => instruction.name === name);
  assert.ok(entry, `missing IDL instruction: ${name}`);
  return Buffer.from(entry.discriminator);
};
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const u8 = (value) => Buffer.from([value]);
const u64 = (value) => { const data = Buffer.alloc(8); data.writeBigUInt64LE(BigInt(value)); return data; };
const i64 = (value) => { const data = Buffer.alloc(8); data.writeBigInt64LE(BigInt(value)); return data; };
const bytes32 = (value) => { const data = Buffer.alloc(32); Buffer.from(value, "utf8").copy(data); return data; };
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const pitPda = (pitId) => pda([Buffer.from("pit"), pitId]);
const matchPda = (pit, nonce) => pda([Buffer.from("match_v2"), pit.toBuffer(), u64(nonce)]);
const runtimePda = (match) => pda([Buffer.from("runtime"), match.toBuffer()]);
const resultPda = (match) => pda([Buffer.from("result"), match.toBuffer()]);
const escrowPda = (match) => pda([Buffer.from("escrow"), match.toBuffer()]);
const quotePda = (match, dealer) => pda([Buffer.from("quote"), match.toBuffer(), dealer.toBuffer()]);
const inventoryPda = (match, player) => pda([Buffer.from("inventory"), match.toBuffer(), player.toBuffer()]);
const sessionPda = (match, authority, session) => pda([Buffer.from("session"), match.toBuffer(), authority.toBuffer(), session.toBuffer()]);
const instruction = (name, keys, args = []) => new TransactionInstruction({ programId, keys, data: Buffer.concat([discriminator(name), ...args]) });

function initializePit(pit, authority, pitId) {
  return instruction("initialize_pit", [meta(pit, true), meta(authority, true, true), meta(systemProgram)], [pitId, u8(4)]);
}
function createMatch(pit, match, runtime, authority, nonce) {
  return instruction("create_match", [meta(pit, true), meta(match, true), meta(runtime, true), meta(authority, true, true), meta(systemProgram)], [u64(nonce)]);
}
function joinMatch(match, player) { return instruction("join_match", [meta(match, true), meta(player, false, true)]); }
function authorizeSession(match, grant, authority, session) {
  return instruction("authorize_session", [meta(match), meta(grant, true), meta(authority, true, true), meta(systemProgram)], [session.publicKey.toBuffer(), i64(900), u8(15)]);
}
function startMatch(match, authority, session, grant) {
  return instruction("start_match", [meta(match, true), meta(authority), meta(session.publicKey, false, true), meta(grant)], [u8(8)]);
}
function initializeResult(match, result, authority) {
  return instruction("initialize_match_result", [meta(match), meta(result, true), meta(authority, true, true), meta(systemProgram)]);
}
function initializeEscrow(match, escrow, authority) {
  return instruction("initialize_escrow", [meta(match), meta(escrow, true), meta(authority, true, true), meta(systemProgram)], [u64(1_000_000)]);
}
function initializeInventory(inventory, match, player) {
  return instruction("initialize_private_inventory", [meta(inventory, true), meta(match), meta(player, true, true), meta(systemProgram)]);
}
function initializeQuote(quote, match, dealer) {
  return instruction("initialize_private_quote", [meta(quote, true), meta(match), meta(dealer, true, true), meta(systemProgram)]);
}
function initializeOracle() {
  return instruction("initialize_oracle", [meta(oracle, true), meta(oracleFeed), meta(authority.publicKey, true, true), meta(systemProgram)], [oracleFeedId]);
}
function openRfq(match, runtime, authority, session, grant, side, quantity) {
  return instruction("open_rfq", [meta(match), meta(runtime, true), meta(oracle), meta(authority), meta(session.publicKey, false, true), meta(grant)], [u8(side), u64(quantity), i64(30)]);
}
function submitQuote(match, runtime, authority, quote, session, grant, price) {
  return instruction("submit_quote", [meta(match), meta(runtime, true), meta(authority), meta(quote, true), meta(session.publicKey, false, true), meta(grant)], [i64(price)]);
}
function resolveRound(match, runtime, takerInventory, quotes, inventories) {
  return instruction("resolve_round", [meta(match), meta(runtime, true), meta(takerInventory, true), ...quotes.map((quote) => meta(quote)), ...inventories.map((inventory) => meta(inventory, true))]);
}
function skipEmptyRound(match, runtime) { return instruction("skip_empty_round", [meta(match), meta(runtime, true)]); }
function advanceRound(match, runtime) { return instruction("advance_round", [meta(match), meta(runtime, true)]); }
function finalizeRuntime(match, runtime, oracleAddress, inventories) { return instruction("finalize_runtime", [meta(match), meta(runtime, true), meta(oracleAddress), ...inventories.map((inventory) => meta(inventory))]); }
function finalizeMatch(match, runtime, result) { return instruction("finalize_match", [meta(match, true), meta(runtime), meta(result, true)]); }
function settleMatch(match, result, escrow, winner) { return instruction("settle_match", [meta(match), meta(result, true), meta(escrow, true), meta(winner, true)]); }

async function waitForRpc(connection, validator) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { await connection.getVersion(); return; } catch {
      if (validator.exitCode !== null) throw new Error("local validator exited before RPC became ready");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  throw new Error("local validator RPC did not become ready within 30 seconds");
}

async function airdrop(connection, keypair) {
  const signature = await connection.requestAirdrop(keypair.publicKey, 20 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(signature, "confirmed");
}

async function submit(connection, label, instructions, signers, feePayer = signers[0]) {
  const transaction = new Transaction().add(...instructions);
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = feePayer.publicKey;
  transaction.recentBlockhash = latest.blockhash;
  transaction.lastValidBlockHeight = latest.lastValidBlockHeight;
  const simulation = await connection.simulateTransaction(transaction, signers);
  assert.equal(simulation.value.err, null, `${label} simulation failed: ${JSON.stringify(simulation.value.err)} logs=${JSON.stringify(simulation.value.logs)}`);
  await sendAndConfirmTransaction(connection, transaction, signers, { commitment: "confirmed" });
}

async function sessionSubmit(connection, label, ix, session, relayer) {
  await submit(connection, label, [ix], [relayer, session], relayer);
}

const workdir = await mkdtemp(join(tmpdir(), "outcry-phase7-"));
const ledger = join(workdir, "ledger");
const oracleFixture = join(workdir, "oracle-account.json");
const oracleResponse = await fetch(sourceRpc, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [oracleFeed.toBase58(), { encoding: "base64", commitment: "confirmed" }] }),
});
assert.ok(oracleResponse.ok, `oracle RPC returned HTTP ${oracleResponse.status}`);
const oraclePayload = await oracleResponse.json();
const oracleValue = oraclePayload.result?.value;
assert.ok(oracleValue, "oracle RPC returned no account");
const oracleData = Buffer.from(oracleValue.data[0], "base64");
const fixtureNow = BigInt(Math.floor(Date.now() / 1000));
oracleData.writeBigInt64LE(fixtureNow, 93);
oracleData.writeBigInt64LE(fixtureNow - 1n, 101);
await writeFile(oracleFixture, JSON.stringify({ pubkey: oracleFeed.toBase58(), account: { ...oracleValue, data: [oracleData.toString("base64"), "base64"], rentEpoch: 0 } }));

const validator = spawn("solana-test-validator", [
  "--reset", "--quiet", "--ledger", ledger, "--rpc-port", "8899", "--faucet-port", "9900",
  "--account", oracleFeed.toBase58(), oracleFixture, "--bpf-program", programId.toBase58(), programSo,
], { stdio: "ignore" });
const connection = new Connection(rpcUrl, "confirmed");
const authority = Keypair.generate();
const players = [authority, Keypair.generate(), Keypair.generate(), Keypair.generate()];
const sessions = players.map(() => Keypair.generate());
const relayer = Keypair.generate();

try {
  await waitForRpc(connection, validator);
  await Promise.all([...players, relayer].map((keypair) => airdrop(connection, keypair)));
  await submit(connection, "initialize oracle", [initializeOracle()], [authority]);

  const oracleInfo = await connection.getAccountInfo(oracle, "confirmed");
  assert.ok(oracleInfo);
  const oraclePrice = Number(oracleInfo.data.readBigInt64LE(72));
  assert.ok(Number.isSafeInteger(oraclePrice) && oraclePrice > 0);

  for (let matchIndex = 0; matchIndex < matches; matchIndex += 1) {
    const pitId = bytes32(`phase7-${matchIndex}`);
    const pit = pitPda(pitId);
    const match = matchPda(pit, 7_000n + BigInt(matchIndex));
    const runtime = runtimePda(match);
    const result = resultPda(match);
    const escrow = escrowPda(match);
    const inventories = players.map((player) => inventoryPda(match, player.publicKey));
    const quotes = players.map((player) => quotePda(match, player.publicKey));
    const grants = players.map((player, index) => sessionPda(match, player.publicKey, sessions[index].publicKey));

    await submit(connection, `match ${matchIndex + 1}: pit and match`, [initializePit(pit, authority.publicKey, pitId), createMatch(pit, match, runtime, authority.publicKey, 7_000n + BigInt(matchIndex))], [authority]);
    await submit(connection, `match ${matchIndex + 1}: join`, players.map((player) => joinMatch(match, player.publicKey)), players, authority);
    await submit(connection, `match ${matchIndex + 1}: setup`, [initializeResult(match, result, authority.publicKey), initializeEscrow(match, escrow, authority.publicKey)], [authority]);
    for (let index = 0; index < players.length; index += 1) {
      await submit(connection, `match ${matchIndex + 1}: inventory ${index}`, [initializeInventory(inventories[index], match, players[index].publicKey), initializeQuote(quotes[index], match, players[index].publicKey), authorizeSession(match, grants[index], players[index].publicKey, sessions[index])], [players[index]]);
    }

    await sessionSubmit(connection, `match ${matchIndex + 1}: start`, startMatch(match, authority.publicKey, sessions[0], grants[0]), sessions[0], relayer);

    for (let round = 0; round < 8; round += 1) {
      const takerIndex = round % players.length;
      const side = (matchIndex + round) % 2;
      const quantity = [1, 2, 5][(matchIndex + round) % 3];
      await sessionSubmit(connection, `match ${matchIndex + 1}: round ${round + 1} open`, openRfq(match, runtime, players[takerIndex].publicKey, sessions[takerIndex], grants[takerIndex], side, quantity), sessions[takerIndex], relayer);
      const dealerIndexes = players.map((_, index) => index).filter((index) => index !== takerIndex);
      for (const dealerIndex of dealerIndexes) {
        const price = oraclePrice + (side === 0 ? 1 : -1) * (dealerIndex + 1) * 1_000;
        await sessionSubmit(connection, `match ${matchIndex + 1}: round ${round + 1} quote ${dealerIndex}`, submitQuote(match, runtime, players[dealerIndex].publicKey, quotes[dealerIndex], sessions[dealerIndex], grants[dealerIndex], price), sessions[dealerIndex], relayer);
      }
      await submit(connection, `match ${matchIndex + 1}: round ${round + 1} resolve`, [resolveRound(match, runtime, inventories[takerIndex], dealerIndexes.map((index) => quotes[index]), dealerIndexes.map((index) => inventories[index]))], [relayer]);
      await submit(connection, `match ${matchIndex + 1}: round ${round + 1} advance`, [advanceRound(match, runtime)], [relayer]);
    }

    await submit(connection, `match ${matchIndex + 1}: finalize`, [finalizeRuntime(match, runtime, oracle, inventories), finalizeMatch(match, runtime, result)], [relayer]);
    const matchInfo = await connection.getAccountInfo(match, "confirmed");
    const resultInfo = await connection.getAccountInfo(result, "confirmed");
    assert.equal(matchInfo?.data[72], 2, "match did not finish");
    assert.ok(resultInfo);
    const winner = new PublicKey(resultInfo.data.subarray(40, 72));
    assert.ok(players.some((player) => player.publicKey.equals(winner)));
    await submit(connection, `match ${matchIndex + 1}: permissionless settle`, [settleMatch(match, result, escrow, winner)], [relayer]);
    const settled = await connection.getAccountInfo(result, "confirmed");
    assert.equal(settled?.data[112], 1, "match did not settle");
    console.log(`phase 7 localnet: ${matchIndex + 1}/${matches} V2 matches passed`);
  }
} finally {
  connection._rpcWebSocket?.close();
  validator.kill("SIGTERM");
  await rm(workdir, { recursive: true, force: true });
}
