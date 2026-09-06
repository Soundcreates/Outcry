import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import outcryIdl from "./idl/outcry.json";
import { createCommitRfqStateInstruction, createInitializeOracleInstruction, createMigrateLegacyMatchInstruction, createOpenRfqInstruction, createSettleMatchInstruction, createStartMatchInstruction, createSubmitQuoteInstruction, waitForRfqExecutionState } from "./matchActions";
import { decodePublicMatchAccount, escrowPda, loadPublicMatchState, oraclePda, resultPda, roundPda } from "./matchState";

const match = Keypair.generate().publicKey;
const players = Array.from({ length: 4 }, () => Keypair.generate().publicKey);
const data = new Uint8Array(373);
const matchDiscriminator = outcryIdl.accounts.find((account) => account.name === "Match")?.discriminator ?? [];
data.set(matchDiscriminator, 0);
data.set(players[0].toBytes(), 8);
data.set(Keypair.generate().publicKey.toBytes(), 40);
new DataView(data.buffer).setBigUint64(72, 1n, true);
data[80] = 1;
data[81] = 4;
data[82] = 4;
data[83] = 0;
players.forEach((player, index) => data.set(player.toBytes(), 84 + index * 32));

const snapshot = decodePublicMatchAccount(match.toBase58(), data);
assert.equal(snapshot.status, "STARTED");
assert.equal(snapshot.authority, players[0].toBase58());
assert.equal(snapshot.host, players[0].toBase58());
assert.equal(snapshot.taker, players[0].toBase58());
assert.equal(snapshot.playerCount, 4);
assert.deepEqual(snapshot.players, players.map((player) => player.toBase58()));
const legacyData = new Uint8Array(372);
legacyData.set(matchDiscriminator, 0);
legacyData.set(players[0].toBytes(), 8);
legacyData.set(Keypair.generate().publicKey.toBytes(), 40);
new DataView(legacyData.buffer).setBigUint64(72, 1n, true);
legacyData[80] = 1;
legacyData[81] = 4;
legacyData[82] = 4;
players.forEach((player, index) => legacyData.set(player.toBytes(), 83 + index * 32));
const legacySnapshot = decodePublicMatchAccount(match.toBase58(), legacyData);
assert.equal(legacySnapshot.capacity, 4);
assert.equal(legacySnapshot.playerCount, 4);
assert.equal(legacySnapshot.currentRound, 0);
assert.equal(legacySnapshot.authority, players[0].toBase58());
assert.equal(legacySnapshot.host, players[0].toBase58());
assert.deepEqual(legacySnapshot.players, players.map((player) => player.toBase58()));
assert.throws(() => decodePublicMatchAccount(match.toBase58(), new Uint8Array(373)), /match_account_invalid/);

const instruction = createOpenRfqInstruction({
  matchAddress: match.toBase58(),
  playerAddress: players[0].toBase58(),
  round: 0,
  side: "BUY",
  quantity: 2,
});
const startInstruction = createStartMatchInstruction({
  matchAddress: match.toBase58(),
  hostAddress: players[0].toBase58(),
});
const initializeOracleInstruction = createInitializeOracleInstruction({
  authorityAddress: players[0].toBase58(),
});
const migrateInstruction = createMigrateLegacyMatchInstruction({
  matchAddress: match.toBase58(),
  hostAddress: players[0].toBase58(),
});
assert.equal(startInstruction.data.length, 8);
assert.equal(migrateInstruction.data.length, 8);
assert.equal(migrateInstruction.keys[0]?.pubkey.toBase58(), match.toBase58());
assert.equal(migrateInstruction.keys[1]?.pubkey.toBase58(), players[0].toBase58());
assert.equal(migrateInstruction.keys[2]?.pubkey.toBase58(), "11111111111111111111111111111111");
assert.equal(migrateInstruction.keys[1]?.isWritable, true);
assert.equal(startInstruction.keys[0]?.pubkey.toBase58(), match.toBase58());
assert.equal(startInstruction.keys[1]?.pubkey.toBase58(), players[0].toBase58());
assert.equal(startInstruction.keys[1]?.isSigner, true);
assert.equal(initializeOracleInstruction.data.length, 40);
assert.equal(initializeOracleInstruction.keys[0]?.pubkey.toBase58(), oraclePda().toBase58());
assert.equal(initializeOracleInstruction.keys[1]?.pubkey.toBase58(), "ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
assert.equal(initializeOracleInstruction.keys[2]?.pubkey.toBase58(), players[0].toBase58());
assert.equal(initializeOracleInstruction.keys[2]?.isSigner, true);
assert.equal(instruction.data.length, 25);
assert.equal(instruction.keys[0]?.pubkey.toBase58(), match.toBase58());
assert.equal(instruction.keys[0]?.isWritable, true);
assert.equal(instruction.keys[3]?.pubkey.toBase58(), players[0].toBase58());
assert.equal(instruction.keys[3]?.isSigner, true);
assert.equal(instruction.keys[3]?.isWritable, false);
assert.equal(roundPda(match.toBase58(), 0).toBase58(), instruction.keys[1]?.pubkey.toBase58());
assert.equal(new PublicKey(outcryIdl.address).toBase58(), instruction.programId.toBase58());
const magicFeeVault = Keypair.generate().publicKey;
const commitInstruction = createCommitRfqStateInstruction({
  matchAddress: match.toBase58(),
  round: 0,
  payer: players[0],
  magicFeeVaultAddress: magicFeeVault.toBase58(),
});
assert.equal(commitInstruction.keys[4]?.pubkey.toBase58(), magicFeeVault.toBase58());
assert.equal(commitInstruction.keys[4]?.isWritable, true);
const result = resultPda(match.toBase58());
const settlement = createSettleMatchInstruction({
  matchAddress: match.toBase58(),
  resultAddress: result.toBase58(),
  winnerAddress: players[0].toBase58(),
});
assert.equal(settlement.keys[1]?.pubkey.toBase58(), result.toBase58());
assert.equal(settlement.keys[2]?.pubkey.toBase58(), escrowPda(match.toBase58()).toBase58());
assert.equal(settlement.keys[3]?.isSigner, true);
assert.equal(settlement.keys[3]?.isWritable, true);
const quoteInstruction = createSubmitQuoteInstruction({
  matchAddress: match.toBase58(),
  dealerAddress: players[1].toBase58(),
  round: 0,
  priceE6: 105_000_000,
});
assert.equal(quoteInstruction.data.length, 16);
assert.equal(quoteInstruction.keys[4]?.pubkey.toBase58(), players[1].toBase58());
assert.equal(quoteInstruction.keys[4]?.isSigner, true);
assert.throws(() => createSubmitQuoteInstruction({ matchAddress: match.toBase58(), dealerAddress: players[1].toBase58(), round: 0, priceE6: 0 }), /invalid_quote_price/);
const roundDiscriminator = outcryIdl.accounts.find((account) => account.name === "RfqRound")?.discriminator ?? [];
const preparedRound = new Uint8Array(181);
preparedRound.set(roundDiscriminator, 0);
preparedRound.set(match.toBytes(), 8);
preparedRound[40] = 0;
preparedRound.set(players[0].toBytes(), 41);
preparedRound[73] = 0;
preparedRound[99] = 2;
const preparedConnection = {
  getAccountInfo: async (address: PublicKey) => ({
    owner: new PublicKey(outcryIdl.address),
    data: Buffer.from(address.equals(match) ? data : preparedRound),
  }),
  getMultipleAccountsInfo: async (addresses: PublicKey[]) => addresses.map(() => ({
    owner: new PublicKey(outcryIdl.address),
    data: Buffer.from(preparedRound),
  })),
} as never;
const preparedSnapshot = await loadPublicMatchState({
  rpcUrl: "https://unused.invalid",
  matchAddress: match.toBase58(),
  connection: preparedConnection,
});
assert.equal(preparedSnapshot.taker, players[0].toBase58());
assert.equal(preparedSnapshot.roundStatus, undefined);
assert.equal(preparedSnapshot.quantityLots, undefined);
const delegatedConnection = {
  getMultipleAccountsInfo: async (addresses: PublicKey[]) => addresses.map(() => ({
    owner: DELEGATION_PROGRAM_ID,
    data: Buffer.alloc(0),
    executable: false,
    lamports: 0,
    rentEpoch: 0,
  })),
} as never;
await waitForRfqExecutionState({
  baseConnection: delegatedConnection,
  teeConnection: delegatedConnection,
  accounts: { match, round: roundPda(match.toBase58(), 0), oracle: oraclePda() },
  attempts: 1,
  retryMs: 0,
});
await assert.rejects(
  waitForRfqExecutionState({
    baseConnection: {
      getMultipleAccountsInfo: async (addresses: PublicKey[]) => addresses.map(() => ({
        owner: new PublicKey(outcryIdl.address),
        data: Buffer.alloc(0),
        executable: false,
        lamports: 0,
        rentEpoch: 0,
      })),
    } as never,
    teeConnection: delegatedConnection,
    accounts: { match },
    attempts: 1,
    retryMs: 0,
  }),
  /rfq_state_not_ready:match_not_delegated/,
);
const hudSource = await readFile(new URL("../match/MatchHud.tsx", import.meta.url), "utf8");
assert.doesNotMatch(hudSource, /PrivateQuote|PrivateInventory|price_e6|cash_e6|sol_position_lots/);
assert.match(hudSource, /YOU ARE THE HOST/);
assert.match(hudSource, /onchain players seated/);
assert.match(hudSource, /minimum 2 required/);
assert.match(hudSource, /Full pit · starting in/);
assert.match(hudSource, /Full pit · host start in/);
assert.match(hudSource, /Retry match state/);
const pitSource = await readFile(new URL("../world/PitOverlay.tsx", import.meta.url), "utf8");
assert.match(pitSource, /matchSnapshot\?\.taker === walletAddress/);
assert.match(pitSource, /startMatchOnchain/);
assert.match(pitSource, /rpcUrl: baseSolanaRpc/);
assert.match(pitSource, /VITE_MAGICBLOCK_ROUTER_RPC/);
assert.doesNotMatch(pitSource, /rpcUrl: teeSolanaRpc \|\| baseSolanaRpc/);
assert.match(pitSource, /autoStartIn/);
assert.match(pitSource, /5_000/);
assert.match(pitSource, /roundStatus === "OPEN"/);
assert.match(pitSource, /magicRouterRpcUrl: magicRouterRpc/);
const matchStateSource = await readFile(new URL("./matchState.ts", import.meta.url), "utf8");
assert.match(matchStateSource, /MATCH_STATE_TIMEOUT_MS = 8_000/);
assert.match(matchStateSource, /getMultipleAccountsInfo/);
const matchActionsSource = await readFile(new URL("./matchActions.ts", import.meta.url), "utf8");
assert.match(matchActionsSource, /ConnectionMagicRouter/);
assert.match(matchActionsSource, /getLatestBlockhashForTransaction/);
assert.match(matchActionsSource, /rfq_state_not_ready/);
console.log("match state: validated public account decoding, taker-safe RFQ instruction, and PDA derivation pass");
