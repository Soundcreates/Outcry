import { Connection, PublicKey } from "@solana/web3.js";
import { resolveBaseRpcUrl } from "./devnet-config.mjs";

const rpcUrl = resolveBaseRpcUrl();
const programId = new PublicKey(process.env.OUTCRY_PROGRAM_ID);
const pitLabel = process.argv.find((value) => value.startsWith("--pit-id="))?.slice(9) || "wall-street-01";
const nonceValue = process.argv.find((value) => value.startsWith("--nonce="))?.slice(8) || "1";
const nonce = BigInt(nonceValue);
if (pitLabel.length > 32) throw new Error("pit id must be at most 32 UTF-8 bytes");
const pitId = new Uint8Array(32);
pitId.set(new TextEncoder().encode(pitLabel));
const nonceBytes = new Uint8Array(8);
new DataView(nonceBytes.buffer).setBigUint64(0, nonce, true);
const [pit] = PublicKey.findProgramAddressSync([Buffer.from("pit"), pitId], programId);
const [match] = PublicKey.findProgramAddressSync([Buffer.from("match"), pit.toBytes(), nonceBytes], programId);

const connection = new Connection(rpcUrl, "confirmed");
const accounts = { pit, match };
const entries = await Promise.all(Object.entries(accounts).map(async ([name, address]) => {
  const info = await connection.getAccountInfo(address, "confirmed");
  return [name, { address: address.toBase58(), exists: Boolean(info), owner: info?.owner.toBase58() ?? null, dataLength: info?.data.length ?? 0 }];
}));
console.log(JSON.stringify({
  rpcHost: new URL(rpcUrl).host,
  programId: programId.toBase58(),
  pitId: pitLabel,
  nonce: nonce.toString(),
  accounts: Object.fromEntries(entries),
  requiredOperations: [
    "initialize_pit",
    "create_match",
    "join_match (each seated wallet, in the browser)",
  ],
  instruction: "BOOTSTRAP_DRY_RUN_ONLY: this creates no accounts; players join separately with their own wallets",
}, null, 2));
