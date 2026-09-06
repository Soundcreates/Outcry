import { copyFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const anchor = process.platform === "win32" ? "anchor.exe" : "anchor";
const cargoFeatures = process.env.OUTCRY_BUILD_FEATURES
  ? ["--", "--features", process.env.OUTCRY_BUILD_FEATURES]
  : [];

const status = await new Promise((resolveStatus, reject) => {
  const child = spawn(anchor, ["build", ...cargoFeatures], {
    cwd: root,
    env: { ...process.env, NO_DNA: "1" },
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => resolveStatus(code ?? (signal ? 1 : 0)));
});

if (status !== 0) process.exit(status);

const source = resolve(root, "target/idl/outcry.json");
const destination = resolve(root, "apps/web/src/chain/idl/outcry.json");
await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
console.log(`program IDL copied to ${destination}`);
