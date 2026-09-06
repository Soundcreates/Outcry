import assert from "node:assert/strict";
import { readServerEnv } from "@outcry/shared/env";
import { TokenVerifier } from "livekit-server-sdk";
import { mintLiveKitToken, parseLiveKitTokenRequest } from "./livekit";

const apiKey = "phase4-test-key";
const apiSecret = "phase4-test-secret";
const verifier = new TokenVerifier(apiKey, apiSecret);

const parsedEnv = readServerEnv({
  NEXT_PUBLIC_WORLD_WS: "ws://localhost:2567",
  OUTCRY_BASE_RPC: "https://api.devnet.solana.com",
  NEXT_PUBLIC_MAGICBLOCK_TEE_RPC: "https://devnet-tee.magicblock.app",
  LIVEKIT_URL: "wss://phase4.example",
  LIVEKIT_API_KEY: apiKey,
  LIVEKIT_API_SECRET: apiSecret,
  ASSEMBLYAI_API_KEY: "",
  OUTCRY_PROGRAM_ID: "",
});
assert.equal(parsedEnv.ASSEMBLYAI_API_KEY, undefined);
assert.equal(parsedEnv.OUTCRY_PROGRAM_ID, undefined);

assert.deepEqual(parseLiveKitTokenRequest({
  matchId: "wall-street-01",
  role: "PLAYER",
  sessionId: "world-session",
}), {
  matchId: "wall-street-01",
  role: "PLAYER",
  sessionId: "world-session",
});
assert.equal(parseLiveKitTokenRequest({ matchId: "wall-street-01", role: "ADMIN", sessionId: "world-session" }), null);
assert.equal(parseLiveKitTokenRequest({ matchId: "wall-street-01", role: "PLAYER", sessionId: "world-session", room: "arbitrary" }), null);

const player = await mintLiveKitToken({
  apiKey,
  apiSecret,
  serverUrl: "wss://phase4.example",
  matchId: "wall-street-01",
  role: "PLAYER",
});
const playerClaims = await verifier.verify(player.token);
assert.equal(playerClaims.video?.room, "outcry_wall-street-01");
assert.equal(playerClaims.video?.canPublish, true);
assert.equal(playerClaims.video?.canSubscribe, true);
assert.equal(playerClaims.video?.canPublishData, true);

const spectator = await mintLiveKitToken({
  apiKey,
  apiSecret,
  serverUrl: "wss://phase4.example",
  matchId: "wall-street-01",
  role: "SPECTATOR",
});
const spectatorClaims = await verifier.verify(spectator.token);
assert.equal(spectatorClaims.video?.canPublish, false);
assert.equal(spectatorClaims.video?.canSubscribe, true);
assert.equal(spectatorClaims.video?.canPublishData, false);

console.log("livekit token: request validation, grants, and optional env parsing pass");
