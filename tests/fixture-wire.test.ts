import assert from "node:assert/strict";
import test from "node:test";
import { fixtureFrameSchema, fixtureInputSchema, inputIdSchema } from "../fixture-wire.ts";

test("fixture input accepts bounded coordinates and literal actions only", () => {
  for (const value of [{ type: "click", x: 0, y: 599 }, { type: "text", text: "你好" }, { type: "key", key: "Backspace" }, { type: "wheel", deltaY: -600 }]) {
    assert.deepEqual(fixtureInputSchema.parse(value), value);
  }
  for (const invalid of [
    { type: "click", x: 800, y: 0 }, { type: "click", x: 0, y: 600 }, { type: "click", x: 1.5, y: 0 },
    { type: "text", text: "x".repeat(257) }, { type: "text", text: "" },
    { type: "key", key: "Control+L" }, { type: "wheel", deltaY: 601 }, { type: "wheel", deltaY: 0 },
    { type: "evaluate", script: "arbitrary" }, { type: "click", x: 1, y: 1, selector: "body" },
  ]) assert.equal(fixtureInputSchema.safeParse(invalid).success, false);
});

test("fixture frame transport rejects oversized or non-PNG payloads", () => {
  for (const png of ["not-an-image", "iVBORw0KGgo" + "A".repeat(1_500_000)]) {
    assert.equal(fixtureFrameSchema.safeParse({ png, width: 800, height: 600 }).success, false);
  }
});

test("input identities require canonical unencoded UUIDv4 values outside the event", () => {
  const id = "01234567-89ab-4cde-8f01-23456789abcd";
  assert.equal(inputIdSchema.parse(id), id);
  for (const invalid of [undefined, null, 1, { inputId: id }, ` ${id}`, `${id}\n`, id.toUpperCase(),
    "01234567-89ab-7cde-8f01-23456789abcd", "01234567-89ab-4cde-0f01-23456789abcd",
    "00000000-0000-0000-0000-000000000000", "01234567%2D89ab%2D4cde%2D8f01%2D23456789abcd",
    "MDEyMzQ1NjctODlhYi00Y2RlLThmMDEtMjM0NTY3ODlhYmNk", `${id}x`]) {
    assert.equal(inputIdSchema.safeParse(invalid).success, false);
  }
  assert.equal(fixtureInputSchema.safeParse({ type: "key", key: "Enter", inputId: id }).success, false);
});
