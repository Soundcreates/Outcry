import { useEffect, useRef, useState } from "react";
import { parseTradeIntent, type TradeIntent } from "./tradeIntent";

type Props = {
  active: boolean;
  matchId?: string;
  role?: "PLAYER" | "SPECTATOR";
  sessionId?: string;
  onConfirm?: (intent: TradeIntent) => void;
  onSubmit?: (intent: TradeIntent) => Promise<void>;
};

const worldHttp = import.meta.env.VITE_WORLD_HTTP ||
  (import.meta.env.VITE_WORLD_WS || "ws://localhost:2567").replace(/^ws/, "http");

function speechError(reason: unknown) {
  const detail = reason instanceof Error
    ? reason.message
    : typeof reason === "string"
      ? reason
      : "";
  if (/429|speech_rate_limited|too_many_requests|rate.?limit/i.test(detail)) {
    return "Groq speech is temporarily rate-limited. Wait a few seconds, then try again or use typed fallback.";
  }
  if (/speech_transcription_not_configured/i.test(detail)) {
    return "Speech transcription is not configured on the world server; use typed fallback.";
  }
  return "Groq speech transcription failed; use typed fallback and try again.";
}

export default function TradeIntentPanel({ active, matchId, role = "PLAYER", sessionId, onConfirm, onSubmit }: Props) {
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const stopTimerRef = useRef<number | undefined>(undefined);
  const transcriptionInFlightRef = useRef(false);
  const [input, setInput] = useState("");
  const [transcript, setTranscript] = useState("");
  const [draft, setDraft] = useState<TradeIntent | null>(null);
  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => () => {
    if (stopTimerRef.current !== undefined) window.clearTimeout(stopTimerRef.current);
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  if (!active) {
    return <p className="trade-intent-inactive">
      {role === "SPECTATOR"
        ? "Spectator view · voice and quote controls are private to the active taker."
        : "Waiting for your turn · voice and quote controls appear when the HUD says YOUR TURN."}
    </p>;
  }

  const parse = (value: string) => {
    const parsed = parseTradeIntent(value);
    setInput(value);
    setTranscript(value);
    setDraft(parsed);
    setConfirmed(false);
    setSubmitted(false);
    setError(parsed ? "" : "Use BUY or SELL + 1, 2, or 5 SOL.");
  };

  const stopListening = () => {
    if (stopTimerRef.current !== undefined) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = undefined;
    }
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  };

  const startListening = async () => {
    if (starting || listening || transcribing) return;
    if (!sessionId || !matchId) {
      setError("World session is unavailable; reconnect and try again.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Audio recording is unavailable; use typed fallback.");
      return;
    }

    setStarting(true);
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
        .find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        stream.getTracks().forEach((track) => track.stop());
        recorderRef.current = undefined;
        streamRef.current = undefined;
        transcriptionInFlightRef.current = false;
        setStarting(false);
        setListening(false);
        setError("Audio recording failed; use typed fallback.");
      };
      recorder.onstop = async () => {
        if (transcriptionInFlightRef.current) return;
        transcriptionInFlightRef.current = true;
        stream.getTracks().forEach((track) => track.stop());
        recorderRef.current = undefined;
        streamRef.current = undefined;
        setListening(false);
        const audio = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (audio.size === 0) {
          transcriptionInFlightRef.current = false;
          setError("No audio was captured; try the voice command again.");
          return;
        }
        setTranscribing(true);
        try {
          const response = await fetch(`${worldHttp}/api/speech/transcribe`, {
            method: "POST",
            headers: {
              "content-type": audio.type || "audio/webm",
              "x-outcry-match-id": matchId,
              "x-outcry-session-id": sessionId,
            },
            body: audio,
          });
          const payload = await response.json() as { error?: string; text?: string };
          if (!response.ok) throw new Error(payload.error ?? "speech_transcription_failed");
          const text = payload.text ?? "";
          if (!text.trim()) throw new Error("speech_empty");
          parse(text);
        } catch (reason) {
          setError(reason instanceof Error && reason.message === "speech_empty"
            ? "No trade phrase was recognized; say BUY or SELL plus 1, 2, or 5 SOL."
            : speechError(reason));
        } finally {
          transcriptionInFlightRef.current = false;
          setTranscribing(false);
        }
      };
      recorder.start();
      setStarting(false);
      setListening(true);
      stopTimerRef.current = window.setTimeout(stopListening, 8_000);
    } catch (reason) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      setStarting(false);
      setError(reason instanceof DOMException && reason.name === "NotAllowedError"
        ? "Microphone permission was denied; allow access or use typed fallback."
        : "Could not start audio recording; use typed fallback.");
    }
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
          <strong>Click Start voice command, say “buy five SOL”, then stop recording.</strong>
        </div>
        <span className={listening ? "trade-listening" : "trade-ready"} role="status">
          {starting ? "Preparing microphone…" : transcribing ? "Transcribing…" : listening ? "Listening…" : "Ready"}
        </span>
      </div>
      <div className="trade-intent-actions">
        <button disabled={starting || transcribing} onClick={() => listening ? stopListening() : void startListening()} type="button">
          {starting ? "Preparing microphone…" : transcribing ? "Transcribing…" : listening ? "Stop voice command" : "Start voice command"}
        </button>
        <form onSubmit={(event) => { event.preventDefault(); parse(input); }}>
          <input aria-label="Typed trade intent" onChange={(event) => setInput(event.target.value)} placeholder="buy two SOL" value={input} />
          <button type="submit">Parse typed</button>
        </form>
      </div>
      {transcript && <p className="trade-transcript">Transcript: “{transcript}”</p>}
      {error && <p className="trade-intent-error" role="alert">{error}</p>}
      {draft && (
        <div className="trade-confirmation">
          <span>Confirm {draft.side === "BUY" ? "bid" : "ask"}: {draft.quantity} SOL / USDC?</span>
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
