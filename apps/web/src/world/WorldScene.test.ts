import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./WorldScene.ts", import.meta.url), "utf8");
assert.match(source, /canMove && this\.room\.connection\.isOpen/);
console.log("world scene: input send is gated while the Colyseus socket is closed");
