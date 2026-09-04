import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { createJoinMatchInstruction, validateJoinAccounts } from "./joinMatch";

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

console.log("wallet join adapter: instruction metas, discriminator, seat bounds pass");
