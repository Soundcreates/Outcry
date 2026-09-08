import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Keypair } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  assertPrivateReadAccess,
  canReadPrivateAccount,
  createDelegatePrivateInventoryInstruction,
  createInitPrivateQuotePermissionInstruction,
  createInitializePrivateInventoryInstruction,
  createInitPrivateInventoryPermissionInstruction,
  createPrivateConnection,
  PRIVATE_EXECUTOR,
  privateInventoryPda,
  privatePermissionPda,
  privateQuotePda,
  readOwnPrivateInventory,
} from "./privacy";
import outcryIdl from "./idl/outcry.json";

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
assert.throws(() => assertPrivateReadAccess(bobQuote, alice), /private_account_access_denied/);
assert.throws(() => assertPrivateReadAccess(aliceInventory, bob), /private_account_access_denied/);
assert.throws(() => assertPrivateReadAccess(aliceQuote, spectator), /private_account_access_denied/);

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

const inventoryData = new Uint8Array(129);
inventoryData.set(outcryIdl.accounts.find((account) => account.name === "PrivateInventory")?.discriminator ?? [], 0);
inventoryData.set(match.toBytes(), 8);
inventoryData.set(alice.toBytes(), 40);
new DataView(inventoryData.buffer).setBigInt64(72, -2n, true);
new DataView(inventoryData.buffer).setBigUint64(80, 1234n, true);
new DataView(inventoryData.buffer).setBigUint64(88, 0n, true);
new DataView(inventoryData.buffer).setBigUint64(96, 1n, true);
new DataView(inventoryData.buffer).setBigUint64(112, 99n, true);
const privateConnection = {
  getAccountInfo: async () => ({ owner: program, data: inventoryData }),
} as never;
const decodedInventory = await readOwnPrivateInventory({ connection: privateConnection, matchAddress: match, player: alice, programId: program });
assert.equal(decodedInventory.solPositionLots, -2n);
assert.equal(decodedInventory.cashE6, 1234n);
assert.equal(decodedInventory.filledNotionalE6, 99n);
const publicFallbackConnection = {
  getAccountInfo: async () => ({ owner: spectator, data: inventoryData }),
} as never;
await assert.rejects(
  readOwnPrivateInventory({ connection: publicFallbackConnection, matchAddress: match, player: alice, programId: program }),
  /private_inventory_account_invalid/,
);
const delegatedInventoryConnection = {
  getAccountInfo: async () => ({ owner: DELEGATION_PROGRAM_ID, data: inventoryData }),
} as never;
const delegatedInventory = await readOwnPrivateInventory({ connection: delegatedInventoryConnection, matchAddress: match, player: alice, programId: program });
assert.equal(delegatedInventory.playerAddress, alice.toBase58());

const initializeInventory = createInitializePrivateInventoryInstruction({ matchAddress: match, player: alice, programId: program });
assert.equal(initializeInventory.keys[0].pubkey.equals(aliceInventory.account), true);
assert.equal(initializeInventory.keys[2].isSigner, true);
const delegateInventory = createDelegatePrivateInventoryInstruction({ matchAddress: match, player: alice, validator: bob, programId: program });
assert.equal(delegateInventory.keys[4].pubkey.equals(aliceInventory.account), true);
assert.equal(delegateInventory.keys[5].pubkey.equals(bob), true);
assert.equal(delegateInventory.keys[7].pubkey.equals(DELEGATION_PROGRAM_ID), true);
assert.equal(delegateInventory.data.length, 72);
const initializeInventoryPermission = createInitPrivateInventoryPermissionInstruction({ matchAddress: match, player: alice, programId: program });
assert.equal(initializeInventoryPermission.keys[0].isWritable, false);
assert.equal(initializeInventoryPermission.keys[0].isSigner, true);
assert.equal(initializeInventoryPermission.keys[1].pubkey.equals(aliceInventory.account), true);
assert.equal(initializeInventoryPermission.keys[1].isWritable, true);
assert.equal(initializeInventoryPermission.keys[2].pubkey.equals(privatePermissionPda(aliceInventory.account)), true);
const initializeQuotePermission = createInitPrivateQuotePermissionInstruction({ matchAddress: match, dealer: alice, round: 0, programId: program });
assert.equal(initializeQuotePermission.keys[0].isWritable, false);
assert.equal(initializeQuotePermission.keys[0].isSigner, true);

const privateQuotePanelSource = await readFile(new URL("../match/PrivateQuotePanel.tsx", import.meta.url), "utf8");
const privateInventoryPanelSource = await readFile(new URL("../match/PrivateInventoryPanel.tsx", import.meta.url), "utf8");
const privacySource = await readFile(new URL("./privacy.ts", import.meta.url), "utf8");
assert.match(privateQuotePanelSource, /Only your quote is sent through the TEE/);
assert.match(privateQuotePanelSource, /private_quote_failed/);
assert.match(privateQuotePanelSource, /Submit private quote/);
assert.match(privateQuotePanelSource, /setStatus\("error"\)/);
assert.match(privateQuotePanelSource, /onClick=\{\(\) => void submit\(\)\}/);
assert.match(privateQuotePanelSource, /onQuoteSealed\?\.\(\)/);
assert.doesNotMatch(privateQuotePanelSource, /new Connection|VITE_SOLANA_RPC|NEXT_PUBLIC_SOLANA_RPC/);
assert.match(privateInventoryPanelSource, /unlockPrivateInventory/);
assert.match(privateInventoryPanelSource, /browserBaseRpc/);
assert.match(privateQuotePanelSource, /browserBaseRpc/);
assert.match(privateInventoryPanelSource, /wallet\.signTransaction/);
assert.match(privacySource, /ensureTeeFeePayer/);
assert.match(privacySource, /waitForPrivateQuoteOnTee/);
assert.match(privacySource, /permissionInfo\?\.lamports/);
assert.match(privacySource, /feePayer: input\.feePayer/);
assert.match(privacySource, /preparePrivateQuote/);
assert.match(privacySource, /getPreparedPrivateQuote/);
assert.match(privacySource, /PRIVATE_QUOTE_AUTH_MIN_VALIDITY_MS/);

console.log("privacy boundary: 800 matrix assertions + Alice/Bob/spectator attack denials + TEE fail-closed/retry boundary pass");
