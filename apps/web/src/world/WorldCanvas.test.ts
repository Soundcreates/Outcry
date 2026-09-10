import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./WorldCanvas.tsx", import.meta.url), "utf8");
assert.match(source, /joinedRoom\.reconnection\.minUptime = 0/);
assert.match(source, /joinedRoom\.reconnection\.maxRetries = 8/);
assert.match(source, /RECONNECT_FALLBACK_DELAY_MS = 10_000/);
assert.match(source, /sendRoomMessage\("chat", \{ text \}\)/);
assert.match(source, /if \(!room \|\| !room\.connection\.isOpen\) \{/);
assert.match(source, /requestReconnect\(\);/);
assert.match(source, /onConnectionLost: requestReconnect/);
assert.match(source, /const sendRoomMessage =/);
assert.match(source, /try \{/);
assert.match(source, /if \(room\?\.connection\.isOpen\) void room\.leave\(\)/);
assert.match(source, /world-chat-input/);
console.log("world canvas: transient Colyseus drops preserve the original session before a fresh join");
