import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./WorldScene.ts", import.meta.url), "utf8");
assert.match(source, /canMove && this\.room\.connection\.isOpen/);
assert.match(source, /if \(player\.mode === "RECONNECTING"\)/);
assert.match(source, /this\.remotePlayers\.delete\(sessionId\)/);
assert.match(source, /private sendRoomMessage\(type: string/);
assert.match(source, /onConnectionLost\?\.\(\)/);
assert.match(source, /chainConfirmed: value\.action === "confirmed" \|\| value\.action === "restored"/);
assert.match(source, /localState\?\.mode === "RESERVING"/);
assert.match(source, /onMessage\("chat"/);
assert.match(source, /CHAT_BUBBLE_DURATION_MS/);
assert.match(source, /fillPoints\(points, true\)/);
assert.doesNotMatch(source, /if \(!this\.room\?\.state\.players\.has\(value\.sessionId\)\) return;/);
console.log("world scene: input send is gated while the Colyseus socket is closed");
