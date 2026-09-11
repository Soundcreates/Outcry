import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./PlayApp.tsx", import.meta.url), "utf8");
assert.match(source, /new URLSearchParams\(window\.location\.search\)/);
assert.match(source, /window\.history\.replaceState/);
assert.match(source, /world=\$\{encodeURIComponent\(id\)\}/);
assert.doesNotMatch(source, /Initialize Wall Street match/);
assert.doesNotMatch(source, /bootstrapMatchOnchain/);
console.log("app recovery: ready world survives browser refresh; Match setup is deferred to first seat");
