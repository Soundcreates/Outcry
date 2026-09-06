import { useEffect, useRef, useState } from "react";
import { parseTradeIntent, type TradeIntent } from "./tradeIntent";

type Props = {
  active: boolean;
  onConfirm?: (intent: TradeIntent) => void;
  onSubmit?: (intent: TradeIntent) => Promise<void>;
};

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onerror: (() => void) | null;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type RecognitionConstructor = new () => Recognition;

export default function TradeIntentPanel({ active, onConfirm, onSubmit }: Props) {
  const recognitionRef = useRef<Recognition | undefined>(undefined);
  const [input, setInput] = useState("");
  const [transcript, setTranscript] = useState("");
  const [draft, setDraft] = useState<TradeIntent | null>(null);
  const [listening, setListening] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => () => recognitionRef.current?.stop(), []);

  if (!active) {
    return <p className="trade-intent-inactive">Spectator view · voice and quote controls are private to the active taker.</p>;
  }

  const parse = (value: string) => {
    const parsed = parseTradeIntent(value);
    setTranscript(value);
    setDraft(parsed);
    setConfirmed(false);
    setSubmitted(false);
    setError(parsed ? "" : "Use BUY or SELL + 1, 2, or 5 SOL.");
  };

  const startListening = () => {
    const speech = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
    const Constructor = speech.SpeechRecognition ?? speech.webkitSpeechRecognition;
    if (!Constructor) {
      setError("Browser speech input unavailable; use typed fallback.");
      return;
    }
    const recognition = new Constructor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (event) => parse(event.results[0]?.[0]?.transcript ?? "");
    recognition.onerror = () => {
      setListening(false);
      setError("Speech input failed; use typed fallback.");
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setError("");
    setListening(true);
    recognition.start();
  };

  const confirm = () => {
    if (!draft) return;
    onConfirm?.(draft);
    setConfirmed(true);
  };

  const submit = async () => {
    if (!draft || !confirmed || !onSubmit) return;
    setSubmitting(true);
    setError("");
    try {
      await onSubmit(draft);
      setSubmitted(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "rfq_submit_failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="trade-intent" aria-label="Trade intent draft">
      <div className="trade-intent-heading">
        <div>
          <p className="eyebrow">ROUND INTENT</p>
          <strong>Say the trade. Confirm the draft.</strong>
        </div>
        <span className={listening ? "trade-listening" : "trade-ready"} role="status">
          {listening ? "Listening…" : "Ready"}
        </span>
      </div>
      <div className="trade-intent-actions">
        <button disabled={listening} onClick={startListening} type="button">{listening ? "Listening…" : "Use voice"}</button>
        <form onSubmit={(event) => { event.preventDefault(); parse(input); }}>
          <input aria-label="Typed trade intent" onChange={(event) => setInput(event.target.value)} placeholder="buy two SOL" value={input} />
          <button type="submit">Parse typed</button>
        </form>
      </div>
      {transcript && <p className="trade-transcript">Transcript: “{transcript}”</p>}
      {error && <p className="trade-intent-error" role="alert">{error}</p>}
      {draft && (
        <div className="trade-confirmation">
          <span>{draft.side} {draft.quantity} SOL / USDC</span>
          {confirmed ? (
            <>
              <strong role="status">{submitted ? "RFQ opened" : "Draft confirmed"}</strong>
              {onSubmit && !submitted && <button disabled={submitting} onClick={() => void submit()} type="button">{submitting ? "Simulating…" : "Submit RFQ"}</button>}
            </>
          ) : (
            <button onClick={confirm} type="button">Confirm draft</button>
          )}
        </div>
      )}
    </section>
  );
}
