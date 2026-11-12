import assert from "node:assert/strict";
import test from "node:test";
import { hostContract } from "../host-contract.ts";

const id = "01234567-89ab-4cde-8f01-23456789abcd";
const input = { capability: "A".repeat(43), scope: { threadId: "contract-thread", attemptId: "contract-attempt", browserContextId: "contract-browser", generation: 1 },
  event: { type: "key", key: "Enter" }, frameRef: "abcdef01-2345-4678-8abc-def012345678" };

test("host input contracts refuse legacy or malformed identities before an event can reach its worker", () => {
  for (const method of ["inputFixture", "inputOci", "inputConsole"] as const) {
    const schema = hostContract[method].input;
    assert.equal(schema.safeParse(input).success, false, `${method} requires an outer input identity`);
    assert.deepEqual(schema.parse({ ...input, inputId: id }), { ...input, inputId: id });
    for (const invalid of [{ ...input, inputId: "untrusted" }, { ...input, inputId: id, verified: true },
      { ...input, inputId: id, event: { ...input.event, inputId: id } }]) {
      assert.equal(schema.safeParse(invalid).success, false);
    }
  }
});

test("host input contracts require a canonical outer displayed-frame reference", () => {
  for (const method of ["inputFixture", "inputOci", "inputConsole"] as const) {
    const schema = hostContract[method].input;
    const { frameRef, ...legacy } = input;
    assert.equal(schema.safeParse({ ...legacy, inputId: id }).success, false);
    for (const invalid of ["invalid", frameRef.toUpperCase(), " " + frameRef]) {
      assert.equal(schema.safeParse({ ...input, inputId: id, frameRef: invalid }).success, false);
    }
    assert.deepEqual(schema.parse({ ...input, inputId: id }), { ...input, inputId: id });
  }
});
