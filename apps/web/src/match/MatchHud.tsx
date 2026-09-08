import { useEffect, useState } from "react";
import type { PublicMatchSnapshot } from "../chain/matchState";

type Props = {
  snapshot?: PublicMatchSnapshot;
  walletAddress?: string;
  error?: string;
  settling?: boolean;
  resolving?: boolean;
  skipping?: boolean;
  resumingSkipped?: boolean;
  starting?: boolean;
  autoStartIn?: number;
  onRetry?: () => void;
  onStart?: () => Promise<void>;
  onSettle?: () => Promise<void>;
  onResolve?: () => Promise<void>;
  onSkip?: () => Promise<void>;
  onResumeSkipped?: () => Promise<void>;
  onReturn?: () => void;
  onReleaseStaleMatch?: () => void;
  releasingStaleMatch?: boolean;
};

const shortKey = (value?: string) => value ? `${value.slice(0, 4)}…${value.slice(-4)}` : "—";

export default function MatchHud({ snapshot, walletAddress, error, settling, resolving, skipping, resumingSkipped, starting, autoStartIn, onRetry, onStart, onSettle, onResolve, onSkip, onResumeSkipped, onReturn, onReleaseStaleMatch, releasingStaleMatch }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!snapshot?.deadlineAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [snapshot?.deadlineAt]);

  if (!snapshot) {
    return (
      <section className="match-hud" aria-label="Match state">
        <p className="eyebrow">MATCH HUD</p>
        <strong className="hud-state" role="status">{error ? `Match state unavailable · ${error}` : "Loading onchain turn state…"}</strong>
        <span className="hud-loading-meta">HOST: resolving from onchain match state…</span>
        {error && onRetry && <button onClick={onRetry} type="button">Retry match state</button>}
      </section>
    );
  }

  const remaining = snapshot.deadlineAt ? Math.max(0, Math.ceil((snapshot.deadlineAt - now) / 1000)) : undefined;
  const localIsTaker = Boolean(walletAddress && snapshot.taker === walletAddress);
  const localIsHost = Boolean(walletAddress && snapshot.host === walletAddress);
  const canStart = localIsHost && snapshot.status === "WAITING" && snapshot.playerCount >= 2;
  const liveRoundStateAvailable = snapshot.stateSource !== "tee-unavailable";
  const quoteDeadlinePassed = remaining === 0;
  const canResolve = liveRoundStateAvailable && snapshot.stateSource === "tee" && localIsHost && snapshot.status === "STARTED" && snapshot.roundStatus === "OPEN" && snapshot.quoteCount > 0 && (snapshot.quoteCount >= snapshot.dealerCount || quoteDeadlinePassed);
  const canSkipEmptyRound = liveRoundStateAvailable && snapshot.stateSource === "tee" && localIsHost && snapshot.status === "STARTED" && snapshot.roundStatus === "OPEN" && snapshot.quoteCount === 0 && quoteDeadlinePassed;
  const canResumeSkippedRound = liveRoundStateAvailable && snapshot.stateSource === "tee" && localIsHost && snapshot.status === "STARTED" && snapshot.roundStatus === "SKIPPED" && snapshot.quoteCount === 0;
  const finalScores = snapshot.finalScoresE6?.slice(0, snapshot.playerCount) ?? [];
  const localIndex = walletAddress ? snapshot.players.indexOf(walletAddress) : -1;
  const localScore = localIndex >= 0 ? finalScores[localIndex] : undefined;
  const finalRank = localIndex >= 0 && snapshot.finalScoresE6
    ? [...finalScores].sort((a, b) => b - a).indexOf(localScore ?? Number.MIN_SAFE_INTEGER) + 1
    : undefined;

  return (
    <section className="match-hud" aria-label="Match state">
      <div className="match-hud-identity" role="status">
        <strong className={localIsHost ? "hud-host" : "hud-muted"}>
          {localIsHost ? "YOU ARE THE HOST" : `HOST: ${shortKey(snapshot.host)}`}
        </strong>
        <span className="hud-muted">{snapshot.playerCount}/{snapshot.capacity} onchain players seated</span>
      </div>
      <div className="match-hud-topline">
        <div>
          <p className="eyebrow">MATCH HUD</p>
          <strong>{snapshot.status} · ROUND {snapshot.currentRound + 1}/8</strong>
        </div>
        <span className={localIsTaker ? "hud-taker" : "hud-muted"} role="status">
          {localIsTaker
            ? "YOUR TURN · START VOICE"
            : snapshot.status === "WAITING" && localIsHost
              ? "HOST · READY TO START"
              : snapshot.status === "WAITING"
                ? `WAITING FOR HOST ${shortKey(snapshot.host)}`
                : snapshot.status === "STARTED" && snapshot.taker
                  ? `WAITING FOR ${shortKey(snapshot.taker)}`
                  : "WAITING FOR MATCH STATE"}
        </span>
      </div>
      {error && <div className="hud-error" role="alert">
        <span>Onchain state refresh failed · {error}</span>
        {onRetry && <button onClick={onRetry} type="button">Retry</button>}
      </div>}
      <div className="match-hud-grid">
        <div><span>Intent</span><strong>{snapshot.side ? `${snapshot.side} ${snapshot.quantityLots} SOL` : "Waiting"}</strong></div>
        <div><span>Quotes sealed</span><strong>{liveRoundStateAvailable ? `${snapshot.quoteCount}/${snapshot.dealerCount}` : "Live TEE unavailable"}</strong></div>
        <div><span>Round clock</span><strong>{remaining === undefined ? "—" : `${remaining}s`}</strong></div>
        <div><span>Private inventory</span><strong>Only you · TEE sync</strong></div>
      </div>
      {canResolve && onResolve && (
        <div className="match-lobby">
          <strong>{snapshot.quoteCount >= snapshot.dealerCount ? "All dealer quotes are sealed. Resolve the round to continue." : "The quote deadline passed. Resolve the sealed quotes that arrived."}</strong>
          <button disabled={resolving || skipping} onClick={() => void onResolve()} type="button">
            {resolving ? "Resolving round…" : "Resolve round"}
          </button>
        </div>
      )}
      {canSkipEmptyRound && onSkip && (
        <div className="match-lobby">
          <strong>No quotes were sealed before the deadline. Skip this round without a trade.</strong>
          <button disabled={resolving || skipping || resumingSkipped} onClick={() => void onSkip()} type="button">
            {skipping ? "Skipping empty round…" : "Skip empty round"}
          </button>
        </div>
      )}
      {canResumeSkippedRound && onResumeSkipped && (
        <div className="match-lobby">
          <strong>This empty round was already skipped. Finish cleanup to continue.</strong>
          <button disabled={resolving || skipping || resumingSkipped} onClick={() => void onResumeSkipped()} type="button">
            {resumingSkipped ? "Resuming skipped round…" : "Resume skipped round"}
          </button>
        </div>
      )}
      {snapshot.status === "WAITING" && (
        <div className="match-lobby">
          <span>{snapshot.playerCount}/{snapshot.capacity} players seated · minimum 2 required</span>
          {localIsHost ? (
            <>
              <strong>{autoStartIn !== undefined
                ? `Full pit · starting in ${autoStartIn}s`
                : canStart ? "You control when the match begins." : "Waiting for at least 2 players."}</strong>
              {onStart && <button disabled={!canStart || starting || autoStartIn !== undefined} onClick={() => void onStart()} type="button">
                {starting ? "Starting match…" : autoStartIn !== undefined ? `Starting in ${autoStartIn}s` : "Start match"}
              </button>}
            </>
          ) : (
            <strong>{autoStartIn !== undefined ? `Full pit · host start in ${autoStartIn}s` : `Host ${shortKey(snapshot.host)} starts the match.`}</strong>
          )}
        </div>
      )}
      {snapshot.winner && (
        <div className="match-result" role="status">
          <span>Result revealed · winner {shortKey(snapshot.winner)}</span>
          {finalRank ? <strong>Your rank #{finalRank}</strong> : <strong>Final scores public</strong>}
          {snapshot.settled ? <>
            <strong>Settled</strong>
            {onReturn && <button onClick={onReturn} type="button">Return to floor</button>}
          </> : snapshot.winner === walletAddress && onSettle ? (
            <button disabled={settling} onClick={() => void onSettle()} type="button">
              {settling ? "Settling…" : "Settle payout"}
            </button>
          ) : null}
        </div>
      )}
      {localIsHost && onReleaseStaleMatch && (
        <div className="match-lobby">
          <strong>Host recovery: abandon this match and create a fresh one.</strong>
          <button disabled={releasingStaleMatch} onClick={onReleaseStaleMatch} type="button">
            {releasingStaleMatch ? "Releasing stale match…" : "Release stale match / start fresh"}
          </button>
        </div>
      )}
    </section>
  );
}
