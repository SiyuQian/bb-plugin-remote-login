import { inputRequest } from "./input-operation-fixture.ts";
import { assessLoginCapabilities } from "../provider-registry.ts";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { loginAttemptSchema } from "../login-protocol.ts";
import type { OciHostStatus } from "../oci-host-wire.ts";
import plugin from "../server.ts";
import { fixtureFrameSchema } from "../fixture-wire.ts";

const context = { projectId: "project-oci-gateway", threadId: "thread-oci-gateway" };
const hostId = "host-oci-gateway";
const key = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
const capability = "A".repeat(43);
const receipt = "11111111-1111-4111-8111-111111111111";
const accountRef = "22222222-2222-4222-8222-222222222222";
// A gateway transport fixture, not evidence of actual browser ownership.
const frameRef = "66666666-6666-4666-8666-666666666666";
const expected = { mode: "oci_cli", tenancyOcid: "ocid1.tenancy.oc1..privateexpectedtenancy", userOcid: "ocid1.user.oc1..privateexpecteduser", region: "ap-sydney-1", realm: "oc1" } as const;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKD8AAAAASUVORK5CYII=";
const body = (value: unknown, token: string | null = capability) => ({
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(inputRequest(value)),
});
function nativeValue(value: PluginAgentToolResult): Record<string, unknown> {
  assert.equal(typeof value, "object");
  if (typeof value === "string") throw new Error("Expected structured native result");
  assert.equal(value.content.length, 1);
  const part = value.content[0]!;
  assert.equal(part.type, "text");
  if (part.type !== "text") throw new Error("Expected bounded native text");
  assert.ok(part.text.length < 2048);
  return JSON.parse(part.text) as Record<string, unknown>;
}

async function system(t: TestContext, root: string | null = "root-oci-gateway") {
  const environment: Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>> = {
    baseBranch: null, branchName: null, createdAt: 1, defaultBranch: null,
    environmentProviderId: null, environmentProviderInstanceKey: null, environmentProviderSelection: null,
    hostId, hostLifecycle: "active", id: "environment-oci-gateway", isGitRepo: false, isWorktree: false,
    lifecycle: { phase: "active", retireAt: null, teardown: null }, managed: false, mergeBaseBranch: null,
    name: "private OCI fixture", path: "/private/oci-gateway-environment", projectId: context.projectId,
    status: "ready", updatedAt: 1, workspaceProvisionType: "personal",
  };
  const state = {
    root, phoneControlAccepted: false, configured: false, authorized: true, verified: false,
    phase: "unconfigured" as OciHostStatus["phase"], proofExpiresAt: null as number | null,
    before: async (_method: string, _input: unknown) => {},
  };
  const calls: Array<{ method: string; input: unknown; hostId: string }> = [];
  const status = (): OciHostStatus => ({ configured: state.configured, phoneControlAccepted: state.phoneControlAccepted, phase: state.phase, failure: null });
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login", sdk: {
    threads: { get: () => makeThreadResponse({ ...context, id: context.threadId, environmentId: environment.id, deletedAt: null, archivedAt: null }) },
    environments: { get: () => environment },
  }, experimental_callHostRpc: async ({ hostId: target, method, input }) => {
    assert.equal(target, hostId, "stored jobs must never select a replacement host");
    calls.push({ method, input, hostId: target });
    await state.before(method, input);
    if (method === "inspectLoginCapabilities") return assessLoginCapabilities({ platform: "darwin", architecture: "arm64", chromeVersion: "157.0.8103.51", processInspection: true, cliSourceMatched: true });
    if (method === "controlInfo") return { provisioned: state.root !== null, rootId: state.root, provisioningDirectory: "/private/oci-gateway-root" };
    if (method === "authenticateControl") {
      assert.equal((input as { key: string }).key, key);
      return { ok: true, grant: { capability, expiresAt: Date.now() + 300_000 } };
    }
    if (method === "authorizeControl") return state.authorized ? { ok: true } : { ok: false, reason: "authorization" };
    if (method === "ociStatus") return { ok: true, status: status() };
    if (method === "configureOci") {
      if (!state.phoneControlAccepted) return { ok: false, reason: "authorization" };
      assert.deepEqual((input as { expected: unknown }).expected, expected);
      state.configured = true; state.phase = "ready";
      return { ok: true };
    }
    if (method === "startOci") {
      assert.equal(state.configured && state.phoneControlAccepted, true);
      state.phase = "starting";
      return { ok: true, viewport: { width: 800, height: 600 } };
    }
    if (method === "frameOci") return state.phase === "user_control" ? { ok: true, frame: { png, width: 800, height: 600, frameRef } } : { ok: false, reason: "busy" };
    if (method === "inputOci") { assert.equal((input as { frameRef: string }).frameRef, frameRef); return state.phase === "user_control" ? { ok: true } : { ok: false, reason: "busy" }; }
    if (method === "handbackOci") {
      state.phase = state.verified ? "verified" : "verifying";
      return { ok: true, result: { ...status(), verified: state.verified, ...(state.verified ? { receipt, accountRef } : {}) } };
    }
    if (method === "ociResumeProof") {
      assert.equal((input as { receipt: string }).receipt, receipt);
      return { ok: true, accountRef, expiresAt: state.proofExpiresAt ?? Date.now() + 60_000 };
    }
    if (method === "readOciTask") {
      assert.equal((input as { accountRef: string }).accountRef, accountRef);
      assert.equal((input as { receipt: string }).receipt, receipt);
      return { ok: true, result: { operation: "list_compartments", rootCompartmentRef: "33333333-3333-4333-8333-333333333333",
        rows: [{ compartmentRef: "44444444-4444-4444-8444-444444444444", name: "read task compartment" }], truncated: false }, expiresAt: Date.now() + 50_000 };
    }
    if (method === "closeOci") { state.phase = "cancelled"; return { ok: true }; }
    if (method === "revokeControl") { state.authorized = false; state.phase = "cancelled"; return { ok: true }; }
    if (method === "stopAttempt") return { ok: true };
    assert.fail(`unexpected host method ${method}`);
  } });
  const waiting: Array<{ controller: AbortController; result: Promise<PluginAgentToolResult> }> = [];
  t.after(async () => {
    for (const wait of waiting) wait.controller.abort();
    await Promise.allSettled(waiting.map((wait) => wait.result));
    await harness.lifecycle.dispose();
  });
  await plugin(bb);
  const requestedResult = await harness.behavior.callAgentTool("remote_login_request", { mode: "oci_cli" }, context);
  assert.equal(typeof requestedResult === "object" && requestedResult.isError, undefined);
  const requested = nativeValue(requestedResult);
  const attemptId = requested.attemptId as string;
  const post = (action: string, extra: Record<string, unknown> = {}, token: string | null = capability) =>
    harness.behavior.fetchHttp("POST", `/login/${action}`, body({ attemptId, ...extra }, token));
  const attempt = async () => {
    const response = await post("status", {}, null);
    assert.equal(response.status, 200);
    return loginAttemptSchema.parse(await response.json());
  };
  const authenticate = async () => {
    const response = await post("session", { key }, null);
    assert.equal(response.status, 200);
    return response;
  };
  const configure = async () => {
    state.phoneControlAccepted = true;
    const response = await post("oci-target", { expected });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { configured: true });
  };
  const start = async () => {
    const response = await post("start");
    assert.equal(response.status, 202); assert.deepEqual(await response.json(), { pending: true });
  };
  const ready = async () => {
    state.phase = "user_control";
    const response = await post("oci-status");
    assert.equal(response.status, 200);
    assert.equal((await attempt()).phase, "user_control");
  };
  const wait = async () => {
    const controller = new AbortController();
    let settled = false;
    const result = harness.behavior.callAgentTool("remote_login_request", { mode: "oci_cli", wait: true }, { ...context, signal: controller.signal }).finally(() => { settled = true; });
    void result.catch(() => {});
    waiting.push({ controller, result });
    for (let retry = 0; retry < 100 && harness.inspection.pendingInteractions.length === 0 && !settled; retry++) await setImmediate();
    const interaction = harness.inspection.pendingInteractions.at(-1);
    assert.ok(interaction, "matched OCI CLI native entry must wait for private verification");
    assert.deepEqual(interaction.payload, { attemptId });
    return { result, interaction, settled: () => settled };
  };
  return { bb, harness, environment, state, calls, requested, attemptId, post, attempt, authenticate, configure, start, ready, wait };
}

// These tests exercise the registered server/coordinator boundary. Host evidence is a fixture, not a live OCI login.
test("OCI cancellation before target selection revokes control without claiming a browser existed", async (t) => {
  const s = await system(t); await s.authenticate();
  const closed = await s.post("close");
  assert.equal(closed.status, 200); assert.deepEqual(await closed.json(), { closed: true });
  assert.equal((await s.attempt()).phase, "cancelled");
  assert.equal(s.calls.filter((call) => call.method === "revokeControl").length, 1);
  assert.equal(s.calls.some((call) => ["closeOci", "startOci"].includes(call.method)), false);
  assert.equal(s.state.authorized, false);
  assert.deepEqual(s.bb.storage.database().prepare("SELECT * FROM remote_login_cleanup_v1").all(), []);
});

test("matched OCI requests queue bounded metadata while private root, target and phone gates prevent startup", async (t) => {
  const s = await system(t, null);
  assert.equal(s.requested.mode, "oci_cli"); assert.equal(s.requested.phase, "awaiting_pairing");
  assert.deepEqual(Object.keys(s.requested).sort(), ["attemptId", "expiresAt", "hostId", "mode", "phase", "resume"]);
  assert.equal((await s.post("session", { key }, null)).status, 403);
  assert.equal(s.calls.some((call) => call.method === "authenticateControl"), false);
  s.state.root = "root-oci-gateway";
  await s.authenticate();
  assert.equal((await s.post("start")).status, 403);
  assert.equal((await s.post("oci-target", { expected }, null)).status, 401);
  assert.equal((await s.post("oci-target", { expected })).status, 403);
  assert.equal(s.calls.some((call) => call.method === "startOci"), false);
  for (const extra of [{ expected, hostId: "other-host" }, { expected: { ...expected, realm: "oc2" } }, { expected: { ...expected, region: "bad" } }]) {
    assert.equal((await s.post("oci-target", extra)).status, 400);
  }
  await s.configure();
  s.state.phoneControlAccepted = false;
  assert.equal((await s.post("start")).status, 403);
  assert.equal(s.calls.some((call) => call.method === "startOci"), false);
  s.state.phoneControlAccepted = true;
  await s.start();
  assert.equal((await s.attempt()).phase, "starting");
  assert.equal(s.calls.filter((call) => call.method === "inspectLoginCapabilities").length, 1);
  assert.ok(s.calls.every((call) => call.hostId === hostId));
  const hostCalls = s.calls.length;
  await assert.rejects(s.harness.behavior.callAgentTool("remote_login_request", { mode: "oci_cli", expected }, context));
  assert.equal(s.calls.length, hostCalls, "public expected identity must be rejected before host dispatch");
});

test("registered OCI startup and handback remain pending until private evidence resumes the original native call", async (t) => {
  const s = await system(t);
  const wait = await s.wait();
  await s.authenticate(); await s.configure(); await s.start();
  assert.equal((await s.post("start")).status, 409);
  for (const [action, extra] of [["frame", {}], ["input", { event: { type: "key", key: "Enter" }, frameRef }]] as const) assert.equal((await s.post(action, extra)).status, 409);
  assert.equal(s.calls.some(call => call.method === "inputOci"), false);
  assert.equal((await s.post("oci-status")).status, 200);
  assert.equal((await s.attempt()).phase, "starting");
  await s.ready();
  const frame = await s.post("frame"); assert.equal(frame.status, 200); assert.equal(frame.headers.get("cache-control"), "no-store");
  const displayed = fixtureFrameSchema.parse(await frame.json());
  assert.deepEqual(displayed, { png, width: 800, height: 600, frameRef });
  const privateText = "private OCI browser input fixture";
  assert.equal((await s.post("input", { event: { type: "text", text: privateText }, frameRef: displayed.frameRef })).status, 200);
  const pending = await s.post("handback"); assert.equal(pending.status, 202); assert.deepEqual(await pending.json(), { pending: true });
  assert.equal((await s.attempt()).phase, "verifying");
  assert.equal((await s.post("frame")).status, 409);
  assert.equal((await s.post("input", { event: { type: "key", key: "Enter" }, frameRef })).status, 409);
  assert.equal(s.calls.filter(call => call.method === "inputOci").length, 1);
  assert.equal(wait.settled(), false);
  s.state.verified = true;
  const verified = await s.post("handback"); assert.equal(verified.status, 200); assert.deepEqual(await verified.json(), { verified: true });
  const saved = await s.attempt(); assert.equal(saved.phase, "verified"); assert.equal(saved.verification?.kind, "oci_cli"); assert.equal(saved.resume.state, "pending");
  assert.equal(wait.settled(), false, "private success cannot fabricate public native delivery");
  const earlyRead = await s.harness.behavior.callAgentTool("remote_login_oci_read", { attemptId: s.attemptId, accountRef,
    request: { operation: "list_compartments" } }, context);
  assert.deepEqual(nativeValue(earlyRead), { error: "unavailable" });
  assert.equal(s.calls.some((call) => call.method === "readOciTask"), false, "an unconsumed pending result cannot delegate account use");
  s.harness.behavior.submitInteraction(wait.interaction.id, { attemptId: s.attemptId });
  const completed = await wait.result;
  assert.equal(typeof completed === "object" && completed.isError, undefined);
  const metadata = nativeValue(completed);
  assert.equal(metadata.mode, "oci_cli"); assert.equal(metadata.phase, "verified"); assert.equal(metadata.resume, "uncertain"); assert.equal(metadata.accountRef, accountRef);
  assert.equal((await s.attempt()).resume.state, "uncertain");
  assert.equal(s.calls.filter((call) => call.method === "startOci").length, 1);
  assert.equal(s.calls.filter((call) => call.method === "ociResumeProof").length, 3, "gateway, native preflight and final native claim each require current private proof");
  const read = await s.harness.behavior.callAgentTool("remote_login_oci_read", { attemptId: s.attemptId, accountRef,
    request: { operation: "list_compartments" } }, context);
  assert.equal(typeof read === "object" && read.isError, undefined);
  assert.equal(nativeValue(read).operation, "list_compartments");
  assert.deepEqual(nativeValue(read).rows, [{ compartmentRef: "44444444-4444-4444-8444-444444444444", name: "read task compartment" }]);
  assert.equal(s.harness.inspection.sdk.calls.some((call) => call.path === "threads.send"), false);
  const records = s.bb.storage.database().prepare("SELECT record FROM remote_login_attempts_v1").all();
  const visible = JSON.stringify([s.requested, metadata, await s.attempt(), records, await s.bb.storage.kv.list(), s.harness.inspection.pendingInteractions, s.harness.logEntries, s.harness.inspection.realtimeSignals]);
  for (const privateValue of [key, capability, png, displayed.frameRef, privateText, expected.tenancyOcid, expected.userOcid, expected.region, "tenancyOcid", "userOcid", '"realm"', "/private/oci-gateway"]) assert.equal(visible.includes(privateValue), false, "private control material must not enter public or durable job state");
});

test("public OCI completion flags cannot replace private target or verification evidence", async (t) => {
  const s = await system(t);
  const wait = await s.wait();
  assert.equal((await s.post("start", { verified: true, expected })).status, 400);
  s.harness.behavior.submitInteraction(wait.interaction.id, { attemptId: s.attemptId, verified: true, expected, accountRef });
  const result = await wait.result;
  assert.equal(typeof result === "object" && result.isError, true);
  assert.deepEqual(nativeValue(result), { error: "unavailable" });
  const attempt = await s.attempt(); assert.equal(attempt.phase, "awaiting_control"); assert.equal(attempt.verification, null); assert.equal(attempt.resume.state, "none");
  assert.equal(s.calls.some((call) => call.method === "configureOci" || call.method === "ociResumeProof"), false);
});

test("cancellation defeats late OCI startup status and retains cleanup without promoting user control", async (t) => {
  const s = await system(t);
  const wait = await s.wait();
  await s.authenticate(); await s.configure(); await s.start();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  s.state.phase = "user_control";
  s.state.before = async (method) => { if (method === "ociStatus") { entered = true; await held; } };
  const pending = s.post("oci-status");
  while (!entered) await setImmediate();
  await s.harness.behavior.callAgentTool("remote_login_cancel", { attemptId: s.attemptId }, context);
  release(); assert.equal((await pending).status, 409);
  assert.equal((await s.attempt()).phase, "cancelled");
  assert.equal(s.calls.some((call) => call.method === "frameOci" || call.method === "ociResumeProof"), false);
  const cleanup = s.bb.storage.database().prepare("SELECT status FROM remote_login_cleanup_v1 WHERE attempt_id=?").get(s.attemptId) as { status: string };
  assert.equal(cleanup.status, "pending");
  s.harness.behavior.cancelInteraction(wait.interaction.id);
  assert.deepEqual(nativeValue(await wait.result), { error: "unavailable" });
});

test("a host or root change during OCI evidence checks cannot verify or retarget the stored attempt", async (t) => {
  for (const change of ["host", "root"] as const) await t.test(change, async (t) => {
    const s = await system(t);
    await s.authenticate(); await s.configure(); await s.start(); await s.ready();
    s.state.verified = true;
    s.state.before = async (method) => {
      if (method === "handbackOci") {
        if (change === "host") s.environment.hostId = "host-replacement";
        else s.state.root = "root-replacement";
      }
    };
    const response = await s.post("handback"); assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: "login_control_failed" });
    const saved = await s.attempt(); assert.equal(saved.phase, "failed"); assert.equal(saved.verification, null); assert.equal(saved.resume.state, "none");
    assert.equal(s.calls.some((call) => call.method === "ociResumeProof"), false);
    assert.ok(s.calls.every((call) => call.hostId === hostId));
  });
});

test("OCI handback refuses an expired final private proof without persisting verification", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const s = await system(t);
  await s.authenticate(); await s.configure(); await s.start(); await s.ready();
  s.state.verified = true;
  s.state.proofExpiresAt = Date.now() + 1000;
  s.state.before = async (method) => { if (method === "ociResumeProof") t.mock.timers.tick(1001); };
  const response = await s.post("handback"); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "login_control_failed" });
  assert.equal(s.calls.filter((call) => call.method === "ociResumeProof").length, 1);
  const saved = await s.attempt(); assert.equal(saved.phase, "failed"); assert.equal(saved.verification, null); assert.equal(saved.resume.state, "none");
});

test("OCI handback rechecks control after provider success before accepting private proof", async (t) => {
  const s = await system(t);
  await s.authenticate(); await s.configure(); await s.start(); await s.ready();
  s.state.verified = true;
  s.state.before = async (method) => { if (method === "handbackOci") s.state.authorized = false; };
  const response = await s.post("handback"); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "login_control_failed" });
  const saved = await s.attempt(); assert.equal(saved.phase, "failed"); assert.equal(saved.verification, null); assert.equal(saved.resume.state, "none");
  assert.equal(s.calls.some((call) => call.method === "ociResumeProof"), false);
});
