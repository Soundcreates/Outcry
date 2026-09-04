import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["apps", "packages", "tools"];

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ["node_modules", ".next", "dist"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile() && path.endsWith(".mjs")) files.push(path);
  }
  return files;
}

const files = [];
for (const root of roots) {
  if ((await stat(root)).isDirectory()) files.push(...(await filesUnder(root)));
}

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`lint: ${files.length} JavaScript module(s) checked`);
