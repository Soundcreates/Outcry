import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createDelegateRuntimeInstruction } from "./privacy";
import outcryIdl from "./idl/outcry.json";
import { createCreateMatchInstruction, createJoinMatchInstruction, createMigrateLegacyMatchInstruction, createReleaseActiveMatchInstruction, isLegacyMatchAccount, matchBootstrapAddresses, recoverV2MatchNonce, sessionGrantState } from "./joinMatch";
import { runtimePda } from "./matchState";

const programId = new PublicKey(outcryIdl.address);
const match = Keypair.generate().publicKey;
const player = Keypair.generate().publicKey;
const join = createJoinMatchInstruction({ matchAddress: match.toBase58(), playerAddress: player.toBase58(), programId: programId.toBase58() });
assert.equal(join.data.length, 8, "join has no seat argument");
assert.equal(join.keys[1]?.isSigner, true);
assert.equal(join.keys[1]?.pubkey.toBase58(), player.toBase58());
const joinSource = await (await import("node:fs/promises")).readFile(new URL("./joinMatch.ts", import.meta.url), "utf8");
assert.match(joinSource, /SESSION_BASE_FEE_BUFFER_LAMPORTS = 2_000_000/);
assert.doesNotMatch(joinSource, /ensureSessionFeeFunding/);
assert.match(joinSource, /ensureOracleInitialized/);
assert.match(joinSource, /ensureSessionGrantOnBase/);
assert.match(joinSource, /replaceSessionKeypairForMatch/);

const bootstrap = matchBootstrapAddresses({ pitId: "wall-street-01", nonce: 1n, programId: programId.toBase58() });
const expected = PublicKey.findProgramAddressSync([
  new TextEncoder().encode("match_v2"),
  bootstrap.pit.toBytes(),
  Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
], programId)[0];
assert.equal(bootstrap.match.toBase58(), expected.toBase58());

const activeV2 = matchBootstrapAddresses({ pitId: "wall-street-01", nonce: 26n, programId: programId.toBase58() });
assert.equal(recoverV2MatchNonce({
  pitAddress: activeV2.pit,
  activeMatchAddress: activeV2.match,
  programId,
  preferredNonce: 13n,
}), 26n, "release must recover the active V2 nonce instead of trusting stale configuration");
assert.equal(recoverV2MatchNonce({
  pitAddress: activeV2.pit,
  activeMatchAddress: activeV2.match,
  programId,
  preferredNonce: 26n,
}), 26n);
assert.throws(() => recoverV2MatchNonce({
  pitAddress: activeV2.pit,
  activeMatchAddress: Keypair.generate().publicKey,
  programId,
  preferredNonce: 13n,
}), /active_v2_match_nonce_unrecoverable/);

const create = createCreateMatchInstruction({
  pitAddress: bootstrap.pit.toBase58(),
  matchAddress: bootstrap.match.toBase58(),
  authorityAddress: player.toBase58(),
  nonce: 1n,
  programId: programId.toBase58(),
});
assert.equal(create.keys[2]?.pubkey.toBase58(), runtimePda(bootstrap.match.toBase58(), programId).toBase58());
assert.equal(create.keys[1]?.isWritable, true, "new MatchV2 account must be writable for init");
assert.equal(create.keys[2]?.isSigner, false);

const delegateRuntime = createDelegateRuntimeInstruction({
  matchAddress: bootstrap.match,
  payer: player,
  validator: Keypair.generate().publicKey,
  programId,
});
assert.equal(delegateRuntime.keys[0]?.pubkey.toBase58(), player.toBase58());
assert.equal(delegateRuntime.keys[0]?.isSigner, true);
assert.equal(delegateRuntime.keys[4]?.pubkey.toBase58(), runtimePda(bootstrap.match.toBase58(), programId).toBase58());
assert.equal(delegateRuntime.keys[4]?.isWritable, true);
assert.equal(delegateRuntime.data.length, 40, "runtime delegation carries only the match key");

const release = createReleaseActiveMatchInstruction({
  pitAddress: bootstrap.pit.toBase58(),
  matchAddress: bootstrap.match.toBase58(),
  authorityAddress: player.toBase58(),
  nonce: 1n,
  programId: programId.toBase58(),
  force: true,
});
assert.equal(release.data.length, 17, "release encodes nonce and force");
assert.equal(release.data[16], 1);

const migrate = createMigrateLegacyMatchInstruction({
  pitAddress: bootstrap.pit.toBase58(),
  legacyMatchAddress: match.toBase58(),
  matchAddress: bootstrap.match.toBase58(),
  authorityAddress: player.toBase58(),
  nonce: 1n,
  programId: programId.toBase58(),
});
assert.equal(migrate.data.length, 16, "legacy migration encodes the nonce");
assert.equal(migrate.keys[1]?.isWritable, false);
assert.equal(migrate.keys[2]?.isWritable, true);
assert.equal(migrate.keys[3]?.pubkey.toBase58(), runtimePda(bootstrap.match.toBase58(), programId).toBase58());

const legacyMatch = new Uint8Array(372);
legacyMatch.set([236, 63, 169, 38, 15, 56, 196, 162]);
assert.equal(isLegacyMatchAccount(legacyMatch), true);
assert.equal(isLegacyMatchAccount(new Uint8Array(205)), false);

assert.throws(() => matchBootstrapAddresses({ pitId: "", nonce: 1n, programId: programId.toBase58() }), /invalid_pit_id/);

const session = Keypair.generate();
const grantData = new Uint8Array(115);
grantData.set(Uint8Array.from(outcryIdl.accounts.find((account) => account.name === "SessionGrant")?.discriminator ?? []));
grantData.set(match.toBytes(), 8);
grantData.set(player.toBytes(), 40);
grantData.set(session.publicKey.toBytes(), 72);
new DataView(grantData.buffer).setBigInt64(104, 100n, true);
assert.equal(sessionGrantState(null, programId, { matchAddress: match, authority: player, sessionKey: session.publicKey }, 0), "missing");
assert.equal(sessionGrantState({ owner: programId, data: grantData }, programId, { matchAddress: match, authority: player, sessionKey: session.publicKey }, 0), "valid");
assert.equal(sessionGrantState({ owner: programId, data: grantData }, programId, { matchAddress: match, authority: player, sessionKey: session.publicKey }, 100), "expired");
grantData[113] = 1;
assert.equal(sessionGrantState({ owner: programId, data: grantData }, programId, { matchAddress: match, authority: player, sessionKey: session.publicKey }, 0), "invalid");
console.log("join builders: V2 match seed, runtime creation, and seat-free join verified");
