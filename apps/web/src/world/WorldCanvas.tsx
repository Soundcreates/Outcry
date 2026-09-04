import { useEffect, useRef, useState } from "react";
import type Phaser from "phaser";
import { Client } from "@colyseus/sdk";
import { WorldState } from "@outcry/shared/world-state";
import { createWorldGame, type WorldRoom } from "./createWorldGame";

type Props = {
  worldId: string;
  onExit: () => void;
};

type ConnectionState = "connecting" | "connected" | "offline";

export default function WorldCanvas({ worldId, onExit }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");

  useEffect(() => {
    if (!mountRef.current) return;
    let disposed = false;
    let game: Phaser.Game | undefined;
    let room: WorldRoom | undefined;
    const client = new Client(import.meta.env.VITE_WORLD_WS || "ws://localhost:2567");

    client
      .joinOrCreate("world", { worldId }, WorldState)
      .then((joinedRoom) => {
        if (disposed) {
          void joinedRoom.leave();
          return;
        }
        room = joinedRoom;
        setConnectionState("connected");
        game = createWorldGame(mountRef.current!, worldId, room);
      })
      .catch((error: unknown) => {
        console.warn("World server unavailable; running local preview", error);
        if (!disposed) {
          setConnectionState("offline");
          game = createWorldGame(mountRef.current!, worldId);
        }
      });

    return () => {
      disposed = true;
      void room?.leave();
      game?.destroy(true);
    };
  }, [worldId]);

  return (
    <main className="world-shell">
      <button className="world-exit" onClick={onExit} type="button">
        Back to worlds
      </button>
      <p className={`world-connection world-connection-${connectionState}`} role="status">
        {connectionState === "connecting" && "Connecting to multiplayer…"}
        {connectionState === "connected" && "● Multiplayer connected"}
        {connectionState === "offline" && "Multiplayer offline · run pnpm dev:world"}
      </p>
      <div aria-label={`${worldId} trading floor`} ref={mountRef} />
    </main>
  );
}
