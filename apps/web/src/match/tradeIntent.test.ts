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
assert.match(panelSource, /onConfirm\?\.\(draft\)/);
console.log("trade intent: 100 corpus phrases, unsupported/ambiguous rejection, and draft-only parser pass");
