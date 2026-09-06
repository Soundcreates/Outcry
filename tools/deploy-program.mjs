import { access, mkdir, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import web3 from "@solana/web3.js";

const { Connection, Keypair, PublicKey } = web3;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const program = resolve(root, "target/deploy/outcry.so");
const programId = resolve(root, "target/deploy/outcry-keypair.json");
const buffer = resolve(root, "target/deploy/outcry-buffer-keypair.json");
const wallet = resolve(homedir(), ".config/solana/id.json");
const upgradeableLoader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const programDataMetadataBytes = 45;
const minimumProgramExtensionBytes = 10_240;
const anchorToml = await readFile(resolve(root, "Anchor.toml"), "utf8");
const cluster = process.env.OUTCRY_DEPLOY_RPC ?? process.env.OUTCRY_BASE_RPC ?? anchorToml.match(/cluster = "([^"]+)"/)?.[1];
const transport = process.env.OUTCRY_DEPLOY_TRANSPORT ?? "quic";
if (!cluster) throw new Error("deploy_rpc_not_configured");
if (transport !== "quic" && transport !== "rpc") throw new Error("deploy_transport_invalid");
const { size: programBytes } = await stat(program);
if (programBytes <= 0) throw new Error("program_artifact_empty");

const programKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(programId, "utf8"))));
const programAddress = programKeypair.publicKey;
const [programDataAddress] = PublicKey.findProgramAddressSync([programAddress.toBuffer()], upgradeableLoader);
const connection = new Connection(cluster, "confirmed");
const programDataAccount = await connection.getAccountInfo(programDataAddress, "confirmed");
const requiredProgramDataBytes = programBytes + programDataMetadataBytes;

if (programDataAccount && !programDataAccount.owner.equals(upgradeableLoader)) {
  throw new Error(`program_data_owner_unexpected:${programDataAccount.owner.toBase58()}`);
}

if (programDataAccount && programDataAccount.data.length < requiredProgramDataBytes) {
  const additionalBytes = Math.max(
    minimumProgramExtensionBytes,
    requiredProgramDataBytes - programDataAccount.data.length,
  );
  console.log(`extending ${programDataAddress.toBase58()} by ${additionalBytes} bytes before deployment`);
  const status = await run("solana", [
    "program", "extend", programAddress.toBase58(), String(additionalBytes),
    "--keypair", wallet,
    "--url", cluster,
    "--commitment", "confirmed",
    "--skip-preflight",
    transport === "quic" ? "--use-quic" : "--use-rpc",
  ]);
  if (status !== 0) process.exit(status);
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, NO_DNA: "1" }, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveRun(code ?? (signal ? 1 : 0)));
  });
}

await mkdir(dirname(buffer), { recursive: true });
try {
  await access(buffer);
} catch {
  const status = await run("solana-keygen", ["new", "--silent", "--no-bip39-passphrase", "--outfile", buffer]);
  if (status !== 0) process.exit(status);
  console.log(`created persistent deploy buffer signer at ${buffer}`);
}

console.log(`using resumable deploy buffer ${buffer}`);
console.log(`deployment transport: ${transport}`);
const status = await run("solana", [
  "program", "deploy", program,
  "--program-id", programId,
  "--upgrade-authority", wallet,
  "--url", cluster,
  "--commitment", "confirmed",
  "--buffer", buffer,
  "--max-len", String(programBytes),
  "--no-auto-extend",
  "--skip-preflight",
  transport === "quic" ? "--use-quic" : "--use-rpc",
  "--verbose",
  "--max-sign-attempts", "5",
  "--with-compute-unit-price", "10000",
]);
process.exit(status);
