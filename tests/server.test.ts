import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

test("ordinary login tools are available per injected thread while only the fixture probe is opt-in", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login" });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const selected = makePluginAgentConfigurationContext({ thread: { id: "thread-selected" } });
  const other = makePluginAgentConfigurationContext({ thread: { id: "thread-other" } });
  const ordinary = ["remote_login_request", "remote_login_status", "remote_login_cancel", "remote_login_oci_read", "remote_login_console_read"].sort();
  const names = async (context: typeof selected) => (await harness.behavior.resolveAgentConfiguration(context)).tools.map((tool) => tool.name).sort();
  assert.deepEqual(await names(selected), ordinary);
  assert.deepEqual(await names(other), ordinary);
  await harness.behavior.setSettings({ probeThreadId: "thread-selected" });
  assert.deepEqual(await names(selected), [...ordinary, "remote_login_wait_probe"].sort());
  assert.deepEqual(await names(other), ordinary);
  await harness.behavior.setSettings({ probeThreadId: "" });
  assert.deepEqual(await names(selected), ordinary);
});

test("RPC caller classification does not claim that a client is a human", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login" });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  assert.deepEqual(await harness.behavior.callRpc("callerInfo", null), {
    kind: "client",
    humanVerified: false,
  });
  assert.deepEqual(await harness.behavior.callRpc("callerInfo", null, {
    experimental_caller: { kind: "plugin", pluginId: "other-plugin" },
  }), { kind: "plugin", humanVerified: false });
});

test("runtime inspection targets the explicitly selected host", async (t) => {
  const runtime = {
    platform: "darwin", architecture: "arm64", nodeVersion: "v22.0.0",
    browser: { available: true, name: "Chrome" },
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "remote-login",
    experimental_callHostRpc: async () => runtime,
  });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  assert.deepEqual(await harness.behavior.callRpc("inspectHost", { hostId: "host-selected" }), {
    hostId: "host-selected", runtime,
  });
  const call = harness.inspection.experimental_hostRpcCalls[0];
  assert.equal(call?.hostId, "host-selected");
  assert.equal(call?.method, "inspectRuntime");
  assert.equal(call?.input, null);
});

test("missing host selection is rejected before invoking the worker", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login" });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  await assert.rejects(harness.behavior.callRpc("inspectHost", { hostId: "" }), {
    code: "invalid_input",
  });
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 0);
});

test("fixture completion remains bound to the host-injected thread context", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login" });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const pending = harness.behavior.callAgentTool("remote_login_wait_probe", {}, {
    threadId: "thread-from-host", projectId: "project-from-host",
  });
  await setImmediate();
  const interaction = harness.inspection.pendingInteractions[0];
  assert.ok(interaction);
  assert.equal(interaction.threadId, "thread-from-host");
  harness.behavior.submitInteraction(interaction.id, { confirmation: "fixture-only" });
  const result = await pending;
  assert.equal(typeof result, "object");
  if (typeof result === "string") throw new Error("expected structured fixture result");
  assert.notEqual(result.isError, true);
  const text = result.content[0];
  assert.equal(text?.type, "text");
  if (text?.type !== "text") throw new Error("expected non-secret text result");
  assert.deepEqual(JSON.parse(text.text), {
    phase: "fixture_complete", threadId: "thread-from-host", authenticationAttempted: false,
  });
});

test("arbitrary form submission does not complete the fixture verifier", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login" });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const pending = harness.behavior.callAgentTool("remote_login_wait_probe", {}, { threadId: "thread-rejected" });
  await setImmediate();
  const interaction = harness.inspection.pendingInteractions[0];
  assert.ok(interaction);
  harness.behavior.submitInteraction(interaction.id, { confirmation: "not-the-fixture" });
  const result = await pending;
  assert.equal(typeof result, "object");
  if (typeof result === "string") throw new Error("expected structured result");
  assert.equal(result.isError, true);
  const text = result.content[0];
  if (text?.type !== "text") throw new Error("expected non-secret text result");
  assert.deepEqual(JSON.parse(text.text), {
    phase: "fixture_rejected", threadId: "thread-rejected", authenticationAttempted: false,
  });
});

test("cancelled fixture wait returns an error rather than login success", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login" });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  const pending = harness.behavior.callAgentTool("remote_login_wait_probe", {}, { threadId: "thread-cancelled" });
  await setImmediate();
  const interaction = harness.inspection.pendingInteractions[0];
  assert.ok(interaction);
  harness.behavior.cancelInteraction(interaction.id);
  const result = await pending;
  assert.equal(typeof result, "object");
  if (typeof result === "string") throw new Error("expected structured result");
  assert.equal(result.isError, true);
  const text = result.content[0];
  if (text?.type !== "text") throw new Error("expected non-secret text result");
  assert.deepEqual(JSON.parse(text.text), {
    phase: "fixture_cancelled", threadId: "thread-cancelled", authenticationAttempted: false,
  });
});
