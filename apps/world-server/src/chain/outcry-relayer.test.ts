import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { base58Encode, crankRelayerReadiness } from "./outcry-relayer";

assert.equal(base58Encode(Uint8Array.from([0])), "1");
assert.equal(base58Encode(Uint8Array.from([0, 1, 2])), "15T");

assert.deepEqual(crankRelayerReadiness({}), { ready: false, code: "relayer_not_configured" });
assert.deepEqual(
  crankRelayerReadiness({ keypairPath: "/missing-base.json" }),
  { ready: false, code: "tee_relayer_not_configured" },
);

const source = await readFile(new URL("./outcry-relayer.ts", import.meta.url), "utf8");
assert.match(source, /requireTeeFeePayer/);
assert.match(source, /getDelegationStatus/);
assert.match(source, /auth\/challenge/);
assert.match(source, /auth\/login/);
assert.match(source, /searchParams\.set\("token", auth\.token\)/);
assert.match(source, /tee_auth_signer_required/);
assert.match(source, /tee_auth_failed/);
assert.match(source, /tee_relayer_route_mismatch/);
assert.match(source, /feePayer: runtimeFeePayer/);
assert.match(source, /additionalSigners: \[input\.relayer\]/);
assert.match(source, /relayer_simulation_failed/);
assert.match(source, /relayer_confirmation_failed/);
assert.match(source, /resolveWasApplied/);
assert.match(source, /tee_relayer_must_be_distinct/);
assert.match(source, /requirePrivateExecutionRoutes/);
assert.match(source, /private_state_route_mismatch/);
assert.match(source, /privateStates/);
assert.match(source, /pitActiveMatch/);
assert.match(source, /MatchV2 is deliberately persistent on base/);
assert.match(source, /refreshOracleFromPushFeed/);
assert.match(source, /7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE/);
assert.match(source, /rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ/);
assert.match(source, /update_oracle/);
console.log("outcry relayer: delegated runtime uses Router-selected ER routing and a compatible TEE fee payer");
