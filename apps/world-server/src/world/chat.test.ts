import assert from "node:assert/strict";
import { MAX_CHAT_MESSAGE_LENGTH, parseChatMessage } from "@outcry/shared/domain";

assert.deepEqual(parseChatMessage({ text: "  hello   floor  " }), { text: "hello floor" });
assert.equal(parseChatMessage({ text: "" }), null);
assert.equal(parseChatMessage({ text: "x".repeat(MAX_CHAT_MESSAGE_LENGTH + 1) }), null);
assert.equal(parseChatMessage({ text: "hello", extra: true }), null);
assert.equal(parseChatMessage({ text: 42 }), null);

console.log("chat: payload validation and whitespace normalization pass");
