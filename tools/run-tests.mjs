import { spawnSync } from "node:child_process";

const tests = [
  "tools/phase-00.mjs",
  "apps/web/src/App.test.ts",
  "tests/world/map-validator.test.mjs",
  "tests/world/collision.test.mjs",
  "apps/world-server/src/world/world.test.ts",
  "apps/web/src/chain/joinMatch.test.ts",
  "apps/web/src/chain/privacy.test.ts",
  "apps/web/src/chain/matchState.test.ts",
  "apps/web/src/match/tradeIntent.test.ts",
  "apps/web/src/world/PitOverlay.test.ts",
  "apps/web/src/world/WorldScene.test.ts",
  "apps/web/src/world/WorldCanvas.test.ts",
];

for (const test of tests) {
  const args = test.endsWith(".ts") ? ["--import", "tsx", test] : [test];
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`test suite: ${tests.length}/${tests.length} test entrypoints passed`);
