import assert from "node:assert/strict";
import { createSeatAssignmentStore } from "./seat-assignments";

const store = createSeatAssignmentStore();
const assignment = {
  matchAddress: "match-v2",
  walletAddress: "wallet",
  pitId: "wall-street-01",
  seatIndex: 2,
};

assert.equal(await store.get(assignment.matchAddress, assignment.walletAddress), undefined);
await store.set(assignment);
assert.deepEqual(await store.get(assignment.matchAddress, assignment.walletAddress), assignment);
await store.delete(assignment.matchAddress, assignment.walletAddress);
assert.equal(await store.get(assignment.matchAddress, assignment.walletAddress), undefined);

console.log("seat assignments: match-scoped durable world seat persistence contract passes");
