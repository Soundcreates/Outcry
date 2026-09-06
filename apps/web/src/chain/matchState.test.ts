import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Keypair, PublicKey } from "@solana/web3.js";
import outcryIdl from "./idl/outcry.json";
import { createOpenRfqInstruction, createSettleMatchInstruction, createSubmitQuoteInstruction } from "./matchActions";
import { decodePublicMatchAccount, escrowPda, resultPda, roundPda } from "./matchState";

const match = Keypair.generate().publicKey;
const players = Array.from({ length: 4 }, () => Keypair.generate().publicKey);
const data = new Uint8Array(373);
const matchDiscriminator = outcryIdl.accounts.find((account) => account.name === "Match")?.discriminator ?? [];
data.set(matchDiscriminator, 0);
data[80] = 1;
data[81] = 4;
data[82] = 4;
data[83] = 0;
players.forEach((player, index) => data.set(player.toBytes(), 84 + index * 32));

const snapshot = decodePublicMatchAccount(match.toBase58(), data);
assert.equal(snapshot.status, "STARTED");
assert.equal(snapshot.playerCount, 4);
assert.deepEqual(snapshot.players, players.map((player) => player.toBase58()));
const legacyData = new Uint8Array(372);
legacyData.set(matchDiscriminator, 0);
legacyData[80] = 1;
legacyData[81] = 4;
legacyData[82] = 4;
players.forEach((player, index) => legacyData.set(player.toBytes(), 83 + index * 32));
const legacySnapshot = decodePublicMatchAccount(match.toBase58(), legacyData);
assert.equal(legacySnapshot.capacity, 4);
assert.equal(legacySnapshot.playerCount, 4);
assert.equal(legacySnapshot.currentRound, 0);
assert.deepEqual(legacySnapshot.players, players.map((player) => player.toBase58()));
assert.throws(() => decodePublicMatchAccount(match.toBase58(), new Uint8Array(373)), /match_account_invalid/);

const instruction = createOpenRfqInstruction({
  matchAddress: match.toBase58(),
  playerAddress: players[0].toBase58(),
  round: 0,
  side: "BUY",
  quantity: 2,
});
assert.equal(instruction.data.length, 25);
assert.equal(instruction.keys[0]?.pubkey.toBase58(), match.toBase58());
assert.equal(instruction.keys[0]?.isWritable, true);
assert.equal(instruction.keys[3]?.pubkey.toBase58(), players[0].toBase58());
assert.equal(instruction.keys[3]?.isSigner, true);
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
assert.equal(quoteInstruction.keys[4]?.pubkey.toBase58(), players[1].toBase58());
assert.equal(quoteInstruction.keys[4]?.isSigner, true);
assert.throws(() => createSubmitQuoteInstruction({ matchAddress: match.toBase58(), dealerAddress: players[1].toBase58(), round: 0, priceE6: 0 }), /invalid_quote_price/);
const hudSource = await readFile(new URL("../match/MatchHud.tsx", import.meta.url), "utf8");
assert.doesNotMatch(hudSource, /PrivateQuote|PrivateInventory|price_e6|cash_e6|sol_position_lots/);
const pitSource = await readFile(new URL("../world/PitOverlay.tsx", import.meta.url), "utf8");
assert.match(pitSource, /matchSnapshot\?\.taker === walletAddress/);
console.log("match state: validated public account decoding, taker-safe RFQ instruction, and PDA derivation pass");
