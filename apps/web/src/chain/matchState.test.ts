import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import outcryIdl from "./idl/outcry.json";
import { createAuthorizeQuoteSessionInstruction, createInitializeEscrowInstruction, createInitializeOracleInstruction, createMigrateLegacyMatchInstruction, createNextRoundInstruction, createOpenRfqInstruction, createPrepareRfqRoundInstruction, createResolveRoundInstruction, createSettleMatchInstruction, createSkipEmptyRoundInstruction, createStartMatchInstruction, createSubmitQuoteInstruction, createSubmitQuoteSessionInstruction, createUndelegateOracleInstruction, createUndelegateRoundInstruction, DEFAULT_MATCH_PAYOUT_LAMPORTS, DEFAULT_QUOTE_WINDOW_SECONDS, sessionGrantPda, waitForRfqExecutionState } from "./matchActions";
import { baseRpcConfigurationMessage, parseBrowserBaseRpc } from "./baseRpc";
import { decodePublicMatchAccount, escrowPda, loadPublicMatchState, loadRuntimeMatchState, oraclePda, resultPda, roundPda } from "./matchState";
import { privateInventoryPda } from "./privacy";

const match = Keypair.generate().publicKey;
const players = Array.from({ length: 4 }, () => Keypair.generate().publicKey);
const magicFeeVault = Keypair.generate().publicKey;
const data = new Uint8Array(407);
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
data[373] = 3;
data[374] = 255;

const snapshot = decodePublicMatchAccount(match.toBase58(), data);
assert.equal(snapshot.status, "STARTED");
assert.equal(snapshot.authority, players[0].toBase58());
assert.equal(snapshot.host, players[0].toBase58());
assert.equal(snapshot.taker, players[0].toBase58());
assert.equal(snapshot.playerCount, 4);
assert.equal(snapshot.roundCount, 3);
assert.deepEqual(snapshot.players, players.map((player) => player.toBase58()));
const authorityAfterAnotherPlayerJoined = players[1];
const authorityFirstSnapshotData = new Uint8Array(data);
authorityFirstSnapshotData.set(authorityAfterAnotherPlayerJoined.toBytes(), 8);
const authorityFirstSnapshot = decodePublicMatchAccount(match.toBase58(), authorityFirstSnapshotData);
assert.equal(authorityFirstSnapshot.host, authorityAfterAnotherPlayerJoined.toBase58());
assert.equal(authorityFirstSnapshot.taker, authorityAfterAnotherPlayerJoined.toBase58());
const resolvedData = new Uint8Array(data);
resolvedData[83] = 1;
resolvedData[374] = 0;
resolvedData.set(players[1].toBytes(), 375);
const resolvedSnapshot = decodePublicMatchAccount(match.toBase58(), resolvedData);
assert.equal(resolvedSnapshot.lastResolvedRound, 0);
assert.equal(resolvedSnapshot.lastRoundWinner, players[1].toBase58());
const previousData = new Uint8Array(data.subarray(0, 373));
const previousSnapshot = decodePublicMatchAccount(match.toBase58(), previousData);
assert.equal(previousSnapshot.roundCount, 8);
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
assert.equal(legacySnapshot.roundCount, 8);
assert.equal(legacySnapshot.authority, players[0].toBase58());
assert.equal(legacySnapshot.host, players[0].toBase58());
assert.deepEqual(legacySnapshot.players, players.map((player) => player.toBase58()));
assert.throws(() => decodePublicMatchAccount(match.toBase58(), new Uint8Array(406)), /match_account_invalid/);

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
const prepareInstruction = createPrepareRfqRoundInstruction({
  matchAddress: match.toBase58(),
  takerAddress: players[0].toBase58(),
  round: 0,
});
const initializeOracleInstruction = createInitializeOracleInstruction({
  authorityAddress: players[0].toBase58(),
  priceUpdateAddress: players[1].toBase58(),
});
const migrateInstruction = createMigrateLegacyMatchInstruction({
  matchAddress: match.toBase58(),
  hostAddress: players[0].toBase58(),
});
assert.equal(startInstruction.data.length, 9);
assert.equal(startInstruction.data[8], 3);
const customStartInstruction = createStartMatchInstruction({
  matchAddress: match.toBase58(),
  hostAddress: players[0].toBase58(),
  roundCount: 6,
});
assert.equal(customStartInstruction.data[8], 6);
assert.throws(() => createStartMatchInstruction({ matchAddress: match.toBase58(), hostAddress: players[0].toBase58(), roundCount: 0 }), /invalid_round_count/);
assert.throws(() => createStartMatchInstruction({ matchAddress: match.toBase58(), hostAddress: players[0].toBase58(), roundCount: 9 }), /invalid_round_count/);
assert.equal(migrateInstruction.data.length, 8);
assert.equal(migrateInstruction.keys[0]?.pubkey.toBase58(), match.toBase58());
assert.equal(migrateInstruction.keys[1]?.pubkey.toBase58(), players[0].toBase58());
assert.equal(migrateInstruction.keys[2]?.pubkey.toBase58(), "11111111111111111111111111111111");
assert.equal(migrateInstruction.keys[1]?.isWritable, true);
assert.equal(startInstruction.keys[0]?.pubkey.toBase58(), match.toBase58());
assert.equal(startInstruction.keys[1]?.pubkey.toBase58(), players[0].toBase58());
assert.equal(startInstruction.keys[1]?.isSigner, true);
assert.equal(prepareInstruction.keys[0]?.pubkey.toBase58(), match.toBase58());
assert.equal(prepareInstruction.keys[1]?.pubkey.toBase58(), roundPda(match.toBase58(), 0).toBase58());
assert.equal(prepareInstruction.keys[2]?.pubkey.toBase58(), players[0].toBase58());
assert.equal(prepareInstruction.keys[2]?.isSigner, true);
assert.equal(initializeOracleInstruction.data.length, 40);
assert.equal(initializeOracleInstruction.keys[0]?.pubkey.toBase58(), oraclePda().toBase58());
assert.equal(initializeOracleInstruction.keys[1]?.pubkey.toBase58(), players[1].toBase58());
assert.equal(initializeOracleInstruction.keys[2]?.pubkey.toBase58(), players[0].toBase58());
assert.equal(initializeOracleInstruction.keys[2]?.isSigner, true);
assert.equal(instruction.data.length, 25);
assert.equal(DEFAULT_QUOTE_WINDOW_SECONDS, 30);
assert.equal(new DataView(instruction.data.buffer, instruction.data.byteOffset, instruction.data.byteLength).getBigInt64(17, true), 30n);
assert.equal(instruction.keys[0]?.pubkey.toBase58(), match.toBase58());
assert.equal(instruction.keys[0]?.isWritable, false);
assert.equal(instruction.keys[3]?.pubkey.toBase58(), players[0].toBase58());
assert.equal(instruction.keys[3]?.isSigner, true);
assert.equal(instruction.keys[3]?.isWritable, false);
assert.equal(roundPda(match.toBase58(), 0).toBase58(), instruction.keys[1]?.pubkey.toBase58());
assert.equal(new PublicKey(outcryIdl.address).toBase58(), instruction.programId.toBase58());
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
const escrowInitialization = createInitializeEscrowInstruction({
  matchAddress: match.toBase58(),
  authorityAddress: players[0].toBase58(),
});
assert.equal(escrowInitialization.data.length, 16);
assert.equal(new DataView(escrowInitialization.data.buffer, escrowInitialization.data.byteOffset, escrowInitialization.data.byteLength).getBigUint64(8, true), BigInt(DEFAULT_MATCH_PAYOUT_LAMPORTS));
assert.equal(escrowInitialization.keys[1]?.pubkey.toBase58(), escrowPda(match.toBase58()).toBase58());
assert.throws(() => createInitializeEscrowInstruction({ matchAddress: match.toBase58(), authorityAddress: players[0].toBase58(), payoutLamports: 0 }), /invalid_escrow_payout/);
const quoteInstruction = createSubmitQuoteInstruction({
  matchAddress: match.toBase58(),
  dealerAddress: players[1].toBase58(),
  round: 0,
  priceE6: 105_000_000,
});
assert.equal(quoteInstruction.data.length, 16);
assert.equal(quoteInstruction.keys[3]?.pubkey.toBase58(), players[1].toBase58());
assert.equal(quoteInstruction.keys[3]?.isSigner, true);
assert.throws(() => createSubmitQuoteInstruction({ matchAddress: match.toBase58(), dealerAddress: players[1].toBase58(), round: 0, priceE6: 0 }), /invalid_quote_price/);
const quoteSessionKey = Keypair.generate().publicKey;
const quoteSessionGrant = sessionGrantPda({
  matchAddress: match.toBase58(),
  authorityAddress: players[1].toBase58(),
  sessionKey: quoteSessionKey,
});
const authorizeQuoteSession = createAuthorizeQuoteSessionInstruction({
  matchAddress: match.toBase58(),
  authorityAddress: players[1].toBase58(),
  sessionKey: quoteSessionKey,
});
assert.equal(authorizeQuoteSession.data.length, 49);
assert.equal(new DataView(authorizeQuoteSession.data.buffer, authorizeQuoteSession.data.byteOffset, authorizeQuoteSession.data.byteLength).getBigInt64(40, true), 900n);
assert.equal(authorizeQuoteSession.data[48], 2);
assert.equal(authorizeQuoteSession.keys[1]?.pubkey.toBase58(), quoteSessionGrant.toBase58());
assert.equal(authorizeQuoteSession.keys[2]?.pubkey.toBase58(), players[1].toBase58());
assert.equal(authorizeQuoteSession.keys[2]?.isSigner, true);
const quoteSessionInstruction = createSubmitQuoteSessionInstruction({
  matchAddress: match.toBase58(),
  dealerAddress: players[1].toBase58(),
  round: 0,
  priceE6: 105_000_000,
  sessionKey: quoteSessionKey,
});
assert.equal(quoteSessionInstruction.data.length, 16);
assert.equal(quoteSessionInstruction.keys[2]?.isSigner, false);
assert.equal(quoteSessionInstruction.keys[4]?.pubkey.toBase58(), quoteSessionKey.toBase58());
assert.equal(quoteSessionInstruction.keys[4]?.isSigner, true);
assert.equal(quoteSessionInstruction.keys[5]?.pubkey.toBase58(), quoteSessionGrant.toBase58());
const resolveInstruction = createResolveRoundInstruction({
  matchAddress: match.toBase58(),
  round: 0,
  takerAddress: players[0].toBase58(),
  resolverAddress: players[0].toBase58(),
  remainingAccounts: [{ pubkey: players[1], isWritable: false, isSigner: false }],
});
assert.equal(resolveInstruction.data.length, 8);
assert.equal(resolveInstruction.keys[0]?.isWritable, false);
assert.equal(resolveInstruction.keys[1]?.pubkey.toBase58(), roundPda(match.toBase58(), 0).toBase58());
assert.equal(resolveInstruction.keys[2]?.pubkey.toBase58(), privateInventoryPda({ matchAddress: match, player: players[0], programId: new PublicKey(outcryIdl.address) }).toBase58());
assert.equal(resolveInstruction.keys[2]?.isWritable, true);
assert.equal(resolveInstruction.keys[3]?.pubkey.toBase58(), players[0].toBase58());
assert.equal(resolveInstruction.keys[3]?.isSigner, true);
assert.equal(resolveInstruction.keys[4]?.pubkey.toBase58(), players[1].toBase58());
const skipInstruction = createSkipEmptyRoundInstruction({
  matchAddress: match.toBase58(),
  round: 0,
  authorityAddress: players[0].toBase58(),
});
assert.equal(skipInstruction.data.length, 8);
assert.equal(skipInstruction.keys[0]?.pubkey.toBase58(), match.toBase58());
assert.equal(skipInstruction.keys[1]?.pubkey.toBase58(), roundPda(match.toBase58(), 0).toBase58());
assert.equal(skipInstruction.keys[2]?.pubkey.toBase58(), players[0].toBase58());
assert.equal(skipInstruction.keys[2]?.isSigner, true);
const undelegateInstruction = createUndelegateRoundInstruction({ roundAddress: roundPda(match.toBase58(), 0), payer: players[0], magicFeeVaultAddress: magicFeeVault.toBase58() });
assert.equal(undelegateInstruction.data.length, 8);
assert.equal(undelegateInstruction.keys[0]?.isSigner, true);
assert.equal(undelegateInstruction.keys[1]?.pubkey.toBase58(), roundPda(match.toBase58(), 0).toBase58());
const undelegateOracleInstruction = createUndelegateOracleInstruction({ oracleAddress: oraclePda(), payer: players[0], magicFeeVaultAddress: magicFeeVault.toBase58() });
assert.equal(undelegateOracleInstruction.data.length, 8);
assert.equal(undelegateOracleInstruction.keys[0]?.isWritable, true);
assert.equal(undelegateOracleInstruction.keys[0]?.isSigner, true);
assert.equal(undelegateOracleInstruction.keys[1]?.pubkey.toBase58(), oraclePda().toBase58());
assert.equal(undelegateOracleInstruction.keys[1]?.isWritable, true);
const nextRoundInstruction = createNextRoundInstruction({ matchAddress: match.toBase58(), round: 0, authorityAddress: players[0].toBase58() });
assert.equal(nextRoundInstruction.data.length, 8);
assert.equal(nextRoundInstruction.keys[0]?.isWritable, true);
assert.equal(nextRoundInstruction.keys[2]?.isSigner, true);
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
assert.equal(preparedSnapshot.accountOwner, outcryIdl.address);
assert.equal(preparedSnapshot.taker, players[0].toBase58());
assert.equal(preparedSnapshot.roundStatus, "PREPARED");
assert.equal(preparedSnapshot.quantityLots, undefined);
const openRound = new Uint8Array(preparedRound);
new DataView(openRound.buffer).setBigUint64(74, 1n, true);
new DataView(openRound.buffer).setBigInt64(82, 1n, true);
new DataView(openRound.buffer).setBigInt64(90, 2n, true);
openRound[99] = 0;
new DataView(openRound.buffer).setBigInt64(132, 105_000_000n, true);
const openConnection = {
  getAccountInfo: async (address: PublicKey) => ({
    owner: new PublicKey(outcryIdl.address),
    data: Buffer.from(address.equals(match) ? data : openRound),
  }),
  getMultipleAccountsInfo: async (addresses: PublicKey[]) => addresses.map(() => ({
    owner: new PublicKey(outcryIdl.address),
    data: Buffer.from(openRound),
  })),
} as never;
const openSnapshot = await loadPublicMatchState({
  rpcUrl: "https://unused.invalid",
  matchAddress: match.toBase58(),
  connection: openConnection,
});
assert.equal(openSnapshot.oraclePriceE6, 105_000_000);
const preparedRoundOne = new Uint8Array(preparedRound);
preparedRoundOne[40] = 1;
preparedRoundOne.set(players[1].toBytes(), 41);
const resolvedRound = new Uint8Array(openRound);
resolvedRound.set(players[0].toBytes(), 41);
resolvedRound[99] = 1;
resolvedRound.set(players[1].toBytes(), 140);
new DataView(resolvedRound.buffer).setBigInt64(172, 101_250_000n, true);
const resolvedRoundConnection = {
  getAccountInfo: async () => ({
    owner: new PublicKey(outcryIdl.address),
    data: Buffer.from(resolvedData),
  }),
  getMultipleAccountsInfo: async (addresses: PublicKey[]) => addresses.map((address) => ({
    owner: new PublicKey(outcryIdl.address),
    data: Buffer.from(address.equals(roundPda(match.toBase58(), 0)) ? resolvedRound : preparedRoundOne),
  })),
};
const resolvedRoundSnapshot = await loadPublicMatchState({
  rpcUrl: "https://unused.invalid",
  matchAddress: match.toBase58(),
  connection: resolvedRoundConnection as never,
});
assert.equal(resolvedRoundSnapshot.lastRoundResult?.round, 0);
assert.equal(resolvedRoundSnapshot.lastRoundResult?.taker, players[0].toBase58());
assert.equal(resolvedRoundSnapshot.lastRoundResult?.side, "BUY");
assert.equal(resolvedRoundSnapshot.lastRoundResult?.winningDealer, players[1].toBase58());
assert.equal(resolvedRoundSnapshot.lastRoundResult?.clearingPriceE6, 101_250_000n);
assert.equal(resolvedRoundSnapshot.lastRoundResult?.notionalE6, 101_250_000n);
const mismatchedResolvedRound = new Uint8Array(resolvedRound);
mismatchedResolvedRound.set(players[2].toBytes(), 140);
await assert.rejects(
  loadPublicMatchState({
    rpcUrl: "https://unused.invalid",
    matchAddress: match.toBase58(),
    connection: {
      ...resolvedRoundConnection,
      getMultipleAccountsInfo: async (addresses: PublicKey[]) => addresses.map((address) => ({
        owner: new PublicKey(outcryIdl.address),
        data: Buffer.from(address.equals(roundPda(match.toBase58(), 0)) ? mismatchedResolvedRound : preparedRoundOne),
      })),
    } as never,
  }),
  /resolved_round_winner_mismatch/,
);
const skippedRound = new Uint8Array(openRound);
skippedRound[99] = 3;
const skippedConnection = {
  getAccountInfo: async (address: PublicKey) => ({
    owner: new PublicKey(outcryIdl.address),
    data: Buffer.from(address.equals(match) ? data : skippedRound),
  }),
  getMultipleAccountsInfo: async (addresses: PublicKey[]) => addresses.map(() => ({
    owner: new PublicKey(outcryIdl.address),
    data: Buffer.from(skippedRound),
  })),
} as never;
const skippedSnapshot = await loadPublicMatchState({
  rpcUrl: "https://unused.invalid",
  matchAddress: match.toBase58(),
  connection: skippedConnection,
});
assert.equal(skippedSnapshot.roundStatus, "SKIPPED");
const staleBaseRound = new Uint8Array(openRound);
staleBaseRound[98] = 0;
const liveTeeRound = new Uint8Array(openRound);
liveTeeRound[98] = 1;
const delegatedBaseConnection = {
  getAccountInfo: async (address: PublicKey) => ({ owner: DELEGATION_PROGRAM_ID, data: Buffer.from(address.equals(match) ? data : staleBaseRound) }),
  getMultipleAccountsInfo: async (addresses: PublicKey[]) => addresses.map(() => ({ owner: DELEGATION_PROGRAM_ID, data: Buffer.from(staleBaseRound) })),
} as never;
const liveTeeConnection = {
  getAccountInfo: async (address: PublicKey) => ({ owner: DELEGATION_PROGRAM_ID, data: Buffer.from(address.equals(match) ? data : liveTeeRound) }),
  getMultipleAccountsInfo: async (addresses: PublicKey[]) => addresses.map(() => ({ owner: DELEGATION_PROGRAM_ID, data: Buffer.from(liveTeeRound) })),
} as never;
const runtimeSnapshot = await loadRuntimeMatchState({ rpcUrl: "https://unused.invalid", matchAddress: match.toBase58(), baseConnection: delegatedBaseConnection, teeConnection: liveTeeConnection });
assert.equal(runtimeSnapshot.stateSource, "tee");
assert.equal(runtimeSnapshot.quoteCount, 1);
assert.equal(runtimeSnapshot.roundOwner, DELEGATION_PROGRAM_ID.toBase58());
const unavailableRuntimeSnapshot = await loadRuntimeMatchState({ rpcUrl: "https://unused.invalid", matchAddress: match.toBase58(), baseConnection: delegatedBaseConnection });
assert.equal(unavailableRuntimeSnapshot.stateSource, "tee-unavailable");
assert.equal(unavailableRuntimeSnapshot.quoteCount, 0);
assert.deepEqual(parseBrowserBaseRpc(), { url: "https://api.devnet.solana.com" });
assert.deepEqual(parseBrowserBaseRpc("https://api.devnet.solana.com"), { url: "https://api.devnet.solana.com" });
assert.deepEqual(parseBrowserBaseRpc("not-a-url"), { error: "base_rpc_invalid" });
assert.deepEqual(parseBrowserBaseRpc("https://rpc.example.devnet"), { url: "https://rpc.example.devnet" });
assert.match(baseRpcConfigurationMessage("base_rpc_invalid"), /VITE_SOLANA_BASE_RPC is invalid/);
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
assert.match(hudSource, /Round \{lastRoundResult\.round \+ 1\} resolved/);
assert.match(hudSource, /RFQ taker/);
const pitSource = await readFile(new URL("../world/PitOverlay.tsx", import.meta.url), "utf8");
assert.match(pitSource, /matchSnapshot\.taker === walletAddress/);
assert.match(pitSource, /startMatchOnchain/);
assert.match(pitSource, /requireBaseSolanaRpc/);
assert.match(pitSource, /startMatchInFlightRef/);
assert.match(pitSource, /WAITING_MATCH_POLL_MS = 15_000/);
assert.match(pitSource, /ACTIVE_MATCH_POLL_MS = 10_000/);
assert.match(pitSource, /visibilitychange/);
assert.match(pitSource, /RATE_LIMIT_BACKOFF_MS = 10_000/);
assert.doesNotMatch(pitSource, /setInterval\(refresh, 1_500\)/);
assert.doesNotMatch(pitSource, /getAccountInfo\(new PublicKey\(matchAddress\)/);
assert.doesNotMatch(pitSource, /VITE_MAGICBLOCK_ROUTER_RPC/);
assert.doesNotMatch(pitSource, /rpcUrl: teeSolanaRpc \|\| baseSolanaRpc/);
assert.match(pitSource, /autoStartIn/);
assert.match(pitSource, /5_000/);
assert.match(pitSource, /roundStatus === "OPEN"/);
assert.match(pitSource, /roundStatus === "PREPARED"/);
assert.match(pitSource, /prepareRfqRoundOnchain/);
assert.match(pitSource, /round-resolved/);
assert.match(pitSource, /resolvedRound \+ 1 >= matchSnapshot\.roundCount/);
assert.doesNotMatch(pitSource, /magicRouterRpcUrl: magicRouterRpc/);
const matchStateSource = await readFile(new URL("./matchState.ts", import.meta.url), "utf8");
assert.match(matchStateSource, /MATCH_STATE_TIMEOUT_MS = 8_000/);
assert.match(matchStateSource, /getMultipleAccountsInfo/);
const baseRpcSource = await readFile(new URL("./baseRpc.ts", import.meta.url), "utf8");
assert.match(baseRpcSource, /disableRetryOnRateLimit: true/);
const matchActionsSource = await readFile(new URL("./matchActions.ts", import.meta.url), "utf8");
assert.doesNotMatch(matchActionsSource, /ConnectionMagicRouter/);
assert.doesNotMatch(matchActionsSource, /getLatestBlockhashForTransaction/);
assert.match(matchActionsSource, /preparePrivateQuote/);
assert.match(matchActionsSource, /getPreparedPrivateQuote/);
assert.match(matchActionsSource, /submit_quote_session/);
assert.match(matchActionsSource, /private_quote_session_authorization/);
assert.match(matchActionsSource, /additionalSigners/);
assert.match(matchActionsSource, /rfq_round_not_prepared/);
assert.match(matchActionsSource, /rfq_state_not_ready:\$\{unavailable\.join\(","\)\}/);
assert.match(matchActionsSource, /inventory_\$\{index\}/);
assert.match(matchActionsSource, /skip_empty_round/);
assert.match(matchActionsSource, /empty_round_required/);
assert.match(matchActionsSource, /input\.round \+ 1 < input\.snapshot\.roundCount/);
assert.doesNotMatch(matchActionsSource, /input\.round < 7/);
console.log("match state: validated public account decoding, taker-safe RFQ instruction, and PDA derivation pass");
