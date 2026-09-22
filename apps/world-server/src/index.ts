import express, { type Request, type Response } from "express";
import { matchMaker, Server } from "colyseus";
import { readServerEnv } from "@outcry/shared/env";
import { mintLiveKitToken, parseLiveKitTokenRequest } from "./media/livekit";
import { GroqTranscriptionError, transcribeWithGroq } from "./media/groq";
import { crankDiagnostics, crankOutcry, crankRelayerReadiness, OUTCRY_CRANK_OPERATIONS, OutcryRelayerError, refreshOracleFromPushFeed, type OutcryCrankOperation } from "./chain/outcry-relayer";
import { WorldRoom } from "./world/WorldRoom";

const env = readServerEnv();
const port = Number(process.env.PORT ?? 2567);
const frontendBaseUrl = env.FRONTEND_BASE_URL.replace(/\/+$/, "");
const corsAllowedHeaders =
  "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Outcry-Match-Id, X-Outcry-Session-Id";
const corsAllowedMethods = "GET,POST,OPTIONS";
const PYTH_SOL_USD_PUSH_FEED = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";

function crankRelayerStatus() {
  return crankRelayerReadiness({
    programId: env.OUTCRY_PROGRAM_ID,
    keypairPath: env.OUTCRY_RELAYER_KEYPAIR_PATH,
    teeKeypairPath: env.OUTCRY_TEE_RELAYER_KEYPAIR_PATH,
  });
}

function safeRpcUrl(value: string) {
  try {
    const url = new URL(value);
    for (const key of ["api-key", "api_key", "token", "auth", "key"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "<redacted>");
    }
    return url.toString();
  } catch {
    return "<invalid-rpc-url>";
  }
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

Object.assign(matchMaker.controller.DEFAULT_CORS_HEADERS, {
  "Access-Control-Allow-Origin": frontendBaseUrl,
  "Access-Control-Allow-Headers": corsAllowedHeaders,
  "Access-Control-Allow-Methods": corsAllowedMethods,
});

const gameServer = new Server({
  express: (app) => {
    app.use((request: Request, response: Response, next) => {
      response.setHeader("Access-Control-Allow-Origin", frontendBaseUrl);
      response.setHeader("Access-Control-Allow-Headers", corsAllowedHeaders);
      response.setHeader("Access-Control-Allow-Methods", corsAllowedMethods);
      response.setHeader("Vary", "Origin");
      if (request.method === "OPTIONS") {
        response.sendStatus(204);
        return;
      }
      next();
    });
    app.use(express.json());
    app.get(
      "/health",
      (_request: Request, response: Response) => {
        response.status(200).json({
          ok: true,
          service: "world-server",
          build: process.env.OUTCRY_BUILD_ID ?? "development",
          programId: env.OUTCRY_PROGRAM_ID,
          seatAssignments: WorldRoom.storageMode(),
          oraclePushFeed: { account: PYTH_SOL_USD_PUSH_FEED, source: "pyth_push_feed", apiKeyRequired: false },
          crankRelayer: crankRelayerStatus(),
          magicBlockRouter: env.OUTCRY_MAGICBLOCK_ROUTER_RPC ?? "https://devnet-router.magicblock.app",
        });
      },
    );
    app.get("/v1/outcry/crank/diagnostics", async (request: Request, response: Response) => {
      if (!env.OUTCRY_PROGRAM_ID || typeof request.query.matchAddress !== "string") {
        response.status(400).json({ error: "invalid_crank_diagnostic_request" });
        return;
      }
      try {
        response.status(200).json(await crankDiagnostics({
          baseRpcUrl: env.OUTCRY_BASE_RPC,
          routerRpcUrl: env.OUTCRY_MAGICBLOCK_ROUTER_RPC,
          programId: env.OUTCRY_PROGRAM_ID,
          matchAddress: request.query.matchAddress,
          teeKeypairPath: env.OUTCRY_TEE_RELAYER_KEYPAIR_PATH,
        }));
      } catch (reason) {
        if (reason instanceof OutcryRelayerError) {
          response.status(reason.status).json({ error: reason.code, stage: reason.stage });
          return;
        }
        console.error("[outcry][crank:diagnostics]", reason);
        response.status(502).json({ error: "runtime_router_unavailable", stage: "router" });
      }
    });
    app.get(
      "/api/worlds",
      (_request: Request, response: Response) => {
        response.status(200).json({
          worlds: [
            { id: "wall-street", name: "Wall Street", mapUrl: "/wall-street/world.tmj", online: WorldRoom.onlineCount(), activePits: 2 },
            { id: "tokyo-night", name: "Tokyo Night", mapUrl: "/tokyo-night/world.tmj", online: 0, activePits: 2 },
            { id: "shibuya-crossing", name: "Shibuya Crossing", mapUrl: "/shibuya-crossing/world.tmj", online: 0, activePits: 2 },
            { id: "kyoto-lanterns", name: "Kyoto Lanterns", mapUrl: "/kyoto-lanterns/world.tmj", online: 0, activePits: 2 },
          ],
        });
      },
    );
    app.post("/v1/outcry/crank", async (request: Request, response: Response) => {
      const body = request.body as Record<string, unknown> | null;
      const operation = body?.operation;
      const matchAddress = body?.matchAddress;
      const requestedProgramId = body?.programId;
      if (
        typeof operation !== "string" || !OUTCRY_CRANK_OPERATIONS.includes(operation as OutcryCrankOperation)
        || typeof matchAddress !== "string" || matchAddress.length === 0
        || (requestedProgramId !== undefined && typeof requestedProgramId !== "string")
      ) {
        response.status(400).json({ error: "invalid_crank_request" });
        return;
      }
      if (!env.OUTCRY_PROGRAM_ID) {
        response.status(503).json({ error: "relayer_program_not_configured" });
        return;
      }
      if (requestedProgramId && requestedProgramId !== env.OUTCRY_PROGRAM_ID) {
        response.status(400).json({ error: "relayer_program_mismatch" });
        return;
      }
      try {
        const result = await crankOutcry({
          request: {
            operation: operation as OutcryCrankOperation,
            matchAddress,
            programId: env.OUTCRY_PROGRAM_ID,
            winnerAddress: typeof body?.winnerAddress === "string" ? body.winnerAddress : undefined,
          },
          baseRpcUrl: env.OUTCRY_BASE_RPC,
          routerRpcUrl: env.OUTCRY_MAGICBLOCK_ROUTER_RPC,
          programId: env.OUTCRY_PROGRAM_ID,
          keypairPath: env.OUTCRY_RELAYER_KEYPAIR_PATH,
          teeKeypairPath: env.OUTCRY_TEE_RELAYER_KEYPAIR_PATH,
        });
        response.status(200).json(result);
      } catch (reason) {
        if (reason instanceof OutcryRelayerError) {
          response.status(reason.status).json({ error: reason.code, stage: reason.stage });
          return;
        }
        console.error("[outcry][crank:unexpected]", reason);
        response.status(502).json({ error: "relayer_rpc_failed" });
      }
    });
    app.post("/api/livekit/token", async (request: Request, response: Response) => {
      const input = parseLiveKitTokenRequest(request.body);
      if (!input || !WorldRoom.isKnownPitId(input.matchId)) {
        response.status(400).json({ error: "invalid_media_request" });
        return;
      }
      if (!WorldRoom.isActiveSession(input.sessionId)) {
        response.status(403).json({ error: "inactive_world_session" });
        return;
      }
      if (input.role === "PLAYER" && !WorldRoom.canJoinMedia(input.sessionId, input.matchId)) {
        response.status(403).json({ error: "seat_membership_required" });
        return;
      }
      if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
        response.status(503).json({ error: "livekit_not_configured" });
        return;
      }
      try {
        const token = await mintLiveKitToken({
          apiKey: env.LIVEKIT_API_KEY,
          apiSecret: env.LIVEKIT_API_SECRET,
          serverUrl: env.LIVEKIT_URL,
          matchId: input.matchId,
          role: input.role,
        });
        response.status(200).json(token);
      } catch {
        response.status(500).json({ error: "livekit_token_failed" });
      }
    });
    app.post(
      "/api/speech/transcribe",
      express.raw({ type: "audio/*", limit: "25mb" }),
      async (request: Request, response: Response) => {
        const sessionId = request.header("x-outcry-session-id");
        const matchId = request.header("x-outcry-match-id");
        if (!sessionId || !matchId || !WorldRoom.isActiveSession(sessionId)) {
          response.status(403).json({ error: "inactive_world_session" });
          return;
        }
        if (!WorldRoom.isKnownPitId(matchId) || !WorldRoom.canJoinMedia(sessionId, matchId)) {
          response.status(403).json({ error: "seat_membership_required" });
          return;
        }
        if (!env.GROQ_API_KEY) {
          response.status(503).json({ error: "speech_transcription_not_configured" });
          return;
        }
        if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
          response.status(400).json({ error: "speech_audio_required" });
          return;
        }
        try {
          const text = await transcribeWithGroq({
            apiKey: env.GROQ_API_KEY,
            audio: request.body,
            contentType: request.header("content-type") ?? "audio/webm",
          });
          response.status(200).json({ text });
        } catch (reason) {
          if (reason instanceof GroqTranscriptionError) {
            response.status(reason.status).json({ error: reason.code });
            return;
          }
          response.status(502).json({ error: "speech_upstream_failed" });
        }
      },
    );
    app.post("/api/oracle/sol-usd-update", async (request: Request, response: Response) => {
      const sessionId = request.header("x-outcry-session-id");
      const matchId = request.header("x-outcry-match-id");
      if (!sessionId || !matchId || !WorldRoom.isActiveSession(sessionId)) {
        response.status(403).json({ error: "inactive_world_session" });
        return;
      }
      if (!WorldRoom.isKnownPitId(matchId) || !WorldRoom.canJoinMedia(sessionId, matchId)) {
        response.status(403).json({ error: "seat_membership_required" });
        return;
      }
      if (!env.OUTCRY_PROGRAM_ID) {
        response.status(503).json({ error: "relayer_program_not_configured" });
        return;
      }
      try {
        response.status(200).json(await refreshOracleFromPushFeed({
          baseRpcUrl: env.OUTCRY_BASE_RPC,
          programId: env.OUTCRY_PROGRAM_ID,
          keypairPath: env.OUTCRY_RELAYER_KEYPAIR_PATH,
        }));
      } catch (reason) {
        if (reason instanceof OutcryRelayerError) {
          response.status(reason.status).json({ error: reason.code, stage: reason.stage });
          return;
        }
        console.error("[outcry][oracle:update]", reason);
        response.status(502).json({ error: "oracle_relayer_failed", stage: "update_oracle" });
      }
    });
  },
});
gameServer.define("world", WorldRoom);

gameServer.listen(port).then(() => {
  console.log(`OUTCRY world server listening on http://localhost:${port}`);
  console.log(`Base Solana RPC configured: ${safeRpcUrl(env.OUTCRY_BASE_RPC)}`);
});
