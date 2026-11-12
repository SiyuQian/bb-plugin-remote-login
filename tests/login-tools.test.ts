import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { attemptIdentity, LoginCoordinator } from "../login-coordinator.ts";
import { registerLoginTools } from "../login-tools.ts";
import { assessLoginCapabilities } from "../provider-registry.ts";

type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
const context = { projectId: "project-fixture", threadId: "thread-injected" };
const hostId = "host-from-environment";
const principalId = "root-host-observed";
const privatePath = "/private/fixture-provisioning-path";
type JobMetadata = { attemptId: string; mode: string; phase: string; hostId: string; expiresAt: number; resume: string };

function environment(id: string, host: string): Environment {
  return {
    baseBranch: null, branchName: null, createdAt: 1, defaultBranch: null,
    environmentProviderId: null, environmentProviderInstanceKey: null, environmentProviderSelection: null,
    hostId: host, hostLifecycle: "active", id, isGitRepo: false, isWorktree: false,
    lifecycle: { phase: "active", retireAt: null, teardown: null }, managed: false, mergeBaseBranch: null,
    name: "private environment title fixture", path: "/private/environment-path", projectId: context.projectId,
    status: "ready", updatedAt: 1, workspaceProvisionType: "personal",
  };
}

function text(result: PluginAgentToolResult): Record<string, unknown> {
  assert.equal(typeof result, "object");
  if (typeof result === "string") throw new Error("Expected structured tool fixture result");
  assert.equal(result.content.length, 1);
  const content = result.content[0]!;
  assert.equal(content.type, "text");
  if (content.type !== "text") throw new Error("Expected text fixture result");
  assert.ok(content.text.length < 2048);
  assert.equal(content.text.includes(privatePath), false);
  assert.equal(content.text.includes(principalId), false);
  return JSON.parse(content.text) as Record<string, unknown>;
}

function fixture(t: TestContext, options: { provisioned?: boolean; rootId?: string | null; observe?: () => void | Promise<void>; hostError?: boolean; now?: () => number;
  compatible?: boolean; consoleRuntime?: boolean; processInspection?: boolean; resumeProof?: () => unknown | Promise<unknown>; readTask?: () => unknown | Promise<unknown>;
  consoleProof?: () => unknown | Promise<unknown>; consoleRead?: () => unknown | Promise<unknown> } = {}) {
  const state = { environmentId: "environment-attached", hostId };
  const { bb, harness } = createFakePluginHost({
    pluginId: "remote-login",
    sdk: {
      threads: { get: () => makeThreadResponse({ projectId: context.projectId, id: context.threadId, environmentId: state.environmentId, deletedAt: null, archivedAt: null }) },
      environments: { get: () => environment(state.environmentId, state.hostId) },
    },
    experimental_callHostRpc: async (call) => {
      assert.equal(call.hostId, hostId);
      if (call.method === "inspectLoginCapabilities") return assessLoginCapabilities({ platform: options.compatible || options.consoleRuntime ? "darwin" : "linux", architecture: "arm64", chromeVersion: "157.0.8103.51", processInspection: options.processInspection !== false, cliSourceMatched: options.compatible === true });
      if (call.method === "consoleResumeProof") return options.consoleProof?.() ?? { ok: false, reason: "authorization" };
      if (call.method === "readConsoleTask") return options.consoleRead?.() ?? { ok: false, reason: "authorization" };
      if (call.method === "ociResumeProof") return options.resumeProof?.() ?? { ok: false, reason: "authorization" };
      if (call.method === "readOciTask") return options.readTask?.() ?? { ok: false, reason: "authorization" };
      assert.equal(call.method, "controlInfo");
      assert.equal(call.input, null);
      await options.observe?.();
      if (options.hostError) throw new Error(`${principalId} private backend exception ${privatePath}`);
      return { provisioned: options.provisioned ?? true, rootId: options.provisioned === false ? null : options.rootId === undefined ? principalId : options.rootId, provisioningDirectory: privatePath };
    },
  });
  t.after(() => harness.lifecycle.dispose());
  const coordinator = new LoginCoordinator(bb.storage, { now: options.now ?? (() => 1000), ttlMs: 10_000 });
  registerLoginTools(bb, coordinator);
  const call = (name: string, input: unknown, override: Partial<typeof context> & { signal?: AbortSignal } = {}) =>
    harness.behavior.callAgentTool(name, input, { ...context, ...override });
  return { bb, harness, coordinator, state, call };
}

test("registering tools is inert until a committed execute activates the coordinator", async (t) => {
  const { bb, harness } = fixture(t);
  assert.equal(bb.storage.database().prepare("SELECT name FROM sqlite_master WHERE name='remote_login_owner_v1'").get(), undefined);
  assert.deepEqual(harness.inspection.registrations.agentTools.map((tool) => tool.name).sort(), ["remote_login_cancel", "remote_login_console_read", "remote_login_oci_read", "remote_login_request", "remote_login_status"]);
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 0);
  assert.equal(harness.inspection.sdk.calls.length, 0);
});

test("synthetic requests observe the actual host root and deduplicate without claiming login", async (t) => {
  const { call, coordinator, harness } = fixture(t);
  const first = await call("remote_login_request", { mode: "synthetic" });
  assert.equal(typeof first === "object" && first.isError, undefined);
  const data = text(first) as JobMetadata;
  assert.deepEqual(Object.keys(data).sort(), ["attemptId", "expiresAt", "hostId", "mode", "phase", "resume"]);
  assert.equal(data.hostId, hostId);
  assert.equal(data.mode, "synthetic");
  assert.equal(data.phase, "awaiting_control");
  assert.equal(data.resume, "none");
  assert.equal(data.expiresAt, 11_000);
  assert.equal(coordinator.get(data.attemptId)!.principalId, principalId);
  assert.deepEqual(text(await call("remote_login_request", { mode: "synthetic" })), data);
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 2);
  assert.ok(harness.inspection.experimental_hostRpcCalls.every((call) => call.hostId === hostId && call.method === "controlInfo"));
  assert.equal(harness.inspection.pendingInteractions.length, 0);
});

test("an unpaired host creates only an awaiting-pairing job, never a credential prompt", async (t) => {
  const { call, coordinator, harness } = fixture(t, { provisioned: false });
  const data = text(await call("remote_login_request", { mode: "synthetic" })) as JobMetadata;
  assert.equal(data.phase, "awaiting_pairing");
  assert.equal(coordinator.get(data.attemptId)!.principalId, null);
  assert.equal(harness.inspection.pendingInteractions.length, 0);
});

test("trusted host pairing upgrades one waiting job and a changed root fails its old binding", async (t) => {
  const options = { provisioned: false, rootId: principalId };
  const { call, coordinator } = fixture(t, options);
  const waiting = text(await call("remote_login_request", { mode: "synthetic" })) as JobMetadata;
  options.provisioned = true;
  const paired = text(await call("remote_login_request", { mode: "synthetic" })) as JobMetadata;
  assert.equal(paired.attemptId, waiting.attemptId);
  assert.equal(paired.phase, "awaiting_control");
  assert.equal(coordinator.get(paired.attemptId)!.principalId, principalId);
  options.rootId = "different-host-observed-root";
  const result = await call("remote_login_request", { mode: "synthetic" });
  assert.deepEqual(text(result), { error: "binding_changed" });
  assert.equal(coordinator.get(paired.attemptId)!.principalId, principalId);
  assert.equal(coordinator.get(paired.attemptId)!.failure, "host_changed");
});

test("inconsistent or invalid host root observations cannot create a job", async (t) => {
  for (const rootId of [null, "../../private-root-fixture"]) {
    await t.test(String(rootId), async (t) => {
      const { call, coordinator } = fixture(t, { rootId });
      assert.deepEqual(text(await call("remote_login_request", { mode: "synthetic" })), { error: "unavailable" });
      assert.deepEqual(coordinator.list(context.projectId, context.threadId), []);
    });
  }
});

test("unrecognized CLI and Console modes are durably unsupported without starting a provider", async (t) => {
  for (const mode of ["oci_cli", "oci_web"]) {
    await t.test(mode, async (t) => {
      const { call, coordinator, harness } = fixture(t);
      const result = await call("remote_login_request", { mode });
      assert.equal(typeof result === "object" && result.isError, true);
      const data = text(result) as JobMetadata;
      assert.equal(data.phase, "unsupported");
      assert.equal(data.mode, mode);
      assert.equal(data.resume, "none");
      assert.equal(coordinator.get(data.attemptId)!.failure, "unsupported");
      assert.equal(harness.inspection.pendingInteractions.length, 0);
      assert.deepEqual(harness.inspection.experimental_hostRpcCalls.map((call) => call.method), ["controlInfo", "inspectLoginCapabilities"]);
    });
  }
});

test("recognized CLI requests only queue owner control without starting authorization", async (t) => {
  const f = fixture(t, { compatible: true });
  const data = text(await f.call("remote_login_request", { mode: "oci_cli" })) as JobMetadata;
  assert.equal(data.phase, "awaiting_control");
  assert.equal(data.mode, "oci_cli");
  assert.equal(f.coordinator.get(data.attemptId)!.verification, null);
  assert.equal(f.harness.inspection.pendingInteractions.length, 0);
  assert.deepEqual(f.harness.inspection.experimental_hostRpcCalls.map((call) => call.method), ["controlInfo", "inspectLoginCapabilities"]);
});

test("model-selected targets and event setters are rejected before execute", async (t) => {
  const { call, bb, harness } = fixture(t);
  for (const [name, input] of [
    ["remote_login_request", { mode: "synthetic", hostId: "arbitrary-host" }],
    ["remote_login_request", { mode: "synthetic", threadId: "arbitrary-thread" }],
    ["remote_login_request", { mode: "synthetic", projectId: "arbitrary-project" }],
    ["remote_login_request", { mode: "synthetic", principalId: "model-chosen-root" }],
    ["remote_login_status", { attemptId: "attempt-fixture", verified: true }],
    ["remote_login_cancel", { attemptId: "attempt-fixture", threadId: "arbitrary-thread" }],
  ]) await assert.rejects(call(name as string, input));
  assert.equal(harness.inspection.sdk.calls.length, 0);
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 0);
  assert.equal(bb.storage.database().prepare("SELECT name FROM sqlite_master WHERE name='remote_login_owner_v1'").get(), undefined);
});

test("cross-thread status and cancel are identical fixed refusals without exposing private jobs", async (t) => {
  const { call, coordinator, harness } = fixture(t);
  const own = text(await call("remote_login_request", { mode: "synthetic" })) as JobMetadata;
  const sdkReads = harness.inspection.sdk.calls.length;
  for (const override of [{ threadId: "different-thread" }, { projectId: "different-project" }]) {
    for (const name of ["remote_login_status", "remote_login_cancel"]) {
      const result = await call(name, { attemptId: own.attemptId }, override);
      assert.equal(typeof result === "object" && result.isError, true);
      assert.deepEqual(text(result), { error: "unavailable" });
    }
  }
  assert.equal(harness.inspection.sdk.calls.length, sdkReads);
  assert.equal(coordinator.get(own.attemptId)!.phase, "awaiting_control");
  assert.deepEqual(text(await call("remote_login_status", { attemptId: "missing-attempt" })), { error: "unavailable" });
});

test("moved environment or host rejects the original job without retargeting it", async (t) => {
  for (const field of ["environmentId", "hostId"] as const) {
    for (const name of ["remote_login_status", "remote_login_cancel"]) await t.test(`${name} ${field}`, async (t) => {
      const { call, coordinator, state, harness } = fixture(t);
      const own = text(await call("remote_login_request", { mode: "synthetic" })) as JobMetadata;
      state[field] = `different-${field}`;
      const result = await call(name, { attemptId: own.attemptId });
      assert.equal(typeof result === "object" && result.isError, true);
      assert.deepEqual(text(result), { error: "binding_changed" });
      const saved = coordinator.get(own.attemptId)!;
      assert.equal(saved.phase, "failed");
      assert.equal(saved.failure, "host_changed");
      assert.equal(saved.hostId, hostId);
      assert.equal(saved.environmentId, "environment-attached");
      assert.equal(harness.inspection.experimental_hostRpcCalls.length, 1);
    });
  }
});

test("well-bound cancellation is idempotent and does not claim pending cleanup completed", async (t) => {
  const { call, coordinator } = fixture(t);
  const own = text(await call("remote_login_request", { mode: "synthetic" })) as JobMetadata;
  let saved = coordinator.get(own.attemptId)!;
  for (const type of ["start", "ready"] as const) saved = coordinator.apply(saved.attemptId, { type, expected: attemptIdentity(saved), expectedRevision: saved.revision });
  const result = await call("remote_login_cancel", { attemptId: own.attemptId });
  const data = text(result);
  assert.equal(data.phase, "cancelled");
  assert.equal(Object.hasOwn(data, "closed"), false);
  assert.equal(coordinator.pendingCleanup().length, 1);
  assert.deepEqual(text(await call("remote_login_cancel", { attemptId: own.attemptId })), data);
  assert.equal(coordinator.pendingCleanup().length, 1);
});

test("a move while host controlInfo is awaited cannot create a stale or retargeted job", async (t) => {
  let move = () => {};
  const { call, state, coordinator, harness } = fixture(t, { observe: () => move() });
  move = () => { state.environmentId = "new-environment"; state.hostId = "new-host"; };
  const result = await call("remote_login_request", { mode: "synthetic" });
  assert.deepEqual(text(result), { error: "binding_changed" });
  assert.deepEqual(coordinator.list(context.projectId, context.threadId), []);
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 1);
  assert.equal(harness.inspection.experimental_hostRpcCalls[0]!.hostId, hostId);
});

test("a confirmed move during a repeated request rejects the existing waiting binding", async (t) => {
  let move = () => {};
  const { call, state, coordinator } = fixture(t, { observe: () => move() });
  const waiting = text(await call("remote_login_request", { mode: "synthetic" })) as JobMetadata;
  move = () => { state.hostId = "different-host"; };
  assert.deepEqual(text(await call("remote_login_request", { mode: "synthetic" })), { error: "binding_changed" });
  const saved = coordinator.get(waiting.attemptId)!;
  assert.equal(saved.failure, "host_changed");
  assert.equal(saved.hostId, hostId);
  assert.equal(coordinator.list(context.projectId, context.threadId).length, 1);
});

test("cancel re-reads the revision after SDK awaits instead of overwriting a competing cancellation", async (t) => {
  const { call, coordinator, harness, state } = fixture(t);
  const waiting = text(await call("remote_login_request", { mode: "synthetic" })) as JobMetadata;
  harness.inspection.sdk.stub("environments.get", () => {
    const current = coordinator.get(waiting.attemptId)!;
    coordinator.apply(current.attemptId, { type: "cancel", expected: attemptIdentity(current), expectedRevision: current.revision });
    return environment(state.environmentId, state.hostId);
  });
  const result = await call("remote_login_cancel", { attemptId: waiting.attemptId });
  assert.equal(typeof result === "object" && result.isError, undefined);
  assert.equal(text(result).phase, "cancelled");
  assert.equal(coordinator.get(waiting.attemptId)!.revision, 1);
});

test("aborted and failed host observations return fixed errors without storing DTOs", async (t) => {
  for (const abort of [false, true]) {
    await t.test(abort ? "abort" : "private backend failure", async (t) => {
      const controller = new AbortController();
      const { call, coordinator, harness } = fixture(t, { hostError: !abort, observe: () => { if (abort) controller.abort(); } });
      const result = await call("remote_login_request", { mode: "synthetic" }, { signal: controller.signal });
      assert.equal(typeof result === "object" && result.isError, true);
      assert.deepEqual(text(result), { error: abort ? "aborted" : "unavailable" });
      assert.deepEqual(coordinator.list(context.projectId, context.threadId), []);
      const publicData = JSON.stringify([harness.inspection.logEntries, harness.inspection.realtimeSignals]);
      assert.equal(publicData.includes(privatePath), false);
    });
  }
});

test("an old coordinator cannot reclaim ownership through a subsequent tool call", async (t) => {
  const { call, coordinator, bb } = fixture(t);
  const own = text(await call("remote_login_request", { mode: "synthetic" })) as JobMetadata;
  const replacement = new LoginCoordinator(bb.storage, { now: () => 1000 });
  replacement.activate();
  const result = await call("remote_login_status", { attemptId: own.attemptId });
  assert.deepEqual(text(result), { error: "unavailable" });
  assert.equal(replacement.get(own.attemptId)!.phase, "awaiting_control");
  assert.throws(() => coordinator.get(own.attemptId));
});


function verifySynthetic(coordinator: LoginCoordinator, attemptId: string, kind: "synthetic" | "oci_cli" | "oci_web" = "synthetic"): void {
  let a = coordinator.get(attemptId)!;
  for (const type of ["start", "ready", "handback"] as const) a = coordinator.apply(attemptId, {
    type, expected: attemptIdentity(a), expectedRevision: a.revision,
  });
  coordinator.apply(attemptId, { type: "verified", verificationId: kind !== "synthetic" ? "c86861c0-7ce2-4003-90d9-5961dafd19f1" : "trusted-synthetic-proof", kind,
    expected: attemptIdentity(a), expectedRevision: a.revision });
}

async function pendingWait(f: ReturnType<typeof fixture>, signal?: AbortSignal, mode: "synthetic" | "oci_cli" | "oci_web" = "synthetic") {
  const result = f.call("remote_login_request", { mode, wait: true }, { signal });
  // Keep a missing-feature rejection observable without an unhandled rejection.
  void result.catch(() => {});
  await setImmediate();
  const interaction = f.harness.inspection.pendingInteractions.at(-1);
  assert.ok(interaction, "native request must wait through the SDK interaction");
  const data = interaction.payload as { attemptId: string };
  return { result, interaction, attemptId: data.attemptId };
}

test("native waiting publishes only an attempt identifier and ignores forged verification", async (t) => {
  const f = fixture(t);
  const { result, interaction, attemptId } = await pendingWait(f);
  assert.equal(interaction.threadId, context.threadId);
  assert.equal(interaction.rendererId, "login-control");
  assert.deepEqual(interaction.payload, { attemptId });
  f.harness.behavior.submitInteraction(interaction.id, { verified: true, token: "private-submission-fixture", attemptId });
  assert.deepEqual(text(await result), { error: "unavailable" });
  const saved = f.coordinator.get(attemptId)!;
  assert.equal(saved.phase, "awaiting_control");
  assert.equal(saved.verification, null);
  assert.equal(saved.resume.state, "none");
  assert.equal(JSON.stringify(f.harness.inspection.logEntries).includes("private-submission-fixture"), false);
});

test("independently verified synthetic completion claims uncertainty before returning the native result", async (t) => {
  const f = fixture(t);
  const { result, interaction, attemptId } = await pendingWait(f);
  verifySynthetic(f.coordinator, attemptId);
  f.harness.behavior.submitInteraction(interaction.id, { ready: true });
  const completion = await result;
  assert.equal(typeof completion === "object" && completion.isError, undefined);
  assert.equal(text(completion).phase, "verified");
  assert.equal(text(completion).resume, "uncertain");
  const saved = f.coordinator.get(attemptId)!;
  assert.equal(saved.resume.state, "uncertain");
  assert.ok(saved.resume.deliveryId);
  assert.equal(f.harness.inspection.sdk.calls.some((call) => call.path === "threads.send"), false);
});

test("CLI native completion requires a fresh retained-session proof and returns only its opaque account reference", async (t) => {
  const accountRef = "41ef3a91-c652-4c70-9d50-ebd2bd173ace";
  const f = fixture(t, { compatible: true, now: Date.now,
    resumeProof: () => ({ ok: true, accountRef, expiresAt: Date.now() + 5000 }) });
  const wait = await pendingWait(f, undefined, "oci_cli");
  verifySynthetic(f.coordinator, wait.attemptId, "oci_cli");
  f.harness.behavior.submitInteraction(wait.interaction.id, {});
  const completion = await wait.result;
  assert.equal(typeof completion === "object" && completion.isError, undefined);
  assert.equal(text(completion).accountRef, accountRef);
  assert.equal(text(completion).resume, "uncertain");
  const proof = f.harness.inspection.experimental_hostRpcCalls.find((call) => call.method === "ociResumeProof")!;
  assert.equal(proof.hostId, hostId);
  assert.equal((proof.input as { receipt: string }).receipt, "c86861c0-7ce2-4003-90d9-5961dafd19f1");
  assert.deepEqual(wait.interaction.payload, { attemptId: wait.attemptId });
});

async function consumedCli(t: TestContext, readTask?: () => unknown | Promise<unknown>) {
  const accountRef = "41ef3a91-c652-4c70-9d50-ebd2bd173ace";
  const f = fixture(t, { compatible: true, now: Date.now,
    resumeProof: () => ({ ok: true, accountRef, expiresAt: Date.now() + 5000 }), readTask });
  const wait = await pendingWait(f, undefined, "oci_cli");
  verifySynthetic(f.coordinator, wait.attemptId, "oci_cli");
  f.harness.behavior.submitInteraction(wait.interaction.id, {}); await wait.result;
  return { ...f, attemptId: wait.attemptId, accountRef };
}

test("Console queues on the supported host and returns only a fresh retained browser reference to its original call", async (t) => {
  const browserRef = "41ef3a91-c652-4c70-9d50-ebd2bd173ace";
  const f = fixture(t, { consoleRuntime: true, now: Date.now,
    consoleProof: () => ({ ok: true, browserRef, expiresAt: Date.now() + 5000 }),
    consoleRead: () => ({ ok: true, expiresAt: Date.now() + 4000, result: { operation: "read_page", title: "Console", headings: ["Overview"] } }) });
  const wait = await pendingWait(f, undefined, "oci_web");
  assert.deepEqual(wait.interaction.payload, { attemptId: wait.attemptId });
  verifySynthetic(f.coordinator, wait.attemptId, "oci_web");
  f.harness.behavior.submitInteraction(wait.interaction.id, {});
  const completion = text(await wait.result);
  assert.equal(completion.browserRef, browserRef); assert.equal(completion.resume, "uncertain");
  assert.equal("browserRef" in text(await f.call("remote_login_status", { attemptId: wait.attemptId })), false);
  const output = text(await f.call("remote_login_console_read", { attemptId: wait.attemptId, browserRef, request: { operation: "read_page" } }));
  assert.equal(output.operation, "read_page"); assert.deepEqual(output.headings, ["Overview"]);
  assert.equal(f.harness.inspection.experimental_hostRpcCalls.some((call) => call.method === "inspectOciCompatibility"), false);
});

test("Console completion fails closed without a live retained proof even after a trusted verification record", async (t) => {
  const f = fixture(t, { consoleRuntime: true, now: Date.now });
  const wait = await pendingWait(f, undefined, "oci_web"); verifySynthetic(f.coordinator, wait.attemptId, "oci_web");
  f.harness.behavior.submitInteraction(wait.interaction.id, { verified: true });
  assert.deepEqual(text(await wait.result), { error: "unavailable" });
  assert.equal(f.coordinator.get(wait.attemptId)!.resume.state, "pending");
});

async function consumedConsole(t: TestContext, readTask?: () => unknown | Promise<unknown>) {
  const options = { consoleRuntime: true, now: Date.now,
    consoleProof: () => ({ ok: true, browserRef: "41ef3a91-c652-4c70-9d50-ebd2bd173ace", expiresAt: Date.now() + 5000 }),
    consoleRead: readTask };
  const f = fixture(t, options), wait = await pendingWait(f, undefined, "oci_web");
  verifySynthetic(f.coordinator, wait.attemptId, "oci_web");
  f.harness.behavior.submitInteraction(wait.interaction.id, {}); await wait.result;
  return { ...f, options, attemptId: wait.attemptId, browserRef: options.consoleProof().browserRef };
}

test("Console consumption rejects other native contexts, CLI refs and arbitrary browser operations before host reads", async (t) => {
  const f = await consumedConsole(t), selection = { attemptId: f.attemptId, browserRef: f.browserRef, request: { operation: "read_page" } };
  for (const override of [{ threadId: "another-thread" }, { projectId: "another-project" }]) {
    assert.deepEqual(text(await f.call("remote_login_console_read", selection, override)), { error: "unavailable" });
  }
  for (const invalid of [{ ...selection, accountRef: f.browserRef }, { ...selection, hostId: "another-host" },
    { ...selection, request: { operation: "evaluate", script: "document.cookie" } },
    { ...selection, request: { operation: "read_page", selector: "input" } }]) await assert.rejects(f.call("remote_login_console_read", invalid));
  assert.equal(f.harness.inspection.experimental_hostRpcCalls.some(c => c.method === "readConsoleTask"), false);
});

test("Console read drops late results after cancellation, binding change, proof mismatch or expired lease", async (t) => {
  for (const change of ["cancel", "host", "root", "reference", "expiry", "stop"] as const) await t.test(change, async t => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await consumedConsole(t, async () => { await gate; return { ok: true, expiresAt: Date.now() + 3000,
      result: { operation: "read_page", title: "Console", headings: [] } }; });
    const controller = new AbortController();
    const pending = f.call("remote_login_console_read", { attemptId: f.attemptId, browserRef: f.browserRef, request: { operation: "read_page" } }, { signal: controller.signal });
    for (let tries = 0; tries < 20 && !f.harness.inspection.experimental_hostRpcCalls.some(c => c.method === "readConsoleTask"); tries++) await setImmediate();
    assert.ok(f.harness.inspection.experimental_hostRpcCalls.some(c => c.method === "readConsoleTask"));
    if (change === "cancel") await f.call("remote_login_cancel", { attemptId: f.attemptId });
    if (change === "host") f.state.hostId = "moved-host";
    if (change === "root") Object.assign(f.options, { rootId: "replacement-root" });
    if (change === "reference") f.options.consoleProof = () => ({ ok: true, browserRef: "51ef3a91-c652-4c70-9d50-ebd2bd173ace", expiresAt: Date.now() + 5000 });
    if (change === "expiry") f.options.consoleProof = () => ({ ok: true, browserRef: f.browserRef, expiresAt: Date.now() - 1 });
    if (change === "stop") controller.abort();
    release(); const result = text(await pending); assert.equal(typeof result.error, "string"); assert.equal("title" in result, false);
  });
});

test("the original native context can consume its verified CLI session through a fixed read task", async (t) => {
  const rootCompartmentRef = "fdbfa138-a74f-44be-8aa3-c91e591b5d50";
  const f = await consumedCli(t, () => ({ ok: true, expiresAt: Date.now() + 4000,
    result: { operation: "list_compartments", rootCompartmentRef, rows: [], truncated: false } }));
  assert.equal(f.harness.inspection.registrations.agentTools.some((tool) => tool.name === "remote_login_oci_read"), true,
    "login completion must provide an actual controlled task interface");
  const output = await f.call("remote_login_oci_read", { attemptId: f.attemptId, accountRef: f.accountRef, request: { operation: "list_compartments" } });
  assert.equal(typeof output === "object" && output.isError, undefined);
  const data = text(output); assert.equal(data.operation, "list_compartments"); assert.equal(data.rootCompartmentRef, rootCompartmentRef);
  const observed = f.harness.inspection.experimental_hostRpcCalls.find((call) => call.method === "readOciTask")!;
  assert.equal(observed.hostId, hostId);
  assert.equal((observed.input as { receipt: string }).receipt, "c86861c0-7ce2-4003-90d9-5961dafd19f1");
  assert.deepEqual((observed.input as { request: unknown }).request, { operation: "list_compartments" });
  assert.equal(f.coordinator.get(f.attemptId)!.resume.state, "uncertain");
});

test("task consumption cannot cross native contexts or accept shell, paths and unlisted operations", async (t) => {
  const f = await consumedCli(t);
  const selection = { attemptId: f.attemptId, accountRef: f.accountRef, request: { operation: "list_compartments" } };
  for (const override of [{ threadId: "other-thread" }, { projectId: "other-project" }]) {
    assert.deepEqual(text(await f.call("remote_login_oci_read", selection, override)), { error: "unavailable" });
  }
  assert.equal(f.harness.inspection.experimental_hostRpcCalls.some((call) => call.method === "readOciTask"), false);
  for (const invalid of [
    { ...selection, hostId: "other-host" }, { ...selection, command: "oci session export" },
    { ...selection, request: { operation: "raw_request", url: "https://unapproved.invalid" } },
    { ...selection, request: { operation: "list_instances", compartmentOcid: "ocid1.compartment.oc1..other" } },
  ]) await assert.rejects(f.call("remote_login_oci_read", invalid));
});

test("native task results are dropped when the binding or attempt changes during the service operation", async (t) => {
  for (const condition of ["host", "cancel"] as const) {
    let f: Awaited<ReturnType<typeof consumedCli>>;
    f = await consumedCli(t, () => {
      if (condition === "host") f.state.hostId = "replacement-host";
      else { const a = f.coordinator.get(f.attemptId)!; f.coordinator.apply(a.attemptId, { type: "cancel", expected: attemptIdentity(a), expectedRevision: a.revision }); }
      return { ok: true, expiresAt: Date.now() + 4000, result: { operation: "list_instances", rows: [], truncated: false } };
    });
    const output = await f.call("remote_login_oci_read", { attemptId: f.attemptId, accountRef: f.accountRef,
      request: { operation: "list_instances", compartmentRef: "fdbfa138-a74f-44be-8aa3-c91e591b5d50" } });
    assert.deepEqual(text(output), { error: condition === "host" ? "binding_changed" : "unavailable" });
  }
});

test("a task result that expires during final SDK observations is never returned", async (t) => {
  let now = Date.now(), afterRead = false;
  t.mock.method(Date, "now", () => now);
  const f = await consumedCli(t, () => {
    afterRead = true;
    return { ok: true, expiresAt: now + 1, result: { operation: "list_instances", rows: [], truncated: false } };
  });
  f.harness.inspection.sdk.stub("environments.get", () => {
    if (afterRead) now += 1;
    return environment(f.state.environmentId, f.state.hostId);
  });
  assert.deepEqual(text(await f.call("remote_login_oci_read", { attemptId: f.attemptId, accountRef: f.accountRef,
    request: { operation: "list_instances" } })), { error: "unavailable" });
});

test("thread stop bounds a task transport that ignores cancellation", async (t) => {
  let started!: () => void;
  const observed = new Promise<void>((resolve) => { started = resolve; });
  const f = await consumedCli(t, () => { started(); return new Promise(() => {}); });
  const controller = new AbortController();
  const result = f.call("remote_login_oci_read", { attemptId: f.attemptId, accountRef: f.accountRef,
    request: { operation: "list_instances" } }, { signal: controller.signal });
  await observed; controller.abort();
  assert.deepEqual(text(await result), { error: "aborted" });
});

test("CLI verification metadata cannot resume with a refused, expired or overlong resource proof", async (t) => {
  for (const condition of ["refused", "expired", "overlong", "expires_during_binding"] as const) await t.test(condition, async (t) => {
    let now = Date.now(), afterProof = false;
    t.mock.method(Date, "now", () => now);
    const f = fixture(t, { compatible: true, now: () => now, resumeProof: () => {
      afterProof = true;
      return condition === "refused" ? { ok: false, reason: "authorization" } : {
        ok: true, accountRef: "41ef3a91-c652-4c70-9d50-ebd2bd173ace",
        expiresAt: now + (condition === "expired" ? 0 : condition === "overlong" ? 20_000 : 1),
      };
    } });
    f.harness.inspection.sdk.stub("environments.get", async () => {
      if (afterProof && condition === "expires_during_binding") now += 1;
      return environment(f.state.environmentId, f.state.hostId);
    });
    const wait = await pendingWait(f, undefined, "oci_cli");
    verifySynthetic(f.coordinator, wait.attemptId, "oci_cli");
    f.harness.behavior.submitInteraction(wait.interaction.id, {});
    assert.deepEqual(text(await wait.result), { error: "unavailable" });
    assert.equal(f.coordinator.get(wait.attemptId)!.resume.state, "pending");
  });
});

test("concurrent native waiters cannot claim duplicate verified results", async (t) => {
  const f = fixture(t);
  const first = await pendingWait(f);
  const second = await pendingWait(f);
  assert.equal(first.attemptId, second.attemptId);
  verifySynthetic(f.coordinator, first.attemptId);
  f.harness.behavior.submitInteraction(first.interaction.id, {});
  f.harness.behavior.submitInteraction(second.interaction.id, {});
  const results = await Promise.all([first.result, second.result]);
  assert.equal(results.filter((result) => typeof result === "object" && result.isError !== true).length, 1);
  assert.equal(results.filter((result) => typeof result === "object" && result.isError === true).length, 1);
  assert.equal(f.coordinator.get(first.attemptId)!.resume.state, "uncertain");
});

test("native waiting rechecks the environment, host and control root before resuming", async (t) => {
  for (const field of ["environmentId", "hostId", "rootId"] as const) await t.test(field, async (t) => {
    const options = { rootId: principalId };
    const f = fixture(t, options);
    const wait = await pendingWait(f);
    verifySynthetic(f.coordinator, wait.attemptId);
    if (field === "rootId") options.rootId = "replacement-root";
    else f.state[field] = `replacement-${field}`;
    f.harness.behavior.submitInteraction(wait.interaction.id, {});
    assert.deepEqual(text(await wait.result), { error: "binding_changed" });
    const saved = f.coordinator.get(wait.attemptId)!;
    assert.equal(saved.failure, "host_changed");
    assert.equal(saved.resume.state, "none");
    assert.equal(f.coordinator.pendingCleanup().length, 1);
  });
});

test("cancelling the SDK wait durably cancels resources with their cleanup command", async (t) => {
  const f = fixture(t);
  const wait = await pendingWait(f);
  let a = f.coordinator.get(wait.attemptId)!;
  a = f.coordinator.apply(a.attemptId, { type: "start", expected: attemptIdentity(a), expectedRevision: a.revision });
  f.harness.behavior.cancelInteraction(wait.interaction.id);
  const result = await wait.result;
  assert.equal(typeof result === "object" && result.isError, true);
  assert.equal(f.coordinator.get(wait.attemptId)!.phase, "cancelled");
  assert.equal(f.coordinator.pendingCleanup().length, 1);
});

test("thread stop aborts an active wait without allowing a later resume", async (t) => {
  const controller = new AbortController();
  const f = fixture(t);
  const result = f.call("remote_login_request", { mode: "synthetic", wait: true }, { signal: controller.signal });
  void result.catch(() => {});
  await setImmediate();
  const interaction = f.harness.inspection.pendingInteractions[0];
  assert.ok(interaction);
  const { attemptId } = interaction.payload as { attemptId: string };
  verifySynthetic(f.coordinator, attemptId);
  controller.abort();
  assert.deepEqual(text(await result), { error: "aborted" });
  assert.equal(f.coordinator.get(attemptId)!.phase, "cancelled");
  assert.equal(f.coordinator.get(attemptId)!.resume.state, "none");
  assert.equal(f.coordinator.pendingCleanup().length, 1);
});

test("reload fences a previously waiting native callback and cannot resume the recovered job", async (t) => {
  const f = fixture(t);
  const wait = await pendingWait(f);
  verifySynthetic(f.coordinator, wait.attemptId);
  const replacement = new LoginCoordinator(f.bb.storage, { now: () => 1000 });
  replacement.activate();
  f.harness.behavior.submitInteraction(wait.interaction.id, {});
  assert.deepEqual(text(await wait.result), { error: "unavailable" });
  const saved = replacement.get(wait.attemptId)!;
  assert.equal(saved.phase, "failed");
  assert.equal(saved.failure, "worker_lost");
  assert.equal(saved.resume.state, "none");
});

test("a deadline reached while waiting cannot claim a verified result", async (t) => {
  let now = 1000;
  const f = fixture(t, { now: () => now });
  const wait = await pendingWait(f);
  verifySynthetic(f.coordinator, wait.attemptId);
  now = 11_000;
  f.harness.behavior.submitInteraction(wait.interaction.id, {});
  const result = await wait.result;
  assert.equal(typeof result === "object" && result.isError, true);
  assert.equal(f.coordinator.get(wait.attemptId)!.phase, "expired");
  assert.equal(f.coordinator.get(wait.attemptId)!.resume.state, "none");
});

test("a competing cancellation during the final host observation cannot resume an older verified revision", async (t) => {
  let observe = () => {};
  const f = fixture(t, { observe: () => observe() });
  const wait = await pendingWait(f);
  verifySynthetic(f.coordinator, wait.attemptId);
  observe = () => {
    const a = f.coordinator.get(wait.attemptId)!;
    f.coordinator.apply(a.attemptId, { type: "cancel", expected: attemptIdentity(a), expectedRevision: a.revision });
  };
  f.harness.behavior.submitInteraction(wait.interaction.id, {});
  assert.deepEqual(text(await wait.result), { error: "unavailable" });
  assert.equal(f.coordinator.get(wait.attemptId)!.phase, "cancelled");
  assert.equal(f.coordinator.get(wait.attemptId)!.resume.state, "none");
  assert.equal(f.coordinator.pendingCleanup().length, 1);
});

test("a target move during the final root observation fails instead of resuming on the old host", async (t) => {
  let observe = () => {};
  const f = fixture(t, { observe: () => observe() });
  const wait = await pendingWait(f);
  verifySynthetic(f.coordinator, wait.attemptId);
  observe = () => { f.state.environmentId = "replacement-environment"; };
  f.harness.behavior.submitInteraction(wait.interaction.id, {});
  assert.deepEqual(text(await wait.result), { error: "binding_changed" });
  assert.equal(f.coordinator.get(wait.attemptId)!.failure, "host_changed");
  assert.equal(f.coordinator.get(wait.attemptId)!.resume.state, "none");
});

test("native cancellation cannot be undone by a later public wait submission", async (t) => {
  const f = fixture(t);
  const wait = await pendingWait(f);
  verifySynthetic(f.coordinator, wait.attemptId);
  const cancelled = await f.call("remote_login_cancel", { attemptId: wait.attemptId });
  assert.equal(text(cancelled).phase, "cancelled");
  f.harness.behavior.submitInteraction(wait.interaction.id, { verified: true });
  assert.deepEqual(text(await wait.result), { error: "unavailable" });
  assert.equal(f.coordinator.get(wait.attemptId)!.resume.state, "none");
});

test("a stop queued after the durable claim suppresses the outgoing native success result", async (t) => {
  const controller = new AbortController();
  const f = fixture(t);
  const result = f.call("remote_login_request", { mode: "synthetic", wait: true }, { signal: controller.signal });
  await setImmediate();
  const interaction = f.harness.inspection.pendingInteractions[0];
  assert.ok(interaction);
  const { attemptId } = interaction.payload as { attemptId: string };
  verifySynthetic(f.coordinator, attemptId);
  const prepareResume = f.coordinator.prepareResume.bind(f.coordinator);
  f.coordinator.prepareResume = (...args) => {
    const claimed = prepareResume(...args);
    queueMicrotask(() => controller.abort());
    return claimed;
  };
  f.harness.behavior.submitInteraction(interaction.id, {});
  assert.deepEqual(text(await result), { error: "aborted" });
  assert.equal(f.coordinator.get(attemptId)!.resume.state, "uncertain");
});


test("a reused native wait uses only the durable deadline's remaining time", async (t) => {
  let now = 1000;
  const f = fixture(t, { now: () => now });
  const scheduled = text(await f.call("remote_login_request", { mode: "synthetic" }));
  now = 10_000;
  const wait = await pendingWait(f);
  assert.equal(wait.attemptId, scheduled.attemptId);
  assert.equal(wait.interaction.timeoutMs, 1000);
  f.harness.behavior.cancelInteraction(wait.interaction.id);
  await wait.result;
});

test("thread stop settles final host and SDK observations even when the transport ignores abort", async (t) => {
  for (const transport of ["host", "sdk"] as const) await t.test(transport, async (t) => {
    const controller = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    let block = false;
    const f = fixture(t, { observe: async () => { if (block && transport === "host") { entered(); await held; } } });
    const wait = await pendingWait(f, controller.signal);
    verifySynthetic(f.coordinator, wait.attemptId);
    if (transport === "sdk") f.harness.inspection.sdk.stub("threads.get", async () => {
      entered(); await held;
      return makeThreadResponse({ ...context, id: context.threadId, environmentId: f.state.environmentId, deletedAt: null, archivedAt: null });
    });
    block = true;
    f.harness.behavior.submitInteraction(wait.interaction.id, { attemptId: wait.attemptId });
    await entering;
    controller.abort();
    const outcome = await Promise.race([wait.result, delay(100).then(() => "still_pending" as const)]);
    release();
    assert.notEqual(outcome, "still_pending", "ignored transport abort must not hold the original native call");
    assert.deepEqual(text(outcome), { error: "aborted" });
    assert.equal(f.coordinator.get(wait.attemptId)!.phase, "cancelled");
    assert.equal(f.coordinator.get(wait.attemptId)!.resume.state, "none");
    assert.equal(f.coordinator.pendingCleanup().length, 1);
  });
});

test("the durable deadline bounds a final ignored host call and expires instead of cancelling", async (t) => {
  let now = 1000;
  let block = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => { entered = resolve; });
  const f = fixture(t, { now: () => now, observe: async () => { if (block) { entered(); await held; } } });
  await f.call("remote_login_request", { mode: "synthetic" });
  now = 10_980;
  const wait = await pendingWait(f);
  verifySynthetic(f.coordinator, wait.attemptId);
  block = true;
  f.harness.behavior.submitInteraction(wait.interaction.id, { attemptId: wait.attemptId });
  await entering;
  now = 11_000;
  const outcome = await Promise.race([wait.result, delay(150).then(() => "still_pending" as const)]);
  release();
  assert.notEqual(outcome, "still_pending", "job deadline must bound all observations after public submission");
  assert.deepEqual(text(outcome), { error: "unavailable" });
  assert.equal(f.coordinator.get(wait.attemptId)!.phase, "expired");
  assert.equal(f.coordinator.get(wait.attemptId)!.resume.state, "none");
  assert.equal(f.coordinator.pendingCleanup().length, 1);
});

test("a previously claimed result refuses another native wait before opening an unclaimable interaction", async (t) => {
  const f = fixture(t);
  const wait = await pendingWait(f);
  verifySynthetic(f.coordinator, wait.attemptId);
  f.harness.behavior.submitInteraction(wait.interaction.id, { attemptId: wait.attemptId });
  await wait.result;
  const before = f.coordinator.get(wait.attemptId)!;
  assert.equal(before.resume.state, "uncertain");
  const retry = f.call("remote_login_request", { mode: "synthetic", wait: true });
  await setImmediate();
  assert.equal(f.harness.inspection.pendingInteractions.length, 0);
  assert.deepEqual(text(await retry), { error: "unavailable" });
  assert.deepEqual(f.coordinator.get(wait.attemptId)!.resume, before.resume);
  assert.equal(f.coordinator.get(wait.attemptId)!.phase, "verified");
});

test("Console cannot queue on a superficially supported host when exact process ownership inspection is unavailable", async t => {
  const f = fixture(t, { consoleRuntime: true, processInspection: false });
  const result = await f.call("remote_login_request", { mode: "oci_web" });
  assert.equal(text(result).phase, "unsupported");
  assert.equal(f.harness.inspection.pendingInteractions.length, 0);
  assert.equal(f.harness.inspection.experimental_hostRpcCalls.some(c => c.method === "startConsole"), false);
});

for (const mode of ["oci_cli", "oci_web"] as const) {
  test(`native ${mode} completion rechecks a control root replaced during the post-proof SDK observation`, async t => {
    const ref = "41ef3a91-c652-4c70-9d50-ebd2bd173ace";
    let proofReturned = false;
    const options = { compatible: true, consoleRuntime: true, now: Date.now, rootId: principalId,
      resumeProof: () => { proofReturned = true; return { ok: true, accountRef: ref, expiresAt: Date.now() + 5000 }; },
      consoleProof: () => { proofReturned = true; return { ok: true, browserRef: ref, expiresAt: Date.now() + 5000 }; } };
    const f = fixture(t, options), wait = await pendingWait(f, undefined, mode);
    verifySynthetic(f.coordinator, wait.attemptId, mode);
    f.harness.sdk.stub("environments.get", () => {
      if (proofReturned) options.rootId = "replacement-during-final-sdk";
      return environment(f.state.environmentId, f.state.hostId);
    });
    f.harness.behavior.submitInteraction(wait.interaction.id, {});
    const result = text(await wait.result);
    assert.equal(result.error, "binding_changed");
    assert.equal("accountRef" in result || "browserRef" in result, false);
    const saved = f.coordinator.get(wait.attemptId)!;
    assert.equal(saved.phase, "failed"); assert.equal(saved.resume.state, "none");
    assert.ok(f.coordinator.pendingCleanup().some(a => a.attemptId === wait.attemptId));
  });
}

for (const mode of ["oci_cli", "oci_web"] as const) {
  test(`native ${mode} completion checks live authority after its final SDK awaits even if public root ID is unchanged`, async t => {
    const ref = "41ef3a91-c652-4c70-9d50-ebd2bd173ace";
    let returned = false, revoked = false;
    const proof = () => { returned = true; return revoked ? { ok: false, reason: "authorization" }
      : { ok: true, ...(mode === "oci_cli" ? { accountRef: ref } : { browserRef: ref }), expiresAt: Date.now() + 5000 }; };
    const f = fixture(t, { compatible: true, consoleRuntime: true, now: Date.now, resumeProof: proof, consoleProof: proof });
    const wait = await pendingWait(f, undefined, mode); verifySynthetic(f.coordinator, wait.attemptId, mode);
    f.harness.sdk.stub("environments.get", () => { if (returned) revoked = true; return environment(f.state.environmentId, f.state.hostId); });
    f.harness.behavior.submitInteraction(wait.interaction.id, {});
    const result = text(await wait.result);
    assert.equal(result.error, "unavailable"); assert.equal("accountRef" in result || "browserRef" in result, false);
    assert.equal(f.coordinator.get(wait.attemptId)!.resume.state, "pending");
  });
}

for (const mode of ["oci_cli", "oci_web"] as const) {
  test(`native ${mode} reads discard results revoked during their final SDK observations`, async t => {
    const ref = "41ef3a91-c652-4c70-9d50-ebd2bd173ace";
    let reading = false, observed = false, revoked = false;
    const proof = () => { if (reading) observed = true; return revoked ? { ok: false, reason: "authorization" }
      : { ok: true, ...(mode === "oci_cli" ? { accountRef: ref } : { browserRef: ref }), expiresAt: Date.now() + 5000 }; };
    const read = () => { reading = true; return { ok: true, expiresAt: Date.now() + 4000, result: mode === "oci_cli"
      ? { operation: "list_compartments", rootCompartmentRef: "51ef3a91-c652-4c70-9d50-ebd2bd173ace", rows: [], truncated: false }
      : { operation: "read_page", title: "private task result", headings: [] } }; };
    const f = fixture(t, { compatible: true, consoleRuntime: true, now: Date.now, resumeProof: proof, consoleProof: proof, readTask: read, consoleRead: read });
    const wait = await pendingWait(f, undefined, mode); verifySynthetic(f.coordinator, wait.attemptId, mode);
    f.harness.behavior.submitInteraction(wait.interaction.id, {}); await wait.result;
    f.harness.sdk.stub("environments.get", () => { if (observed) revoked = true; return environment(f.state.environmentId, f.state.hostId); });
    const result = text(await f.call(mode === "oci_cli" ? "remote_login_oci_read" : "remote_login_console_read", {
      attemptId: wait.attemptId, ...(mode === "oci_cli" ? { accountRef: ref, request: { operation: "list_compartments" } }
        : { browserRef: ref, request: { operation: "read_page" } }),
    }));
    assert.equal(result.error, "unavailable"); assert.equal("operation" in result, false);
  });
}

for (const mode of ["oci_cli", "oci_web"] as const) {
  test(`native ${mode} read cancellation during the last host proof defeats its late valid reply`, async t => {
    const ref = "41ef3a91-c652-4c70-9d50-ebd2bd173ace";
    let reading = false, reads = 0, attemptId = "";
    let f!: ReturnType<typeof fixture>;
    const proof = async () => {
      if (reading && ++reads === 2) await f.call("remote_login_cancel", { attemptId });
      return { ok: true, ...(mode === "oci_cli" ? { accountRef: ref } : { browserRef: ref }), expiresAt: Date.now() + 5000 };
    };
    const read = () => { reading = true; return { ok: true, expiresAt: Date.now() + 4000, result: mode === "oci_cli"
      ? { operation: "list_compartments", rootCompartmentRef: "51ef3a91-c652-4c70-9d50-ebd2bd173ace", rows: [], truncated: false }
      : { operation: "read_page", title: "private task result", headings: [] } }; };
    f = fixture(t, { compatible: true, consoleRuntime: true, now: Date.now, resumeProof: proof, consoleProof: proof, readTask: read, consoleRead: read });
    const wait = await pendingWait(f, undefined, mode); attemptId = wait.attemptId; verifySynthetic(f.coordinator, attemptId, mode);
    f.harness.behavior.submitInteraction(wait.interaction.id, {}); await wait.result;
    const result = text(await f.call(mode === "oci_cli" ? "remote_login_oci_read" : "remote_login_console_read", {
      attemptId, ...(mode === "oci_cli" ? { accountRef: ref, request: { operation: "list_compartments" } }
        : { browserRef: ref, request: { operation: "read_page" } }),
    }));
    assert.equal(result.error, "unavailable"); assert.equal("operation" in result, false);
    assert.equal(f.coordinator.get(attemptId)!.phase, "cancelled");
  });
}
