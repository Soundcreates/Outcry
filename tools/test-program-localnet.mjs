import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const programSo = resolve(root, "target/deploy/outcry.so");
const backupDir = await mkdtemp(join(tmpdir(), "outcry-program-"));
const backupSo = join(backupDir, "outcry.so");
const matches = process.argv.find((value) => value.startsWith("--matches="))?.slice(10) ?? "20";

await copyFile(programSo, backupSo);

function run(command, args, env = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...env, NO_DNA: "1" },
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => resolveRun(code ?? (signal ? 1 : 0)));
  });
}

let status = 1;
try {
  status = await run(process.platform === "win32" ? "node.exe" : "node", ["tools/build-program.mjs"], {
    OUTCRY_BUILD_FEATURES: "localnet",
  });
  if (status === 0) {
    status = await run(process.platform === "win32" ? "node.exe" : "node", [
      "--env-file=.env",
      "--import",
      "tsx",
      "tools/phase-07.localnet.mjs",
      "--matches",
      matches,
    ]);
  }
} finally {
  await copyFile(backupSo, programSo);
  await rm(backupDir, { recursive: true, force: true });
}

process.exit(status);
