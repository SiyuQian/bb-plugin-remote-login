import { inputRequest } from "./input-operation-fixture.ts";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const context = { projectId: "project-gateway", threadId: "thread-gateway" };
const key = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
const capability = "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM";
const renewedCapability = Buffer.alloc(32, 4).toString("base64url");
const frameRef = "11111111-1111-4111-8111-111111111111";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKD8AAAAASUVORK5CYII=";
const body = (value: unknown, token: string | null = capability) => ({
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(inputRequest(value && typeof value === "object" && "event" in value ? { frameRef, ...value } : value)),
});
function result(r: PluginAgentToolResult): Record<string, unknown> {
  assert.equal(typeof r, "object"); if (typeof r === "string") throw new Error();
  assert.equal(r.content[0]?.type, "text"); return JSON.parse(r.content[0]!.type === "text" ? r.content[0]!.text : "null");
}
async function system(t: { after(fn: () => unknown): void }, initialRoot: string | null = "root-bound") {
  const environment: Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>> = {
    baseBranch: null, branchName: null, createdAt: 1, defaultBranch: null, environmentProviderId: null,
    environmentProviderInstanceKey: null, environmentProviderSelection: null, hostId: "host-bound", hostLifecycle: "active",
    id: "environment-bound", isGitRepo: false, isWorktree: false, lifecycle: { phase: "active", retireAt: null, teardown: null },
    managed: false, mergeBaseBranch: null, name: "fixture", path: "/private/fixture", projectId: context.projectId,
    status: "ready", updatedAt: 1, workspaceProvisionType: "personal",
  };
  const state = { root: initialRoot, verified: false, refuse: "", staleInput: false, staleFrame: false, before: async (_method: string) => {} };
  const calls: string[] = [];
  const inputs: Array<{ method: string; input: unknown }> = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login", sdk: {
    threads: { get: () => makeThreadResponse({ ...context, id: context.threadId, environmentId: environment.id, deletedAt: null, archivedAt: null }) },
    environments: { get: () => environment },
  }, experimental_callHostRpc: async ({ hostId, method, input }) => {
    assert.equal(hostId, "host-bound"); calls.push(method); inputs.push({ method, input }); await state.before(method);
    if (method === "controlInfo") return { provisioned: state.root !== null, rootId: state.root, provisioningDirectory: "/private/root" };
    if (method === "authenticateControl") {
      assert.equal((input as { key: string }).key, key);
      return { ok: true, grant: { capability, expiresAt: Date.now() + 300_000 } };
    }
    if (state.refuse === method) return { ok: false, reason: "unauthorized" };
    if (method === "renewControl") return { ok: true, grant: { capability: renewedCapability, expiresAt: Date.now() + 300_000 } };
    if (method === "startFixture") return { ok: true, viewport: { width: 800, height: 600 } };
    if (method === "frameFixture") return state.staleFrame ? { ok: false, reason: "stale_frame" } : { ok: true, frame: { png, width: 800, height: 600, frameRef } };
    if (method === "inputFixture" && state.staleInput) return { ok: false, reason: "stale_frame" };
    if (method === "verifyFixture") return { ok: true, verified: state.verified };
    if (method === "completePhoneFixture") {
      calls.push("verifyFixture"); await state.before("verifyFixture");
      if (state.verified) {
        calls.push("closeFixture"); await state.before("closeFixture");
        if (state.refuse === "closeFixture") return { ok: false, reason: "cleanup_uncertain" };
      }
      return { ok: true, verified: state.verified };
    }
    return { ok: true };
  } });
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  const requested = result(await harness.behavior.callAgentTool("remote_login_request", { mode: "synthetic" }, context));
  const attemptId = requested.attemptId as string;
  const post = (action: string, extra = {}, token: string | null = capability) => harness.behavior.fetchHttp("POST", `/login/${action}`, body({ attemptId, ...extra }, token));
  const status = async () => { const r = await post("status", {}, null); assert.equal(r.status, 200); return await r.json() as Record<string, any>; };
  return { bb, harness, environment, state, calls, inputs, attemptId, post, status };
}

test("host mode persists on its bound job, refuses remote observation and still requires independent handback", async t => {
  const s = await system(t);
  assert.equal((await s.post("start", { controlMode: "host" }, null)).status, 401);
  assert.equal(s.calls.includes("startFixture"), false);
  assert.equal((await s.post("start", { controlMode: "host" })).status, 200);
  const opened = s.inputs.find(call => call.method === "startFixture")!.input as any;
  assert.equal(opened.controlMode, "host");
  assert.equal((await s.status()).controlMode, "host");
  assert.equal((await s.post("frame")).status, 409);
  assert.equal((await s.post("input", { frameRef, event: { type: "key", key: "Enter" } })).status, 409);
  assert.equal(s.calls.includes("frameFixture") || s.calls.includes("inputFixture"), false);
  assert.equal((await s.post("start", { controlMode: "remote" })).status, 409);
  assert.equal((await s.post("handback")).status, 409);
  assert.equal((await s.status()).phase, "user_control");
  s.state.verified = true;
  assert.equal((await s.post("handback")).status, 200);
  assert.equal((await s.status()).phase, "verified");
  assert.equal((await s.status()).controlMode, "host");
});

test("job stale input is recoverable only while its post-host root and binding are still current", async t => {
  const s = await system(t); await s.post("start"); s.state.staleInput = true;
  const stale = await s.post("input", { frameRef, event: { type: "key", key: "Enter" } });
  assert.equal(stale.status, 409); assert.deepEqual(await stale.json(), { error: "stale_frame" });
  assert.equal(stale.headers.get("cache-control"), "no-store"); assert.equal((await s.status()).phase, "user_control");
  assert.equal((s.inputs.slice().reverse().find(call => call.method === "inputFixture")!.input as { frameRef: string }).frameRef, frameRef);
  s.state.before = async method => { if (method === "inputFixture") s.state.root = "changed-during-stale-input"; };
  const replaced = await s.post("input", { frameRef, event: { type: "key", key: "Enter" } });
  assert.equal(replaced.status, 403); assert.deepEqual(await replaced.json(), { error: "login_control_failed" });
  assert.equal((await s.status()).phase, "failed");
});

test("a changed readonly job frame remains recoverable only after current root checks", async t => {
  const s = await system(t); await s.post("start"); s.state.staleFrame = true;
  const frame = await s.post("frame");
  assert.equal(frame.status, 409); assert.deepEqual(await frame.json(), { error: "stale_frame" });
  assert.equal(frame.headers.get("cache-control"), "no-store"); assert.equal((await s.status()).phase, "user_control");
  s.state.before = async method => { if (method === "frameFixture") s.state.root = "changed-during-frame-read"; };
  const replaced = await s.post("frame");
  assert.equal(replaced.status, 403); assert.deepEqual(await replaced.json(), { error: "login_control_failed" });
  assert.equal((await s.status()).phase, "failed");
});

test("job gateway binds the private browser and never trusts public completion flags", async (t) => {
  const s = await system(t);
  for (const [action, extra] of [["start", {}], ["frame", {}], ["input", { event: { type: "text", text: "private synthetic" } }], ["handback", {}], ["close", {}]] as const) {
    assert.equal((await s.post(action, extra, null)).status, 401);
  }
  for (const extra of [{ verified: true }, { hostId: "other-host" }, { scope: {} }, { url: "https://unapproved.invalid" }]) {
    assert.equal((await s.post("start", extra)).status, 400);
  }
  assert.equal((await s.post("session", { key }, null)).status, 200);
  assert.equal((await s.post("start")).status, 200);
  assert.equal((await s.status()).phase, "user_control");
  assert.equal((await s.post("input", { event: { type: "text", text: "private synthetic" } })).status, 200);
  const frame = await s.post("frame"); assert.equal(frame.status, 200); assert.equal(frame.headers.get("cache-control"), "no-store");
  assert.equal((await frame.json() as { png: string }).png, png);
  const scope = (await s.harness.behavior.callRpc("loginAttempts", { threadId: context.threadId }) as any[])[0];
  const target = { hostId: scope.hostId, scope: { threadId: scope.threadId, attemptId: scope.attemptId, browserContextId: scope.browserContextId, generation: scope.generation } };
  for (const path of ["/fixture/start", "/fixture/frame", "/fixture/input", "/fixture/close", "/control/check", "/control/renew", "/control/release", "/control/session"]) {
    const r = await s.harness.behavior.fetchHttp("POST", path, body({ ...target, ...(path.endsWith("input") ? { event: { type: "key", key: "Enter" } } : {}), ...(path === "/control/session" ? { key } : {}) }));
    assert.equal(r.status, 403, path);
  }
  const exposed = JSON.stringify([await bbKv(s.bb), s.harness.logEntries, s.harness.inspection.realtimeSignals, await s.status()]);
  for (const secret of [key, capability, png, "private synthetic"]) assert.equal(exposed.includes(secret), false);
});
const bbKv = (bb: BbPluginApi) => bb.storage.kv.list();

test("handback false permits retry; matching verification closes before persisting success", async (t) => {
  const s = await system(t); await s.post("start");
  assert.equal((await s.post("handback")).status, 409);
  assert.equal((await s.status()).phase, "user_control");
  assert.equal(s.calls.includes("closeFixture"), false);
  s.state.verified = true;
  const r = await s.post("handback"); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { verified: true });
  const a = await s.status(); assert.equal(a.phase, "verified"); assert.equal(a.verification.kind, "synthetic"); assert.equal(a.resume.state, "pending");
  assert.ok(s.calls.lastIndexOf("closeFixture") > s.calls.lastIndexOf("verifyFixture"));
  const count = s.calls.length;
  assert.equal((await s.post("input", { event: { type: "key", key: "Enter" } })).status, 409);
  assert.equal(s.calls.slice(count).includes("inputFixture"), false);
  assert.equal((await s.post("handback")).status, 409);
});

test("failed authorization cannot start or terminate the legitimate attempt", async (t) => {
  const s = await system(t); s.state.refuse = "authorizeControl";
  assert.equal((await s.post("start")).status, 403);
  assert.equal(s.calls.includes("startFixture"), false);
  assert.equal((await s.status()).phase, "awaiting_control");
});

test("root or target change never retargets a persisted job", async (t) => {
  for (const change of ["root", "host"] as const) {
    const s = await system(t);
    if (change === "root") s.state.root = "root-replaced";
    else s.environment.hostId = "host-other";
    assert.equal((await s.post("start")).status, 403);
    assert.equal(s.calls.includes("startFixture"), false);
    assert.equal((await s.status()).phase, "failed");
  }
});

test("cancellation during a frame drops the late image and never reopens the job", async (t) => {
  const s = await system(t); await s.post("start");
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  s.state.before = async (method) => { if (method === "frameFixture") await hold; };
  const frame = s.post("frame");
  while (!s.calls.includes("frameFixture")) await setImmediate();
  await s.harness.behavior.callAgentTool("remote_login_cancel", { attemptId: s.attemptId }, context);
  release();
  const r = await frame; assert.equal(r.status, 409); assert.equal((await r.text()).includes(png), false);
  assert.equal((await s.status()).phase, "cancelled");
});

test("handback excludes concurrent input and failed cleanup never verifies", async (t) => {
  const s = await system(t); await s.post("start"); s.state.verified = true;
  let release!: () => void; const hold = new Promise<void>((r) => { release = r; });
  s.state.before = async (method) => { if (method === "verifyFixture") await hold; };
  const handback = s.post("handback");
  while (!s.calls.includes("verifyFixture")) await setImmediate();
  assert.equal((await s.post("input", { event: { type: "text", text: "late" } })).status, 409);
  s.state.refuse = "closeFixture"; release();
  assert.equal((await handback).status, 503);
  const a = await s.status(); assert.equal(a.phase, "failed"); assert.equal(a.verification, null);
});

test("a late startup after cancellation cannot publish ready or verified", async (t) => {
  const s = await system(t);
  let release!: () => void; const hold = new Promise<void>((r) => { release = r; });
  s.state.before = async (method) => { if (method === "startFixture") await hold; };
  const start = s.post("start"); while (!s.calls.includes("startFixture")) await setImmediate();
  await s.harness.behavior.callAgentTool("remote_login_cancel", { attemptId: s.attemptId }, context);
  release(); assert.equal((await start).status, 409);
  assert.equal((await s.status()).phase, "cancelled");
});

test("session grant binds an initially unpaired job only after observing the configured root", async (t) => {
  const s = await system(t, null);
  assert.equal((await s.post("session", { key }, null)).status, 403);
  assert.equal((await s.status()).phase, "awaiting_pairing");
  s.state.root = "root-provisioned";
  const r = await s.post("session", { key }, null); assert.equal(r.status, 200);
  const { attempt, grant } = await r.json() as any;
  assert.equal(attempt.phase, "awaiting_control"); assert.equal(attempt.principalId, "root-provisioned");
  assert.equal(attempt.verification, null); assert.equal(grant.capability, capability);
});

test("a root change during verification discards true evidence and queues cleanup", async (t) => {
  const s = await system(t); await s.post("start"); s.state.verified = true;
  s.state.before = async (method) => { if (method === "verifyFixture") s.state.root = "root-replaced"; };
  assert.equal((await s.post("handback")).status, 403);
  const a = await s.status(); assert.equal(a.phase, "failed"); assert.equal(a.verification, null);
  assert.equal(a.resume.state, "none");
  const cleanup = s.bb.storage.database().prepare("SELECT status FROM remote_login_cleanup_v1 WHERE attempt_id=?").get(s.attemptId) as { status: string } | undefined;
  assert.equal(cleanup?.status, "pending");
});

test("plugin disposal promptly drops a host frame even if transport ignores abort", async (t) => {
  const s = await system(t); await s.post("start");
  let release!: () => void; const hold = new Promise<void>((r) => { release = r; });
  s.state.before = async (method) => { if (method === "frameFixture") await hold; };
  const pending = s.post("frame"); while (!s.calls.includes("frameFixture")) await setImmediate();
  await s.harness.lifecycle.dispose();
  const r = await pending; assert.equal(r.status, 503); assert.equal((await r.text()).includes(png), false);
  release(); await setImmediate();
});

test("renewal derives the actual deadline and proof scope without restarting the browser", async (t) => {
  const s = await system(t); await s.post("start");
  const before = await s.status();
  const response = await s.post("renew"); assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const grant = await response.json() as { capability: string; expiresAt: number };
  assert.equal(grant.capability, renewedCapability); assert.ok(grant.expiresAt <= before.expiresAt);
  assert.deepEqual(await s.status(), before, "rotating private proof does not advance job authentication state");
  assert.equal(s.calls.filter((m) => m === "startFixture").length, 1); assert.equal(s.calls.includes("closeFixture"), false);
  assert.equal((s.inputs.find((c) => c.method === "renewControl")!.input as any).deadline, before.expiresAt);
  assert.equal((s.inputs.find((c) => c.method === "renewControl")!.input as any).scope.attemptId, s.attemptId);
  assert.equal((await s.post("renew", { expiresAt: before.expiresAt + 1000 })).status, 400);
  assert.equal((await s.post("renew", {}, null)).status, 401);
});

test("renewal is allowed before start but terminal or verifying jobs cannot rotate", async (t) => {
  const s = await system(t);
  assert.equal((await s.post("renew")).status, 200);
  await s.harness.behavior.callAgentTool("remote_login_cancel", { attemptId: s.attemptId }, context);
  assert.equal((await s.post("renew")).status, 409);
});

test("uncertain rotation fails the matching job, keeps cleanup pending, and never exposes a grant", async (t) => {
  const s = await system(t); await s.post("start"); s.state.refuse = "renewControl";
  const response = await s.post("renew"); assert.equal(response.status, 503);
  assert.equal((await response.text()).includes(renewedCapability), false);
  const a = await s.status(); assert.equal(a.phase, "failed"); assert.equal(a.verification, null);
  const cleanup = s.bb.storage.database().prepare("SELECT status FROM remote_login_cleanup_v1 WHERE attempt_id=?").get(s.attemptId) as { status: string };
  assert.equal(cleanup.status, "pending");
});

test("pre-rotation authorization refusal preserves the live job", async (t) => {
  const s = await system(t); await s.post("start"); s.state.refuse = "authorizeControl";
  assert.equal((await s.post("renew")).status, 403);
  assert.equal((await s.status()).phase, "user_control");
  assert.equal(s.calls.includes("renewControl"), false);
});

test("a rotating job excludes input and a concurrent cancellation defeats late rotation", async (t) => {
  const s = await system(t); await s.post("start");
  let release!: () => void; const hold = new Promise<void>((r) => { release = r; });
  s.state.before = async (method) => { if (method === "renewControl") await hold; };
  const renew = s.post("renew"); while (!s.calls.includes("renewControl")) await setImmediate();
  assert.equal((await s.post("input", { event: { type: "key", key: "Enter" } })).status, 409);
  assert.equal((await s.post("handback")).status, 409);
  await s.harness.behavior.callAgentTool("remote_login_cancel", { attemptId: s.attemptId }, context);
  release(); const response = await renew; assert.equal(response.status, 409);
  assert.equal((await response.text()).includes(renewedCapability), false);
  assert.equal((await s.status()).phase, "cancelled");
});

test("request abort bounds ignored transport rotation and retains failed-job cleanup", async (t) => {
  const s = await system(t); await s.post("start");
  let release!: () => void; const hold = new Promise<void>((r) => { release = r; });
  s.state.before = async (method) => { if (method === "renewControl") await hold; };
  const controller = new AbortController();
  const pending = s.harness.behavior.fetchHttp("POST", "/login/renew", { ...body({ attemptId: s.attemptId }), signal: controller.signal });
  while (!s.calls.includes("renewControl")) await setImmediate();
  controller.abort(); const response = await pending;
  assert.equal(response.status, 503); assert.equal((await response.text()).includes(renewedCapability), false);
  assert.equal((await s.status()).phase, "failed");
  release(); await setImmediate(); assert.equal((await s.status()).phase, "failed");
});

test("root replacement after rotation drops the replacement proof and retains owned cleanup", async (t) => {
  const s = await system(t); await s.post("start");
  s.state.before = async (method) => { if (method === "renewControl") s.state.root = "replaced-after-rotation"; };
  const response = await s.post("renew"); assert.equal(response.status, 403);
  assert.equal((await response.text()).includes(renewedCapability), false);
  const a = await s.status(); assert.equal(a.phase, "failed"); assert.equal(a.verification, null);
  const cleanup = s.bb.storage.database().prepare("SELECT status FROM remote_login_cleanup_v1 WHERE attempt_id=?").get(s.attemptId) as { status: string };
  assert.equal(cleanup.status, "pending");
});

test("committed reload bounds old rotation and the late callback cannot revive its successor", async (t) => {
  const s = await system(t); await s.post("start");
  let release!: () => void; const hold = new Promise<void>((r) => { release = r; });
  s.state.before = async (method) => { if (method === "renewControl") await hold; };
  const pending = s.post("renew"); while (!s.calls.includes("renewControl")) await setImmediate();
  const next = await s.harness.lifecycle.reload(plugin); t.after(() => next.harness.lifecycle.dispose());
  const response = await pending; assert.equal(response.status, 503); assert.equal((await response.text()).includes(renewedCapability), false);
  const status = async () => {
    const r = await next.harness.behavior.fetchHttp("POST", "/login/status", body({ attemptId: s.attemptId }, null));
    assert.equal(r.status, 200); return await r.json() as any;
  };
  const a = await status(); assert.equal(a.phase, "failed"); assert.equal(a.verification, null);
  release(); await setImmediate(); assert.deepEqual(await status(), a);
  const cleanup = next.bb.storage.database().prepare("SELECT status FROM remote_login_cleanup_v1 WHERE attempt_id=?").get(s.attemptId) as { status: string };
  assert.equal(cleanup.status, "pending");
});
