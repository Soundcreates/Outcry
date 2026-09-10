import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type Phaser from "phaser";
import { Client } from "@colyseus/sdk";
import { MAX_CHAT_MESSAGE_LENGTH } from "@outcry/shared/domain";
import { WorldState } from "@outcry/shared/world-state";
import { connectedWalletAddress } from "../chain/joinMatch";
import { createWorldGame, type WorldRoom } from "./createWorldGame";
import PitOverlay from "./PitOverlay";

type Props = {
  worldId: string;
  onExit: () => void;
};

type ConnectionState = "connecting" | "connected" | "reconnecting" | "offline";
type PitState = { pitId: string; seatIndex: number; matchAddress?: string; chainConfirmed?: boolean };
const RECONNECT_FALLBACK_DELAY_MS = 10_000;

export default function WorldCanvas({ worldId, onExit }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<WorldRoom | undefined>(undefined);
  const preservedGameRef = useRef<Phaser.Game | undefined>(undefined);
  const reconnectRequestedRef = useRef(false);
  const intentionalExitRef = useRef(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [pit, setPit] = useState<PitState>();
  const [chatDraft, setChatDraft] = useState("");
  const chatInputRef = useRef<HTMLInputElement>(null);

  const requestReconnect = () => {
    if (intentionalExitRef.current || reconnectRequestedRef.current) return;
    reconnectRequestedRef.current = true;
    setConnectionState("reconnecting");
    setReconnectAttempt((value) => value + 1);
  };

  const sendRoomMessage = (type: string, payload?: unknown) => {
    const room = roomRef.current;
    if (!room || !room.connection.isOpen) {
      requestReconnect();
      return false;
    }
    try {
      room.send(type, payload);
      return true;
    } catch {
      requestReconnect();
      return false;
    }
  };

  const sendChat = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = chatDraft.trim();
    if (!text || !sendRoomMessage("chat", { text })) return;
    setChatDraft("");
    chatInputRef.current?.blur();
  };

  useEffect(() => {
    if (!mountRef.current) return;
    let disposed = false;
    let reconnectTimer: number | undefined;
    let game: Phaser.Game | undefined;
    let room: WorldRoom | undefined;
    let removeRoomListeners: (() => void) | undefined;
    const client = new Client(import.meta.env.VITE_WORLD_WS || "ws://localhost:2567");

    client
      .joinOrCreate("world", { worldId }, WorldState)
      .then((joinedRoom) => {
        if (disposed) {
          if (joinedRoom.connection.isOpen) void joinedRoom.leave();
          return;
        }
        preservedGameRef.current?.destroy(true);
        preservedGameRef.current = undefined;
        room = joinedRoom;
        roomRef.current = joinedRoom;
        joinedRoom.reconnection.minUptime = 0;
        joinedRoom.reconnection.maxRetries = 8;
        reconnectRequestedRef.current = false;
        if (reconnectAttempt > 0) setPit(undefined);
        const onRoomError = (code: number, message?: string) => {
          if (disposed) return;
          console.warn(`World room error ${code}: ${message ?? "unknown_error"}`);
          setConnectionState("reconnecting");
        };
        const onRoomDrop = () => {
          if (!disposed) setConnectionState("reconnecting");
        };
        const onRoomReconnect = () => {
          if (!disposed) setConnectionState("connected");
        };
        const onRoomLeave = () => {
          if (disposed) return;
          if (roomRef.current === joinedRoom) roomRef.current = undefined;
          setConnectionState("reconnecting");
          reconnectRequestedRef.current = true;
          reconnectTimer = window.setTimeout(() => {
            if (!disposed) setReconnectAttempt((value) => value + 1);
          }, RECONNECT_FALLBACK_DELAY_MS);
        };
        joinedRoom.onError(onRoomError);
        joinedRoom.onDrop(onRoomDrop);
        joinedRoom.onReconnect(onRoomReconnect);
        joinedRoom.onLeave(onRoomLeave);
        removeRoomListeners = () => {
          joinedRoom.onError.remove(onRoomError);
          joinedRoom.onDrop.remove(onRoomDrop);
          joinedRoom.onReconnect.remove(onRoomReconnect);
          joinedRoom.onLeave.remove(onRoomLeave);
        };
        setConnectionState("connected");
        const matchAddress = joinedRoom.state.pits.get("wall-street-01")?.activeMatchId;
        const walletAddress = connectedWalletAddress();
        if (matchAddress && walletAddress) {
          joinedRoom.send("reconcileSeat", { matchAddress, walletAddress });
        }
        game = createWorldGame(mountRef.current!, worldId, room, {
          onSeatEnter: setPit,
          onSeatExit: () => setPit(undefined),
          onConnectionLost: requestReconnect,
        });
      })
      .catch((error: unknown) => {
        console.warn("World server unavailable; running local preview", error);
        if (!disposed) {
          setConnectionState("offline");
          if (!preservedGameRef.current && reconnectAttempt === 0) {
            game = createWorldGame(mountRef.current!, worldId);
          }
          reconnectRequestedRef.current = true;
          reconnectTimer = window.setTimeout(() => {
            if (!disposed) setReconnectAttempt((value) => value + 1);
          }, 2_000);
        }
      });

    return () => {
      const preserveForReconnect = reconnectRequestedRef.current && !intentionalExitRef.current;
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      removeRoomListeners?.();
      if (roomRef.current === room) roomRef.current = undefined;
      if (room?.connection.isOpen) void room.leave();
      if (preserveForReconnect) {
        if (game) {
          game.scene.pause("WorldScene");
          preservedGameRef.current = game;
        }
      } else {
        game?.destroy(true);
        preservedGameRef.current?.destroy(true);
        preservedGameRef.current = undefined;
      }
    };
  }, [reconnectAttempt, worldId]);

  return (
    <main className="world-shell">
      <button className="world-exit" onClick={() => { intentionalExitRef.current = true; onExit(); }} type="button">
        Back to worlds
      </button>
      <p className={`world-connection world-connection-${connectionState}`} role="status">
        {connectionState === "connecting" && "Connecting to multiplayer…"}
        {connectionState === "connected" && "● Multiplayer connected"}
        {connectionState === "reconnecting" && "↻ Multiplayer reconnecting · match state remains available"}
        {connectionState === "offline" && "Multiplayer offline · run pnpm dev:world"}
      </p>
      <div className="world-game-mount" aria-label={`${worldId} trading floor`} ref={mountRef} />
      <form className="world-chat" onSubmit={sendChat}>
        <label htmlFor="world-chat-input">WORLD CHAT</label>
        <div className="world-chat-row">
          <input
            ref={chatInputRef}
            id="world-chat-input"
            maxLength={MAX_CHAT_MESSAGE_LENGTH}
            onChange={(event) => setChatDraft(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            placeholder={connectionState === "connected" ? "Say something…" : "Connect to chat"}
            value={chatDraft}
            disabled={connectionState !== "connected"}
          />
          <button type="submit" disabled={connectionState !== "connected" || chatDraft.trim().length === 0}>SEND</button>
        </div>
        <span>Messages appear above your avatar · {MAX_CHAT_MESSAGE_LENGTH} chars max</span>
      </form>
      {pit && roomRef.current && (
        <PitOverlay
          matchId={pit.pitId}
          matchAddress={pit.matchAddress}
          chainConfirmed={pit.chainConfirmed}
          onWalletJoinStarted={() => sendRoomMessage("beginConfirm")}
          onChainConfirmed={({ matchAddress, walletAddress }) => sendRoomMessage("confirmSeat", {
            confirmed: true,
            matchAddress,
            walletAddress,
          })}
          onMatchAddressChanged={(matchAddress) => setPit((current) => current ? {
            ...current,
            matchAddress,
            chainConfirmed: false,
          } : current)}
          onChainSeatConflict={({ matchAddress, walletAddress }) => sendRoomMessage("reconcileSeat", {
            matchAddress,
            walletAddress,
          })}
          onExit={() => sendRoomMessage("releaseSeat")}
          role="PLAYER"
          seatIndex={pit.seatIndex}
          sessionId={roomRef.current.sessionId}
        />
      )}
    </main>
  );
}
