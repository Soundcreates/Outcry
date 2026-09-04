import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";

const requiredFiles = [
  "package.json",
  "pnpm-workspace.yaml",
  "Cargo.toml",
  "Anchor.toml",
  "apps/web/package.json",
  "apps/web/index.html",
  "apps/web/src/main.tsx",
  "apps/web/src/App.tsx",
  "apps/web/vite.config.ts",
  "apps/world-server/package.json",
  "apps/world-server/src/index.ts",
  "programs/outcry/Cargo.toml",
  "programs/outcry/src/lib.rs",
  "packages/shared/src/domain.ts",
  "packages/shared/src/env.ts",
  "docs/AUTHORITY.md",
  ".env.example",
];

for (const file of requiredFiles) await access(file);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ["node_modules", ".next", "dist"].includes(entry.name)) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.isFile() && /\.(js|mjs|ts|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

for (const file of await sourceFiles("apps/web")) {
  const source = await readFile(file, "utf8");
  for (const forbidden of ["LIVEKIT_API_SECRET", "ASSEMBLYAI_API_KEY", "PRIVATE_KEY", "SEED_PHRASE"]) {
    assert.equal(source.includes(forbidden), false, `client secret leak in ${file}: ${forbidden}`);
  }
}

const authority = await readFile("docs/AUTHORITY.md", "utf8");
for (const boundary of ["Colyseus", "LiveKit", "STT", "MagicBlock PER", "Solana L1"]) {
  assert.equal(authority.includes(boundary), true, `missing authority boundary: ${boundary}`);
}

const webPackage = JSON.parse(await readFile("apps/web/package.json", "utf8"));
assert.equal(webPackage.scripts.dev, "vite", "web must use Vite dev server");
assert.equal(webPackage.scripts.build, "vite build", "web must use Vite build");
assert.equal(webPackage.dependencies.next, undefined, "Next.js must not be a web dependency");
assert.equal(webPackage.devDependencies.vite !== undefined, true, "Vite dependency missing");
assert.equal(webPackage.devDependencies["@vitejs/plugin-react"] !== undefined, true, "Vite React plugin missing");
assert.equal(
  Object.values({ ...webPackage.dependencies, ...webPackage.devDependencies }).some((value) =>
    String(value).startsWith("workspace:"),
  ),
  false,
  "web must be installable directly with npm",
);

console.log(`phase-00 smoke: ${requiredFiles.length}/${requiredFiles.length} required files present`);
console.log("phase-00 smoke: client secret scan passed");
console.log("phase-00 smoke: authority contract contains all five boundaries");
console.log("phase-00 smoke: web is a React + Vite project");
console.log("phase-00 smoke: web has no npm-incompatible workspace protocol");
