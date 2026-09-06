import { Connection, PublicKey } from "@solana/web3.js";
import { resolveBaseRpcUrl } from "./devnet-config.mjs";

const rpcUrl = resolveBaseRpcUrl();
const programValue = process.env.OUTCRY_PROGRAM_ID;
const matchValue = process.env.OUTCRY_MATCH_ADDRESS;

if (!programValue || !matchValue) {
  console.error("deployment_preflight_failed: OUTCRY_PROGRAM_ID and OUTCRY_MATCH_ADDRESS are required");
  process.exit(1);
}

let programId;
let matchAddress;
try {
  programId = new PublicKey(programValue);
  matchAddress = new PublicKey(matchValue);
} catch {
  console.error("deployment_preflight_failed: invalid program or match public key");
  process.exit(1);
}

const connection = new Connection(rpcUrl, "confirmed");
const [programInfo, matchInfo, slot] = await Promise.all([
  connection.getAccountInfo(programId, "confirmed"),
  connection.getAccountInfo(matchAddress, "confirmed"),
  connection.getSlot("confirmed"),
]);
const result = {
  rpcHost: new URL(rpcUrl).host,
  slot,
  programId: programId.toBase58(),
  matchAddress: matchAddress.toBase58(),
  program: {
    exists: Boolean(programInfo),
    executable: programInfo?.executable ?? false,
    dataLength: programInfo?.data.length ?? 0,
  },
  match: {
    exists: Boolean(matchInfo),
    owner: matchInfo?.owner.toBase58() ?? null,
    dataLength: matchInfo?.data.length ?? 0,
    ownerMatchesProgram: Boolean(matchInfo?.owner.equals(programId)),
  },
};
console.log(JSON.stringify(result, null, 2));

if (!result.program.exists || !result.program.executable) {
  console.error("deployment_preflight_failed: program is not executable on the configured RPC");
  process.exit(1);
}
if (!result.match.exists || !result.match.ownerMatchesProgram) {
  console.error("deployment_preflight_failed: match account is missing or owned by another program");
  process.exit(1);
}
