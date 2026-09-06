import { PublicKey } from "@solana/web3.js";

export const DEFAULT_DEVNET_RPC = "https://api.devnet.solana.com";
export const MAGICBLOCK_PYTH_ORACLE_PROGRAM_ID = new PublicKey("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
export const MAGICBLOCK_PYTH_SOL_USD_FEED = new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
export const MAGICBLOCK_PYTH_SOL_USD_FEED_ID = Uint8Array.from(
  "c6ad3e841d9c0f248adff90cf776f839fd59f1cbd8ffbc8f9402883ea16e8420".match(/../g).map((value) => Number.parseInt(value, 16)),
);

export function resolveBaseRpcUrl() {
  return process.argv.find((value) => value.startsWith("--rpc="))?.slice(6)
    || process.env.OUTCRY_BASE_RPC
    || DEFAULT_DEVNET_RPC;
}

export function resolveTeeRpcUrl() {
  return process.argv.find((value) => value.startsWith("--tee-rpc="))?.slice(10)
    || process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_RPC
    || "https://devnet-tee.magicblock.app";
}

export async function readMagicblockPythPreflight(connection) {
  const info = await connection.getAccountInfo(MAGICBLOCK_PYTH_SOL_USD_FEED, "confirmed");
  return {
    address: MAGICBLOCK_PYTH_SOL_USD_FEED.toBase58(),
    exists: Boolean(info),
    owner: info?.owner.toBase58() ?? null,
    dataLength: info?.data.length ?? 0,
    expectedOwner: MAGICBLOCK_PYTH_ORACLE_PROGRAM_ID.toBase58(),
    expectedDataLength: 134,
    valid: Boolean(info)
      && info.owner.equals(MAGICBLOCK_PYTH_ORACLE_PROGRAM_ID)
      && info.data.length === 134,
  };
}

export function assertMagicblockPythPreflight(preflight) {
  if (!preflight.valid) {
    throw new Error(
      `magicblock_pyth_preflight_failed: ${preflight.address} owner=${preflight.owner ?? "missing"} dataLength=${preflight.dataLength}; expected owner=${preflight.expectedOwner} dataLength=${preflight.expectedDataLength}`,
    );
  }
}
