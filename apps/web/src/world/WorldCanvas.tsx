import { useEffect, useRef, useState } from "react";
import type Phaser from "phaser";
import { Client } from "@colyseus/sdk";
import { WorldState } from "@outcry/shared/world-state";
import { connectedWalletAddress } from "../chain/joinMatch";
import { createWorldGame, type WorldRoom } from "./createWorldGame";
import PitOverlay from "./PitOverlay";

type Props = {
  worldId: string;
  onExit: () => void;
};

type ConnectionState = "connecting" | "connected" | "offline";
type PitState = { pitId: string; seatIndex: number; matchAddress?: string; chainConfirmed?: boolean };

export default function WorldCanvas({ worldId, onExit }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<WorldRoom | undefined>(undefined);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [pit, setPit] = useState<PitState>();

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
        roomRef.current = joinedRoom;
        setConnectionState("connected");
        const matchAddress = joinedRoom.state.pits.get("wall-street-01")?.activeMatchId;
        const walletAddress = connectedWalletAddress();
        if (matchAddress && walletAddress) {
          joinedRoom.send("reconcileSeat", { matchAddress, walletAddress });
        }
        game = createWorldGame(mountRef.current!, worldId, room, {
          onSeatEnter: setPit,
          onSeatExit: () => setPit(undefined),
        });
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
      roomRef.current = undefined;
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
      {pit && roomRef.current && (
        <PitOverlay
          matchId={pit.pitId}
          matchAddress={pit.matchAddress}
          chainConfirmed={pit.chainConfirmed}
          onChainConfirmed={({ matchAddress, walletAddress }) => roomRef.current?.send("confirmSeat", {
            confirmed: true,
            matchAddress,
            walletAddress,
          })}
          onExit={() => roomRef.current?.send("releaseSeat")}
          role="PLAYER"
          seatIndex={pit.seatIndex}
          sessionId={roomRef.current.sessionId}
        />
      )}
    </main>
  );
}
