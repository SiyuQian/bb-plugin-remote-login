import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const scope = { threadId: "thread-test", attemptId: "attempt-test", browserContextId: "context-test", generation: 1 };
const fixtureKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const fixtureToken = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
const body = (value: unknown, token?: string): RequestInit => ({
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(value),
});

test("control session response is private and routed only to the selected host", async (t) => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "remote-login",
    experimental_callHostRpc: async ({ hostId, method, input }) => {
      assert.equal(hostId, "host-selected");
      assert.equal(method, "authenticateControl");
      assert.deepEqual(input, { key: fixtureKey, scope });
      return { ok: true, grant: { capability: fixtureToken, expiresAt: 1_000_000 } };
    },
  });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const response = await harness.behavior.fetchHttp("POST", "/control/session", body({ hostId: "host-selected", key: fixtureKey, scope }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { capability: fixtureToken, expiresAt: 1_000_000 });
  assert.equal(JSON.stringify(harness.inspection.realtimeSignals).includes(fixtureToken), false);
  assert.equal(JSON.stringify(harness.logEntries).includes(fixtureKey), false);
});

test("unproved UI flags do not create a control session", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login" });
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  const response = await harness.behavior.fetchHttp("POST", "/control/session", body({ hostId: "host-selected", scope, humanVerified: true }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_request" });
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 0);
});

test("private control check requires a bearer before accessing the worker", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login" });
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  const response = await harness.behavior.fetchHttp("POST", "/control/check", body({ hostId: "host-selected", scope }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "control_authorization_failed" });
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 0);
});

test("denied control does not echo credentials or backend error details", async (t) => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "remote-login",
    experimental_callHostRpc: async () => ({ ok: false, reason: "invalid_capability" }),
  });
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  const response = await harness.behavior.fetchHttp("POST", "/control/check", body({ hostId: "host-selected", scope }, fixtureToken));
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "control_authorization_failed" });
});

test("control routes do not accept non-JSON or oversized bodies", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login" });
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  const text = await harness.behavior.fetchHttp("POST", "/control/session", {
    headers: { "content-type": "text/plain" }, body: "key=not-a-credential",
  });
  assert.equal(text.status, 400);
  const oversized = await harness.behavior.fetchHttp("POST", "/control/session", body({ extra: "x".repeat(5000) }));
  assert.equal(oversized.status, 400);
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 0);
});

test("backend exceptions are redacted on control routes", async (t) => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "remote-login",
    experimental_callHostRpc: async () => { throw new Error(`Sensitive fixture ${fixtureKey}`); },
  });
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  const response = await harness.behavior.fetchHttp("POST", "/control/session", body({ hostId: "host-selected", key: fixtureKey, scope }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "control_unavailable" });
  assert.equal(JSON.stringify(harness.logEntries).includes(fixtureKey), false);
});
