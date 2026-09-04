import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./PitOverlay.tsx", import.meta.url), "utf8");
assert.doesNotMatch(source, /setError\([^\n]+\);\s*onExit\(\);/);
assert.match(source, /Retry wallet join/);
assert.match(source, />Leave seat<\/button>/);
console.log("pit overlay: failed wallet joins stay retryable and leave is explicit");
