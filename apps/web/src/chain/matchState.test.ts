import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import outcryIdl from "./idl/outcry.json";
import { createInitializeOracleInstruction, createMigrateLegacyMatchInstruction, createNextRoundInstruction, createOpenRfqInstruction, createResolveRoundInstruction, createSettleMatchInstruction, createStartMatchInstruction, createSubmitQuoteInstruction, createUndelegateOracleInstruction, createUndelegateRoundInstruction, waitForRfqExecutionState } from "./matchActions";
import { baseRpcConfigurationMessage, parseBrowserBaseRpc } from "./baseRpc";
import { decodePublicMatchAccount, escrowPda, loadPublicMatchState, oraclePda, resultPda, roundPda } from "./matchState";
import { privateInventoryPda } from "./privacy";

const match = Keypair.generate().publicKey;
const players = Array.from({ length: 4 }, () => Keypair.generate().publicKey);
const magicFeeVault = Keypair.generate().publicKey;
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
  priceUpdateAddress: players[1].toBase58(),
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
assert.equal(initializeOracleInstruction.keys[1]?.pubkey.toBase58(), players[1].toBase58());
assert.equal(initializeOracleInstruction.keys[2]?.pubkey.toBase58(), players[0].toBase58());
assert.equal(initializeOracleInstruction.keys[2]?.isSigner, true);
assert.equal(instruction.data.length, 25);
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
assert.equal(preparedSnapshot.roundStatus, undefined);
assert.equal(preparedSnapshot.quantityLots, undefined);
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
const pitSource = await readFile(new URL("../world/PitOverlay.tsx", import.meta.url), "utf8");
assert.match(pitSource, /matchSnapshot\?\.taker === walletAddress/);
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
assert.doesNotMatch(pitSource, /magicRouterRpcUrl: magicRouterRpc/);
const matchStateSource = await readFile(new URL("./matchState.ts", import.meta.url), "utf8");
assert.match(matchStateSource, /MATCH_STATE_TIMEOUT_MS = 8_000/);
assert.match(matchStateSource, /getMultipleAccountsInfo/);
const baseRpcSource = await readFile(new URL("./baseRpc.ts", import.meta.url), "utf8");
assert.match(baseRpcSource, /disableRetryOnRateLimit: true/);
const matchActionsSource = await readFile(new URL("./matchActions.ts", import.meta.url), "utf8");
assert.doesNotMatch(matchActionsSource, /ConnectionMagicRouter/);
assert.doesNotMatch(matchActionsSource, /getLatestBlockhashForTransaction/);
assert.match(matchActionsSource, /ensurePrivateQuote/);
assert.match(matchActionsSource, /rfq_state_not_ready/);
console.log("match state: validated public account decoding, taker-safe RFQ instruction, and PDA derivation pass");
