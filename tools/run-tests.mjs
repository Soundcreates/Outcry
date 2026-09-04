import { spawnSync } from "node:child_process";

const tests = [
  "tools/phase-00.mjs",
  "tests/world/map-validator.test.mjs",
  "tests/world/collision.test.mjs",
  "apps/world-server/src/world/world.test.ts",
];

for (const test of tests) {
  const args = test.endsWith(".ts") ? ["--import", "tsx", test] : [test];
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`test suite: ${tests.length}/${tests.length} test entrypoints passed`);
