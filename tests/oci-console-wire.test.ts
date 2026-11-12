import assert from "node:assert/strict";
import test from "node:test";
import { consoleHandbackSchema, consoleReadRequestSchema, consoleReadResultSchema } from "../oci-console-wire.ts";

test("Console handback cannot carry references before verified or return a partial reference pair", () => {
  const pending = { configured: true, phoneControlAccepted: true, phase: "verifying", failure: null, verified: false };
  const receipt = "11111111-1111-4111-8111-111111111111", browserRef = "22222222-2222-4222-8222-222222222222";
  assert.equal(consoleHandbackSchema.safeParse(pending).success, true);
  for (const changed of [{ receipt }, { browserRef }, { receipt, browserRef }, { phase: "verified" }, { verified: true }]) {
    assert.equal(consoleHandbackSchema.safeParse({ ...pending, ...changed }).success, false);
  }
  assert.equal(consoleHandbackSchema.safeParse({ ...pending, phase: "verified", verified: true, receipt, browserRef }).success, true);
});

test("Console read wire permits only fixed operations and bounded projected text", () => {
  for (const operation of ["read_identity", "read_page"]) assert.equal(consoleReadRequestSchema.safeParse({ operation }).success, true);
  for (const value of [{ operation: "evaluate" }, { operation: "read_page", url: "https://cloud.oracle.com/" }, { operation: "read_identity", headers: {} }]) {
    assert.equal(consoleReadRequestSchema.safeParse(value).success, false);
  }
  const outline = { operation: "read_page", title: "Console", headings: ["Overview"] };
  assert.equal(consoleReadResultSchema.safeParse(outline).success, true);
  for (const value of [{ ...outline, title: "x".repeat(129) }, { ...outline, headings: Array(21).fill("x") },
    { ...outline, title: "hidden\u202evalue" }, { ...outline, cookies: "forbidden" }, { ...outline, headings: ["a\nb"] }]) {
    assert.equal(consoleReadResultSchema.safeParse(value).success, false);
  }
});
