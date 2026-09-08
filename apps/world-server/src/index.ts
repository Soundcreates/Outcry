import express, { type Request, type Response } from "express";
import { matchMaker, Server } from "colyseus";
import { readServerEnv } from "@outcry/shared/env";
import { mintLiveKitToken, parseLiveKitTokenRequest } from "./media/livekit";
import { GroqTranscriptionError, transcribeWithGroq } from "./media/groq";
import { fetchLatestPythPriceUpdates, PythPriceUpdateError } from "./media/pyth";
import { WorldRoom } from "./world/WorldRoom";

const env = readServerEnv();
const port = Number(process.env.PORT ?? 2567);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

matchMaker.controller.DEFAULT_CORS_HEADERS["Access-Control-Allow-Headers"] =
  "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Outcry-Match-Id, X-Outcry-Session-Id";

const gameServer = new Server({
  express: (app) => {
    app.use(express.json());
    app.get(
      "/health",
      (_request: Request, response: Response) => {
        response.status(200).json({ ok: true, service: "world-server" });
      },
    );
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
    app.get("/api/oracle/sol-usd-update", async (request: Request, response: Response) => {
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
      if (!env.PYTH_HERMES_URL || !env.PYTH_API_KEY) {
        response.status(503).json({ error: "pyth_not_configured" });
        return;
      }
      try {
        const updates = await fetchLatestPythPriceUpdates({
          endpoint: env.PYTH_HERMES_URL,
          apiKey: env.PYTH_API_KEY,
        });
        response.status(200).json({ updates });
      } catch (reason) {
        if (reason instanceof PythPriceUpdateError) {
          response.status(reason.status).json({ error: reason.code });
          return;
        }
        response.status(502).json({ error: "pyth_upstream_failed" });
      }
    });
  },
});
gameServer.define("world", WorldRoom);

gameServer.listen(port).then(() => {
  console.log(`OUTCRY world server listening on http://localhost:${port}`);
  console.log(`Base Solana RPC configured: ${env.OUTCRY_BASE_RPC}`);
});
