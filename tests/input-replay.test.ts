import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { InputReplayGuard, InputReplayError } from "../input-replay.ts";

test("an input operation ID is spent once for its entire guard lifetime", () => {
  const guard = new InputReplayGuard(), inputId = randomUUID();
  guard.claim(inputId);
  assert.throws(() => guard.claim(inputId), InputReplayError);
  guard.claim(randomUUID());
  assert.throws(() => guard.claim(inputId), InputReplayError);
  assert.equal(JSON.stringify(guard), "{}");
});

test("only canonical opaque UUIDv4 IDs can be claimed and refusals do not echo input", () => {
  const guard = new InputReplayGuard(), id = "12345678-1234-4123-8123-abcdef012345";
  for (const value of [undefined, null, "", "private-marker", id.toUpperCase(), ` ${id}`, "12345678-1234-1123-8123-abcdef012345", { inputId: id, event: "private-marker" }]) {
    assert.throws(() => guard.claim(value), { name: "InputReplayError", message: "Input operation refused." });
  }
  guard.claim(id);
});

test("4096 accepted claims fill the guard without evicting earlier operation IDs", () => {
  const guard = new InputReplayGuard(), first = randomUUID();
  guard.claim(first);
  for (let index = 1; index < 4096; index++) guard.claim(randomUUID());
  assert.throws(() => guard.claim(randomUUID()), InputReplayError);
  assert.throws(() => guard.claim(first), InputReplayError);
});

test("spent operation IDs are owned by a guard rather than global authority", () => {
  const first = new InputReplayGuard(), other = new InputReplayGuard(), id = randomUUID();
  first.claim(id); other.claim(id);
  assert.throws(() => first.claim(id), InputReplayError);
  assert.throws(() => other.claim(id), InputReplayError);
});
