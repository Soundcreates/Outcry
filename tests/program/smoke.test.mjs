import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("programs/outcry/src/lib.rs", "utf8");
assert.match(source, /declare_id!\("[1-9A-HJ-NP-Za-km-z]{32,44}"\)/);
assert.match(source, /pub fn initialize/);
assert.match(source, /pub fn initialize_pit/);
assert.match(source, /pub fn create_match/);
assert.match(source, /pub fn join_match/);
assert.match(source, /pub fn start_match/);
assert.match(source, /pub fn initialize_match_result/);
assert.match(source, /seeds = \[b"match"/);
assert.match(source, /seeds = \[b"result"/);
console.log("program smoke: Anchor entrypoint, Phase 5 instructions, PDAs, and program ID present");
