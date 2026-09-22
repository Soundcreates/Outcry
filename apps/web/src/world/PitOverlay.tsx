import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  Participant,
  Room,
  RoomEvent,
  Track,
  type DisconnectReason,
} from "livekit-client";
import { bootstrapMatchOnchain, classifyMatchOwnership, connectedWalletAddress, joinMatchOnchain, migrateLegacyMatchOnchain, readActivePitMatchOnchain, releaseActiveMatchOnchain, renewSessionOnchain, type MatchOwnership } from "../chain/joinMatch";
import { baseRpcConfigurationMessage, browserBaseRpc, createBaseRpcConnection } from "../chain/baseRpc";
import { openRfqOnchain, resolveRoundOnchain, RfqSubmissionError, resumeSkippedRoundOnchain, settleMatchOnchain, skipEmptyRoundOnchain, startMatchOnchain } from "../chain/matchActions";
import { currentRoundTaker, loadRuntimeMatchState, type PublicMatchSnapshot } from "../chain/matchState";
import MatchHud from "../match/MatchHud";
import PrivateInventoryPanel from "../match/PrivateInventoryPanel";
import PrivateQuotePanel from "../match/PrivateQuotePanel";
import TradeIntentPanel from "../match/TradeIntentPanel";
import { API_BASE_URL } from "../config";

type Props = {
  matchId: string;
  matchAddress?: string;
  chainConfirmed?: boolean;
  onChainConfirmed: (input: { matchAddress: string; walletAddress: string }) => void;
  onWalletJoinStarted: () => void;
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
const RFQ_OPEN_TOPIC = "outcry-rfq";

type MatchStateNotification = {
  type: "rfq-open" | "round-resolved";
  matchAddress: string;
  round: number;
};

function isMatchStateNotification(value: unknown): value is MatchStateNotification {
  if (!value || typeof value !== "object") return false;
  const notification = value as Partial<MatchStateNotification>;
  const round = notification.round;
  return (notification.type === "rfq-open" || notification.type === "round-resolved")
    && typeof notification.matchAddress === "string"
    && typeof round === "number"
    && Number.isInteger(round)
    && round >= 0
    && round < 8;
}

function requireBaseSolanaRpc() {
  if (!baseSolanaRpc) throw new Error(baseRpcConfigurationMessage(browserBaseRpc.error));
  return baseSolanaRpc;
}

function isRateLimitError(reason: unknown) {
  return /(?:\b429\b|too many requests|rate limit)/i.test(reason instanceof Error ? reason.message : String(reason));
}

function walletJoinError(reason: unknown) {
  const message = reason instanceof Error ? reason.message : "onchain_join_failed";
  if (/HostCannotJoin|Error Number:\s*6060/.test(message)) {
    return "The deployed Outcry program is outdated and rejects host seating. Deploy the current program build to this configured Solana cluster, then retry.";
  }
  if (message === "wallet_fee_payer_unfunded") {
    return "This wallet has insufficient Devnet SOL to pay the join fee. Fund it from the Solana Devnet faucet, then retry wallet join.";
  }
  if (message === "wallet_already_joined_different_seat") {
    return "This wallet is already joined in a different seat. Leave that seat or use the matching seat before retrying.";
  }
  if (message === "legacy_match_requires_migration") {
    return "This pit still points to a legacy V1 match. The host must migrate it or release it and create a V2 match; changing .env alone is not enough.";
  }
  if (message === "match_account_invalid") {
    return "The world server advertised a match that is not a current MatchV2 account. Restart the world server, then have the host migrate or release the active V1 match.";
  }
  if (message === "active_v2_match_nonce_unrecoverable") {
    return "The active V2 match nonce could not be recovered locally. No wallet approval was requested; contact the operator to recover the pit lifecycle state.";
  }
  if (message === "match_finished_release_required") {
    return "This match has finished. The host must release it and start a fresh match before a new wallet can join.";
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

function resolveRoundError(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  const code = reason instanceof RfqSubmissionError ? reason.code : message;
  if (code === "permissionless_relayer_unreachable") {
    return "The round relayer could not be reached. Check that the world server is running, then retry.";
  }
  if (code === "relayer_not_configured" || code === "relayer_keypair_invalid") {
    return "The world server has no usable round-relayer signer. Ask the host to configure and fund its Devnet relayer.";
  }
  if (code === "tee_relayer_not_configured" || code === "tee_relayer_keypair_invalid" || code === "tee_relayer_must_be_distinct") {
    return "The world server needs a separate TEE fee-payer key. Configure it, restart the server, then retry.";
  }
  if (code === "tee_relayer_not_delegated" || code === "tee_relayer_underfunded" || code === "tee_relayer_unavailable" || code === "tee_relayer_owner_invalid") {
    return "The TEE fee payer is not ready. The host must run the TEE-relayer provisioning command, then retry.";
  }
  if (code === "relayer_simulation_failed") {
    return "The round cannot be resolved in its current state. The host can check the world-server relayer logs for the exact failed invariant.";
  }
  if (code === "runtime_router_unavailable" || code === "runtime_router_invalid" || code === "runtime_route_mismatch") {
    return "The runtime route is not ready on MagicBlock. Retry shortly; the host can inspect the crank diagnostics endpoint if it persists.";
  }
  if (code === "tee_relayer_route_mismatch") {
    return "The TEE fee payer is delegated to a different validator than this match runtime. Re-provision it for this MagicBlock route.";
  }
  if (code === "private_state_unavailable" || code === "private_state_not_delegated") {
    return "Resolve is blocked because one or more private quote or inventory accounts have not been delegated. Re-run that player's private-state setup.";
  }
  if (code === "private_state_router_unavailable" || code === "private_state_router_invalid" || code === "private_state_route_mismatch") {
    return "Resolve is blocked because private state is not on the same MagicBlock route as the runtime. Check crank diagnostics before retrying.";
  }
  if (code === "relayer_confirmation_failed" || code === "relayer_rpc_failed") {
    return `The round relayer failed during ${reason instanceof RfqSubmissionError && reason.detail ? reason.detail : "submission"}. It will not duplicate a resolved round; check crank diagnostics before retrying.`;
  }
  if (message.startsWith("rfq_state_not_ready:")) {
    const missing = message.slice("rfq_state_not_ready:".length).split(",").filter(Boolean);
    if (missing.some((account) => account.includes("inventory"))) {
      return "Resolve is not ready: private inventory state is unavailable for one or more players.";
    }
    if (missing.some((account) => account.includes("quote"))) {
      return "Resolve is not ready: the dealer quote is still being prepared. Ask the dealer to retry private quote setup.";
    }
    return `Resolve is not ready: ${missing.join(", ") || "private round state is unavailable"}.`;
  }
  if (message === "tee_auth_failed") return "TEE authorization failed. Retry resolving the round.";
  if (message === "skip_deadline_not_reached") return "The quote deadline has not passed yet.";
  if (message === "empty_round_required") return "A sealed quote arrived, so this round must be resolved rather than skipped.";
  if (message === "empty_round_requires_skip") return "No quotes were sealed. Wait for the deadline, then skip the empty round.";
  return message || "round_resolution_failed";
}

function settlementError(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (message === "settlement_escrow_missing_release_required") {
    return "This legacy match was started without its escrow payout. It cannot be settled safely; the host must release it and start a fresh match.";
  }
  return message || "settlement_failed";
}

export default function PitOverlay({ matchId, matchAddress, chainConfirmed, onChainConfirmed, onWalletJoinStarted, onMatchAddressChanged, onChainSeatConflict, onExit, role, seatIndex, sessionId }: Props) {
  const room = useMemo(() => new Room({ adaptiveStream: true, dynacast: true }), []);
  const matchConnection = useMemo(() => baseSolanaRpc ? createBaseRpcConnection(baseSolanaRpc) : undefined, []);
  // MatchV2 is durable metadata; MatchRuntime and private state are live in the ER.
  const teeMatchConnection = useMemo(() => new Connection(teeSolanaRpc, { commitment: "confirmed", disableRetryOnRateLimit: true }), []);
  const [chainPhase, setChainPhase] = useState<"required" | "joining" | "awaiting_confirmation" | "confirmed" | "failed">(
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
  const [skippingRound, setSkippingRound] = useState(false);
  const [resumingSkippedRound, setResumingSkippedRound] = useState(false);
  const [startingMatch, setStartingMatch] = useState(false);
  const [selectedRoundCount, setSelectedRoundCount] = useState(3);
  const [activeMatchToRelease, setActiveMatchToRelease] = useState<string>();
  const [legacyMatchToMigrate, setLegacyMatchToMigrate] = useState<string>();
  const [currentMatchNonce, setCurrentMatchNonce] = useState(matchNonce);
  const [releasingStaleMatch, setReleasingStaleMatch] = useState(false);
  const [migratingLegacyMatch, setMigratingLegacyMatch] = useState(false);
  const [submittingRfq, setSubmittingRfq] = useState(false);
  const [rfqProgress, setRfqProgress] = useState("");
  const [autoStartIn, setAutoStartIn] = useState<number>();
  const matchReadInFlightRef = useRef(false);
  const startMatchInFlightRef = useRef(false);
  const autoStartAttemptedRef = useRef(false);
  const walletAddress = connectedWalletAddress();
  const chainActionInFlight = startingMatch || settling || resolving || skippingRound || resumingSkippedRound || releasingStaleMatch || migratingLegacyMatch || submittingRfq || chainPhase === "joining";

  useEffect(() => {
    if (chainConfirmed) setChainPhase("confirmed");
  }, [chainConfirmed]);

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

  const startMatch = useCallback(async (roundCount = selectedRoundCount) => {
    if (startMatchInFlightRef.current) return;
    if (!matchAddress || !matchSnapshot) throw new Error("match_state_unavailable");
    startMatchInFlightRef.current = true;
    setStartingMatch(true);
    setError("");
    try {
      await startMatchOnchain({
        rpcUrl: requireBaseSolanaRpc(),
        matchAddress,
        hostAddress: matchSnapshot.host ?? matchSnapshot.authority,
        roundCount,
        programId,
      });
      setMatchRevision((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "start_match_failed");
    } finally {
      startMatchInFlightRef.current = false;
      setStartingMatch(false);
    }
  }, [matchAddress, matchSnapshot?.host, selectedRoundCount]);

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
    const onMatchStateHint = (payload: Uint8Array) => {
      try {
        const notification = JSON.parse(new TextDecoder().decode(payload));
        if (active && isMatchStateNotification(notification) && notification.matchAddress === matchAddress) {
          setMatchRevision((value) => value + 1);
        }
      } catch {
        // Data messages are hints only; Base state remains authoritative.
      }
    };

    room.on(RoomEvent.Connected, onConnected);
    room.on(RoomEvent.Reconnecting, onReconnecting);
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.Disconnected, onDisconnected);
    room.on(RoomEvent.DataReceived, onMatchStateHint);
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
      const response = await fetch(`${API_BASE_URL}/api/livekit/token`, {
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
      room.off(RoomEvent.DataReceived, onMatchStateHint);
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
        const next = await loadRuntimeMatchState({
          rpcUrl: requireBaseSolanaRpc(),
          matchAddress,
          programId,
          baseConnection: matchConnection,
          teeConnection: teeMatchConnection,
        });
        if (active && isVisible()) {
          setMatchSnapshot(next);
          setMatchOwnership(next.accountOwner ? classifyMatchOwnership(new PublicKey(next.accountOwner), new PublicKey(programId)) : undefined);
          setMatchError(next.stateSource === "tee-unavailable" ? "Live TEE state unavailable. Quote count cannot be confirmed yet." : "");
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
  }, [chainActionInFlight, chainConfirmed, matchAddress, matchRevision, matchConnection, teeMatchConnection]);

  const fullMatch = matchSnapshot?.status === "WAITING" &&
    matchSnapshot.playerCount >= matchSnapshot.capacity;
  const localIsHost = Boolean(walletAddress && matchSnapshot?.host === walletAddress);
  const currentTaker = matchSnapshot ? currentRoundTaker(matchSnapshot) : undefined;

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
    onWalletJoinStarted();
    try {
      let result;
      try {
        result = await joinMatchOnchain({
          matchAddress,
          rpcUrl: requireBaseSolanaRpc(),
          programId,
          teeRpcUrl: teeSolanaRpc,
          onWalletApprovalRequested: () => setError("Setup simulation passed. Approve the one-time match/session setup in your wallet."),
        });
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
        result = await joinMatchOnchain({
          matchAddress,
          rpcUrl: requireBaseSolanaRpc(),
          programId,
          teeRpcUrl: teeSolanaRpc,
          onWalletApprovalRequested: () => setError("Setup simulation passed. Approve the one-time match/session setup in your wallet."),
        });
      }
      onChainConfirmed({ matchAddress, walletAddress: result.walletAddress });
      setChainPhase("awaiting_confirmation");
    } catch (reason) {
      if (reason instanceof Error && reason.message.startsWith("pit_has_active_match:")) {
        setActiveMatchToRelease(reason.message.slice("pit_has_active_match:".length));
      }
      if (reason instanceof Error && reason.message === "match_finished_release_required") {
        setActiveMatchToRelease(matchAddress);
      }
      if (reason instanceof Error && reason.message === "legacy_match_requires_migration") {
        setActiveMatchToRelease(matchAddress);
        setLegacyMatchToMigrate(matchAddress);
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
        preferredMatchNonce: currentMatchNonce,
        rpcUrl: requireBaseSolanaRpc(),
        programId,
        onWalletApprovalRequested: () => setError("Release simulation passed. Approve the host cleanup transaction in your wallet."),
      });
      setCurrentMatchNonce(result.matchNonce);
      setActiveMatchToRelease(undefined);
      setLegacyMatchToMigrate(undefined);
      onMatchAddressChanged?.(result.matchAddress);
      setChainPhase("required");
      setError("Fresh match created. Join it with your wallet to continue.");
    } catch (reason) {
      setChainPhase("failed");
      setError(walletJoinError(reason));
    } finally {
      setReleasingStaleMatch(false);
    }
  };

  const migrateLegacyMatch = async () => {
    if (!legacyMatchToMigrate || migratingLegacyMatch) return;
    setMigratingLegacyMatch(true);
    setChainPhase("joining");
    setError("Simulating legacy-match migration…");
    try {
      const result = await migrateLegacyMatchOnchain({
        pitId: matchId,
        legacyMatchAddress: legacyMatchToMigrate,
        rpcUrl: requireBaseSolanaRpc(),
        programId,
        onWalletApprovalRequested: () => setError("Migration simulation passed. Approve the host migration transaction in your wallet."),
      });
      setCurrentMatchNonce(result.matchNonce);
      setActiveMatchToRelease(undefined);
      setLegacyMatchToMigrate(undefined);
      onMatchAddressChanged?.(result.matchAddress);
      setChainPhase("required");
      setError("Legacy match migrated to V2. Join the new match with your wallet.");
    } catch (reason) {
      setChainPhase("failed");
      setError(walletJoinError(reason));
    } finally {
      setMigratingLegacyMatch(false);
    }
  };

  const submitIntent = async (intent: Parameters<typeof openRfqOnchain>[0]["intent"]) => {
    if (!matchAddress || !matchSnapshot) throw new Error("match_state_unavailable");
    const takerAddress = currentRoundTaker(matchSnapshot);
    if (matchSnapshot.roundStatus !== "PREPARED" || !takerAddress || takerAddress !== walletAddress) {
      throw new Error("not_current_taker");
    }
    if (submittingRfq) return;
    setSubmittingRfq(true);
    setRfqProgress("Submitting the RFQ with your authorized session signer…");
    try {
      await openRfqOnchain({
        baseRpcUrl: requireBaseSolanaRpc(),
        teeRpcUrl: teeSolanaRpc,
        matchAddress,
        matchId,
        sessionId,
        authorityAddress: takerAddress,
        programId,
        intent,
        onProgress: setRfqProgress,
      });
      setMatchRevision((value) => value + 1);
      void room.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify({ type: "rfq-open", matchAddress, round: matchSnapshot.currentRound } satisfies MatchStateNotification)),
        { reliable: true, topic: RFQ_OPEN_TOPIC },
      ).catch(() => undefined);
    } finally {
      setSubmittingRfq(false);
      setRfqProgress("");
    }
  };

  const renewSession = async () => {
    if (!matchAddress || !walletAddress) throw new Error("session_renewal_unavailable");
    setSubmittingRfq(true);
    setRfqProgress("Simulating session renewal before wallet approval…");
    try {
      await renewSessionOnchain({
        rpcUrl: requireBaseSolanaRpc(),
        matchAddress,
        authorityAddress: walletAddress,
        programId,
        onWalletApprovalRequested: () => setRfqProgress("Approve the one-time session renewal in your wallet…"),
      });
      setRfqProgress("Session renewed for 24 hours.");
      setMatchRevision((value) => value + 1);
    } finally {
      setSubmittingRfq(false);
      window.setTimeout(() => setRfqProgress(""), 2_000);
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
      setError(settlementError(reason));
    } finally {
      setSettling(false);
    }
  };

  const resolveRound = async () => {
    setResolving(true);
    setError("");
    try {
      if (!matchAddress || !matchSnapshot) throw new Error("match_state_unavailable");
      const resolvedRound = matchSnapshot.currentRound;
      await resolveRoundOnchain({
        baseRpcUrl: requireBaseSolanaRpc(),
        matchAddress,
        snapshot: matchSnapshot,
        programId,
      });
      setMatchRevision((value) => value + 1);
      void room.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify({ type: "round-resolved", matchAddress, round: resolvedRound } satisfies MatchStateNotification)),
        { reliable: true, topic: RFQ_OPEN_TOPIC },
      ).catch(() => undefined);
    } catch (reason) {
      console.error("[outcry][resolve_round]", reason);
      setError(resolveRoundError(reason));
    } finally {
      setResolving(false);
    }
  };

  const skipEmptyRound = async () => {
    if (skippingRound) return;
    setSkippingRound(true);
    setError("");
    try {
      if (!matchAddress || !matchSnapshot) throw new Error("match_state_unavailable");
      await skipEmptyRoundOnchain({
        baseRpcUrl: requireBaseSolanaRpc(),
        matchAddress,
        snapshot: matchSnapshot,
        programId,
      });
      setMatchRevision((value) => value + 1);
    } catch (reason) {
      console.error("[outcry][skip_empty_round]", reason);
      setError(resolveRoundError(reason));
    } finally {
      setSkippingRound(false);
    }
  };

  const resumeSkippedRound = async () => {
    if (resumingSkippedRound) return;
    setResumingSkippedRound(true);
    setError("");
    try {
      if (!matchAddress || !matchSnapshot) throw new Error("match_state_unavailable");
      await resumeSkippedRoundOnchain({
        baseRpcUrl: requireBaseSolanaRpc(),
        matchAddress,
        snapshot: matchSnapshot,
        programId,
      });
      setMatchRevision((value) => value + 1);
    } catch (reason) {
      console.error("[outcry][resume_skipped_round]", reason);
      setError(resolveRoundError(reason));
    } finally {
      setResumingSkippedRound(false);
    }
  };

  const needsChainJoin = role === "PLAYER" && Boolean(matchAddress) && chainPhase !== "confirmed" && chainPhase !== "awaiting_confirmation";

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
                <p>Host cleanup is required before this pit can use a V2 match. Migrate a waiting V1 match to preserve its players, or release it to abandon the old state and create a fresh nonce.</p>
            {legacyMatchToMigrate && (
              <button disabled={chainPhase === "joining" || migratingLegacyMatch} onClick={() => void migrateLegacyMatch()} type="button">
                {migratingLegacyMatch ? "Migrating legacy match…" : "Migrate waiting V1 match (host)"}
              </button>
            )}
            <button disabled={chainPhase === "joining" || releasingStaleMatch} onClick={() => void releaseStaleMatch()} type="button">
              {chainPhase === "joining" || releasingStaleMatch ? "Releasing active match…" : "Release stale match (host)"}
            </button>
              </>
            )}
            <button className="pit-leave" onClick={onExit} type="button">Leave seat</button>
          </div>
        ) : chainPhase === "awaiting_confirmation" ? (
          <div className="pit-chain-join">
            <p>Wallet approved. Verifying your onchain seat before entering the media room…</p>
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
              skipping={skippingRound}
              resumingSkipped={resumingSkippedRound}
              starting={startingMatch}
              autoStartIn={autoStartIn}
              roundCount={selectedRoundCount}
              onRetry={() => setMatchRevision((value) => value + 1)}
              onRoundCountChange={setSelectedRoundCount}
              onStart={startMatch}
              onSettle={settle}
              onResolve={resolveRound}
              onSkip={skipEmptyRound}
              onResumeSkipped={resumeSkippedRound}
              onReturn={onExit}
              onReleaseStaleMatch={() => releaseStaleMatch(matchAddress)}
              releasingStaleMatch={releasingStaleMatch}
            />
            {role === "PLAYER" && matchAddress && walletAddress && (
              <PrivateInventoryPanel
                matchAddress={matchAddress}
                playerAddress={walletAddress}
                programId={programId}
                lastResolvedRound={matchSnapshot?.lastRoundResult?.round}
              />
            )}
            <PrivateQuotePanel
              active={matchOwnership !== "delegated" && role === "PLAYER" && matchSnapshot?.roundStatus === "OPEN" && Boolean(matchSnapshot.taker && matchSnapshot.taker !== walletAddress)}
              matchAddress={matchAddress}
              dealerAddress={walletAddress}
              round={matchSnapshot?.currentRound}
              roundStatus={matchSnapshot?.roundStatus === "OPEN" ? "OPEN" : undefined}
              oraclePriceE6={matchSnapshot?.oraclePriceE6}
              deadlineAt={matchSnapshot?.deadlineAt}
              programId={programId}
              onQuoteSealed={() => setMatchRevision((value) => value + 1)}
            />
            <TradeIntentPanel
              active={matchOwnership !== "delegated" && role === "PLAYER" && matchSnapshot?.roundStatus === "PREPARED" && currentTaker === walletAddress}
              matchId={matchId}
              role={role}
              sessionId={sessionId}
              onSubmit={matchSnapshot && matchAddress ? submitIntent : undefined}
              onRecoverSession={matchAddress && walletAddress ? renewSession : undefined}
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
