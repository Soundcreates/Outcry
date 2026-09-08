export const PYTH_SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

export class PythPriceUpdateError extends Error {
  constructor(
    public readonly code: "pyth_rate_limited" | "pyth_upstream_failed" | "pyth_update_invalid",
    public readonly status: number,
  ) {
    super(code);
    this.name = "PythPriceUpdateError";
  }
}

export async function fetchLatestPythPriceUpdates(input: {
  endpoint: string;
  apiKey: string;
  feedId?: string;
}) {
  const endpoint = new URL("v2/updates/price/latest", `${input.endpoint.replace(/\/$/, "")}/`);
  endpoint.searchParams.append("ids[]", input.feedId ?? PYTH_SOL_USD_FEED_ID);
  endpoint.searchParams.set("encoding", "base64");
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
    });
  } catch {
    throw new PythPriceUpdateError("pyth_upstream_failed", 502);
  }
  if (response.status === 429) throw new PythPriceUpdateError("pyth_rate_limited", 429);
  if (!response.ok) throw new PythPriceUpdateError("pyth_upstream_failed", 502);
  const payload = await response.json() as { binary?: { data?: unknown } };
  const updates = payload.binary?.data;
  if (!Array.isArray(updates) || updates.length === 0 || updates.some((update) => typeof update !== "string" || update.length === 0)) {
    throw new PythPriceUpdateError("pyth_update_invalid", 502);
  }
  return updates;
}
