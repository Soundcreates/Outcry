import { useEffect, useState } from "react";
import type { PublicMatchSnapshot } from "../chain/matchState";

type Props = {
  snapshot?: PublicMatchSnapshot;
  walletAddress?: string;
  error?: string;
  settling?: boolean;
  onSettle?: () => Promise<void>;
  onReturn?: () => void;
};

const shortKey = (value?: string) => value ? `${value.slice(0, 4)}…${value.slice(-4)}` : "—";

export default function MatchHud({ snapshot, walletAddress, error, settling, onSettle, onReturn }: Props) {
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
        <strong>{error ?? "Waiting for public match state…"}</strong>
      </section>
    );
  }

  const remaining = snapshot.deadlineAt ? Math.max(0, Math.ceil((snapshot.deadlineAt - now) / 1000)) : undefined;
  const localIsTaker = Boolean(walletAddress && snapshot.taker === walletAddress);
  const finalScores = snapshot.finalScoresE6?.slice(0, snapshot.playerCount) ?? [];
  const localIndex = walletAddress ? snapshot.players.indexOf(walletAddress) : -1;
  const localScore = localIndex >= 0 ? finalScores[localIndex] : undefined;
  const finalRank = localIndex >= 0 && snapshot.finalScoresE6
    ? [...finalScores].sort((a, b) => b - a).indexOf(localScore ?? Number.MIN_SAFE_INTEGER) + 1
    : undefined;

  return (
    <section className="match-hud" aria-label="Match state">
      <div className="match-hud-topline">
        <div>
          <p className="eyebrow">MATCH HUD</p>
          <strong>{snapshot.status} · ROUND {snapshot.currentRound + 1}/8</strong>
        </div>
        <span className={localIsTaker ? "hud-taker" : "hud-muted"} role="status">
          {localIsTaker ? "YOUR TURN" : `TAKER ${shortKey(snapshot.taker)}`}
        </span>
      </div>
      <div className="match-hud-grid">
        <div><span>Intent</span><strong>{snapshot.side ? `${snapshot.side} ${snapshot.quantityLots} SOL` : "Waiting"}</strong></div>
        <div><span>Quotes sealed</span><strong>{snapshot.quoteCount}/{snapshot.dealerCount}</strong></div>
        <div><span>Round clock</span><strong>{remaining === undefined ? "—" : `${remaining}s`}</strong></div>
        <div><span>Private inventory</span><strong>Only you · TEE sync</strong></div>
      </div>
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
    </section>
  );
}
