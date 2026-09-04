import assert from "node:assert/strict";
import { loadWorldGeometry } from "./geometry";
import {
  parseSeatConfirmation,
  parseSeatRequest,
  SeatLeaseManager,
} from "./seat-leasing";

const geometry = await loadWorldGeometry();
const pit = geometry.pits[0];
const seat = geometry.seats.find(({ pitId }) => pitId === pit.pitId);
if (!pit || !seat) throw new Error("test map missing pit seat");

let now = 0;
const manager = new SeatLeaseManager(geometry.pits, geometry.seats, () => now);

assert.deepEqual(parseSeatRequest({ pitId: pit.pitId, seatIndex: seat.seatIndex }), {
  pitId: pit.pitId,
  seatIndex: seat.seatIndex,
});
assert.equal(parseSeatRequest({ pitId: pit.pitId, seatIndex: seat.seatIndex, x: 999999 }), null);
assert.deepEqual(parseSeatConfirmation({ confirmed: true }), { confirmed: true });
assert.equal(parseSeatConfirmation({ confirmed: "yes" }), null);

const reserved = manager.reserve("alice", pit.pitId, seat.seatIndex, seat.x, seat.y);
assert.equal(reserved.accepted, true);
if (!reserved.accepted) throw new Error("reservation should succeed");
assert.equal(reserved.seat.status, "RESERVED");
assert.equal(manager.reserve("bob", pit.pitId, seat.seatIndex, seat.x, seat.y).accepted, false);
assert.equal(
  manager.reserve("alice", pit.pitId, seat.seatIndex + 1, seat.x, seat.y).accepted,
  false,
  "one user cannot reserve two seats",
);
manager.releaseSession("alice");

assert.equal(
  manager.reserve("edge", pit.pitId, seat.seatIndex, seat.x + pit.interactionRadius, seat.y).accepted,
  true,
  "the interaction radius boundary is inclusive",
);
manager.releaseSession("edge");
assert.equal(
  manager.reserve("outside", pit.pitId, seat.seatIndex, seat.x + pit.interactionRadius + 1, seat.y).accepted,
  false,
);

for (let cycle = 0; cycle < 100; cycle += 1) {
  const lease = manager.reserve(`expiry-${cycle}`, pit.pitId, seat.seatIndex, seat.x, seat.y);
  assert.equal(lease.accepted, true);
  now += 10_000;
  assert.equal(manager.expire().length, 1);
  assert.equal(manager.get(pit.pitId, seat.seatIndex)?.status, "FREE");
}

const confirmation = manager.reserve("confirmed", pit.pitId, seat.seatIndex, seat.x, seat.y);
assert.equal(confirmation.accepted, true);
assert.equal(manager.beginConfirmation("confirmed").accepted, true);
assert.equal(manager.get(pit.pitId, seat.seatIndex)?.status, "CONFIRMING");
assert.equal(manager.confirm("confirmed").accepted, true);
assert.equal(manager.get(pit.pitId, seat.seatIndex)?.status, "CONFIRMED");
now += 100_000;
assert.equal(manager.expire().length, 0, "confirmed seats do not expire during the world lease");
manager.releaseSession("confirmed");

let racesWithDoubleReservation = 0;
for (let race = 0; race < 1_000; race += 1) {
  const first = manager.reserve(`race-a-${race}`, pit.pitId, seat.seatIndex, seat.x, seat.y);
  const second = manager.reserve(`race-b-${race}`, pit.pitId, seat.seatIndex, seat.x, seat.y);
  if (first.accepted && second.accepted) racesWithDoubleReservation += 1;
  manager.releaseSession(`race-a-${race}`);
  manager.releaseSession(`race-b-${race}`);
}
assert.equal(racesWithDoubleReservation, 0);

console.log("seat leasing: proximity, atomic race, 100 expiry cycles, confirmation, and release pass");
