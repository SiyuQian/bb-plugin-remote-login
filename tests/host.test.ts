import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "../host.ts";

test("inspectRuntime returns only portable runtime facts", async (t) => {
  const harness = experimental_createHostEntryHarness(hostEntry);
  t.after(() => harness.experimental_dispose());

  const result = await harness.experimental_call("inspectRuntime", null);

  assert.deepEqual(Object.keys(result).sort(), [
    "architecture", "browser", "nodeVersion", "platform",
  ]);
  assert.equal(result.platform, process.platform);
  assert.equal(result.architecture, process.arch);
  assert.equal(result.nodeVersion, process.version);
  assert.deepEqual(Object.keys(result.browser).sort(), ["available", "name"]);
  assert.equal(result.browser.available, result.browser.name !== null);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("a worker without the owned scope cannot confirm prior-worker cleanup", async (t) => {
  const harness = experimental_createHostEntryHarness(hostEntry);
  t.after(() => harness.experimental_dispose());
  assert.deepEqual(await harness.experimental_call("stopAttempt", { scope: {
    threadId: "prior-thread", attemptId: "prior-attempt", browserContextId: "prior-context", generation: 1,
  } }), { ok: false, reason: "cleanup_uncertain" });
  assert.equal(harness.experimental_getRetainedWorkerLeaseCount(), 0);
});

test("synthetic verification requires independent proof and accepts no predicate or result fields", async (t) => {
  const harness = experimental_createHostEntryHarness(hostEntry);
  t.after(() => harness.experimental_dispose());
  const input = { capability: "client", scope: {
    threadId: "verify-thread", attemptId: "verify-attempt", browserContextId: "verify-context", generation: 1,
  } };
  assert.deepEqual(await harness.experimental_call("verifyFixture", input), { ok: false, reason: "unauthorized" });
  for (const extra of [{ selector: "output" }, { code: "true" }, { verified: true }, { frame: "synthetic" }]) {
    await assert.rejects(harness.experimental_call("verifyFixture", { ...input, ...extra } as never));
  }
  assert.equal(harness.experimental_getRetainedWorkerLeaseCount(), 0);
});

test("inspectRuntime reports unavailable when no browser executable is accessible", async (t) => {
  t.mock.method(fs, "accessSync", () => {
    throw Object.assign(new Error("Not found"), { code: "ENOENT" });
  });
  const harness = experimental_createHostEntryHarness(hostEntry);
  t.after(() => harness.experimental_dispose());

  const result = await harness.experimental_call("inspectRuntime", null);

  assert.deepEqual(result.browser, { available: false, name: null });
});

test("inspectRuntime finds Chromium on PATH without disclosing its executable path", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "remote-login-probe-"));
  const executable = join(directory, process.platform === "win32" ? "chromium.exe" : "chromium");
  await writeFile(executable, "browser fixture; never execute", { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = directory;
  t.after(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  });
  const accessSync = fs.accessSync;
  t.mock.method(fs, "accessSync", (path: fs.PathLike, mode?: number) => {
    if (path === executable) return accessSync(path, mode);
    throw Object.assign(new Error("Not found"), { code: "ENOENT" });
  });
  const harness = experimental_createHostEntryHarness(hostEntry);
  t.after(() => harness.experimental_dispose());

  const result = await harness.experimental_call("inspectRuntime", null);

  assert.deepEqual(result.browser, { available: true, name: "Chromium" });
  assert.equal(JSON.stringify(result).includes(directory), false);
});

test("inspectRuntime accepts only the null request and can be disposed normally", async () => {
  const harness = experimental_createHostEntryHarness(hostEntry);
  try {
    await assert.rejects(harness.experimental_call("inspectRuntime", {} as never));
    await harness.experimental_call("inspectRuntime", null);
  } finally {
    await harness.experimental_dispose();
  }
});
