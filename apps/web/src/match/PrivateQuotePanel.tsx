import { useEffect, useState } from "react";
import { baseRpcConfigurationMessage, browserBaseRpc } from "../chain/baseRpc";
import { preparePrivateQuoteOnchain, submitPrivateQuoteOnchain } from "../chain/matchActions";

type Props = {
  active: boolean;
  matchAddress?: string;
  dealerAddress?: string;
  round?: number;
  roundStatus?: "PREPARED" | "OPEN";
  oraclePriceE6?: number;
  deadlineAt?: number;
  programId: string;
  onQuoteSealed?: () => void;
};

const teeRpc = import.meta.env.VITE_MAGICBLOCK_TEE_RPC || import.meta.env.NEXT_PUBLIC_MAGICBLOCK_TEE_RPC || "";

const MAX_QUOTE_DEVIATION_BPS = 500;
const QUOTE_SUBMISSION_CUTOFF_MS = 3_000;

function quoteBounds(oraclePriceE6?: number) {
  if (!Number.isSafeInteger(oraclePriceE6) || !oraclePriceE6 || oraclePriceE6 <= 0) return undefined;
  const oracle = BigInt(oraclePriceE6);
  const deviation = (oracle * BigInt(MAX_QUOTE_DEVIATION_BPS)) / 10_000n;
  return { min: oracle - deviation, max: oracle + deviation };
}

function formatUsdcE6(value: bigint) {
  return `$${(Number(value) / 1_000_000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function PrivateQuotePanel({ active, matchAddress, dealerAddress, round, roundStatus, oraclePriceE6, deadlineAt, programId, onQuoteSealed }: Props) {
  const [price, setPrice] = useState("");
  const [status, setStatus] = useState<"idle" | "preparing" | "prepared" | "submitting" | "submitted" | "error">("idle");
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const quoteReady = status === "prepared" || status === "submitting";
  const quoteSealed = status === "submitted";
  const bounds = quoteBounds(oraclePriceE6);

  useEffect(() => {
    setPrice("");
    setStatus("idle");
    setError("");
  }, [dealerAddress, matchAddress, round]);

  useEffect(() => {
    if (roundStatus !== "OPEN" || deadlineAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [deadlineAt, roundStatus]);

  if (!active) return null;

  const prepare = async () => {
    if (!matchAddress || !dealerAddress || round === undefined) return setError("private_round_unavailable");
    if (!teeRpc) return setError("tee_rpc_unconfigured");
    if (!browserBaseRpc.url) return setError(baseRpcConfigurationMessage(browserBaseRpc.error));
    setStatus("preparing");
    setError("");
    try {
      await preparePrivateQuoteOnchain({ baseRpcUrl: browserBaseRpc.url, teeRpcUrl: teeRpc, matchAddress, dealerAddress, round, programId });
      setStatus("prepared");
    } catch (reason) {
      setStatus("error");
      setError(reason instanceof Error ? reason.message : "private_quote_preparation_failed");
    }
  };

  const submit = async () => {
    const priceE6 = Number(price);
    if (!matchAddress || !dealerAddress || round === undefined) return setError("private_round_unavailable");
    if (!teeRpc) return setError("tee_rpc_unconfigured");
    if (!browserBaseRpc.url) return setError(baseRpcConfigurationMessage(browserBaseRpc.error));
    if (!Number.isSafeInteger(priceE6) || priceE6 <= 0) return setError("enter_positive_price_e6");
    if (bounds && (BigInt(priceE6) < bounds.min || BigInt(priceE6) > bounds.max)) {
      return setError(`Quote must be within ±5% of the verified mark ${formatUsdcE6(BigInt(oraclePriceE6!))}: ${formatUsdcE6(bounds.min)} to ${formatUsdcE6(bounds.max)} (${bounds.min} to ${bounds.max} USDC e6).`);
    }
    if (deadlineAt !== undefined && Date.now() >= deadlineAt - QUOTE_SUBMISSION_CUTOFF_MS) {
      return setError("quote_window_too_close_wait_for_next_rfq");
    }
    setStatus("submitting");
    setError("");
    try {
      await submitPrivateQuoteOnchain({ baseRpcUrl: browserBaseRpc.url, teeRpcUrl: teeRpc, matchAddress, dealerAddress, round, priceE6, programId });
      setStatus("submitted");
      onQuoteSealed?.();
    } catch (reason) {
      setStatus("prepared");
      setError(reason instanceof Error ? reason.message : "private_quote_failed");
    }
  };

  const deadlineTooClose = deadlineAt !== undefined && deadlineAt - now <= QUOTE_SUBMISSION_CUTOFF_MS;

  return (
    <section className="private-quote" aria-label="Private dealer quote">
      <div>
        <p className="eyebrow">PRIVATE DEALER QUOTE</p>
        <strong>Only your quote is sent through the TEE.</strong>
      </div>
      {roundStatus === "PREPARED" && (
        <p className="trade-intent-inactive">Prepare private access and a match-scoped quote session now. Setup can require wallet approvals; sealing an open RFQ will not.</p>
      )}
      {roundStatus === "OPEN" && !quoteReady && !quoteSealed && (
        <p className="trade-intent-error" role="alert">Quote access was not prepared for this RFQ. Wait for the next prepared round; setup will not start inside this 30-second window.</p>
      )}
      {roundStatus === "OPEN" && quoteReady && (
        <>
          {bounds && <p className="trade-intent-inactive">Verified SOL/USD mark: {formatUsdcE6(BigInt(oraclePriceE6!))}. Allowed quote range (±5%): {formatUsdcE6(bounds.min)}–{formatUsdcE6(bounds.max)}.</p>}
          <label>
            Price (USDC e6)
            <input inputMode="numeric" onChange={(event) => setPrice(event.target.value)} placeholder={bounds ? bounds.min.toString() : "105000000"} value={price} />
          </label>
        </>
      )}
      {roundStatus === "OPEN" && quoteReady && deadlineTooClose && (
        <p className="trade-intent-error" role="alert">Less than three seconds remain. Wait for the next RFQ instead of sending a deadline-bound quote.</p>
      )}
      {error && <span role="alert">{error}</span>}
      {roundStatus === "PREPARED" && <button disabled={status === "preparing" || status === "prepared"} onClick={() => void prepare()} type="button">{status === "preparing" ? "Preparing private access…" : status === "prepared" ? "Private quote session ready" : "Prepare fast private quotes"}</button>}
      {roundStatus === "OPEN" && quoteSealed && <span role="status">Quote sealed privately.</span>}
      {roundStatus === "OPEN" && quoteReady && <button disabled={status === "submitting" || deadlineTooClose} onClick={() => void submit()} type="button">{status === "submitting" ? "Sealing…" : "Submit private quote"}</button>}
    </section>
  );
}
