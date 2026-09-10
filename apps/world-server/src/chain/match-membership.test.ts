import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { isJoinableMatchAccount, isMatchMemberAtSeat, isValidMatchAccount, SolanaMatchMembershipReader } from "./match-membership";

const programId = Keypair.generate().publicKey;
const validData = Buffer.alloc(373);
Buffer.from([236, 63, 169, 38, 15, 56, 196, 162]).copy(validData);

assert.equal(isValidMatchAccount({ owner: programId, data: validData }, programId), true);
assert.equal(isValidMatchAccount({ owner: new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"), data: validData }, programId), true);
assert.equal(isValidMatchAccount(null, programId), false);
assert.equal(isValidMatchAccount({ owner: PublicKey.unique(), data: validData }, programId), false);
const legacyData = Buffer.alloc(372);
Buffer.from([236, 63, 169, 38, 15, 56, 196, 162]).copy(legacyData);
assert.equal(isValidMatchAccount({ owner: programId, data: legacyData }, programId), true);
const currentData = Buffer.alloc(407);
Buffer.from([236, 63, 169, 38, 15, 56, 196, 162]).copy(currentData);
assert.equal(isValidMatchAccount({ owner: programId, data: currentData }, programId), true);
assert.equal(isJoinableMatchAccount({ owner: programId, data: currentData }, programId), true);
currentData[80] = 2;
assert.equal(isValidMatchAccount({ owner: programId, data: currentData }, programId), true);
assert.equal(isJoinableMatchAccount({ owner: programId, data: currentData }, programId), false);
currentData[80] = 1;
assert.equal(isJoinableMatchAccount({ owner: programId, data: currentData }, programId), true);
const wallet = Keypair.generate().publicKey;
wallet.toBuffer().copy(legacyData, 83);
wallet.toBuffer().copy(legacyData, 211);
assert.equal(isMatchMemberAtSeat(legacyData, wallet, 0), true);
wallet.toBuffer().copy(currentData, 84);
wallet.toBuffer().copy(currentData, 212);
assert.equal(isMatchMemberAtSeat(currentData, wallet, 0), true);
assert.equal(isMatchMemberAtSeat(legacyData, Keypair.generate().publicKey, 0), false);
assert.equal(isValidMatchAccount({ owner: programId, data: Buffer.alloc(371) }, programId), false);
const wrongDiscriminator = Buffer.from(validData);
wrongDiscriminator[0] ^= 1;
assert.equal(isValidMatchAccount({ owner: programId, data: wrongDiscriminator }, programId), false);

const pitIdBytes = Buffer.alloc(32);
Buffer.from("wall-street-01").copy(pitIdBytes);
const [pitAddress] = PublicKey.findProgramAddressSync([Buffer.from("pit"), pitIdBytes], programId);
const activeMatch = Keypair.generate().publicKey;
const pitData = Buffer.alloc(106);
activeMatch.toBuffer().copy(pitData, 73);
const reader = new SolanaMatchMembershipReader("http://127.0.0.1:8899", programId.toBase58());
Object.defineProperty(reader, "connection", {
  value: {
    getAccountInfo: async (address: PublicKey) => {
      if (address.equals(pitAddress)) return { owner: programId, data: pitData };
      if (address.equals(activeMatch)) return { owner: programId, data: currentData };
      return null;
    },
  },
});
currentData[80] = 2;
assert.equal(await reader.readActiveMatch("wall-street-01"), activeMatch.toBase58());
currentData[80] = 1;
assert.equal(await reader.readActiveMatch("wall-street-01"), activeMatch.toBase58());
currentData[81] = 1;
currentData[82] = 1;
wallet.toBuffer().copy(currentData, 84);
wallet.toBuffer().copy(currentData, 212);
currentData[80] = 2;
assert.equal(await reader.isConfirmed({
  matchAddress: activeMatch.toBase58(),
  walletAddress: wallet.toBase58(),
  seatIndex: 0,
}), true);

console.log("match membership: missing, wrong-owner, wrong-size, and wrong-discriminator accounts fail closed");
