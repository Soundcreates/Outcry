import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createTeeFeePayerSetupInstructions, teeValidatorForRpc } from "../apps/web/src/chain/privacy.ts";

const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const DEVNET_ROUTER_RPC = "https://devnet-router.magicblock.app";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function loadKeypair(path, label) {
  try {
    const bytes = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error("invalid");
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch {
    throw new Error(`${label}_invalid`);
  }
}

async function delegatedRoute(routerRpc, account) {
  const response = await fetch(routerRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [account.toBase58()] }),
  });
  const payload = await response.json();
  if (!response.ok || !payload?.result?.isDelegated || typeof payload.result.fqdn !== "string" || typeof payload.result.delegationRecord?.authority !== "string") {
    throw new Error("tee_relayer_router_route_unavailable");
  }
  return { fqdn: new URL(payload.result.fqdn).toString(), authority: new PublicKey(payload.result.delegationRecord.authority) };
}

const base = new Connection(requiredEnv("OUTCRY_BASE_RPC"), "confirmed");
const routerRpc = process.env.OUTCRY_MAGICBLOCK_ROUTER_RPC || DEVNET_ROUTER_RPC;
const configuredTeeRpc = process.env.OUTCRY_RELAYER_RPC_URL || requiredEnv("NEXT_PUBLIC_MAGICBLOCK_TEE_RPC");
const baseRelayer = loadKeypair(requiredEnv("OUTCRY_RELAYER_KEYPAIR_PATH"), "outcry_relayer_keypair");
const teeRelayer = loadKeypair(requiredEnv("OUTCRY_TEE_RELAYER_KEYPAIR_PATH"), "outcry_tee_relayer_keypair");
if (baseRelayer.publicKey.equals(teeRelayer.publicKey)) throw new Error("tee_relayer_must_be_distinct");

const validator = process.env.OUTCRY_TEE_VALIDATOR
  ? new PublicKey(process.env.OUTCRY_TEE_VALIDATOR)
  : teeValidatorForRpc(configuredTeeRpc);
const currentAccount = await base.getAccountInfo(teeRelayer.publicKey, "confirmed");
const instructions = createTeeFeePayerSetupInstructions({
  player: baseRelayer.publicKey,
  feePayer: teeRelayer.publicKey,
  validator,
  currentAccount,
});

if (instructions.length > 0) {
  const blockhash = await base.getLatestBlockhash("confirmed");
  const transaction = new Transaction({ feePayer: baseRelayer.publicKey, recentBlockhash: blockhash.blockhash }).add(...instructions);
  transaction.lastValidBlockHeight = blockhash.lastValidBlockHeight;
  transaction.sign(baseRelayer, teeRelayer);
  const simulation = await base.simulateTransaction(transaction);
  if (simulation.value.err) throw new Error(`tee_relayer_provision_simulation_failed: ${JSON.stringify(simulation.value.err)}`);
  const signature = await base.sendRawTransaction(transaction.serialize(), { skipPreflight: false, maxRetries: 5 });
  const confirmation = await base.confirmTransaction({ signature, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight }, "confirmed");
  if (confirmation.value.err) throw new Error(`tee_relayer_provision_failed: ${JSON.stringify(confirmation.value.err)}`);
}

const delegated = await base.getAccountInfo(teeRelayer.publicKey, "confirmed");
if (!delegated?.owner.equals(DELEGATION_PROGRAM_ID)) throw new Error("tee_relayer_not_delegated");
const route = await delegatedRoute(routerRpc, teeRelayer.publicKey);
if (!route.authority.equals(validator)) throw new Error("tee_relayer_validator_mismatch");
const teeAccount = await new Connection(route.fqdn, "confirmed").getAccountInfo(teeRelayer.publicKey, "confirmed");
if (!teeAccount) throw new Error("tee_relayer_unavailable");

console.log(JSON.stringify({
  ready: true,
  baseRelayer: baseRelayer.publicKey.toBase58(),
  teeRelayer: teeRelayer.publicKey.toBase58(),
  validator: validator.toBase58(),
  erRpc: route.fqdn,
  provisioned: instructions.length > 0,
}));
