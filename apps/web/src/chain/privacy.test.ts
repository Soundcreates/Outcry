import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID, PERMISSION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  assertPrivateReadAccess,
  canReadPrivateAccount,
  createDelegatePrivateInventoryInstruction,
  createDelegatePrivateQuoteInstruction,
  createInitPrivateInventoryPermissionInstruction,
  createInitPrivateQuotePermissionInstruction,
  createInitializePrivateInventoryInstruction,
  createInitializePrivateQuoteInstruction,
  createPrivateConnection,
  createTeeFeePayerSetupInstructions,
  isValidPrivatePermission,
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
const session = Keypair.generate();
const grant = Keypair.generate().publicKey;

const aliceQuote = {
  account: privateQuotePda({ matchAddress: match, dealer: alice, programId: program }),
  owner: alice,
  kind: "quote" as const,
};
const bobQuote = {
  account: privateQuotePda({ matchAddress: match, dealer: bob, programId: program }),
  owner: bob,
  kind: "quote" as const,
};
const aliceInventory = {
  account: privateInventoryPda({ matchAddress: match, player: alice, programId: program }),
  owner: alice,
  kind: "inventory" as const,
};

assert.notEqual(aliceQuote.account.toBase58(), bobQuote.account.toBase58());
assert.equal(
  privateQuotePda({ matchAddress: match, dealer: alice, programId: program }).toBase58(),
  privateQuotePda({ matchAddress: match, round: 7, dealer: alice, programId: program }).toBase58(),
);
assert.equal(privatePermissionPda(aliceQuote.account).equals(privatePermissionPda(aliceQuote.account)), true);

assert.equal(canReadPrivateAccount(aliceQuote, alice), true);
assert.equal(canReadPrivateAccount(aliceQuote, bob), false);
assert.equal(canReadPrivateAccount(aliceQuote, PRIVATE_EXECUTOR), true);
assertPrivateReadAccess(aliceQuote, alice);
assert.throws(() => assertPrivateReadAccess(aliceQuote, bob), /private_account_access_denied/);

let authCalls = 0;
const privateSession = await createPrivateConnection({
  teeRpcUrl: "https://devnet-tee.magicblock.app",
  publicKey: session.publicKey,
  signMessage: async (message) => message,
  verifyIntegrity: async () => undefined,
  authenticate: async () => {
    authCalls += 1;
    return { token: "opaque-token", expiresAt: 1234 };
  },
});
assert.equal(privateSession.expiresAt, 1234);
assert.equal(privateSession.publicKey.equals(session.publicKey), true);
assert.equal(privateSession.connection.rpcEndpoint.includes("opaque-token"), true);
assert.equal(authCalls, 1);

await assert.rejects(
  createPrivateConnection({
    teeRpcUrl: "https://devnet-tee.magicblock.app",
    publicKey: session.publicKey,
    signMessage: async (message) => message,
    verifyIntegrity: async () => { throw new Error("forced_integrity_failure"); },
    authenticate: async () => ({ token: "never-used", expiresAt: 1234 }),
  }),
  /tee_integrity_failed/,
);

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
const delegatedInventory = await readOwnPrivateInventory({
  connection: { getAccountInfo: async () => ({ owner: DELEGATION_PROGRAM_ID, data: inventoryData }) } as never,
  matchAddress: match,
  player: alice,
  programId: program,
});
assert.equal(delegatedInventory.playerAddress, alice.toBase58());

const permissionData = new Uint8Array(101);
permissionData[0] = 1;
permissionData.set(aliceInventory.account.toBytes(), 2);
permissionData[34] = 1;
permissionData.set(alice.toBytes(), 36);
assert.equal(isValidPrivatePermission({ owner: PERMISSION_PROGRAM_ID, data: permissionData }, aliceInventory.account), true);
assert.equal(isValidPrivatePermission({ owner: PERMISSION_PROGRAM_ID, data: permissionData }, bob), false);
permissionData[34] = 0;
assert.equal(isValidPrivatePermission({ owner: PERMISSION_PROGRAM_ID, data: permissionData }, aliceInventory.account), false);

const initializeInventory = createInitializePrivateInventoryInstruction({ matchAddress: match, player: alice, programId: program });
assert.equal(initializeInventory.keys[0].pubkey.equals(aliceInventory.account), true);
assert.equal(initializeInventory.keys[2].isSigner, true);
const initializeQuote = createInitializePrivateQuoteInstruction({ matchAddress: match, dealer: alice, programId: program });
assert.equal(initializeQuote.keys[0].pubkey.equals(aliceQuote.account), true);
assert.equal(initializeQuote.data.length, 8);
const delegateQuote = createDelegatePrivateQuoteInstruction({ matchAddress: match, dealer: alice, validator: bob, programId: program });
assert.equal(delegateQuote.keys[4].pubkey.equals(aliceQuote.account), true);
assert.equal(delegateQuote.data.length, 72);
const delegateInventory = createDelegatePrivateInventoryInstruction({ matchAddress: match, player: alice, validator: bob, programId: program });
assert.equal(delegateInventory.keys[4].pubkey.equals(aliceInventory.account), true);

const teeFeePayer = Keypair.generate().publicKey;
const teeValidator = Keypair.generate().publicKey;
const firstUseFeePayerSetup = createTeeFeePayerSetupInstructions({
  player: alice,
  feePayer: teeFeePayer,
  validator: teeValidator,
  currentAccount: null,
});
assert.equal(firstUseFeePayerSetup.length, 3, "first-use TEE fee payer needs funding, assignment, and delegation");
assert.equal(firstUseFeePayerSetup[0].programId.equals(SystemProgram.programId), true);
assert.equal(firstUseFeePayerSetup[1].programId.equals(SystemProgram.programId), true);
assert.equal(firstUseFeePayerSetup[2].keys[0].pubkey.equals(alice), true);
assert.deepEqual(
  createTeeFeePayerSetupInstructions({
    player: alice,
    feePayer: teeFeePayer,
    validator: teeValidator,
    currentAccount: { owner: SystemProgram.programId, lamports: 10_000_000 },
  }).map((instruction) => instruction.programId.toBase58()),
  [SystemProgram.programId.toBase58(), DELEGATION_PROGRAM_ID.toBase58()],
);
assert.deepEqual(
  createTeeFeePayerSetupInstructions({
    player: alice,
    feePayer: teeFeePayer,
    validator: teeValidator,
    currentAccount: { owner: DELEGATION_PROGRAM_ID, lamports: 1 },
  }),
  [],
);
assert.throws(() => createTeeFeePayerSetupInstructions({
  player: alice,
  feePayer: teeFeePayer,
  validator: teeValidator,
  currentAccount: { owner: Keypair.generate().publicKey, lamports: 1 },
}), /tee_fee_payer_account_invalid/);

const initializeInventoryPermission = createInitPrivateInventoryPermissionInstruction({
  matchAddress: match,
  player: alice,
  sessionKey: session.publicKey,
  sessionGrantAddress: grant,
  programId: program,
});
assert.equal(initializeInventoryPermission.keys[0].pubkey.equals(match), true);
assert.equal(initializeInventoryPermission.keys[2].pubkey.equals(session.publicKey), true);
assert.equal(initializeInventoryPermission.keys[2].isSigner, true);
assert.equal(initializeInventoryPermission.keys[4].pubkey.equals(aliceInventory.account), true);
assert.equal(initializeInventoryPermission.keys[5].pubkey.equals(privatePermissionPda(aliceInventory.account)), true);

const initializeQuotePermission = createInitPrivateQuotePermissionInstruction({
  matchAddress: match,
  dealer: alice,
  sessionKey: session.publicKey,
  sessionGrantAddress: grant,
  programId: program,
});
assert.equal(initializeQuotePermission.keys[1].pubkey.equals(alice), true);
assert.equal(initializeQuotePermission.keys[2].pubkey.equals(session.publicKey), true);
assert.equal(initializeQuotePermission.keys[2].isSigner, true);
assert.equal(initializeQuotePermission.keys[4].pubkey.equals(aliceQuote.account), true);

const privateQuotePanelSource = await readFile(new URL("../match/PrivateQuotePanel.tsx", import.meta.url), "utf8");
const privateInventoryPanelSource = await readFile(new URL("../match/PrivateInventoryPanel.tsx", import.meta.url), "utf8");
const privacySource = await readFile(new URL("./privacy.ts", import.meta.url), "utf8");
const matchActionsSource = await readFile(new URL("./matchActions.ts", import.meta.url), "utf8");
assert.match(privateQuotePanelSource, /Submit private quote/);
assert.match(privateInventoryPanelSource, /sessionKeypairForMatch/);
assert.doesNotMatch(privateInventoryPanelSource, /wallet\.signTransaction/);
assert.match(privacySource, /sendTeeSessionTransaction/);
assert.doesNotMatch(privacySource, /sendTeeTransaction\(/);
assert.match(privacySource, /!quotePermission\s*\?\s*waitForPrivateQuoteOnTee/);
assert.match(privacySource, /!inventoryPermission\s*\?\s*waitForPrivateInventoryOnTee/);
assert.match(matchActionsSource, /sendSessionTransaction/);
assert.doesNotMatch(matchActionsSource, /preparePrivateQuoteOnchain|submit_quote_session/);

console.log("privacy boundary: reusable quote/inventory PDAs, session permission signers, and private read authorization pass");
