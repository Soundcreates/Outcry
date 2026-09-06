import { useEffect, useMemo, useRef, useState } from "react";
import {
  Participant,
  Room,
  RoomEvent,
  Track,
  type DisconnectReason,
} from "livekit-client";
import { bootstrapMatchOnchain, connectedWalletAddress, joinMatchOnchain } from "../chain/joinMatch";
import { openRfqOnchain, settleMatchOnchain } from "../chain/matchActions";
import { loadPublicMatchState, type PublicMatchSnapshot } from "../chain/matchState";
import MatchHud from "../match/MatchHud";
import PrivateInventoryPanel from "../match/PrivateInventoryPanel";
import PrivateQuotePanel from "../match/PrivateQuotePanel";
import TradeIntentPanel from "../match/TradeIntentPanel";

type Props = {
  matchId: string;
  matchAddress?: string;
  chainConfirmed?: boolean;
  onChainConfirmed: (input: { matchAddress: string; walletAddress: string }) => void;
  onChainSeatConflict?: (input: { matchAddress: string; walletAddress: string }) => void;
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

// Match accounts and wallet instructions live on Solana's durable base layer.
const baseSolanaRpc = import.meta.env.VITE_SOLANA_BASE_RPC || "https://api.devnet.solana.com";
const programId = import.meta.env.VITE_OUTCRY_PROGRAM_ID || "D2rYtfu8x3CxJ89YoAUrWbfiMGhFbAtE9Hq8RNoJaUZt";

function walletJoinError(reason: unknown) {
  const message = reason instanceof Error ? reason.message : "onchain_join_failed";
  if (message === "wallet_fee_payer_unfunded") {
    return "This wallet has insufficient Devnet SOL to pay the join fee. Fund it from the Solana Devnet faucet, then retry wallet join.";
  }
  if (message === "wallet_already_joined_different_seat") {
    return "This wallet is already joined in a different seat. Leave that seat or use the matching seat before retrying.";
  }
  if (message === "match_bootstrap_simulation_failed") {
    return "Match setup could not be simulated. Retry in a moment or leave the seat.";
  }
  return message;
}

export default function PitOverlay({ matchId, matchAddress, chainConfirmed, onChainConfirmed, onChainSeatConflict, onExit, role, seatIndex, sessionId }: Props) {
  const room = useMemo(() => new Room({ adaptiveStream: true, dynacast: true }), []);
  const [chainPhase, setChainPhase] = useState<"required" | "joining" | "confirmed" | "failed">(
    role === "PLAYER" && matchAddress && !chainConfirmed ? "required" : "confirmed",
  );
  const [phase, setPhase] = useState<"connecting" | "connected" | "reconnecting" | "disconnected" | "error">("connecting");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [retry, setRetry] = useState(0);
  const [matchSnapshot, setMatchSnapshot] = useState<PublicMatchSnapshot>();
  const [matchError, setMatchError] = useState("");
  const [matchRevision, setMatchRevision] = useState(0);
  const [settling, setSettling] = useState(false);
  const walletAddress = connectedWalletAddress();

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

  useEffect(() => {
    let active = true;
    if (!matchAddress || !chainConfirmed) {
      setMatchSnapshot(undefined);
      setMatchError("");
      return () => { active = false; };
    }
    const refresh = async () => {
      try {
        const next = await loadPublicMatchState({ rpcUrl: baseSolanaRpc, matchAddress, programId });
        if (active) {
          setMatchSnapshot(next);
          setMatchError("");
        }
      } catch (reason) {
        if (active) setMatchError(reason instanceof Error ? reason.message : "match_state_unavailable");
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 1_500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [chainConfirmed, matchAddress, matchRevision]);

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
      let result;
      try {
        result = await joinMatchOnchain({ matchAddress, seatIndex, rpcUrl: baseSolanaRpc, programId });
      } catch (reason) {
        if (!(reason instanceof Error) || reason.message !== "match_account_not_initialized") throw reason;
        setError("Match is not initialized. Simulating first-player setup before wallet approval…");
        await bootstrapMatchOnchain({
          pitId: matchId,
          nonce: 1n,
          capacity: 4,
          rpcUrl: baseSolanaRpc,
          programId,
          expectedMatchAddress: matchAddress,
          onWalletApprovalRequested: () => setError("Setup simulation passed. Approve the Match account transaction in your wallet."),
        });
        result = await joinMatchOnchain({ matchAddress, seatIndex, rpcUrl: baseSolanaRpc, programId });
      }
      if ("alreadyJoined" in result && result.seatIndex !== seatIndex) {
        setError(`Wallet is already assigned to seat ${result.seatIndex}. Restoring that seat…`);
        onChainSeatConflict?.({ matchAddress, walletAddress: result.walletAddress });
      } else {
        onChainConfirmed({ matchAddress, walletAddress: result.walletAddress });
      }
      setChainPhase("confirmed");
    } catch (reason) {
      setChainPhase("failed");
      setError(walletJoinError(reason));
    }
  };

  const submitIntent = async (intent: Parameters<typeof openRfqOnchain>[0]["intent"]) => {
    if (!matchAddress || !matchSnapshot) throw new Error("match_state_unavailable");
    await openRfqOnchain({
      rpcUrl: baseSolanaRpc,
      matchAddress,
      programId,
      round: matchSnapshot.currentRound,
      intent,
    });
    setMatchRevision((value) => value + 1);
  };

  const settle = async () => {
    if (!matchAddress || !matchSnapshot?.resultAddress || !matchSnapshot.winner) throw new Error("match_result_unavailable");
    setSettling(true);
    setError("");
    try {
      await settleMatchOnchain({
        rpcUrl: baseSolanaRpc,
        matchAddress,
        resultAddress: matchSnapshot.resultAddress,
        winnerAddress: matchSnapshot.winner,
        programId,
      });
      setMatchRevision((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "settlement_failed");
    } finally {
      setSettling(false);
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
        {(phase === "error" || phase === "disconnected") && (
          <p className="pit-media-note">Media is unavailable; match state remains available. Retry media when ready.</p>
        )}
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
            <MatchHud snapshot={matchSnapshot} walletAddress={walletAddress} error={matchError} settling={settling} onSettle={settle} onReturn={onExit} />
            {role === "PLAYER" && matchAddress && walletAddress && (
              <PrivateInventoryPanel
                matchAddress={matchAddress}
                playerAddress={walletAddress}
                programId={programId}
              />
            )}
            <PrivateQuotePanel
              active={role === "PLAYER" && Boolean(matchSnapshot?.taker && matchSnapshot.taker !== walletAddress)}
              matchAddress={matchAddress}
              dealerAddress={walletAddress}
              round={matchSnapshot?.currentRound}
              programId={programId}
            />
            <TradeIntentPanel
              active={role === "PLAYER" && matchSnapshot?.taker === walletAddress}
              onSubmit={matchSnapshot && matchAddress ? submitIntent : undefined}
            />
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
