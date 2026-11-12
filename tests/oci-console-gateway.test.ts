import { inputRequest } from "./input-operation-fixture.ts";
import { assessLoginCapabilities } from "../provider-registry.ts";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { loginAttemptSchema } from "../login-protocol.ts";
import { consoleBuild } from "../oci-console-protocol.ts";
import type { OciHostStatus } from "../oci-host-wire.ts";
import { fixtureFrameSchema } from "../fixture-wire.ts";

const context = { projectId: "project-console-gateway", threadId: "thread-console-gateway" };
const hostId = "host-console-gateway", key = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
const receipt = "11111111-1111-4111-8111-111111111111", browserRef = "22222222-2222-4222-8222-222222222222";
// A gateway transport fixture, not evidence of actual browser ownership.
const frameRef = "55555555-5555-4555-8555-555555555555";
const expected = { mode: "oci_web", userOcid: "ocid1.user.oc1..independentuser", tenancyOcid: "ocid1.tenancy.oc1..independenttenancy",
  domainOcid: "ocid1.domain.oc1..independentdomain", domainOrigin: "https://independent.identity.oraclecloud.com", region: "ap-sydney-1", realm: "oc1" } as const;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKD8AAAAASUVORK5CYII=";
const body = (value: unknown, capability?: string | null) => ({ headers: { "content-type": "application/json", ...(capability ? { authorization: `Bearer ${capability}` } : {}) }, body: JSON.stringify(inputRequest(value)) });
function value(result: PluginAgentToolResult): Record<string, unknown> {
  assert.equal(typeof result, "object"); if (typeof result === "string") throw new Error("Structured native result required");
  assert.equal(result.content[0]?.type, "text"); const part = result.content[0]!; if (part.type !== "text") throw new Error("Bounded native text required");
  assert.ok(Buffer.byteLength(part.text) <= 65536); return JSON.parse(part.text) as Record<string, unknown>;
}
async function system(t: TestContext, root: string | null = "root-console-gateway") {
  const environment: Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>> = {
    baseBranch: null, branchName: null, createdAt: 1, defaultBranch: null, environmentProviderId: null, environmentProviderInstanceKey: null,
    environmentProviderSelection: null, hostId, hostLifecycle: "active", id: "environment-console-gateway", isGitRepo: false, isWorktree: false,
    lifecycle: { phase: "active", retireAt: null, teardown: null }, managed: false, mergeBaseBranch: null, name: "private Console fixture",
    path: "/private/console-gateway-environment", projectId: context.projectId, status: "ready", updatedAt: 1, workspaceProvisionType: "personal",
  };
  const state = { root, configured: false, phoneControlAccepted: false, authorized: true, phase: "unconfigured" as OciHostStatus["phase"], verified: false,
    capability: "A".repeat(43), proofExpiresAt: null as number | null, retained: false, before: async (_method: string, _input: unknown) => {} };
  const calls: Array<{ method: string; input: unknown; hostId: string }> = [];
  const status = (): OciHostStatus => ({ configured: state.configured, phoneControlAccepted: state.phoneControlAccepted, phase: state.phase, failure: null });
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login", sdk: {
    threads: { get: () => makeThreadResponse({ ...context, id: context.threadId, environmentId: environment.id, deletedAt: null, archivedAt: null }) },
    environments: { get: () => environment },
  }, experimental_callHostRpc: async ({ hostId: target, method, input }) => {
    assert.equal(target, hostId); calls.push({ method, input, hostId: target }); await state.before(method, input);
    if (method === "inspectLoginCapabilities") return assessLoginCapabilities({ platform: "darwin", architecture: "arm64", chromeVersion: "157.0.8103.51", processInspection: true, cliSourceMatched: true });
    if (method === "controlInfo") return { provisioned: state.root !== null, rootId: state.root, provisioningDirectory: "/private/console-gateway-root" };
    if (method === "authenticateControl") { assert.equal((input as { key: string }).key, key); return { ok: true, grant: { capability: state.capability, expiresAt: Date.now() + 300_000 } }; }
    if (method === "authorizeControl") return state.authorized && (input as { capability: string }).capability === state.capability ? { ok: true } : { ok: false, reason: "authorization" };
    if (method === "consoleStatus") return { ok: true, status: status() };
    if (method === "configureConsole") {
      if (!state.phoneControlAccepted) return { ok: false, reason: "authorization" };
      assert.deepEqual((input as { expected: unknown }).expected, expected); state.configured = true; state.phase = "ready"; return { ok: true };
    }
    if (method === "startConsole") { assert.equal(state.configured && state.phoneControlAccepted, true); state.phase = "starting"; return { ok: true, viewport: { width: 800, height: 600 } }; }
    if (method === "frameConsole") return { ok: true, frame: { png, width: 800, height: 600, frameRef } };
    if (method === "inputConsole") { assert.equal((input as { frameRef: string }).frameRef, frameRef); return { ok: true }; }
    if (method === "handbackConsole") {
      state.phase = state.verified ? "verified" : "verifying"; state.retained = state.verified;
      return { ok: true, result: { ...status(), verified: state.verified, ...(state.verified ? { receipt, browserRef } : {}) } };
    }
    if (method === "consoleResumeProof") { assert.equal((input as { receipt: string }).receipt, receipt); return state.authorized ? { ok: true, browserRef, expiresAt: state.proofExpiresAt ?? Date.now() + 60_000 } : { ok: false, reason: "authorization" }; }
    if (method === "readConsoleTask") {
      const selection = input as { receipt: string; browserRef: string; request: { operation: string } };
      assert.equal(selection.receipt, receipt); assert.equal(selection.browserRef, browserRef);
      return { ok: true, result: selection.request.operation === "read_page" ? { operation: "read_page", title: "Current Console page", headings: ["Overview"] }
        : { operation: "read_identity", matched: true, userMatched: true, tenancyMatched: true, domainMatched: true, sourceBuild: consoleBuild }, expiresAt: Date.now() + 50_000 };
    }
    if (method === "renewControl") { state.capability = "C".repeat(43); return { ok: true, grant: { capability: state.capability, expiresAt: Date.now() + 300_000 } }; }
    if (method === "closeConsole") { state.phase = "cancelled"; state.retained = false; return { ok: true }; }
    if (method === "revokeControl") { state.authorized = false; state.phase = "cancelled"; return { ok: true }; }
    if (method === "stopAttempt") { state.retained = false; return { ok: true }; }
    assert.fail(`unexpected host method ${method}`);
  } });
  const waiting: Array<{ controller: AbortController; result: Promise<PluginAgentToolResult> }> = [];
  t.after(async () => { for (const wait of waiting) wait.controller.abort(); await Promise.allSettled(waiting.map(wait => wait.result)); await harness.lifecycle.dispose(); });
  await plugin(bb);
  const requested = value(await harness.behavior.callAgentTool("remote_login_request", { mode: "oci_web" }, context));
  assert.equal(requested.phase, root === null ? "awaiting_pairing" : "awaiting_control", "Console must enter the gated host workflow");
  const attemptId = requested.attemptId as string;
  const post = (action: string, extra: Record<string, unknown> = {}, capability: string | null = state.capability) => harness.behavior.fetchHttp("POST", `/login/${action}`, body({ attemptId, ...extra }, capability));
  const attempt = async () => { const response = await post("status", {}, null); assert.equal(response.status, 200); return loginAttemptSchema.parse(await response.json()); };
  const authenticate = async () => { const response = await post("session", { key }, null); assert.equal(response.status, 200); return response; };
  const configure = async () => { state.phoneControlAccepted = true; const response = await post("console-target", { expected }); assert.equal(response.status, 200); };
  const start = async () => { const response = await post("start"); assert.equal(response.status, 202); assert.deepEqual(await response.json(), { pending: true }); };
  const ready = async () => { state.phase = "user_control"; assert.equal((await post("console-status")).status, 200); assert.equal((await attempt()).phase, "user_control"); };
  const wait = async () => {
    const controller = new AbortController(); let settled = false;
    const result = harness.behavior.callAgentTool("remote_login_request", { mode: "oci_web", wait: true }, { ...context, signal: controller.signal }).finally(() => { settled = true; });
    void result.catch(() => {}); waiting.push({ controller, result });
    for (let retry = 0; retry < 100 && !harness.inspection.pendingInteractions.length && !settled; retry++) await setImmediate();
    const interaction = harness.inspection.pendingInteractions.at(-1); assert.ok(interaction); assert.deepEqual(interaction.payload, { attemptId });
    return { result, interaction, settled: () => settled };
  };
  return { bb, harness, environment, state, calls, requested, attemptId, post, attempt, authenticate, configure, start, ready, wait };
}

// Registered SDK/host fixtures prove the boundary contract, never actual phone/Oracle authentication.
test("a configured host choice survives private reauthentication before start and cannot retarget to remote", async t => {
  const s = await system(t); await s.authenticate(); s.state.phoneControlAccepted = true;
  assert.equal((await s.post("console-target", { expected, controlMode: "host" })).status, 200);
  assert.equal((await s.attempt()).controlMode, "host");
  const reopened = await s.authenticate();
  assert.equal((await reopened.json() as any).attempt.controlMode, "host");
  assert.equal((await s.post("console-target", { expected, controlMode: "remote" })).status, 409);
  assert.equal((await s.post("start", { controlMode: "remote" })).status, 409);
  assert.equal((await s.attempt()).phase, "awaiting_control");
  assert.equal((await s.post("start")).status, 202);
  assert.equal((s.calls.find(call => call.method === "startConsole")!.input as any).controlMode, "host");
});

test("Console queues bounded metadata while owner, paired-control and private expected-domain gates block startup", async t => {
  const s = await system(t, null);
  assert.deepEqual(Object.keys(s.requested).sort(), ["attemptId", "expiresAt", "hostId", "mode", "phase", "resume"]);
  assert.equal((await s.post("session", { key }, null)).status, 403); assert.equal(s.calls.some(call => call.method === "authenticateControl"), false);
  s.state.root = "root-console-gateway"; await s.authenticate();
  assert.equal((await s.post("console-target", { expected }, null)).status, 401);
  assert.equal((await s.post("console-target", { expected })).status, 403);
  assert.equal((await s.post("start")).status, 403);
  for (const extra of [{ expected, hostId: "other-host" }, { expected: { ...expected, domainOrigin: "https://unreviewed.invalid" } }, { expected: { ...expected, verified: true } }]) assert.equal((await s.post("console-target", extra)).status, 400);
  await s.configure(); s.state.phoneControlAccepted = false; assert.equal((await s.post("start")).status, 403);
  assert.equal(s.calls.some(call => call.method === "startConsole"), false);
  assert.equal(s.calls.some(call => call.method === "inspectOciCompatibility"), false, "Console cannot borrow CLI compatibility evidence");
});

test("Console startup and retained handback require private polling, and verifying-only key rejoin never exposes browser input", async t => {
  const s = await system(t); await s.authenticate(); await s.configure(); await s.start();
  assert.equal((await s.post("frame")).status, 409); assert.equal((await s.post("input", { event: { type: "key", key: "Enter" }, frameRef })).status, 409);
  assert.equal(s.calls.some(call => call.method === "inputConsole"), false);
  assert.equal((await s.post("session", { key }, null)).status, 409);
  await s.ready();
  const frame = await s.post("frame"); assert.equal(frame.status, 200);
  assert.deepEqual(fixtureFrameSchema.parse(await frame.json()), { png, width: 800, height: 600, frameRef });
  assert.equal((await s.post("session", { key }, null)).status, 409);
  const pending = await s.post("handback"); assert.equal(pending.status, 202); assert.deepEqual(await pending.json(), { pending: true });
  assert.equal((await s.attempt()).phase, "verifying");
  s.state.capability = "B".repeat(43); await s.authenticate();
  for (const action of ["start", "frame", "input"]) assert.equal((await s.post(action, action === "input" ? { event: { type: "key", key: "Enter" }, frameRef } : {})).status, 409);
  assert.equal(s.calls.some(call => call.method === "inputConsole"), false);
  assert.equal((await s.post("console-status")).status, 200);
  s.state.verified = true; assert.equal((await s.post("handback")).status, 200);
  assert.equal(s.state.retained, true); assert.equal(s.calls.some(call => call.method === "closeConsole"), false);
  assert.equal((await s.attempt()).verification?.kind, "oci_web");
});

test("original Console native completion transfers only an opaque browser reference and enables two bounded retained-context reads", async t => {
  const s = await system(t), waiting = await s.wait();
  await s.authenticate(); await s.configure(); await s.start(); await s.ready();
  const frameResponse = await s.post("frame"); assert.equal(frameResponse.status, 200);
  const frame = fixtureFrameSchema.parse(await frameResponse.json());
  assert.deepEqual(frame, { png, width: 800, height: 600, frameRef });
  const privateInput = "private Console input fixture";
  assert.equal((await s.post("input", { event: { type: "text", text: privateInput }, frameRef: frame.frameRef })).status, 200);
  s.state.verified = true; const handback = await s.post("handback"); assert.equal(handback.status, 200); assert.deepEqual(await handback.json(), { verified: true });
  assert.equal(waiting.settled(), false);
  const before = await s.harness.behavior.callAgentTool("remote_login_console_read", { attemptId: s.attemptId, browserRef, request: { operation: "read_identity" } }, context);
  assert.deepEqual(value(before), { error: "unavailable" }); assert.equal(s.calls.some(call => call.method === "readConsoleTask"), false);
  s.harness.behavior.submitInteraction(waiting.interaction.id, { attemptId: s.attemptId });
  const native = value(await waiting.result); assert.equal(native.browserRef, browserRef); assert.equal(native.resume, "uncertain");
  for (const operation of ["read_identity", "read_page"] as const) {
    const result = value(await s.harness.behavior.callAgentTool("remote_login_console_read", { attemptId: s.attemptId, browserRef, request: { operation } }, context));
    assert.equal(result.operation, operation); assert.equal(Object.hasOwn(result, "browserRef"), false);
  }
  assert.equal(s.calls.some(call => call.method === "closeConsole"), false);
  assert.equal(s.harness.inspection.sdk.calls.some(call => call.path === "threads.send"), false);
  const durable = s.bb.storage.database().prepare("SELECT record FROM remote_login_attempts_v1").all();
  const visible = JSON.stringify([s.requested, await s.attempt(), durable, await s.bb.storage.kv.list(), s.harness.inspection.pendingInteractions, s.harness.logEntries, s.harness.inspection.realtimeSignals]);
  for (const secret of [key, s.state.capability, browserRef, png, frame.frameRef, privateInput, expected.userOcid, expected.tenancyOcid, expected.domainOcid, expected.domainOrigin, "/private/console-gateway"]) assert.equal(visible.includes(secret), false);
  for (const secret of [key, s.state.capability, png, frame.frameRef, expected.userOcid, expected.tenancyOcid, expected.domainOcid, expected.domainOrigin]) assert.equal(JSON.stringify(native).includes(secret), false);
});

test("public Console success flags and arbitrary browser tasks cannot create or broaden a retained reference", async t => {
  const s = await system(t), waiting = await s.wait();
  assert.equal((await s.post("start", { verified: true, browserRef, expected })).status, 400);
  s.harness.behavior.submitInteraction(waiting.interaction.id, { attemptId: s.attemptId, verified: true, browserRef });
  assert.deepEqual(value(await waiting.result), { error: "unavailable" });
  const saved = await s.attempt(); assert.equal(saved.verification, null); assert.equal(saved.resume.state, "none");
  const calls = s.calls.length;
  for (const request of [{ operation: "evaluate", source: "document.cookie" }, { operation: "read_page", url: "https://cloud.oracle.com/" }, { operation: "input", text: "not allowed" }]) {
    await assert.rejects(s.harness.behavior.callAgentTool("remote_login_console_read", { attemptId: s.attemptId, browserRef, request }, context));
  }
  assert.equal(s.calls.length, calls);
});

test("final Console proof revocation and root changes discard otherwise matching handback", async t => {
  for (const changed of ["expired", "root", "authorization"] as const) await t.test(changed, async t => {
    const s = await system(t); await s.authenticate(); await s.configure(); await s.start(); await s.ready(); s.state.verified = true;
    s.state.before = async method => {
      if (method !== "consoleResumeProof") return;
      if (changed === "expired") s.state.proofExpiresAt = Date.now() - 1;
      if (changed === "root") s.state.root = "replacement-root";
      if (changed === "authorization") s.state.authorized = false;
    };
    assert.notEqual((await s.post("handback")).status, 200); assert.notEqual((await s.attempt()).phase, "verified");
  });
});

test("Console cancellation before startup revokes proof without fabricating an owned browser close", async t => {
  const s = await system(t); await s.authenticate();
  assert.equal((await s.post("close")).status, 200); assert.equal((await s.attempt()).phase, "cancelled");
  assert.equal(s.calls.filter(call => call.method === "revokeControl").length, 1);
  assert.equal(s.calls.some(call => call.method === "closeConsole" || call.method === "startConsole"), false);
});

test("explicit Console Stop cancels an acknowledged retained browser before the original public interaction completes", async t => {
  const s = await system(t), waiting = await s.wait();
  await s.authenticate(); await s.configure(); await s.start(); await s.ready(); s.state.verified = true;
  assert.equal((await s.post("handback")).status, 200); assert.equal(s.state.retained, true);
  assert.equal((await s.post("close")).status, 200); assert.equal(s.state.retained, false);
  assert.equal((await s.attempt()).phase, "cancelled");
  s.harness.behavior.submitInteraction(waiting.interaction.id, { attemptId: s.attemptId });
  assert.equal(value(await waiting.result).error, "unavailable");
});
