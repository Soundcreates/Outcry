import assert from "node:assert/strict";
import { MAX_WORLD_SPEED } from "@outcry/shared/domain";
import { loadWorldGeometry } from "./geometry";
import { parseMovementInput, simulatePlayer } from "./simulation";

const geometry = await loadWorldGeometry();

function playerAt(x = geometry.spawn.x, y = geometry.spawn.y) {
  return { x, y, facing: "down", lastProcessedSeq: -1 };
}

const valid = { seq: 1, left: false, right: true, up: false, down: false, dtMs: 50 };
assert.deepEqual(parseMovementInput(valid), valid);
assert.equal(parseMovementInput({ ...valid, x: 999999 }), null);
assert.equal(parseMovementInput({ ...valid, dtMs: Number.POSITIVE_INFINITY }), null);

const idle = playerAt();
simulatePlayer(idle, { ...valid, right: false }, geometry);
assert.deepEqual(idle, { ...playerAt(), lastProcessedSeq: 1 });

const walking = playerAt();
simulatePlayer(walking, valid, geometry);
assert.equal(walking.x, geometry.spawn.x + (MAX_WORLD_SPEED * 50) / 1000);
assert.equal(walking.facing, "right");

const hacked = playerAt();
simulatePlayer(hacked, { ...valid, dtMs: 999999 }, geometry);
assert.equal(hacked.x, geometry.spawn.x + (MAX_WORLD_SPEED * 50) / 1000);

const table = playerAt(160, 120);
simulatePlayer(table, { ...valid, seq: 2, right: false, down: true }, geometry);
assert.equal(table.y, 120);

const boundary = playerAt(9, 64);
simulatePlayer(boundary, { ...valid, seq: 3, right: false, left: true }, geometry);
assert.equal(boundary.x, 9);

const seated = { ...playerAt(), mode: "SEATED" };
simulatePlayer(seated, { ...valid, seq: 4 }, geometry);
assert.equal(seated.x, geometry.spawn.x);
assert.equal(seated.y, geometry.spawn.y);

const reconnecting = { ...playerAt(), mode: "RECONNECTING" };
simulatePlayer(reconnecting, { ...valid, seq: 5 }, geometry);
assert.equal(reconnecting.x, geometry.spawn.x);
assert.equal(reconnecting.y, geometry.spawn.y);

console.log("world simulation: input validation, idle, speed clamp, and Tiled collision pass");
