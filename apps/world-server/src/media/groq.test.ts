import assert from "node:assert/strict";
import { GROQ_TRANSCRIPTION_MODEL, transcribeWithGroq } from "./groq";

const originalFetch = globalThis.fetch;
let capturedRequest: RequestInit | undefined;
globalThis.fetch = async (_input, init) => {
  capturedRequest = init;
  return new Response("buy five SOL", { status: 200 });
};

try {
  const text = await transcribeWithGroq({
    apiKey: "groq-test-key",
    audio: Buffer.from("test-audio"),
    contentType: "audio/webm;codecs=opus",
  });
  assert.equal(text, "buy five SOL");
  assert.equal(capturedRequest?.method, "POST");
  assert.equal((capturedRequest?.headers as Record<string, string>).Authorization, "Bearer groq-test-key");
  const form = capturedRequest?.body as FormData;
  assert.equal(form.get("model"), GROQ_TRANSCRIPTION_MODEL);
  assert.equal(form.get("language"), "en");
  assert.equal(form.get("response_format"), "text");
  assert.equal((form.get("file") as File).name, "command.webm");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("groq speech: server-side model, multipart audio, and text response pass");
