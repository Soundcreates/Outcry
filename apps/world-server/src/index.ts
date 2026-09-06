import express, { type Request, type Response } from "express";
import { Server } from "colyseus";
import { readServerEnv } from "@outcry/shared/env";
import { mintLiveKitToken, parseLiveKitTokenRequest } from "./media/livekit";
import { WorldRoom } from "./world/WorldRoom";

const env = readServerEnv();
const port = Number(process.env.PORT ?? 2567);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

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
  },
});
gameServer.define("world", WorldRoom);

gameServer.listen(port).then(() => {
  console.log(`OUTCRY world server listening on http://localhost:${port}`);
  console.log(`Base Solana RPC configured: ${env.OUTCRY_BASE_RPC}`);
});
