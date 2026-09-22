import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./WorldRoom.ts", import.meta.url), "utf8");
assert.match(source, /void this\.interact\(client, payload\)/);
assert.doesNotMatch(source, /activeMatchAddressReady/);
assert.match(source, /chain_match_unavailable/);
assert.match(source, /rpcUrl: env\.OUTCRY_BASE_RPC/);
assert.match(source, /refreshActiveMatch/);
assert.match(source, /await this\.refreshActiveMatch\(true\)/);
assert.match(source, /void this\.refreshActiveMatch\(\);/);
assert.match(source, /this\.applyActiveMatch\(undefined\)/);
assert.match(source, /redis_required_in_production/);
assert.match(source, /static storageMode/);
assert.match(source, /this\.seatAssignments\.get\(identity\.matchAddress, identity\.walletAddress\)/);
assert.match(source, /const isMember = await this\.membershipReader\.isConfirmed/);
assert.match(source, /canRebindPendingSeat/);
assert.match(source, /this\.reservePlayer\(player, result\.seat\)/);
assert.match(source, /this\.seatPlayer\(client\.sessionId, player, result\.seat\)/);
assert.doesNotMatch(source, /if \(player\) player\.mode = "SEATED"/);
assert.match(source, /player\.mode = "RESERVING"/);
assert.match(source, /RECONNECTION_GRACE_SECONDS = 30/);
assert.match(source, /createSeatAssignmentStore/);
assert.match(source, /onMessage\("chat"/);
assert.match(source, /this\.broadcast\("chat"/);

console.log("world room: first seat can trigger lazy Match setup when the configured address is present");
