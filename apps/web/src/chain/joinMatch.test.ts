import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { readFile } from "node:fs/promises";
import {
  createCreateMatchInstruction,
  createInitializePitInstruction,
  createJoinMatchInstruction,
  matchBootstrapAddresses,
  validateJoinAccounts,
  validateWalletBalance,
} from "./joinMatch";

const match = Keypair.generate().publicKey;
const player = Keypair.generate().publicKey;
const programId = Keypair.generate().publicKey;
const nodeGlobals = globalThis as { Buffer?: unknown };
const originalBuffer = nodeGlobals.Buffer;
nodeGlobals.Buffer = undefined;
const instruction = createJoinMatchInstruction({
  matchAddress: match.toBase58(),
  playerAddress: player.toBase58(),
  programId: programId.toBase58(),
  seatIndex: 2,
});
nodeGlobals.Buffer = originalBuffer;

assert.equal(instruction.programId.toBase58(), programId.toBase58());
assert.equal(instruction.keys[0]?.pubkey.toBase58(), match.toBase58());
assert.equal(instruction.keys[0]?.isWritable, true);
assert.equal(instruction.keys[1]?.pubkey.toBase58(), player.toBase58());
assert.equal(instruction.keys[1]?.isSigner, true);
assert.deepEqual([...instruction.data], [244, 8, 47, 130, 192, 59, 179, 44, 2]);
assert.throws(() => createJoinMatchInstruction({
  matchAddress: match.toBase58(),
  playerAddress: player.toBase58(),
  programId: programId.toBase58(),
  seatIndex: 4,
}), /invalid_seat/);
assert.throws(() => validateJoinAccounts(null, null, programId), /outcry_program_not_deployed/);
assert.throws(() => validateJoinAccounts({ executable: true }, null, programId), /match_account_not_initialized/);
assert.throws(() => validateJoinAccounts({ executable: true }, { owner: player }, programId), /match_account_program_mismatch/);
validateJoinAccounts({ executable: true }, { owner: programId }, programId);
assert.throws(() => validateWalletBalance(0), /wallet_fee_payer_unfunded/);
assert.throws(() => validateWalletBalance(4_999), /wallet_fee_payer_unfunded/);
validateWalletBalance(5_000);
assert.match(await readFile(new URL("./matchState.ts", import.meta.url), "utf8"), /LEGACY_MATCH_BYTES/);

const bootstrap = matchBootstrapAddresses({ pitId: "wall-street-01", nonce: 1n, programId: programId.toBase58() });
const initializePit = createInitializePitInstruction({
  pitAddress: bootstrap.pit.toBase58(),
  authorityAddress: player.toBase58(),
  pitId: "wall-street-01",
  capacity: 4,
  programId: programId.toBase58(),
});
const createMatch = createCreateMatchInstruction({
  pitAddress: bootstrap.pit.toBase58(),
  matchAddress: bootstrap.match.toBase58(),
  authorityAddress: player.toBase58(),
  nonce: 1n,
  programId: programId.toBase58(),
});
assert.equal(initializePit.keys[0]?.pubkey.toBase58(), bootstrap.pit.toBase58());
assert.equal(initializePit.keys[1]?.isSigner, true);
assert.equal(createMatch.keys[1]?.pubkey.toBase58(), bootstrap.match.toBase58());
assert.equal(createMatch.keys[2]?.isSigner, true);
assert.throws(() => createInitializePitInstruction({
  pitAddress: bootstrap.pit.toBase58(), authorityAddress: player.toBase58(), pitId: "wall-street-01", capacity: 5, programId: programId.toBase58(),
}), /invalid_pit_capacity/);
const source = await readFile(new URL("./joinMatch.ts", import.meta.url), "utf8");
assert.match(source, /sigVerify: false/);
assert.match(source, /replaceRecentBlockhash: true/);
assert.match(source, /signTransaction/);
assert.match(source, /wallet_transaction_expired_retry/);
assert.match(source, /getBalance\(player/);
assert.match(source, /alreadyJoined/);
assert.match(source, /seatIndex: existingSeat/);
assert.match(source, /join_match_simulation_failed:/);

console.log("wallet adapter: join and authority-bootstrap instruction metas, PDAs, discriminators, and bounds pass");
