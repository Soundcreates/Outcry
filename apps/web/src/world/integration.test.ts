import assert from "node:assert/strict";
import type { InputHandle, Room } from "@colyseus/sdk";
import { WorldMoveInput } from "@outcry/shared/world-input";
import { WorldState, type PlayerState } from "@outcry/shared/world-state";

(globalThis as { WebSocket?: unknown }).WebSocket = undefined;
const { Client } = await import("@colyseus/sdk");

type TestRoom = Room<any, WorldState>;
const worldUrl = process.env.VITE_WORLD_WS || "ws://127.0.0.1:2567";
const worldHttpUrl = process.env.VITE_API_BASE_URL || worldUrl.replace(/^ws/, "http");
const webUrl = process.env.VITE_WEB_URL || "http://localhost:5173";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(50);
  }
  assert.fail(`condition not met within ${timeoutMs}ms`);
}

async function waitForAsync(check: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await wait(50);
  }
  assert.fail(`async condition not met within ${timeoutMs}ms`);
}

const sequences = new Map<string, number>();
const movementInputs = new Map<string, InputHandle<WorldMoveInput>>();
function sendInput(room: TestRoom, input: Partial<Record<"left" | "right" | "up" | "down", boolean>> & { dtMs?: number }) {
  const seq = sequences.get(room.sessionId) ?? 0;
  sequences.set(room.sessionId, seq + 1);
  const movement = movementInputs.get(room.sessionId) ?? room.input<WorldMoveInput>({
    type: WorldMoveInput,
    mode: "reliable",
  });
  movementInputs.set(room.sessionId, movement);
  movement.data.seq = seq;
  movement.data.left = input.left ?? false;
  movement.data.right = input.right ?? false;
  movement.data.up = input.up ?? false;
  movement.data.down = input.down ?? false;
  movement.send();
}

function player(room: TestRoom): PlayerState {
  const value = room.state.players.get(room.sessionId);
  assert.ok(value, `missing player ${room.sessionId}`);
  return value;
}

async function moveNearSeat(room: TestRoom, side: "left" | "right") {
  const rightTicks = side === "left" ? 8 : 19;
  for (let index = 0; index < rightTicks; index += 1) sendInput(room, { right: true });
  for (let index = 0; index < 8; index += 1) sendInput(room, { down: true });
  await waitFor(() => {
    const current = player(room);
    return side === "left"
      ? Math.hypot(current.x - 160, current.y - 124) <= 48
      : Math.hypot(current.x - 192, current.y - 124) <= 48;
  }, 3_000);
}

const rooms: TestRoom[] = [];
try {
  const health = await fetch(`${worldUrl.replace(/^ws/, "http")}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: "world-server" });

  const worldDirectory = await fetch(`${worldHttpUrl}/api/worlds`);
  assert.equal(worldDirectory.status, 200);
  assert.equal((await worldDirectory.json()).worlds[0].id, "wall-street");

  const malformedMediaRequest = await fetch(`${worldHttpUrl}/api/livekit/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ matchId: "wall-street-01", role: "ADMIN", sessionId: "unknown" }),
  });
  assert.equal(malformedMediaRequest.status, 400);

  const inactiveMediaRequest = await fetch(`${worldHttpUrl}/api/livekit/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ matchId: "wall-street-01", role: "PLAYER", sessionId: "unknown" }),
  });
  assert.equal(inactiveMediaRequest.status, 403);

  const web = await fetch(webUrl);
  assert.equal(web.status, 200);
  assert.match(await web.text(), /<div id="root"><\/div>/);
  const map = await fetch(`${webUrl}/wall-street/world.tmj`);
  assert.equal(map.status, 200);
  assert.match(await map.text(), /objects_pits/);

  const client = new Client(worldUrl);
  for (let index = 0; index < 4; index += 1) {
    rooms.push(await client.joinOrCreate("world", { worldId: "wall-street", userId: `integration-${index}` }, WorldState));
  }
  await waitFor(() => rooms.every((room) => room.state.players.size === 4));
  assert.equal(new Set(rooms.map((room) => room.sessionId)).size, 4);
  await waitForAsync(async () => {
    const response = await fetch(`${worldHttpUrl}/api/worlds`);
    if (!response.ok) return false;
    const payload = await response.json() as { worlds: Array<{ id: string; online: number }> };
    return payload.worlds.find((world) => world.id === "wall-street")?.online === 4;
  });
  rooms.forEach((room) => room.onMessage("seat", () => undefined));

  const injectionPlayer = player(rooms[3]);
  const injectionBefore = { x: injectionPlayer.x, y: injectionPlayer.y };
  rooms[3].send("input", { x: 999999, y: 999999 });
  await wait(200);
  assert.deepEqual({ x: injectionPlayer.x, y: injectionPlayer.y }, injectionBefore);

  sendInput(rooms[3], { right: true, dtMs: 999999 });
  await waitFor(() => player(rooms[3]).lastProcessedSeq >= 0);
  assert.ok(player(rooms[3]).x - injectionBefore.x <= 7.5);

  await Promise.all([moveNearSeat(rooms[0], "left"), moveNearSeat(rooms[1], "left")]);
  const seatResults: unknown[][] = [[], []];
  rooms.slice(0, 2).forEach((room, index) => room.onMessage("seat", (message) => seatResults[index].push(message)));
  rooms[0].send("interact", { pitId: "wall-street-01", seatIndex: 0 });
  rooms[1].send("interact", { pitId: "wall-street-01", seatIndex: 0 });
  await waitFor(() => rooms[0].state.pits.get("wall-street-01")?.seats.get("0")?.status !== "FREE");
  await wait(150);
  const seatState = rooms[0].state.pits.get("wall-street-01")?.seats.get("0");
  assert.equal(seatState?.status, "RESERVED");
  assert.equal([player(rooms[0]).mode, player(rooms[1]).mode].filter((mode) => mode === "SEATED").length, 1);
  assert.equal(seatResults.flat().filter((result) => (result as { accepted?: boolean }).accepted).length, 1);

  const seatedRoom = player(rooms[0]).mode === "SEATED" ? rooms[0] : rooms[1];
  const seated = player(seatedRoom);
  const mediaRequest = await fetch(`${worldHttpUrl}/api/livekit/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ matchId: "wall-street-01", role: "PLAYER", sessionId: seatedRoom.sessionId }),
  });
  assert.ok(mediaRequest.status === 200 || mediaRequest.status === 503);
  const seatedPosition = { x: seated.x, y: seated.y };
  sendInput(seatedRoom, { right: true });
  await wait(200);
  assert.deepEqual({ x: seated.x, y: seated.y }, seatedPosition);

  const otherSeat = seatedRoom === rooms[0] ? rooms[1] : rooms[0];
  otherSeat.send("interact", { pitId: "wall-street-01", seatIndex: 1 });
  await wait(150);
  assert.equal(rooms[0].state.pits.get("wall-street-01")?.seats.get("1")?.status, "FREE");

  seatedRoom.send("releaseSeat");
  await waitFor(() => player(seatedRoom).mode === "WALKING");
  await waitFor(() => rooms[0].state.pits.get("wall-street-01")?.seats.get("0")?.status === "FREE");
  const releasedPosition = { x: player(seatedRoom).x, y: player(seatedRoom).y };
  assert.ok(Math.hypot(releasedPosition.x - seatedPosition.x, releasedPosition.y - seatedPosition.y) >= 20);
  sendInput(seatedRoom, { up: true });
  await waitFor(() => player(seatedRoom).y < releasedPosition.y);

  await moveNearSeat(rooms[2], "right");
  rooms[2].send("interact", { pitId: "wall-street-01", seatIndex: 0 });
  await waitFor(() => player(rooms[2]).mode === "SEATED");
  await waitFor(() => rooms[2].state.pits.get("wall-street-01")?.seats.get("0")?.status === "RESERVED");
  await waitFor(() => rooms[2].state.pits.get("wall-street-01")?.seats.get("0")?.status === "FREE", 12_000);
  assert.equal(player(rooms[2]).mode, "WALKING");

  const reconnectSession = rooms[3].sessionId;
  const reconnectBefore = { x: player(rooms[3]).x, y: player(rooms[3]).y };
  await wait(5_500);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    rooms[3].connection.close(1001, `integration-drop-${attempt}`);
    await waitFor(() => rooms[3].reconnection.isReconnecting, 2_000);
    await waitFor(() => rooms[3].connection.isOpen && !rooms[3].reconnection.isReconnecting, 8_000);
    await waitFor(() => rooms[3].state.players.has(reconnectSession));
    assert.equal(rooms[3].sessionId, reconnectSession);
    assert.deepEqual({ x: player(rooms[3]).x, y: player(rooms[3]).y }, reconnectBefore);
  }

  console.log(`world integration: health, Vite assets, 4-player presence, authority, race, lock, expiry, release, media token ${mediaRequest.status}, and 20/20 reconnect pass`);
} finally {
  await Promise.allSettled(rooms.map((room) => room.leave()));
}
