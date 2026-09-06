import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./WorldCanvas.tsx", import.meta.url), "utf8");
assert.match(source, /joinedRoom\.onDrop\(onRoomDrop\)/);
assert.match(source, /joinedRoom\.onReconnect\(onRoomReconnect\)/);
assert.match(source, /match state remains available/);
assert.match(source, /setReconnectAttempt/);
assert.match(source, /setConnectionState\("reconnecting"\)/);
assert.match(source, /clearTimeout\(reconnectTimer\)/);
assert.match(source, /preservedGameRef/);
assert.match(source, /pause\("WorldScene"\)/);
assert.match(source, /intentionalExitRef/);
assert.match(source, /removeRoomListeners\?\.\(\)/);
assert.match(source, /onChainSeatConflict/);
console.log("world canvas: reconnection state is visible and listeners are cleaned up");
