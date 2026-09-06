const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

export const GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";

const TRADING_PROMPT = "Short English trading command: buy or sell one, two, or five SOL.";

export class GroqTranscriptionError extends Error {
  constructor(
    public readonly code: "speech_rate_limited" | "speech_invalid_audio" | "speech_upstream_failed",
    public readonly status: number,
  ) {
    super(code);
    this.name = "GroqTranscriptionError";
  }
}

function filenameForContentType(contentType: string) {
  const mime = contentType.split(";", 1)[0]?.toLowerCase();
  if (mime === "audio/mp4") return "command.mp4";
  if (mime === "audio/mpeg") return "command.mp3";
  if (mime === "audio/ogg") return "command.ogg";
  if (mime === "audio/wav" || mime === "audio/x-wav") return "command.wav";
  return "command.webm";
}

export async function transcribeWithGroq(input: {
  apiKey: string;
  audio: Buffer;
  contentType: string;
}) {
  const form = new FormData();
  form.set(
    "file",
    new Blob([new Uint8Array(input.audio)], { type: input.contentType }),
    filenameForContentType(input.contentType),
  );
  form.set("model", GROQ_TRANSCRIPTION_MODEL);
  form.set("language", "en");
  form.set("prompt", TRADING_PROMPT);
  form.set("response_format", "text");
  form.set("temperature", "0");

  const response = await fetch(GROQ_TRANSCRIPTION_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.apiKey}` },
    body: form,
  });
  const body = await response.text();

  if (!response.ok) {
    if (response.status === 429) throw new GroqTranscriptionError("speech_rate_limited", 429);
    if (response.status === 400 || response.status === 413) {
      throw new GroqTranscriptionError("speech_invalid_audio", response.status);
    }
    throw new GroqTranscriptionError("speech_upstream_failed", 502);
  }

  const text = body.trim();
  if (!text) throw new GroqTranscriptionError("speech_invalid_audio", 422);
  return text;
}
