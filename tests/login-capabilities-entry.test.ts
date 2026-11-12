import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { assessLoginCapabilities } from "../provider-registry.ts";

const report = assessLoginCapabilities({ platform: "darwin", architecture: "arm64", chromeVersion: "157.0.8103.50", processInspection: false, cliSourceMatched: true });
test("method diagnostics route to the explicit host and expose limitations without authorization", async t => {
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login", experimental_callHostRpc: async call => {
    assert.equal(call.hostId, "host-selected"); assert.equal(call.method, "inspectLoginCapabilities"); assert.equal(call.input, null); return report;
  } });
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  assert.deepEqual(await harness.behavior.callRpc("loginCapabilities", { hostId: "host-selected" }), { hostId: "host-selected", report });
  await assert.rejects(harness.behavior.callRpc("loginCapabilities", { hostId: "" }));
  await assert.rejects(harness.behavior.callRpc("loginCapabilities", { hostId: "host-selected", enabled: true }));
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 1);
  assert.equal(harness.inspection.pendingInteractions.length, 0);
  assert.equal(bb.storage.database().prepare("SELECT name FROM sqlite_master WHERE name='remote_login_owner_v1'").get(), undefined);
});

test("the command reports methods on an explicit host and rejects arbitrary probe arguments", async t => {
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login", experimental_callHostRpc: async call => {
    assert.equal(call.hostId, "host-selected"); assert.equal(call.method, "inspectLoginCapabilities"); return report;
  } }); t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  const result = await harness.behavior.runCli(["probe-methods", "host-selected", "--json"]);
  assert.equal(result.exitCode, 0); assert.deepEqual(JSON.parse(result.stdout!), { hostId: "host-selected", report });
  for (const input of [["probe-methods"], ["probe-methods", "--json"], ["probe-methods", "host-selected", "--url", "https://unreviewed.invalid"]]) {
    assert.equal((await harness.behavior.runCli(input)).exitCode, 1);
  }
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 1);
});

test("source host-entry inspection needs no account/control root and rejects caller-selected probe inputs", async t => {
  const { experimental_createHostEntryHarness } = await import("@get-bb/plugin-sdk/testing/host");
  const { default: entry } = await import("../host.ts");
  const { loginCapabilitiesSchema } = await import("../provider-wire.ts");
  const worker = experimental_createHostEntryHarness(entry); t.after(() => worker.experimental_dispose());
  const report = loginCapabilitiesSchema.parse(await worker.experimental_call("inspectLoginCapabilities", null));
  assert.equal(report.providers[2].availability, "unavailable");
  assert.ok(report.providers.every(provider => provider.acceptance === "not_accepted"));
  await assert.rejects(worker.experimental_call("inspectLoginCapabilities", { url: "https://unreviewed.invalid", enabled: true } as never));
  assert.equal(worker.experimental_getRetainedWorkerLeaseCount(), 0);
});
