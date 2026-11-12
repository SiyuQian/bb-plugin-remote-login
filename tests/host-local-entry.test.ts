import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import puppeteer, { type Browser } from "puppeteer-core";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { controlKeyFingerprint, provisionControlRoot } from "../control-authority.ts";
import { PairedControlGate } from "../paired-control-gate.ts";
import { ControlAuthority } from "../control-authority.ts";
import { hostContract } from "../host-contract.ts";
import hostEntry from "../host.ts";
import plugin from "../server.ts";
import { recoveryChromeGuard } from "./mobile-recovery-fixture.ts";
import { eventually, nativeValue } from "./owned-console-flow-fixture.ts";

test("built host artifact enforces local-mode transport refusal and exact owned cleanup", {
  skip: process.platform !== "darwin" || process.arch !== "arm64", timeout: 20000,
}, async t => {
  const guard = recoveryChromeGuard(t);
  const root = await mkdtemp(join(await realpath(tmpdir()), "host-local-built-")), dataDir = join(root, "private");
  const key = Buffer.alloc(32, 92).toString("base64url");
  await provisionControlRoot(dataDir, key, controlKeyFingerprint(key));
  const entry = (await import(new URL("../dist/host.js", import.meta.url).href)).default as typeof hostEntry;
  const worker = experimental_createHostEntryHarness(entry, { experimental_paths: { dataDir, tempDir: join(root, "unused") } });
  t.after(async () => { await worker.experimental_dispose(); await rm(root, { recursive: true, force: true }); });
  const scope = { threadId: "built-local-thread", attemptId: "built-local-attempt", browserContextId: "built-local-browser", generation: 1 };
  const authenticated = await worker.experimental_call("authenticateControl", { key, scope });
  assert.equal(authenticated.ok, true); if (!authenticated.ok) throw new Error("Fixture authorization required");
  const proof = { scope, capability: authenticated.grant.capability };
  assert.equal((await worker.experimental_call("startFixture", { ...proof, controlMode: "host" })).ok, true);
  assert.equal(worker.experimental_getRetainedWorkerLeaseCount(), 1);
  assert.equal((await worker.experimental_call("frameFixture", proof)).ok, false);
  assert.equal((await worker.experimental_call("inputFixture", { ...proof, inputId: "11111111-1111-4111-8111-111111111111",
    frameRef: "22222222-2222-4222-8222-222222222222", event: { type: "text", text: "must never reach local page" } })).ok, false);
  assert.equal((await worker.experimental_call("startFixture", { ...proof, controlMode: "remote" })).ok, false);
  assert.deepEqual(await worker.experimental_call("closeFixture", proof), { ok: true });
  assert.equal(worker.experimental_getRetainedWorkerLeaseCount(), 0);
  await eventually(() => guard.counts().closed === guard.counts().total); guard.assertClosed();
  assert.equal((await readdir(dataDir)).some(name => name.startsWith("fixture-browser-")), false);
});

test("registered host entry completes visible local control through its original native call without remote observations", {
  skip: process.platform !== "darwin" || process.arch !== "arm64", timeout: 30000,
}, async t => {
  const guard = recoveryChromeGuard(t);
  const root = await mkdtemp(join(await realpath(tmpdir()), "host-local-entry-")), dataDir = join(root, "private");
  const key = Buffer.alloc(32, 91).toString("base64url");
  await provisionControlRoot(dataDir, key, controlKeyFingerprint(key));
  const worker = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir, tempDir: join(root, "unused") } });
  let browser: Browser | undefined, localLaunch = false;
  const launch = puppeteer.launch.bind(puppeteer);
  t.mock.method(puppeteer, "launch", async (options: Parameters<typeof puppeteer.launch>[0]) => {
    localLaunch = options?.headless === false;
    browser = await launch(options); return browser;
  });
  const context = { projectId: "project-host-local", threadId: "thread-host-local" }, hostId = "host-local-target";
  const environment = {
    baseBranch: null, branchName: null, createdAt: 1, defaultBranch: null, environmentProviderId: null,
    environmentProviderInstanceKey: null, environmentProviderSelection: null, hostId, hostLifecycle: "active" as const,
    id: "environment-host-local", isGitRepo: false, isWorktree: false, lifecycle: { phase: "active" as const, retireAt: null, teardown: null },
    managed: false, mergeBaseBranch: null, name: "local fixture", path: "/private/local-fixture", projectId: context.projectId,
    status: "ready" as const, updatedAt: 1, workspaceProvisionType: "personal" as const,
  };
  const calls: string[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login", sdk: {
    threads: { get: () => makeThreadResponse({ ...context, id: context.threadId, environmentId: environment.id, deletedAt: null, archivedAt: null }) },
    environments: { get: () => environment },
  }, experimental_callHostRpc: ({ hostId: selectedHost, method, input, signal }) => {
    assert.equal(selectedHost, hostId); calls.push(method);
    return worker.experimental_call(method as keyof typeof hostContract, input as never, { signal });
  } });
  const controller = new AbortController();
  let waiting: Promise<unknown> | undefined;
  t.after(async () => {
    controller.abort(); await waiting?.catch(() => {});
    await harness.lifecycle.dispose(); await worker.experimental_dispose();
    await rm(root, { recursive: true, force: true });
  });
  await plugin(bb);
  waiting = harness.behavior.callAgentTool("remote_login_request", { mode: "synthetic", wait: true }, { ...context, signal: controller.signal });
  await eventually(() => harness.inspection.pendingInteractions.length === 1);
  const interaction = harness.inspection.pendingInteractions[0]!, { attemptId } = interaction.payload as { attemptId: string };
  const post = (action: string, extra = {}, capability?: string) => harness.behavior.fetchHttp("POST", `/login/${action}`, {
    headers: { "content-type": "application/json", ...(capability ? { authorization: `Bearer ${capability}` } : {}) },
    body: JSON.stringify({ attemptId, ...extra }),
  });
  const authenticated = await post("session", { key }); assert.equal(authenticated.status, 200);
  const { grant } = await authenticated.json() as { grant: { capability: string } };
  assert.equal((await post("start", { controlMode: "host" }, grant.capability)).status, 200);
  assert.equal(localLaunch, true); assert.ok(browser);
  const page = (await browser.pages())[0]!;
  assert.equal((await post("frame", {}, grant.capability)).status, 409);
  assert.equal(calls.includes("frameFixture"), false);
  await page.focus("input"); await page.keyboard.type("fabricated host control"); await page.click("button");
  assert.equal((await post("handback", {}, grant.capability)).status, 200);
  assert.equal(browser.connected, false);
  assert.equal(worker.experimental_getRetainedWorkerLeaseCount(), 0);
  const gate = new PairedControlGate(dataDir, new ControlAuthority(dataDir));
  assert.equal(await gate.accepted("host"), true); assert.equal(await gate.accepted("remote"), false);
  harness.behavior.submitInteraction(interaction.id, { attemptId });
  const result = nativeValue(await waiting as Awaited<ReturnType<typeof harness.behavior.callAgentTool>>);
  assert.equal(result.phase, "verified"); assert.equal(result.resume, "uncertain");
  await setImmediate();
  const status = await (await post("status")).json() as { controlMode: string };
  assert.equal(status.controlMode, "host");
  assert.equal(harness.inspection.sdk.calls.some(call => call.path === "threads.send"), false);
  assert.equal((await readdir(dataDir)).some(name => name.startsWith("fixture-browser-")), false);
  await eventually(() => guard.counts().closed === guard.counts().total); guard.assertClosed();
  const visible = JSON.stringify([result, status, harness.logEntries, harness.inspection.realtimeSignals,
    bb.storage.database().prepare("SELECT record FROM remote_login_attempts_v1").all()]);
  for (const privateValue of [key, grant.capability, root, "fabricated host control"]) assert.equal(visible.includes(privateValue), false);
});
