import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { isJoinableMatchAccount, isMatchMember, isValidMatchAccount, SolanaMatchMembershipReader } from "./match-membership";

const programId = Keypair.generate().publicKey;
const v2Data = Buffer.alloc(205);
Buffer.from([62, 55, 226, 63, 20, 119, 49, 118]).copy(v2Data);
const legacyData = Buffer.alloc(373);
Buffer.from([236, 63, 169, 38, 15, 56, 196, 162]).copy(legacyData);

assert.equal(isValidMatchAccount({ owner: programId, data: v2Data }, programId), true);
assert.equal(isValidMatchAccount({ owner: new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"), data: v2Data }, programId), true);
assert.equal(isValidMatchAccount({ owner: PublicKey.unique(), data: v2Data }, programId), false);
assert.equal(isValidMatchAccount({ owner: programId, data: Buffer.alloc(204) }, programId), false);
assert.equal(isValidMatchAccount({ owner: programId, data: legacyData }, programId), true);

assert.equal(isJoinableMatchAccount({ owner: programId, data: v2Data }, programId), true);
v2Data[72] = 2;
assert.equal(isJoinableMatchAccount({ owner: programId, data: v2Data }, programId), false);
v2Data[72] = 1;

const wallet = Keypair.generate().publicKey;
v2Data[73] = 4;
v2Data[74] = 1;
wallet.toBuffer().copy(v2Data, 76);
assert.equal(isMatchMember(v2Data, wallet), true);
assert.equal(isMatchMember(v2Data, Keypair.generate().publicKey), false);
assert.equal(isMatchMember(v2Data, PublicKey.default), false);

legacyData[81] = 4;
legacyData[82] = 1;
wallet.toBuffer().copy(legacyData, 83);
assert.equal(isMatchMember(legacyData, wallet), true);
assert.doesNotThrow(() => isMatchMember(legacyData, wallet));

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
      if (address.equals(activeMatch)) return { owner: programId, data: v2Data };
      return null;
    },
  },
});
assert.equal(await reader.readActiveMatch("wall-street-01"), activeMatch.toBase58());
assert.equal(await reader.isConfirmed({ matchAddress: activeMatch.toBase58(), walletAddress: wallet.toBase58() }), true);

console.log("match membership: V2 authority membership, legacy read compatibility, and invalid-account checks pass");
