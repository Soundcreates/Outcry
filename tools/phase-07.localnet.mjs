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

const rpcUrl = "http://127.0.0.1:8899";
const sourceRpc = process.env.OUTCRY_ORACLE_RPC
  ?? process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_RPC
  ?? process.env.NEXT_PUBLIC_SOLANA_RPC
  ?? "https://api.devnet.solana.com";
const matchesArgumentIndex = process.argv.indexOf("--matches");
const matchesArgument = matchesArgumentIndex >= 0 ? Number(process.argv[matchesArgumentIndex + 1]) : NaN;
const matchesToRun = Number.isFinite(matchesArgument)
  ? matchesArgument
  : Number(process.env.OUTCRY_PHASE7_MATCHES ?? 20);
const programSo = resolve("target/deploy/outcry.so");
const idl = JSON.parse(await readFile("target/idl/outcry.json", "utf8"));
const programId = new PublicKey(idl.address);
const systemProgram = SystemProgram.programId;
const oracleFeed = new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
const oracleFeedId = Buffer.from("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", "hex");

assert.ok(Number.isInteger(matchesToRun) && matchesToRun > 0, "OUTCRY_PHASE7_MATCHES must be positive");

if (!process.env.OUTCRY_PHASE7_WORKER && matchesToRun > 1) {
  for (let matchIndex = 0; matchIndex < matchesToRun; matchIndex += 1) {
    console.log(`phase 7 localnet: starting isolated match ${matchIndex + 1}/${matchesToRun}`);
    await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, ["--env-file=.env", "--import", "tsx", "tools/phase-07.localnet.mjs"], {
        env: { ...process.env, OUTCRY_PHASE7_WORKER: "1", OUTCRY_PHASE7_MATCHES: "1" },
        stdio: "inherit",
      });
      child.once("error", rejectPromise);
      child.once("exit", (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`isolated match exited with code ${code}`)));
    });
  }
  console.log(`phase 7 localnet: ${matchesToRun}/${matchesToRun} isolated scripted 8-round matches passed`);
  process.exit(0);
}

const discriminator = (name) => {
  const instruction = idl.instructions.find((entry) => entry.name === name);
  assert.ok(instruction, `missing IDL instruction: ${name}`);
  return Buffer.from(instruction.discriminator);
};
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const u8 = (value) => Buffer.from([value]);
const u64 = (value) => {
  const data = Buffer.alloc(8);
  data.writeBigUInt64LE(BigInt(value));
  return data;
};
const i64 = (value) => {
  const data = Buffer.alloc(8);
  data.writeBigInt64LE(BigInt(value));
  return data;
};
const bytes32 = (value) => {
  const data = Buffer.alloc(32);
  Buffer.from(value, "utf8").copy(data);
  return data;
};
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const pitPda = (pitId) => pda([Buffer.from("pit"), pitId]);
const matchPda = (pit, nonce) => pda([Buffer.from("match"), pit.toBuffer(), u64(nonce)]);
const roundPda = (match, round) => pda([Buffer.from("round"), match.toBuffer(), u8(round)]);
const quotePda = (match, round, dealer) => pda([Buffer.from("quote"), match.toBuffer(), u8(round), dealer.toBuffer()]);
const inventoryPda = (match, player) => pda([Buffer.from("inventory"), match.toBuffer(), player.toBuffer()]);
const escrowPda = (match) => pda([Buffer.from("escrow"), match.toBuffer()]);
const oraclePda = pda([Buffer.from("oracle"), oracleFeedId]);
const BLOCKHASH_ATTEMPTS = 4;
const SUBMIT_ATTEMPTS = 4;
const QUOTE_WINDOW_SECONDS = 30;
const PYTH_PUBLISH_TIME_OFFSET = 93;
const PYTH_PREV_PUBLISH_TIME_OFFSET = 101;

function instruction(name, keys, args = []) {
  return new TransactionInstruction({
    programId,
    keys,
    data: Buffer.concat([discriminator(name), ...args]),
  });
}

function initializePit(pit, authority, pitId) {
  return instruction("initialize_pit", [
    meta(pit, true), meta(authority, true, true), meta(systemProgram),
  ], [pitId, u8(4)]);
}

function createMatch(pit, match, authority, nonce) {
  return instruction("create_match", [
    meta(pit, true), meta(match, true), meta(authority, true, true), meta(systemProgram),
  ], [u64(nonce)]);
}

function joinMatch(match, player, seat) {
  return instruction("join_match", [meta(match, true), meta(player, false, true)], [u8(seat)]);
}

function startMatch(match, authority) {
  return instruction("start_match", [meta(match, true), meta(authority, false, true)]);
}

function initializeResult(match, result, authority) {
  return instruction("initialize_match_result", [
    meta(match, true), meta(result, true), meta(authority, true, true), meta(systemProgram),
  ]);
}

function initializeOracle(oracle, authority) {
  return instruction("initialize_oracle", [
    meta(oracle, true), meta(oracleFeed), meta(authority, true, true), meta(systemProgram),
  ], [oracleFeedId]);
}

function initializeInventory(inventory, match, player) {
  return instruction("initialize_private_inventory", [
    meta(inventory, true), meta(match), meta(player, true, true), meta(systemProgram),
  ]);
}

function initializeQuote(quote, match, dealer, round) {
  return instruction("initialize_private_quote", [
    meta(quote, true), meta(match), meta(dealer, true, true), meta(systemProgram),
  ], [u8(round)]);
}

function openRfq(match, roundAccount, taker, side, quantity) {
  return instruction("open_rfq", [
    meta(match, true), meta(roundAccount, true), meta(oraclePda), meta(taker, true, true), meta(systemProgram),
  ], [u8(side), u64(quantity), i64(QUOTE_WINDOW_SECONDS)]);
}

function submitQuote(match, roundAccount, quote, dealer, price) {
  return instruction("submit_quote", [
    meta(match), meta(roundAccount, true), meta(quote, true), meta(oraclePda), meta(dealer, false, true),
  ], [i64(price)]);
}

function resolveRound(match, roundAccount, takerInventory, winningInventory, resolver, quoteAccounts) {
  return instruction("resolve_round", [
    meta(match), meta(roundAccount, true), meta(takerInventory, true), meta(winningInventory, true),
    meta(oraclePda), meta(resolver, false, true),
    ...quoteAccounts.map((quote) => meta(quote)),
  ]);
}

function nextRound(match, roundAccount, authority) {
  return instruction("next_round", [meta(match, true), meta(roundAccount), meta(authority, false, true)]);
}

function finalizeScores(match, result, authority, inventories) {
  return instruction("finalize_scores", [
    meta(match), meta(result, true), meta(oraclePda), meta(authority, false, true),
    ...inventories.map((inventory) => meta(inventory)),
  ]);
}

function settleMatch(match, result, winner) {
  return instruction("settle_match", [
    meta(match), meta(result, true), meta(escrowPda(match), true), meta(winner, true, true),
  ]);
}

function initializeEscrow(match, escrow, authority, payoutLamports) {
  return instruction("initialize_escrow", [
    meta(match, true), meta(escrow, true), meta(authority, true, true), meta(systemProgram),
  ], [u64(payoutLamports)]);
}

async function waitForRpc(connection, validator) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await connection.getVersion();
      return;
    } catch {
      if (validator.exitCode !== null) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        const diagnostic = [validatorOutput.trim(), validatorError.trim()].filter(Boolean).join(" | ");
        throw new Error(`local validator exited before RPC became ready${diagnostic ? `: ${diagnostic}` : ""}`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  throw new Error("local validator RPC did not become ready within 30 seconds");
}

async function airdrop(connection, keypair) {
  const signature = await connection.requestAirdrop(keypair.publicKey, 20 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(signature, "confirmed");
}

async function latestBlockhash(connection) {
  let lastError;
  for (let attempt = 0; attempt < BLOCKHASH_ATTEMPTS; attempt += 1) {
    try {
      return await connection.getLatestBlockhash("confirmed");
    } catch (error) {
      lastError = error;
      if (attempt + 1 < BLOCKHASH_ATTEMPTS) await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  throw lastError;
}

async function submit(connection, label, instructions, signers) {
  let lastError;
  for (let attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt += 1) {
    const transaction = new Transaction().add(...instructions);
    transaction.feePayer = signers[0].publicKey;
    const latest = await latestBlockhash(connection);
    transaction.recentBlockhash = latest.blockhash;
    transaction.lastValidBlockHeight = latest.lastValidBlockHeight;
    const simulation = await connection.simulateTransaction(transaction, signers);
    assert.equal(
      simulation.value.err,
      null,
      `${label} simulation failed: ${JSON.stringify(simulation.value.err)} logs=${JSON.stringify(simulation.value.logs)}`,
    );
    try {
      await sendAndConfirmTransaction(connection, transaction, signers, { commitment: "confirmed" });
      return;
    } catch (error) {
      lastError = error;
      if (error && typeof error === "object" && "getLogs" in error && typeof error.getLogs === "function") {
        try {
          console.error(`${label} transaction logs: ${JSON.stringify(await error.getLogs(connection))}`);
        } catch (logError) {
          console.error(`${label} transaction log lookup failed: ${logError instanceof Error ? logError.message : String(logError)}`);
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /blockhash|block height|expired|timeout|timed out|node is behind|fetch failed/i.test(message);
      if (!retryable || attempt + 1 === SUBMIT_ATTEMPTS) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  throw lastError;
}

async function simulateExpectedFailure(connection, label, instructions, signers) {
  let lastError;
  for (let attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt += 1) {
    const transaction = new Transaction().add(...instructions);
    transaction.feePayer = signers[0].publicKey;
    const latest = await latestBlockhash(connection);
    transaction.recentBlockhash = latest.blockhash;
    transaction.lastValidBlockHeight = latest.lastValidBlockHeight;
    try {
      const simulation = await connection.simulateTransaction(transaction, signers);
      assert.notEqual(
        simulation.value.err,
        null,
        `${label} unexpectedly simulated successfully: logs=${JSON.stringify(simulation.value.logs)}`,
      );
      return transaction;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /blockhash|block height|expired|timeout|timed out|node is behind|fetch failed/i.test(message);
      if (!retryable || attempt + 1 === SUBMIT_ATTEMPTS) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  throw lastError;
}

async function expectRejected(connection, label, instructions, signers) {
  await simulateExpectedFailure(connection, label, instructions, signers);
}

async function submitExpectedFailure(connection, label, instructions, signers) {
  const transaction = await simulateExpectedFailure(connection, label, instructions, signers);
  await assert.rejects(
    sendAndConfirmTransaction(connection, transaction, signers, { commitment: "confirmed" }),
    `${label} unexpectedly confirmed`,
  );
}

function uniqueSigners(signers) {
  return [...new Map(signers.map((signer) => [signer.publicKey.toBase58(), signer])).values()];
}

const workdir = await mkdtemp(join(tmpdir(), "outcry-phase7-"));
const ledger = join(workdir, "ledger");
const oracleFixture = join(workdir, "oracle-account.json");
const oracleResponse = await fetch(sourceRpc, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getAccountInfo",
    params: [oracleFeed.toBase58(), { encoding: "base64", commitment: "confirmed" }],
  }),
});
assert.ok(oracleResponse.ok, `oracle RPC returned HTTP ${oracleResponse.status}`);
const oraclePayload = await oracleResponse.json();
const oracleValue = oraclePayload.result?.value;
assert.ok(oracleValue, "oracle RPC returned no account");
assert.ok(Array.isArray(oracleValue.data) && typeof oracleValue.data[0] === "string", "oracle RPC returned unexpected account encoding");
const oracleData = Buffer.from(oracleValue.data[0], "base64");
assert.equal(oracleData.length, 134, "oracle fixture length changed");
const fixtureNow = BigInt(Math.floor(Date.now() / 1000));
oracleData.writeBigInt64LE(fixtureNow, PYTH_PUBLISH_TIME_OFFSET);
oracleData.writeBigInt64LE(fixtureNow - 1n, PYTH_PREV_PUBLISH_TIME_OFFSET);
await writeFile(oracleFixture, JSON.stringify({
  pubkey: oracleFeed.toBase58(),
  account: { ...oracleValue, data: [oracleData.toString("base64"), "base64"], rentEpoch: 0 },
}));
let validatorOutput = "";
let validatorError = "";
const validator = spawn("solana-test-validator", [
  "--reset", "--quiet", "--ledger", ledger, "--rpc-port", "8899", "--faucet-port", "9900",
  "--account", oracleFeed.toBase58(), oracleFixture, "--bpf-program", programId.toBase58(), programSo,
], { stdio: ["ignore", "pipe", "pipe"] });
validator.stdout.on("data", (chunk) => { validatorOutput += chunk.toString(); });
validator.stderr.on("data", (chunk) => { validatorError += chunk.toString(); });
const connection = new Connection(rpcUrl, "confirmed");

try {
  await waitForRpc(connection, validator);
  const authority = Keypair.generate();
  const players = Array.from({ length: 4 }, () => Keypair.generate());
  await Promise.all([authority, ...players].map((keypair) => airdrop(connection, keypair)));
  const clonedFeed = await connection.getAccountInfo(oracleFeed, "confirmed");
  assert.ok(clonedFeed, "cloned Pyth feed account missing");
  assert.equal(clonedFeed.owner.toBase58(), "PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd", "cloned Pyth owner mismatch");
  assert.equal(clonedFeed.data.subarray(41, 73).toString("hex"), oracleFeedId.toString("hex"), "embedded Pyth feed ID mismatch");

  await submit(connection, "initialize oracle", [initializeOracle(oraclePda, authority.publicKey)], [authority]);
  const oracleAccount = await connection.getAccountInfo(oraclePda, "confirmed");
  assert.ok(oracleAccount, "oracle account missing after initialization");
  const oraclePrice = Number(oracleAccount.data.readBigInt64LE(72));
  assert.ok(Number.isSafeInteger(oraclePrice) && oraclePrice > 0, "oracle price snapshot invalid");

  for (let matchIndex = 0; matchIndex < matchesToRun; matchIndex += 1) {
    const pitId = bytes32(`phase7-${matchIndex}`);
    const pit = pitPda(pitId);
    const nonce = 7_000n + BigInt(matchIndex);
    const match = matchPda(pit, nonce);
    const result = pda([Buffer.from("result"), match.toBuffer()]);
    const escrow = escrowPda(match);
    const inventories = players.map((player) => inventoryPda(match, player.publicKey));

    await submit(connection, `match ${matchIndex + 1}: setup`, [
      initializePit(pit, authority.publicKey, pitId), createMatch(pit, match, authority.publicKey, nonce),
    ], [authority]);
    await submit(connection, `match ${matchIndex + 1}: join`, players.map((player, index) => joinMatch(match, player.publicKey, index)), [authority, ...players]);
    await submit(connection, `match ${matchIndex + 1}: start`, [
      startMatch(match, authority.publicKey),
      initializeResult(match, result, authority.publicKey),
      initializeEscrow(match, escrow, authority.publicKey, 1_000_000),
    ], [authority]);
    await submit(connection, `match ${matchIndex + 1}: inventories`, players.map((player, index) => initializeInventory(inventories[index], match, player.publicKey)), players);

    for (let roundIndex = 0; roundIndex < 8; roundIndex += 1) {
      const takerIndex = roundIndex % players.length;
      const side = (matchIndex + roundIndex) % 2;
      const quantity = [1, 2, 5][(matchIndex + roundIndex) % 3];
      const dealerIndexes = players.map((_, index) => index).filter((index) => index !== takerIndex);
      const prices = dealerIndexes.map((dealerIndex) => oraclePrice + (side === 0 ? 1 : -1) * (dealerIndex + 1) * 1_000);
      const winningPrice = side === 0 ? Math.min(...prices) : Math.max(...prices);
      const winningDealerIndex = dealerIndexes[prices.indexOf(winningPrice)];
      const currentRound = roundPda(match, roundIndex);
      const currentQuotes = dealerIndexes.map((dealerIndex) => quotePda(match, roundIndex, players[dealerIndex].publicKey));

      if (roundIndex === 0) {
        await submit(connection, `match ${matchIndex + 1}: round 1 open`, [
          ...dealerIndexes.map((dealerIndex, index) => initializeQuote(currentQuotes[index], match, players[dealerIndex].publicKey, roundIndex)),
          openRfq(match, currentRound, players[takerIndex].publicKey, side, quantity),
        ], uniqueSigners([...dealerIndexes.map((index) => players[index]), players[takerIndex]]));
      }

      const roundBundle = [
        ...dealerIndexes.map((dealerIndex, index) => submitQuote(match, currentRound, currentQuotes[index], players[dealerIndex].publicKey, prices[index])),
        resolveRound(match, currentRound, inventories[takerIndex], inventories[winningDealerIndex], authority.publicKey, currentQuotes),
      ];

      if (roundIndex < 7) {
        const nextIndex = roundIndex + 1;
        const nextTakerIndex = nextIndex % players.length;
        const nextRoundAccount = roundPda(match, nextIndex);
        const nextDealerIndexes = players.map((_, index) => index).filter((index) => index !== nextTakerIndex);
        const nextQuotes = nextDealerIndexes.map((dealerIndex) => quotePda(match, nextIndex, players[dealerIndex].publicKey));
        roundBundle.push(
          nextRound(match, currentRound, authority.publicKey),
          ...nextDealerIndexes.map((dealerIndex, index) => initializeQuote(nextQuotes[index], match, players[dealerIndex].publicKey, nextIndex)),
          openRfq(match, nextRoundAccount, players[nextTakerIndex].publicKey, (matchIndex + nextIndex) % 2, [1, 2, 5][(matchIndex + nextIndex) % 3]),
        );
        await submit(connection, `match ${matchIndex + 1}: round ${roundIndex + 1} -> ${nextIndex + 1}`, roundBundle, uniqueSigners([
          authority,
          ...dealerIndexes.map((index) => players[index]),
          ...nextDealerIndexes.map((index) => players[index]),
          players[nextTakerIndex],
        ]));
      } else {
        roundBundle.push(nextRound(match, currentRound, authority.publicKey));
        await submit(connection, `match ${matchIndex + 1}: finish`, roundBundle, uniqueSigners([authority, ...dealerIndexes.map((index) => players[index])]));
      }
    }

    await submit(connection, `match ${matchIndex + 1}: finalize`, [finalizeScores(match, result, authority.publicKey, inventories)], [authority]);
    const matchAccount = await connection.getAccountInfo(match, "confirmed");
    const finalizedResult = await connection.getAccountInfo(result, "confirmed");
    const escrowBefore = await connection.getAccountInfo(escrow, "confirmed");
    assert.equal(matchAccount?.data.readUInt8(80), 2, `match ${matchIndex + 1} did not finish`);
    assert.equal(finalizedResult?.data.readUInt8(112), 0, `match ${matchIndex + 1} settled before authorization`);
    assert.ok(escrowBefore, `match ${matchIndex + 1} escrow missing before settlement`);
    const winner = new PublicKey(finalizedResult.data.subarray(40, 72));
    const winnerKeypair = players.find((player) => player.publicKey.equals(winner));
    assert.ok(winnerKeypair, `match ${matchIndex + 1} winner is not a match player`);
    const wrongWinner = players.find((player) => !player.publicKey.equals(winner));
    assert.ok(wrongWinner, `match ${matchIndex + 1} has no alternate winner signer`);
    const failedSettlement = [settleMatch(match, result, wrongWinner.publicKey)];
    if (matchIndex === 0) {
      await submitExpectedFailure(connection, `match ${matchIndex + 1}: failed settlement`, failedSettlement, [wrongWinner]);
    } else {
      await expectRejected(connection, `match ${matchIndex + 1}: failed settlement`, failedSettlement, [wrongWinner]);
    }
    await submit(connection, `match ${matchIndex + 1}: settle`, [settleMatch(match, result, winner)], [winnerKeypair]);
    const settledResult = await connection.getAccountInfo(result, "confirmed");
    const escrowAfter = await connection.getAccountInfo(escrow, "confirmed");
    assert.equal(settledResult?.data.readUInt8(112), 1, `match ${matchIndex + 1} did not settle`);
    assert.equal(escrowBefore.lamports - (escrowAfter?.lamports ?? 0), 1_000_000, `match ${matchIndex + 1} paid an incorrect escrow amount`);
    await expectRejected(connection, `match ${matchIndex + 1}: double settle`, [settleMatch(match, result, winner)], [winnerKeypair]);
    console.log(`phase 7 localnet: ${matchIndex + 1}/${matchesToRun} complete`);
  }

  console.log(`phase 7 localnet: ${matchesToRun}/${matchesToRun} scripted 8-round matches passed with live Pyth account clone`);
} catch (error) {
  if (validatorError) console.error(validatorError.trim());
  throw error;
} finally {
  connection._rpcWebSocket?.close();
  validator.kill("SIGTERM");
  await rm(workdir, { recursive: true, force: true });
}
