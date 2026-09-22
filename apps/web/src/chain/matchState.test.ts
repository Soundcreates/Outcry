import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import outcryIdl from "./idl/outcry.json";
import {
  createAdvanceRoundInstruction,
  createOpenRfqInstruction,
  createRenewSessionInstruction,
  createResolveRoundInstruction,
  createSettleMatchInstruction,
  createSkipEmptyRoundInstruction,
  createStartMatchInstruction,
  createSubmitQuoteInstruction,
  createUpdateOracleInstruction,
  normalizeRfqError,
  sessionGrantPda,
} from "./matchActions";
import { currentRoundTaker, decodePublicMatchAccount, loadPublicMatchState, loadRuntimeMatchState, resultPda, runtimePda } from "./matchState";

const programId = new PublicKey(outcryIdl.address);
const match = Keypair.generate().publicKey;
const players = Array.from({ length: 4 }, () => Keypair.generate().publicKey);
const discriminator = (name: string) => Uint8Array.from(outcryIdl.accounts.find((account) => account.name === name)?.discriminator ?? []);

const matchData = new Uint8Array(205);
matchData.set(discriminator("MatchV2"));
matchData.set(players[0].toBytes(), 8);
matchData.set(Keypair.generate().publicKey.toBytes(), 40);
matchData[72] = 1;
matchData[73] = 4;
matchData[74] = 4;
matchData[75] = 3;
players.forEach((player, index) => matchData.set(player.toBytes(), 76 + index * 32));
const matchSnapshot = decodePublicMatchAccount(match.toBase58(), matchData);
assert.equal(matchSnapshot.status, "STARTED");
assert.equal(matchSnapshot.currentRound, 0);
assert.equal(matchSnapshot.roundCount, 3);
assert.deepEqual(matchSnapshot.players, players.map((player) => player.toBase58()));
assert.equal(currentRoundTaker(matchSnapshot), players[0].toBase58());
assert.equal(currentRoundTaker({ ...matchSnapshot, currentRound: 1, taker: undefined }), players[1].toBase58());
assert.throws(() => decodePublicMatchAccount(match.toBase58(), new Uint8Array(204)), /match_account_invalid/);

const runtimeData = new Uint8Array(286);
runtimeData.set(discriminator("MatchRuntime"));
runtimeData.set(match.toBytes(), 8);
runtimeData[40] = 0;
runtimeData.set(players[0].toBytes(), 41);
runtimeData[73] = 0;
new DataView(runtimeData.buffer).setBigUint64(74, 1n, true);
new DataView(runtimeData.buffer).setBigInt64(82, 100n, true);
new DataView(runtimeData.buffer).setBigInt64(90, 130n, true);
runtimeData[98] = 2;
runtimeData[99] = 0;
new DataView(runtimeData.buffer).setBigInt64(132, 105_000_000n, true);
runtimeData[180] = 255;

const account = (owner: PublicKey, data: Uint8Array) => ({ owner, executable: false, lamports: 1, data, });
const baseAccounts = new Map<string, { owner: PublicKey; executable: boolean; lamports: number; data: Uint8Array }>([
  [match.toBase58(), account(programId, matchData)],
  [runtimePda(match.toBase58(), programId).toBase58(), account(programId, runtimeData)],
]);
const mockConnection = {
  getAccountInfo: async (address: PublicKey) => baseAccounts.get(address.toBase58()) ?? null,
  getMultipleAccountsInfo: async (addresses: PublicKey[]) => addresses.map((address) => baseAccounts.get(address.toBase58()) ?? null),
} as never;
const loaded = await loadPublicMatchState({ rpcUrl: "http://127.0.0.1:8899", matchAddress: match.toBase58(), programId: programId.toBase58(), connection: mockConnection });
assert.equal(loaded.roundStatus, "OPEN");
assert.equal(loaded.quoteCount, 2);
assert.equal(loaded.oraclePriceE6, 105_000_000);
assert.equal(loaded.taker, players[0].toBase58());

const session = Keypair.generate();
const grant = sessionGrantPda({ matchAddress: match.toBase58(), authorityAddress: players[0].toBase58(), sessionKey: session.publicKey, programId });
const start = createStartMatchInstruction({ matchAddress: match.toBase58(), hostAddress: players[0].toBase58(), sessionKey: session.publicKey, programId });
assert.equal(start.keys[2]?.pubkey.toBase58(), session.publicKey.toBase58());
assert.equal(start.keys[2]?.isSigner, true);
assert.equal(start.keys[3]?.pubkey.toBase58(), grant.toBase58());

const open = createOpenRfqInstruction({ matchAddress: match.toBase58(), authorityAddress: players[0].toBase58(), sessionKey: session.publicKey, side: "BUY", quantityLots: 1, programId });
const renew = createRenewSessionInstruction({ matchAddress: match.toBase58(), authorityAddress: players[0].toBase58(), sessionKey: session.publicKey, programId });
const updateOracle = createUpdateOracleInstruction({ priceFeedAddress: Keypair.generate().publicKey.toBase58(), programId });
const submit = createSubmitQuoteInstruction({ matchAddress: match.toBase58(), authorityAddress: players[1].toBase58(), sessionKey: session.publicKey, priceE6: 105_000_000, programId });
assert.equal(open.keys[4]?.isSigner, true);
assert.equal(submit.keys[4]?.isSigner, true);
assert.equal(open.keys[5]?.isSigner, false);
assert.equal(open.keys[2]?.isWritable, false);
assert.equal(open.keys.length, 6);
assert.equal(submit.keys[5]?.isSigner, false);
assert.equal(renew.keys[1]?.pubkey.toBase58(), grant.toBase58());
assert.equal(renew.keys[1]?.isWritable, true);
assert.equal(renew.keys[2]?.isSigner, true);
assert.equal(updateOracle.keys.length, 2);
assert.equal(updateOracle.keys[0]?.isWritable, true);

const resolve = createResolveRoundInstruction({ matchAddress: match.toBase58(), takerAddress: players[0].toBase58(), quoteAddresses: [players[1].toBase58()], inventoryAddresses: players.map((player) => player.toBase58()), programId });
const skip = createSkipEmptyRoundInstruction({ matchAddress: match.toBase58(), programId });
const advance = createAdvanceRoundInstruction({ matchAddress: match.toBase58(), programId });
const settle = createSettleMatchInstruction({ matchAddress: match.toBase58(), winnerAddress: players[1].toBase58(), programId });
for (const ix of [resolve, skip, advance, settle]) assert.equal(ix.keys.some((key) => key.isSigner), false, "deterministic transition has no signer");
assert.equal(settle.keys[3]?.pubkey.toBase58(), players[1].toBase58());
assert.equal(settle.keys[3]?.isSigner, false);
assert.equal(normalizeRfqError(new Error("custom program error: 0x1799")).code, "session_expired");
const actionsSource = await readFile(new URL("./matchActions.ts", import.meta.url), "utf8");
assert.match(actionsSource, /api\/oracle\/sol-usd-update/);
assert.doesNotMatch(actionsSource, /PYTH_HERMES|PYTH_API|postPythPriceAndConsume/);
assert.match(actionsSource, /VITE_OUTCRY_RELAYER_URL \|\| worldApiBaseUrl\(\)/);
assert.match(actionsSource, /permissionless_relayer_unreachable/);
assert.match(actionsSource, /body\.applied !== true/);

const delegatedAccounts = new Map(baseAccounts);
delegatedAccounts.set(runtimePda(match.toBase58(), programId).toBase58(), account(DELEGATION_PROGRAM_ID, runtimeData));
const teeConnection = {
  getAccountInfo: async (address: PublicKey) => address.equals(runtimePda(match.toBase58(), programId)) ? account(DELEGATION_PROGRAM_ID, runtimeData) : null,
} as never;
const delegatedConnection = {
  getAccountInfo: async (address: PublicKey) => delegatedAccounts.get(address.toBase58()) ?? null,
  getMultipleAccountsInfo: async (addresses: PublicKey[]) => addresses.map((address) => delegatedAccounts.get(address.toBase58()) ?? null),
} as never;
const runtimeSnapshot = await loadRuntimeMatchState({ rpcUrl: "http://127.0.0.1:8899", matchAddress: match.toBase58(), programId: programId.toBase58(), baseConnection: delegatedConnection, teeConnection });
assert.equal(runtimeSnapshot.stateSource, "tee");
assert.equal(runtimeSnapshot.roundOwner, DELEGATION_PROGRAM_ID.toBase58());
assert.equal(resultPda(match.toBase58(), programId).toBase58(), runtimeSnapshot.resultAddress);
console.log("match state/actions: V2 layout, session-only gameplay, reusable runtime, and permissionless transitions verified");
