import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseTradeIntent } from "./tradeIntent";

const corpus = JSON.parse(await readFile(new URL("../../../../tests/voice/intents.json", import.meta.url), "utf8")) as {
  valid: string[];
  invalid: string[];
};

assert.ok(corpus.valid.length + corpus.invalid.length >= 100);
for (const phrase of corpus.valid) assert.ok(parseTradeIntent(phrase), `valid phrase rejected: ${phrase}`);
for (const phrase of corpus.invalid) assert.equal(parseTradeIntent(phrase), null, `invalid phrase accepted: ${phrase}`);
assert.deepEqual(parseTradeIntent("buy two sol"), { side: "BUY", baseAsset: "SOL", quoteAsset: "USDC", quantity: 2 });
assert.equal(parseTradeIntent("buy twenty sol"), null);
const panelSource = await readFile(new URL("./TradeIntentPanel.tsx", import.meta.url), "utf8");
assert.doesNotMatch(panelSource, /joinMatchOnchain|sendTransaction|signTransaction/);
assert.doesNotMatch(panelSource, /SpeechRecognition|webkitSpeechRecognition/);
assert.doesNotMatch(panelSource, /puter|Puter/);
assert.match(panelSource, /MediaRecorder/);
assert.match(panelSource, /api\/speech\/transcribe/);
assert.match(panelSource, /x-outcry-session-id/);
assert.match(panelSource, /x-outcry-match-id/);
assert.match(panelSource, /rate-limited/);
assert.match(panelSource, /onKeyDown=\{\(event\) => event\.stopPropagation\(\)\}/);
assert.match(panelSource, /onKeyUp=\{\(event\) => event\.stopPropagation\(\)\}/);
assert.match(panelSource, /Renew session/);
assert.match(panelSource, /session expired/);
const indexSource = await readFile(new URL("../../index.html", import.meta.url), "utf8");
assert.doesNotMatch(indexSource, /puter/);
assert.match(panelSource, /onConfirm\?\.\(draft\)/);
console.log("trade intent: 100 corpus phrases, unsupported/ambiguous rejection, and draft-only parser pass");
