import assert from "node:assert/strict";
import { fetchLatestPythPriceUpdates, PythPriceUpdateError, PYTH_SOL_USD_FEED_ID } from "./pyth";

const originalFetch = globalThis.fetch;
let requested: URL | undefined;
let headers: Headers | undefined;
globalThis.fetch = async (input, init) => {
  requested = new URL(input.toString());
  headers = new Headers(init?.headers);
  return new Response(JSON.stringify({ binary: { data: ["verified-update"] } }), { status: 200 });
};

const updates = await fetchLatestPythPriceUpdates({ endpoint: "https://pyth.example/hermes", apiKey: "test-key" });
assert.deepEqual(updates, ["verified-update"]);
assert.equal(PYTH_SOL_USD_FEED_ID, "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d");
assert.equal(requested?.pathname, "/hermes/v2/updates/price/latest");
assert.equal(requested?.searchParams.get("ids[]"), PYTH_SOL_USD_FEED_ID);
assert.equal(headers?.get("authorization"), "Bearer test-key");

globalThis.fetch = async () => new Response("", { status: 429 });
await assert.rejects(
  fetchLatestPythPriceUpdates({ endpoint: "https://pyth.example/hermes", apiKey: "test-key" }),
  (reason: unknown) => reason instanceof PythPriceUpdateError && reason.code === "pyth_rate_limited",
);

globalThis.fetch = originalFetch;
