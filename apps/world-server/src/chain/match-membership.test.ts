import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { isMatchMemberAtSeat, isValidMatchAccount } from "./match-membership";

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
const wallet = Keypair.generate().publicKey;
wallet.toBuffer().copy(legacyData, 83);
wallet.toBuffer().copy(legacyData, 211);
assert.equal(isMatchMemberAtSeat(legacyData, wallet, 0), true);
assert.equal(isMatchMemberAtSeat(legacyData, Keypair.generate().publicKey, 0), false);
assert.equal(isValidMatchAccount({ owner: programId, data: Buffer.alloc(371) }, programId), false);
const wrongDiscriminator = Buffer.from(validData);
wrongDiscriminator[0] ^= 1;
assert.equal(isValidMatchAccount({ owner: programId, data: wrongDiscriminator }, programId), false);

console.log("match membership: missing, wrong-owner, wrong-size, and wrong-discriminator accounts fail closed");
