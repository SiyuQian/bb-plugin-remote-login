import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { assessOciCompatibility } from "../oci-compatibility.ts";
import { ociCompatibilityReportSchema } from "../oci-compatibility-wire.ts";
import hostEntry from "../host.ts";
import plugin from "../server.ts";

const unavailable = assessOciCompatibility({ version: null, launcher: null, bootstrap: null, session: null, pythonBrowser: null });

test("OCI inventory wire rejects arbitrary paths, raw source and enabling either adapter", () => {
  assert.deepEqual(ociCompatibilityReportSchema.parse(unavailable), unavailable);
  for (const extra of [{ source: "raw source" }, { path: "/private/account" }, { observedHash: "arbitrary" }]) {
    assert.equal(ociCompatibilityReportSchema.safeParse({ ...unavailable, ...extra }).success, false);
  }
  for (const adapter of ["hostBrowser", "phoneCallback"] as const) {
    assert.equal(ociCompatibilityReportSchema.safeParse({ ...unavailable, [adapter]: { ...unavailable[adapter], enabled: true } }).success, false);
  }
});

test("OCI host inventory accepts only null and leaves private control storage unopened", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "oci-inventory-host-"));
  const privateDir = join(root, "private");
  // Nonexistent storage catches accidental authority construction or initialization.
  await writeFile(join(root, "synthetic-private-frame"), "fixture-frame-never-read");
  const worker = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir: privateDir, tempDir: join(root, "unused") } });
  t.after(async () => { await worker.experimental_dispose(); await rm(root, { recursive: true, force: true }); });
  const result = await worker.experimental_call("inspectOciCompatibility", null);
  assert.deepEqual(ociCompatibilityReportSchema.parse(result), result);
  assert.equal(result.hostBrowser.enabled, false);
  assert.equal(result.phoneCallback.enabled, false);
  assert.deepEqual(await readdir(root), ["synthetic-private-frame"]);
  assert.equal(worker.experimental_getRetainedWorkerLeaseCount(), 0);
  for (const invalid of [{}, { path: "/private/account" }, { key: "fixture-key-never-read" }, { callbackPort: 8181 }]) {
    await assert.rejects(worker.experimental_call("inspectOciCompatibility", invalid as never));
  }
});

test("OCI RPC and CLI preserve the explicit selected host and fixed null worker input", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login", experimental_callHostRpc: async () => unavailable });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  assert.deepEqual(await harness.behavior.callRpc("ociCompatibility", { hostId: "host-selected" }), { hostId: "host-selected", compatibility: unavailable });
  const cli = await harness.behavior.runCli(["probe-oci", "host-other", "--json"]);
  assert.equal(cli.exitCode, 0);
  assert.deepEqual(JSON.parse(cli.stdout), { hostId: "host-other", compatibility: unavailable });
  assert.deepEqual(harness.inspection.experimental_hostRpcCalls.map(({ hostId, method, input }) => ({ hostId, method, input })), [
    { hostId: "host-selected", method: "inspectOciCompatibility", input: null },
    { hostId: "host-other", method: "inspectOciCompatibility", input: null },
  ]);
});

test("OCI probe rejects absent host and arbitrary caller command or path arguments", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login" });
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  for (const invalid of [{}, { hostId: "" }, { hostId: "host-selected", path: "/private/account" }, { hostId: "host-selected", args: ["session", "authenticate"] }]) {
    await assert.rejects(harness.behavior.callRpc("ociCompatibility", invalid), { code: "invalid_input" });
  }
  for (const invalid of [["probe-oci"], ["probe-oci", "--json"], ["probe-oci", "host-selected", "--path", "/private/account"], ["probe-oci", "host-selected", "session", "authenticate"]]) {
    assert.equal((await harness.behavior.runCli(invalid)).exitCode, 1);
  }
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 0);
});
