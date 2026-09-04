import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import {
  assertPrivateReadAccess,
  canReadPrivateAccount,
  createPrivateConnection,
  PRIVATE_EXECUTOR,
  privateInventoryPda,
  privatePermissionPda,
  privateQuotePda,
} from "./privacy";

const match = Keypair.generate().publicKey;
const program = Keypair.generate().publicKey;
const alice = Keypair.generate().publicKey;
const bob = Keypair.generate().publicKey;
const spectator = Keypair.generate().publicKey;

const aliceQuote = {
  account: privateQuotePda({ matchAddress: match, round: 0, dealer: alice, programId: program }),
  owner: alice,
  kind: "quote" as const,
};
const bobQuote = {
  account: privateQuotePda({ matchAddress: match, round: 0, dealer: bob, programId: program }),
  owner: bob,
  kind: "quote" as const,
};
const aliceInventory = {
  account: privateInventoryPda({ matchAddress: match, player: alice, programId: program }),
  owner: alice,
  kind: "inventory" as const,
};
const bobInventory = {
  account: privateInventoryPda({ matchAddress: match, player: bob, programId: program }),
  owner: bob,
  kind: "inventory" as const,
};

const runtime = globalThis as { Buffer?: unknown };
const nodeBuffer = runtime.Buffer;
delete runtime.Buffer;
try {
  assert.ok(privateQuotePda({ matchAddress: match, round: 0, dealer: alice, programId: program }));
  assert.ok(privateInventoryPda({ matchAddress: match, player: alice, programId: program }));
} finally {
  runtime.Buffer = nodeBuffer;
}

assert.notEqual(aliceQuote.account.toBase58(), bobQuote.account.toBase58());
assert.notEqual(aliceQuote.account.toBase58(), aliceInventory.account.toBase58());
assert.equal(privatePermissionPda(aliceQuote.account).equals(privatePermissionPda(aliceQuote.account)), true);
assert.throws(() => privateQuotePda({ matchAddress: match, round: 256, dealer: alice, programId: program }), /invalid_private_round/);

const matrix = [
  [aliceQuote, alice, true],
  [aliceQuote, bob, false],
  [bobQuote, bob, true],
  [bobQuote, alice, false],
  [aliceInventory, alice, true],
  [aliceInventory, bob, false],
  [bobInventory, bob, true],
  [bobInventory, spectator, false],
] as const;

for (let iteration = 0; iteration < 100; iteration += 1) {
  for (const [account, principal, expected] of matrix) {
    assert.equal(canReadPrivateAccount(account, principal), expected);
  }
}
assert.equal(canReadPrivateAccount(aliceQuote, PRIVATE_EXECUTOR), true);
assertPrivateReadAccess(aliceQuote, alice);
assert.throws(() => assertPrivateReadAccess(aliceQuote, bob), /private_account_access_denied/);

let authCalls = 0;
const session = await createPrivateConnection({
  teeRpcUrl: "https://devnet-tee.magicblock.app",
  publicKey: alice,
  signMessage: async (message) => message,
  verifyIntegrity: async () => undefined,
  authenticate: async () => {
    authCalls += 1;
    return { token: "opaque-token", expiresAt: 1234 };
  },
});
assert.equal(session.expiresAt, 1234);
assert.equal(session.publicKey.equals(alice), true);
assert.equal(session.connection.rpcEndpoint.includes("opaque-token"), true);
assert.equal(authCalls, 1);

let failedAuthCalls = 0;
await assert.rejects(
  createPrivateConnection({
    teeRpcUrl: "https://devnet-tee.magicblock.app",
    publicKey: alice,
    signMessage: async (message) => message,
    verifyIntegrity: async () => { throw new Error("forced_integrity_failure"); },
    authenticate: async () => {
      failedAuthCalls += 1;
      return { token: "never-used", expiresAt: 1234 };
    },
  }),
  /tee_integrity_failed/,
);
assert.equal(failedAuthCalls, 0);

console.log("privacy boundary: 800 access assertions, PDA separation, TEE fail-closed, and auth session pass");
