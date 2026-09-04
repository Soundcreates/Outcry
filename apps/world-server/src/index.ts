import { Server } from "colyseus";
import { readServerEnv } from "@outcry/shared/env";
import { WorldRoom } from "./world/WorldRoom";

const env = readServerEnv();
const port = Number(process.env.PORT ?? 2567);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const gameServer = new Server({
  express: (app) => {
    app.get(
      "/health",
      (_request: unknown, response: { status: (code: number) => { json: (body: unknown) => void } }) => {
      response.status(200).json({ ok: true, service: "world-server" });
      },
    );
    app.get(
      "/api/worlds",
      (_request: unknown, response: { status: (code: number) => { json: (body: unknown) => void } }) => {
        response.status(200).json({
          worlds: [
            { id: "wall-street", name: "Wall Street", mapUrl: "/wall-street/world.tmj", online: WorldRoom.onlineCount(), activePits: 2 },
            { id: "tokyo-night", name: "Tokyo Night", mapUrl: null, online: 0, activePits: 0 },
          ],
        });
      },
    );
  },
});
gameServer.define("world", WorldRoom);

gameServer.listen(port).then(() => {
  console.log(`OUTCRY world server listening on http://localhost:${port}`);
  console.log(`Solana RPC configured: ${env.NEXT_PUBLIC_SOLANA_RPC}`);
});
