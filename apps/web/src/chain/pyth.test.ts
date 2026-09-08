import assert from "node:assert/strict";
import { parsePythInstructionError, PythSubmissionError, pythFeedId } from "./pyth";

const solUsd = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

assert.equal(pythFeedId(solUsd), `0x${solUsd}`);
assert.equal(pythFeedId(`0x${solUsd.toUpperCase()}`), `0x${solUsd}`);
assert.throws(() => pythFeedId("not-a-feed"), /price_feed_id_invalid/);
assert.deepEqual(
  parsePythInstructionError({ InstructionError: [2, { Custom: 6000 }] }),
  { index: 2, details: { Custom: 6000 } },
);
assert.deepEqual(
  parsePythInstructionError(["InstructionError", [1, "ComputationalBudgetExceeded"]]),
  { index: 1, details: "ComputationalBudgetExceeded" },
);
assert.equal(parsePythInstructionError({ AccountNotFound: null }), undefined);

const diagnostics = {
  transactionIndex: 1,
  transactionCount: 2,
  failedInstructionIndex: 0,
  failingProgramId: "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
  instructionProgramIds: ["rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"],
  err: ["InstructionError", [0, "InvalidAccountOwner"]],
  logs: ["Program log: account owner mismatch"],
  unitsConsumed: 42,
};
const simulationError = new PythSubmissionError("simulation", "instruction_0_failed", diagnostics);
assert.deepEqual(simulationError.diagnostics, diagnostics);
