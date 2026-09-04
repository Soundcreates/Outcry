import { useEffect, useMemo, useRef, useState } from "react";
import {
  Participant,
  Room,
  RoomEvent,
  Track,
  type DisconnectReason,
} from "livekit-client";
import { joinMatchOnchain } from "../chain/joinMatch";

type Props = {
  matchId: string;
  matchAddress?: string;
  chainConfirmed?: boolean;
  onChainConfirmed: (input: { matchAddress: string; walletAddress: string }) => void;
  role: "PLAYER" | "SPECTATOR";
  seatIndex: number;
  sessionId: string;
  onExit: () => void;
};

type TokenResponse = {
  serverUrl?: string;
  token?: string;
  error?: string;
};

const worldHttp = import.meta.env.VITE_WORLD_HTTP ||
  (import.meta.env.VITE_WORLD_WS || "ws://localhost:2567").replace(/^ws/, "http");

const solanaRpc = import.meta.env.VITE_SOLANA_RPC || "https://api.devnet.solana.com";
const programId = import.meta.env.VITE_OUTCRY_PROGRAM_ID || "D2rYtfu8x3CxJ89YoAUrWbfiMGhFbAtE9Hq8RNoJaUZt";

export default function PitOverlay({ matchId, matchAddress, chainConfirmed, onChainConfirmed, onExit, role, seatIndex, sessionId }: Props) {
  const room = useMemo(() => new Room({ adaptiveStream: true, dynacast: true }), []);
  const [chainPhase, setChainPhase] = useState<"required" | "joining" | "confirmed" | "failed">(
    role === "PLAYER" && matchAddress && !chainConfirmed ? "required" : "confirmed",
  );
  const [phase, setPhase] = useState<"connecting" | "connected" | "reconnecting" | "disconnected" | "error">("connecting");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    if (role === "PLAYER" && matchAddress && chainPhase !== "confirmed") {
      setPhase("disconnected");
      return () => {
        active = false;
        void room.disconnect(true);
      };
    }
    const refresh = () => setRevision((value) => value + 1);
    const onConnected = () => active && setPhase("connected");
    const onReconnecting = () => active && setPhase("reconnecting");
    const onReconnected = () => active && setPhase("connected");
    const onDisconnected = (_reason?: DisconnectReason) => active && setPhase("disconnected");

    room.on(RoomEvent.Connected, onConnected);
    room.on(RoomEvent.Reconnecting, onReconnecting);
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.Disconnected, onDisconnected);
    for (const event of [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
    ]) room.on(event, refresh);

    const connect = async () => {
      setPhase("connecting");
      setError("");
      try {
        const response = await fetch(`${worldHttp}/api/livekit/token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ matchId, role, sessionId }),
        });
        const payload = await response.json() as TokenResponse;
        if (!response.ok || !payload.serverUrl || !payload.token) {
          throw new Error(payload.error ?? "media_token_unavailable");
        }
        await room.connect(payload.serverUrl, payload.token);
        if (active) setPhase("connected");
      } catch (reason) {
        if (active) {
          setPhase("error");
          setError(reason instanceof Error ? reason.message : "media_connection_failed");
        }
      }
    };

    void connect();
    return () => {
      active = false;
      room.off(RoomEvent.Connected, onConnected);
      room.off(RoomEvent.Reconnecting, onReconnecting);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.Disconnected, onDisconnected);
      for (const event of [
        RoomEvent.ParticipantConnected,
        RoomEvent.ParticipantDisconnected,
        RoomEvent.TrackSubscribed,
        RoomEvent.TrackUnsubscribed,
        RoomEvent.LocalTrackPublished,
        RoomEvent.LocalTrackUnpublished,
        RoomEvent.TrackMuted,
        RoomEvent.TrackUnmuted,
      ]) room.off(event, refresh);
      void room.disconnect(true);
    };
  }, [chainPhase, matchAddress, matchId, retry, role, room, sessionId]);

  const participants = [room.localParticipant, ...room.remoteParticipants.values()];
  const toggleCamera = async () => {
    try {
      await room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled);
      setRevision((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "camera_unavailable");
    }
  };
  const toggleMicrophone = async () => {
    try {
      await room.localParticipant.setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled);
      setRevision((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "microphone_unavailable");
    }
  };
  const joinOnchain = async () => {
    if (!matchAddress) return;
    setChainPhase("joining");
    setError("");
    try {
      const result = await joinMatchOnchain({
        matchAddress,
        seatIndex,
        rpcUrl: solanaRpc,
        programId,
      });
      onChainConfirmed({ matchAddress, walletAddress: result.walletAddress });
      setChainPhase("confirmed");
    } catch (reason) {
      setChainPhase("failed");
      setError(reason instanceof Error ? reason.message : "onchain_join_failed");
    }
  };

  const needsChainJoin = role === "PLAYER" && Boolean(matchAddress) && chainPhase !== "confirmed";

  return (
    <section className="pit-overlay" aria-label={`${matchId} media pit`}>
      <div className="pit-panel">
        <div className="pit-header">
          <div>
            <p className="eyebrow">LIVE PIT</p>
            <h2>{matchId}</h2>
          </div>
          <span className={`pit-status pit-status-${phase}`} role="status">
            {phase === "connecting" && "Connecting media…"}
            {phase === "connected" && `${participants.length} connected`}
            {phase === "reconnecting" && "Reconnecting media…"}
            {phase === "disconnected" && "Media disconnected"}
            {phase === "error" && "Media unavailable"}
          </span>
        </div>

        {error && <p className="pit-error">{error}</p>}
        {needsChainJoin ? (
          <div className="pit-chain-join">
            <p>Confirm your wallet join for seat {seatIndex} before entering the media room.</p>
            <button disabled={chainPhase === "joining"} onClick={() => void joinOnchain()} type="button">
              {chainPhase === "joining"
                ? "Confirming wallet…"
                : chainPhase === "failed" ? "Retry wallet join" : "Join match with wallet"}
            </button>
            <button className="pit-leave" onClick={onExit} type="button">Leave seat</button>
          </div>
        ) : (
          <>
            <div className="pit-grid">
              {participants.map((participant) => (
                <ParticipantTile key={participant.identity} participant={participant} revision={revision} />
              ))}
            </div>

            <div className="pit-controls">
              {role === "PLAYER" && (
                <>
                  <button onClick={() => void toggleCamera()} type="button">
                    {room.localParticipant.isCameraEnabled ? "Camera off" : "Camera on"}
                  </button>
                  <button onClick={() => void toggleMicrophone()} type="button">
                    {room.localParticipant.isMicrophoneEnabled ? "Mute mic" : "Join audio"}
                  </button>
                </>
              )}
              {(phase === "error" || phase === "disconnected") && (
                <button onClick={() => setRetry((value) => value + 1)} type="button">Reconnect media</button>
              )}
              <button className="pit-leave" onClick={onExit} type="button">Leave pit</button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function ParticipantTile({ participant, revision }: { participant: Participant; revision: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const camera = participant.getTrackPublication(Track.Source.Camera)?.videoTrack;
  const microphone = participant.getTrackPublication(Track.Source.Microphone)?.audioTrack;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !camera) return;
    camera.attach(video);
    return () => {
      camera.detach(video);
    };
  }, [camera, revision]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || participant.isLocal || !microphone) return;
    microphone.attach(audio);
    return () => {
      microphone.detach(audio);
    };
  }, [microphone, participant.isLocal, revision]);

  return (
    <article className="participant-tile">
      {camera ? (
        <video autoPlay muted={participant.isLocal} playsInline ref={videoRef} />
      ) : (
        <div className="participant-placeholder">{participant.isLocal ? "You" : "Camera off"}</div>
      )}
      {!participant.isLocal && <audio autoPlay ref={audioRef} />}
      <span>{participant.name || participant.identity}</span>
    </article>
  );
}
