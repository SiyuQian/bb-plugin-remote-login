import { inputRequest } from "./input-operation-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const hostId = "host-selected";
const scope = { threadId: "fixture-thread", attemptId: "fixture-attempt", browserContextId: "fixture-browser", generation: 1 };
const capability = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
const frameRef = "11111111-1111-4111-8111-111111111111";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKD8AAAAASUVORK5CYII=";
const body = (value: unknown, token: string | null = capability) => ({
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(inputRequest(value && typeof value === "object" && "event" in value ? { frameRef, ...value } : value)),
});

test("protected input and readonly frame routes expose distinct trusted stale observations", async t => {
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login", experimental_callHostRpc: async ({ method, input }) => {
    if (method === "inputFixture") assert.equal((input as { frameRef: string }).frameRef, frameRef);
    return { ok: false, reason: "stale_frame" };
  } });
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  const stale = await harness.behavior.fetchHttp("POST", "/fixture/input", body({ hostId, scope, frameRef, event: { type: "key", key: "Enter" } }));
  assert.equal(stale.status, 409); assert.equal(stale.headers.get("cache-control"), "no-store");
  assert.deepEqual(await stale.json(), { error: "stale_frame" });
  const frame = await harness.behavior.fetchHttp("POST", "/fixture/frame", body({ hostId, scope }));
  assert.equal(frame.status, 409); assert.deepEqual(await frame.json(), { error: "stale_frame" });
  assert.equal(frame.headers.get("cache-control"), "no-store");
  const start = await harness.behavior.fetchHttp("POST", "/fixture/start", body({ hostId, scope }));
  assert.equal(start.status, 503); assert.deepEqual(await start.json(), { error: "fixture_control_failed" });
});

test("fixture routes reject missing proof and unbounded or executable input before contacting a host", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login" });
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  for (const action of ["start", "frame", "input", "close"]) {
    const value = { hostId, scope, ...(action === "input" ? { event: { type: "text", text: "fixture" } } : {}) };
    assert.equal((await harness.behavior.fetchHttp("POST", `/fixture/${action}`, body(value, null))).status, 401);
  }
  for (const event of [{ type: "evaluate", script: "private" }, { type: "click", x: 999, y: 0 }, { type: "text", text: "x".repeat(257) }]) {
    assert.equal((await harness.behavior.fetchHttp("POST", "/fixture/input", body({ hostId, scope, event }))).status, 400);
  }
  assert.equal((await harness.behavior.fetchHttp("POST", "/fixture/start", body({ hostId, scope, url: "https://unapproved.invalid" }))).status, 400);
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 0);
});

test("fixture control stays on the private channel and selected host, with no public frame RPC", async (t) => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "remote-login",
    experimental_callHostRpc: async ({ hostId: selected, method, input }) => {
      assert.equal(selected, hostId);
      const supplied = input as Record<string, unknown>;
      if (method === "inputFixture") assert.match(String(supplied.inputId), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      const { inputId: _inputId, ...rest } = supplied;
      assert.deepEqual(rest, { capability, scope, ...(method === "inputFixture" ? { event: { type: "text", text: "synthetic only" }, frameRef } : {}) });
      if (method === "startFixture") return { ok: true, viewport: { width: 800, height: 600 } };
      if (method === "frameFixture") return { ok: true, frame: { png, width: 800, height: 600, frameRef } };
      return { ok: true };
    },
  });
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  const expected = { start: { width: 800, height: 600 }, frame: { png, width: 800, height: 600, frameRef }, input: { accepted: true }, close: { closed: true } };
  for (const action of ["start", "frame", "input", "close"] as const) {
    const response = await harness.behavior.fetchHttp("POST", `/fixture/${action}`, body({ hostId, scope, ...(action === "input" ? { event: { type: "text", text: "synthetic only" } } : {}) }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), expected[action]);
  }
  await assert.rejects(harness.behavior.callRpc("frameFixture", { hostId, scope, capability }), { code: "unknown_method" });
  const publicValues = JSON.stringify([harness.logEntries, harness.inspection.realtimeSignals, await bb.storage.kv.list()]);
  for (const privateValue of [png, capability, "synthetic only"]) assert.equal(publicValues.includes(privateValue), false);
});

test("fixture refusals and backend failures reveal no submitted control material", async (t) => {
  let throws = false;
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login", experimental_callHostRpc: async () => {
    if (throws) throw new Error(`${capability} synthetic only`);
    return { ok: false, reason: "unauthorized" };
  } });
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  for (const expectedStatus of [403, 503]) {
    const response = await harness.behavior.fetchHttp("POST", "/fixture/frame", body({ hostId, scope }));
    assert.equal(response.status, expectedStatus);
    assert.deepEqual(await response.json(), { error: "fixture_control_failed" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    throws = true;
  }
});
