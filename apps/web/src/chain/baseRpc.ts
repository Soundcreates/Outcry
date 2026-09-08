import { Connection } from "@solana/web3.js";

const PUBLIC_DEVNET_RPC_ORIGIN = "https://api.devnet.solana.com";

const BASE_RPC_CONNECTION_CONFIG = {
  commitment: "confirmed" as const,
  // The public endpoint already returns 429 when saturated. Retrying the same
  // request five times in the SDK makes saturation worse; callers back off instead.
  disableRetryOnRateLimit: true,
};

export type BrowserBaseRpcConfig =
  | { url: string; error?: never }
  | { url?: never; error: string };

export function parseBrowserBaseRpc(value?: string): BrowserBaseRpcConfig {
  const url = value?.trim() || PUBLIC_DEVNET_RPC_ORIGIN;
  try {
    new URL(url);
  } catch {
    return { error: "base_rpc_invalid" };
  }
  return { url };
}

export const browserBaseRpc = parseBrowserBaseRpc(import.meta.env?.VITE_SOLANA_BASE_RPC);

export function createBaseRpcConnection(endpoint: string) {
  return new Connection(endpoint, BASE_RPC_CONNECTION_CONFIG);
}

export function baseRpcConfigurationMessage(error?: string) {
  return error === "base_rpc_invalid"
    ? "VITE_SOLANA_BASE_RPC is invalid. Configure a valid Solana RPC URL, then restart the web server."
    : "Configure a valid Solana RPC URL in VITE_SOLANA_BASE_RPC, then restart the web server.";
}
