import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { resolveBaseRpcUrl } from "./devnet-config.mjs";

const rpcUrl = resolveBaseRpcUrl();
const programId = new PublicKey(process.env.OUTCRY_PROGRAM_ID);
const arg = (name) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const pitLabel = arg("--pit-id") || "wall-street-01";
const nonceText = arg("--nonce") || "1";
const capacityText = arg("--capacity") || "4";
const authorityText = arg("--authority") || process.env.OUTCRY_AUTHORITY;
const configuredMatch = process.env.OUTCRY_MATCH_ADDRESS;

if (!authorityText) throw new Error("provide --authority=<public-key>; only public keys are accepted");
const authority = new PublicKey(authorityText);
const nonce = BigInt(nonceText);
const capacity = Number(capacityText);
if (nonce < 0n || nonce > 18_446_744_073_709_551_615n) throw new Error("nonce must fit u64");
if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4) throw new Error("capacity must be an integer from 1 to 4");
const pitBytes = new TextEncoder().encode(pitLabel);
if (pitBytes.length > 32) throw new Error("pit id must be at most 32 UTF-8 bytes");
const pitId = new Uint8Array(32);
pitId.set(pitBytes);

const idl = JSON.parse(await readFile(resolve("apps/web/src/chain/idl/outcry.json"), "utf8"));
const discriminator = (name) => {
  const entry = idl.instructions.find((instruction) => instruction.name === name);
  if (!entry) throw new Error(`missing IDL instruction: ${name}`);
  return Buffer.from(entry.discriminator);
};
const u8 = (value) => Buffer.from([value]);
const u64 = (value) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
};
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
const instruction = (name, accounts, args = []) => new TransactionInstruction({
  programId,
  keys: accounts,
  data: Buffer.concat([discriminator(name), ...args]),
});

const [pit] = PublicKey.findProgramAddressSync([Buffer.from("pit"), pitId], programId);
const [match] = PublicKey.findProgramAddressSync([Buffer.from("match"), pit.toBytes(), u64(nonce)], programId);
if (configuredMatch && !new PublicKey(configuredMatch).equals(match)) throw new Error("derived match does not equal OUTCRY_MATCH_ADDRESS");

const connection = new Connection(rpcUrl, "confirmed");
const accounts = { pit, match };
const accountEntries = await Promise.all(Object.entries(accounts).map(async ([name, address]) => {
  const info = await connection.getAccountInfo(address, "confirmed");
  return [name, { address: address.toBase58(), exists: Boolean(info), owner: info?.owner.toBase58() ?? null, dataLength: info?.data.length ?? 0 }];
}));
const existing = accountEntries.filter(([, value]) => value.exists);
if (existing.length > 0) throw new Error(`setup is not pristine; existing accounts: ${existing.map(([name]) => name).join(", ")}`);

const transaction = new Transaction().add(
  instruction("initialize_pit", [
    meta(pit, true), meta(authority, true, true), meta(SystemProgram.programId),
  ], [Buffer.from(pitId), u8(capacity)]),
  instruction("create_match", [
    meta(pit, true), meta(match, true), meta(authority, true, true), meta(SystemProgram.programId),
  ], [u64(nonce)]),
);
const latest = await connection.getLatestBlockhash("confirmed");
transaction.feePayer = authority;
transaction.recentBlockhash = latest.blockhash;
transaction.lastValidBlockHeight = latest.lastValidBlockHeight;
const transactionBase64 = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
const response = await fetch(rpcUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "simulateTransaction",
    params: [transactionBase64, {
      encoding: "base64",
      commitment: "confirmed",
      sigVerify: false,
      replaceRecentBlockhash: true,
    }],
  }),
});
if (!response.ok) throw new Error(`bootstrap_simulation_failed: RPC returned HTTP ${response.status}`);
const payload = await response.json();
if (payload.error) throw new Error(`bootstrap_simulation_failed: ${payload.error.message ?? "RPC error"}`);
const simulation = payload.result?.value;
if (!simulation) throw new Error("bootstrap_simulation_failed: malformed RPC response");
const output = {
  rpcHost: new URL(rpcUrl).host,
  programId: programId.toBase58(),
  authority: authority.toBase58(),
  pitId: pitLabel,
  capacity,
  nonce: nonce.toString(),
  accounts: Object.fromEntries(accountEntries),
  instructionNames: ["initialize_pit", "create_match"],
  requiredSigners: [authority.toBase58()],
  simulation: { ok: simulation.err === null, error: simulation.err, logs: simulation.logs ?? [] },
  unsignedTransactionBase64: transactionBase64,
  instruction: "UNSIGNED_ONLY: sign and submit this bootstrap with the authority wallet only after simulation succeeds; seated players join separately in the browser",
};
console.log(JSON.stringify(output, null, 2));
if (simulation.err !== null) {
  const logs = Array.isArray(simulation.logs) ? simulation.logs.join("\n") : "";
  const staleInterface = logs.includes("InstructionFallbackNotFound") || logs.includes("Fallback functions are not supported");
  throw new Error(staleInterface
    ? "program_interface_stale: deployed program does not support the current initialize_pit instruction; deploy the current program build before bootstrapping a match"
    : "bootstrap_simulation_failed: inspect simulation.logs; no transaction was signed or submitted");
}
