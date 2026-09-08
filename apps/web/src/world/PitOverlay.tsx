import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  Participant,
  Room,
  RoomEvent,
  Track,
  type DisconnectReason,
} from "livekit-client";
import { bootstrapMatchOnchain, classifyMatchOwnership, connectedWalletAddress, joinMatchOnchain, readActivePitMatchOnchain, releaseActiveMatchOnchain, restoreDelegatedMatchOnchain, type MatchOwnership } from "../chain/joinMatch";
import { baseRpcConfigurationMessage, browserBaseRpc, createBaseRpcConnection } from "../chain/baseRpc";
import { openRfqOnchain, resolveRoundOnchain, settleMatchOnchain, startMatchOnchain } from "../chain/matchActions";
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
  onMatchAddressChanged?: (matchAddress: string) => void;
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
const baseSolanaRpc = browserBaseRpc.url;
const teeSolanaRpc = import.meta.env.VITE_MAGICBLOCK_TEE_RPC || "https://devnet-tee.magicblock.app";
const programId = import.meta.env.VITE_OUTCRY_PROGRAM_ID || "D2rYtfu8x3CxJ89YoAUrWbfiMGhFbAtE9Hq8RNoJaUZt";
const configuredMatchNonce = import.meta.env.VITE_OUTCRY_MATCH_NONCE || "1";
if (!/^\d+$/.test(configuredMatchNonce)) throw new Error("invalid_match_nonce_configuration");
const matchNonce = BigInt(configuredMatchNonce);
const WAITING_MATCH_POLL_MS = 15_000;
const ACTIVE_MATCH_POLL_MS = 10_000;
const RATE_LIMIT_BACKOFF_MS = 10_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 30_000;

function requireBaseSolanaRpc() {
  if (!baseSolanaRpc) throw new Error(baseRpcConfigurationMessage(browserBaseRpc.error));
  return baseSolanaRpc;
}

function isRateLimitError(reason: unknown) {
  return /(?:\b429\b|too many requests|rate limit)/i.test(reason instanceof Error ? reason.message : String(reason));
}

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
  if (message === "match_bootstrap_simulation_rpc_http_429") {
    return "The Solana RPC is rate-limiting setup simulation. Wait a few seconds and retry, or configure a dedicated Devnet RPC in VITE_SOLANA_BASE_RPC.";
  }
  if (message.startsWith("pit_has_active_match:")) {
    return "This pit already has another active match. The host can release it and start a fresh match.";
  }
  return message;
}

async function fetchSolUsdPriceUpdates(input: { matchId: string; sessionId: string }) {
  const response = await fetch(`${worldHttp}/api/oracle/sol-usd-update`, {
    headers: {
      "x-outcry-match-id": input.matchId,
      "x-outcry-session-id": input.sessionId,
    },
  });
  const payload = await response.json().catch(() => ({})) as { error?: string; updates?: unknown };
  if (!response.ok) throw new Error(payload.error ?? "pyth_price_update_unavailable");
  if (!Array.isArray(payload.updates) || payload.updates.some((update) => typeof update !== "string")) {
    throw new Error("pyth_price_update_invalid");
  }
  return payload.updates;
}

export default function PitOverlay({ matchId, matchAddress, chainConfirmed, onChainConfirmed, onMatchAddressChanged, onChainSeatConflict, onExit, role, seatIndex, sessionId }: Props) {
  const room = useMemo(() => new Room({ adaptiveStream: true, dynacast: true }), []);
  const matchConnection = useMemo(() => baseSolanaRpc ? createBaseRpcConnection(baseSolanaRpc) : undefined, []);
  const [chainPhase, setChainPhase] = useState<"required" | "joining" | "confirmed" | "failed">(
    role === "PLAYER" && matchAddress && !chainConfirmed ? "required" : "confirmed",
  );
  const [phase, setPhase] = useState<"connecting" | "connected" | "reconnecting" | "disconnected" | "error">("connecting");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [retry, setRetry] = useState(0);
  const [matchSnapshot, setMatchSnapshot] = useState<PublicMatchSnapshot>();
  const [matchOwnership, setMatchOwnership] = useState<MatchOwnership>();
  const [matchError, setMatchError] = useState("");
  const [matchRevision, setMatchRevision] = useState(0);
  const [settling, setSettling] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [startingMatch, setStartingMatch] = useState(false);
  const [activeMatchToRelease, setActiveMatchToRelease] = useState<string>();
  const [currentMatchNonce, setCurrentMatchNonce] = useState(matchNonce);
  const [releasingStaleMatch, setReleasingStaleMatch] = useState(false);
  const [restoringMatch, setRestoringMatch] = useState(false);
  const [submittingRfq, setSubmittingRfq] = useState(false);
  const [rfqProgress, setRfqProgress] = useState("");
  const [autoStartIn, setAutoStartIn] = useState<number>();
  const matchReadInFlightRef = useRef(false);
  const startMatchInFlightRef = useRef(false);
  const autoStartAttemptedRef = useRef(false);
  const walletAddress = connectedWalletAddress();
  const chainActionInFlight = startingMatch || settling || resolving || releasingStaleMatch || restoringMatch || submittingRfq || chainPhase === "joining";

  useEffect(() => {
    let active = true;
    if (!baseSolanaRpc || role !== "PLAYER" || !matchAddress || chainPhase === "confirmed") {
      return () => { active = false; };
    }
    void readActivePitMatchOnchain({ pitId: matchId, rpcUrl: requireBaseSolanaRpc(), programId })
      .then((activeMatch) => {
        if (active && activeMatch && activeMatch !== matchAddress) setActiveMatchToRelease(activeMatch);
      })
      .catch(() => {
        // The join/bootstrap flow reports the actionable RPC error if setup is attempted.
      });
    return () => { active = false; };
  }, [chainPhase, matchAddress, matchId, role]);

  const startMatch = useCallback(async () => {
    if (startMatchInFlightRef.current) return;
    if (!matchAddress || !matchSnapshot?.host) throw new Error("match_host_unavailable");
    startMatchInFlightRef.current = true;
    setStartingMatch(true);
    setError("");
    try {
      await startMatchOnchain({
        rpcUrl: requireBaseSolanaRpc(),
        matchAddress,
        hostAddress: matchSnapshot.host,
        programId,
      });
      setMatchRevision((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "start_match_failed");
    } finally {
      startMatchInFlightRef.current = false;
      setStartingMatch(false);
    }
  }, [matchAddress, matchSnapshot?.host]);

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
    if (!baseSolanaRpc || !matchConnection) {
      setMatchSnapshot(undefined);
      setMatchOwnership(undefined);
      setMatchError(baseRpcConfigurationMessage(browserBaseRpc.error));
      return () => { active = false; };
    }
    if (!matchAddress || !chainConfirmed) {
      setMatchSnapshot(undefined);
      setMatchOwnership(undefined);
      setMatchError("");
      return () => { active = false; };
    }
    let timer: number | undefined;
    let rateLimitFailures = 0;
    const isVisible = () => document.visibilityState === "visible";
    const schedule = (delay: number) => {
      timer = window.setTimeout(() => void refresh(), delay);
    };
    const refresh = async () => {
      if (!active || !isVisible() || chainActionInFlight) return;
      if (matchReadInFlightRef.current) {
        schedule(1_000);
        return;
      }
      matchReadInFlightRef.current = true;
      try {
        const next = await loadPublicMatchState({
          rpcUrl: requireBaseSolanaRpc(),
          matchAddress,
          programId,
          connection: matchConnection,
        });
        if (active && isVisible()) {
          setMatchSnapshot(next);
          setMatchOwnership(next.accountOwner ? classifyMatchOwnership(new PublicKey(next.accountOwner), new PublicKey(programId)) : undefined);
          setMatchError("");
          rateLimitFailures = 0;
          schedule(next.status === "STARTED" ? ACTIVE_MATCH_POLL_MS : WAITING_MATCH_POLL_MS);
        }
      } catch (reason) {
        if (active && isVisible()) {
          setMatchError(reason instanceof Error ? reason.message : "match_state_unavailable");
          rateLimitFailures = isRateLimitError(reason) ? rateLimitFailures + 1 : 0;
          schedule(rateLimitFailures > 0
            ? Math.min(MAX_RATE_LIMIT_BACKOFF_MS, RATE_LIMIT_BACKOFF_MS * rateLimitFailures)
            : WAITING_MATCH_POLL_MS);
        }
      } finally {
        matchReadInFlightRef.current = false;
      }
    };
    const onVisibilityChange = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      if (isVisible()) void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void refresh();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [chainActionInFlight, chainConfirmed, matchAddress, matchRevision, matchConnection]);

  const fullMatch = matchSnapshot?.status === "WAITING" &&
    matchSnapshot.playerCount >= matchSnapshot.capacity;
  const localIsHost = Boolean(walletAddress && matchSnapshot?.host === walletAddress);

  useEffect(() => {
    if (!fullMatch) {
      autoStartAttemptedRef.current = false;
      setAutoStartIn(undefined);
      return;
    }
    if (autoStartAttemptedRef.current) return;
    autoStartAttemptedRef.current = true;
    const deadline = Date.now() + 5_000;
    const updateCountdown = () => {
      setAutoStartIn(Math.max(0, Math.ceil((deadline - Date.now()) / 1_000)));
    };
    updateCountdown();
    const interval = window.setInterval(updateCountdown, 250);
    const timer = localIsHost
      ? window.setTimeout(() => {
        setAutoStartIn(undefined);
        void startMatch();
      }, 5_000)
      : undefined;
    return () => {
      window.clearInterval(interval);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [fullMatch, localIsHost, startMatch]);

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
    setActiveMatchToRelease(undefined);
    try {
      let result;
      try {
        result = await joinMatchOnchain({ matchAddress, seatIndex, rpcUrl: requireBaseSolanaRpc(), programId });
      } catch (reason) {
        if (!(reason instanceof Error) || reason.message !== "match_account_not_initialized") throw reason;
        setError("Match is not initialized. Simulating first-player setup before wallet approval…");
        await bootstrapMatchOnchain({
          pitId: matchId,
          nonce: currentMatchNonce,
          capacity: 4,
          rpcUrl: requireBaseSolanaRpc(),
          programId,
          expectedMatchAddress: matchAddress,
          onWalletApprovalRequested: () => setError("Setup simulation passed. Approve the Match account transaction in your wallet."),
        });
        result = await joinMatchOnchain({ matchAddress, seatIndex, rpcUrl: requireBaseSolanaRpc(), programId });
      }
      if ("alreadyJoined" in result && result.seatIndex !== seatIndex) {
        setError(`Wallet is already assigned to seat ${result.seatIndex}. Restoring that seat…`);
        onChainSeatConflict?.({ matchAddress, walletAddress: result.walletAddress });
      } else {
        onChainConfirmed({ matchAddress, walletAddress: result.walletAddress });
      }
      setChainPhase("confirmed");
    } catch (reason) {
      if (reason instanceof Error && reason.message.startsWith("pit_has_active_match:")) {
        setActiveMatchToRelease(reason.message.slice("pit_has_active_match:".length));
      }
      setChainPhase("failed");
      setError(walletJoinError(reason));
    }
  };

  const releaseStaleMatch = async (requestedMatchAddress = activeMatchToRelease ?? matchAddress) => {
    if (!requestedMatchAddress || releasingStaleMatch) return;
    if (!window.confirm("Release this match and create a fresh match? Existing round state will be abandoned.")) return;
    setReleasingStaleMatch(true);
    setChainPhase("joining");
    setError("Simulating stale-match release…");
    try {
      const result = await releaseActiveMatchOnchain({
        pitId: matchId,
        activeMatchAddress: requestedMatchAddress,
        rpcUrl: requireBaseSolanaRpc(),
        teeRpcUrl: teeSolanaRpc,
        programId,
        onWalletApprovalRequested: () => setError("Release simulation passed. Approve the host cleanup transaction in your wallet."),
      });
      setCurrentMatchNonce(result.matchNonce);
      setActiveMatchToRelease(undefined);
      onMatchAddressChanged?.(result.matchAddress);
      setChainPhase("required");
      setError("Fresh match created. Join it with your wallet to continue.");
    } catch (reason) {
      setChainPhase("failed");
      setError(reason instanceof Error ? reason.message : "active_match_release_failed");
    } finally {
      setReleasingStaleMatch(false);
    }
  };

  const restoreMatchToBase = async () => {
    if (!matchAddress || restoringMatch) return;
    setRestoringMatch(true);
    setError("Preparing legacy-match recovery…");
    try {
      await restoreDelegatedMatchOnchain({
        matchAddress,
        rpcUrl: requireBaseSolanaRpc(),
        teeRpcUrl: teeSolanaRpc,
        programId,
        onWalletApprovalRequested: () => setError("Recovery is ready. Approve the host transaction in your wallet."),
      });
      setError("Match restored to Base. You can now submit the RFQ.");
      setMatchRevision((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "match_restore_failed");
    } finally {
      setRestoringMatch(false);
    }
  };

  const submitIntent = async (intent: Parameters<typeof openRfqOnchain>[0]["intent"]) => {
    if (!matchAddress || !matchSnapshot?.host) throw new Error("match_host_unavailable");
    if (submittingRfq) return;
    setSubmittingRfq(true);
    setRfqProgress("Fetching a verified SOL/USD price update…");
    try {
      const priceUpdates = await fetchSolUsdPriceUpdates({ matchId, sessionId });
      await openRfqOnchain({
        baseRpcUrl: requireBaseSolanaRpc(),
        teeRpcUrl: teeSolanaRpc,
        matchAddress,
        hostAddress: matchSnapshot.host,
        programId,
        round: matchSnapshot.currentRound,
        intent,
        priceUpdates,
        onProgress: setRfqProgress,
      });
      setMatchRevision((value) => value + 1);
    } finally {
      setSubmittingRfq(false);
      setRfqProgress("");
    }
  };

  const settle = async () => {
    if (!matchAddress || !matchSnapshot?.resultAddress || !matchSnapshot.winner) throw new Error("match_result_unavailable");
    setSettling(true);
    setError("");
    try {
      await settleMatchOnchain({
        rpcUrl: requireBaseSolanaRpc(),
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

  const resolveRound = async () => {
    if (!matchAddress || !matchSnapshot?.host) throw new Error("match_host_unavailable");
    setResolving(true);
    setError("");
    try {
      const priceUpdates = matchSnapshot.currentRound >= 7
        ? await fetchSolUsdPriceUpdates({ matchId, sessionId })
        : undefined;
      await resolveRoundOnchain({
        baseRpcUrl: requireBaseSolanaRpc(),
        teeRpcUrl: teeSolanaRpc,
        matchAddress,
        round: matchSnapshot.currentRound,
        resolverAddress: matchSnapshot.host,
        snapshot: matchSnapshot,
        priceUpdates,
        programId,
      });
      setMatchRevision((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "round_resolution_failed");
    } finally {
      setResolving(false);
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
            {phase === "connected" && `${participants.length} media connected`}
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
            {activeMatchToRelease && (
              <>
                <p>Host cleanup is required before this pit can create the next match. This abandons the old match and creates a fresh nonce.</p>
                <button disabled={chainPhase === "joining" || releasingStaleMatch} onClick={() => void releaseStaleMatch()} type="button">
                  {chainPhase === "joining" || releasingStaleMatch ? "Releasing active match…" : "Release stale match (host)"}
                </button>
              </>
            )}
            <button className="pit-leave" onClick={onExit} type="button">Leave seat</button>
          </div>
        ) : (
          <>
            <MatchHud
              snapshot={matchSnapshot}
              walletAddress={walletAddress}
              error={matchError}
              settling={settling}
              resolving={resolving}
              starting={startingMatch}
              autoStartIn={autoStartIn}
              onRetry={() => setMatchRevision((value) => value + 1)}
              onStart={startMatch}
              onSettle={settle}
              onResolve={resolveRound}
              onReturn={onExit}
              onReleaseStaleMatch={() => releaseStaleMatch(matchAddress)}
              releasingStaleMatch={releasingStaleMatch}
            />
            {matchOwnership === "delegated" && (
              <div className="match-bootstrap match-bootstrap-failed">
                <p>This legacy match is delegated to the TEE. RFQs require the Match account on Base.</p>
                {localIsHost ? (
                  <button disabled={restoringMatch} onClick={() => void restoreMatchToBase()} type="button">
                    {restoringMatch ? "Restoring match…" : "Restore match to Base (host)"}
                  </button>
                ) : (
                  <p>Waiting for the host to restore the match.</p>
                )}
              </div>
            )}
            {role === "PLAYER" && matchAddress && walletAddress && (
              <PrivateInventoryPanel
                matchAddress={matchAddress}
                playerAddress={walletAddress}
                programId={programId}
              />
            )}
            <PrivateQuotePanel
              active={matchOwnership !== "delegated" && role === "PLAYER" && matchSnapshot?.roundStatus === "OPEN" && Boolean(matchSnapshot.taker && matchSnapshot.taker !== walletAddress)}
              matchAddress={matchAddress}
              dealerAddress={walletAddress}
              round={matchSnapshot?.currentRound}
              programId={programId}
            />
            <TradeIntentPanel
              active={matchOwnership !== "delegated" && role === "PLAYER" && matchSnapshot?.taker === walletAddress}
              matchId={matchId}
              role={role}
              sessionId={sessionId}
              onSubmit={matchSnapshot && matchAddress ? submitIntent : undefined}
              submissionStatus={rfqProgress}
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
                  <span className="pit-voice-note">
                    Pit audio is separate from trade dictation. When it is your turn, use “Start voice command”.
                  </span>
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
