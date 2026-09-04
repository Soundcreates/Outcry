import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("programs/outcry/src/lib.rs", "utf8");
assert.match(source, /declare_id!\("[1-9A-HJ-NP-Za-km-z]{32,44}"\)/);
assert.match(source, /pub fn initialize/);
console.log("program smoke: Anchor entrypoint and program ID present");
