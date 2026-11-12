import { inputRequest } from "./input-operation-fixture.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { provisionControlRoot } from "../control-authority.ts";
import { controlGrantSchema } from "../control-wire.ts";
import { fixtureFrameSchema, type FixtureInput } from "../fixture-wire.ts";
import { hostContract } from "../host-contract.ts";
import hostEntry from "../host.ts";
import { loginAttemptSchema } from "../login-protocol.ts";
import plugin from "../server.ts";

const supportedHost = process.platform === "darwin" && process.arch === "arm64"
  && existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const context = { projectId: "project-composed-flow", threadId: "thread-composed-flow" };
const hostId = "host-composed-flow";
const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const fingerprint = "a9c4f1b05534fc01b30a65ef34a7bf09500d112aaf4e7169647049640365a7d9";

function nativeValue(result: PluginAgentToolResult): Record<string, unknown> {
  assert.equal(typeof result, "object");
  if (typeof result === "string") throw new Error("Expected bounded native result");
  assert.equal(result.content.length, 1);
  const part = result.content[0]!;
  assert.equal(part.type, "text");
  if (part.type !== "text") throw new Error("Expected bounded native text");
  assert.ok(part.text.length < 2048);
  return JSON.parse(part.text) as Record<string, unknown>;
}

async function system(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "remote-login-composed-flow-"));
  const dataDir = join(root, "private");
  await provisionControlRoot(dataDir, key, fingerprint);
  const worker = experimental_createHostEntryHarness(hostEntry, {
    experimental_paths: { dataDir, tempDir: join(root, "unused") },
  });
  const environment: Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>> = {
    baseBranch: null, branchName: null, createdAt: 1, defaultBranch: null,
    environmentProviderId: null, environmentProviderInstanceKey: null, environmentProviderSelection: null,
    hostId, hostLifecycle: "active", id: "environment-composed-flow", isGitRepo: false, isWorktree: false,
    lifecycle: { phase: "active", retireAt: null, teardown: null }, managed: false, mergeBaseBranch: null,
    name: "synthetic environment", path: "/private/synthetic-environment", projectId: context.projectId,
    status: "ready", updatedAt: 1, workspaceProvisionType: "personal",
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "remote-login",
    sdk: {
      threads: { get: () => makeThreadResponse({ ...context, id: context.threadId,
        environmentId: environment.id, deletedAt: null, archivedAt: null }) },
      environments: { get: () => environment },
    },
    experimental_callHostRpc: ({ hostId: target, method, input, signal }) => {
      assert.equal(target, hostId);
      return worker.experimental_call(method as keyof typeof hostContract, input as never, { signal });
    },
  });
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await harness.lifecycle.dispose();
    await worker.experimental_dispose();
    await rm(root, { recursive: true, force: true });
  });
  await plugin(bb);
  let settled = false;
  const native = harness.behavior.callAgentTool("remote_login_request", { mode: "synthetic", wait: true }, {
    ...context, signal: controller.signal,
  }).finally(() => { settled = true; });
  void native.catch(() => {});
  for (let retry = 0; retry < 200 && harness.inspection.pendingInteractions.length === 0 && !settled; retry++) await delay(5);
  const interaction = harness.inspection.pendingInteractions[0];
  assert.ok(interaction, "native call must wait for protected browser handback");
  assert.equal(interaction.rendererId, "login-control");
  assert.equal(interaction.threadId, context.threadId);
  const { attemptId } = interaction.payload as { attemptId: string };
  assert.equal(typeof attemptId, "string");
  assert.deepEqual(interaction.payload, { attemptId });
  const post = (action: string, extra = {}, capability?: string) => harness.behavior.fetchHttp("POST", `/login/${action}`, {
    headers: { "content-type": "application/json", ...(capability ? { authorization: `Bearer ${capability}` } : {}) },
    body: JSON.stringify(inputRequest({ attemptId, ...extra })),
  });
  const status = async () => {
    const response = await post("status");
    assert.equal(response.status, 200);
    return loginAttemptSchema.parse(await response.json());
  };
  const session = await post("session", { key });
  assert.equal(session.status, 200);
  assert.equal(session.headers.get("cache-control"), "no-store");
  const authenticated = await session.json() as { grant: unknown; attempt: unknown };
  const grant = controlGrantSchema.parse(authenticated.grant);
  const attempt = loginAttemptSchema.parse(authenticated.attempt);
  assert.equal(attempt.attemptId, attemptId);
  assert.equal(attempt.hostId, hostId);
  assert.equal(attempt.environmentId, environment.id);
  assert.equal(attempt.phase, "awaiting_control");
  const freshInput = async (event: FixtureInput, capability: string) => {
    const response = await post("frame", {}, capability); assert.equal(response.status, 200);
    const frame = fixtureFrameSchema.parse(await response.json());
    return post("input", { event, frameRef: frame.frameRef }, capability);
  };
  return { bb, harness, worker, root, dataDir, native, interaction, attemptId, grant, post, freshInput, status, settled: () => settled };
}

// This composes the real verifier and browser; no public or test event marks the job verified.
test("protected real-browser handback completes its original waiting native call without exposing private content", {
  skip: !supportedHost, timeout: 30_000, concurrency: false,
}, async (t) => {
  const s = await system(t);
  const opened = await s.post("start", {}, s.grant.capability);
  assert.equal(opened.status, 200);
  assert.deepEqual(await opened.json(), { width: 800, height: 600 });
  assert.equal(s.worker.experimental_getRetainedWorkerLeaseCount(), 1);
  assert.equal((await s.status()).phase, "user_control");

  const frameResponse = await s.post("frame", {}, s.grant.capability);
  assert.equal(frameResponse.status, 200);
  assert.equal(frameResponse.headers.get("cache-control"), "no-store");
  const frame = fixtureFrameSchema.parse(await frameResponse.json());
  const png = Buffer.from(frame.png, "base64");
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 600);

  const notVerified = await s.post("handback", {}, s.grant.capability);
  assert.equal(notVerified.status, 409);
  const retry = await s.status();
  assert.equal(retry.phase, "user_control");
  assert.equal(retry.verification, null);
  assert.equal(retry.resume.state, "none");
  assert.equal(s.worker.experimental_getRetainedWorkerLeaseCount(), 1);

  const syntheticText = "private composed synthetic text 你好";
  for (const event of [
    { type: "click", x: 80, y: 60 },
    { type: "text", text: syntheticText },
  ] as const) {
    const response = await s.freshInput(event, s.grant.capability);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true });
  }
  const filesBeforeRenew = (await readdir(s.dataDir)).sort();
  const renewal = await s.post("renew", {}, s.grant.capability);
  assert.equal(renewal.status, 200);
  const nextGrant = controlGrantSchema.parse(await renewal.json());
  assert.notEqual(nextGrant.capability, s.grant.capability);
  assert.ok(nextGrant.expiresAt <= (await s.status()).expiresAt);
  assert.equal(s.worker.experimental_getRetainedWorkerLeaseCount(), 1);
  assert.deepEqual((await readdir(s.dataDir)).sort(), filesBeforeRenew, "renewal preserves the exact owned browser profile");
  assert.equal((await s.post("frame", {}, s.grant.capability)).status, 403);
  assert.equal((await s.status()).phase, "user_control");
  assert.equal((await s.freshInput({ type: "click", x: 80, y: 130 }, nextGrant.capability)).status, 200);
  const handback = await s.post("handback", {}, nextGrant.capability);
  assert.equal(handback.status, 200);
  assert.deepEqual(await handback.json(), { verified: true });
  assert.equal(s.worker.experimental_getRetainedWorkerLeaseCount(), 0);
  assert.deepEqual((await readdir(s.dataDir)).sort(), ["control-budget.json", "control-root.json", "paired-control-acceptance.json"]);
  const verified = await s.status();
  assert.equal(verified.phase, "verified");
  assert.equal(verified.verification?.kind, "synthetic");
  assert.equal(verified.resume.state, "pending");
  await setImmediate();
  assert.equal(s.settled(), false, "private verification alone must not invent a native result delivery");

  s.harness.behavior.submitInteraction(s.interaction.id, { attemptId: s.attemptId });
  const native = await s.native;
  assert.equal(typeof native === "object" && native.isError, undefined);
  const completed = nativeValue(native);
  assert.equal(completed.attemptId, s.attemptId);
  assert.equal(completed.mode, "synthetic");
  assert.equal(completed.phase, "verified");
  assert.equal(completed.resume, "uncertain");
  const durable = await s.status();
  assert.equal(durable.resume.state, "uncertain");
  assert.ok(durable.resume.deliveryId);
  assert.equal(s.harness.inspection.sdk.calls.some((call) => call.path === "threads.send"), false);
  assert.equal((await s.post("frame", {}, s.grant.capability)).status, 409);

  const records = s.bb.storage.database().prepare("SELECT record FROM remote_login_attempts_v1").all();
  const visible = JSON.stringify([completed, durable, records, await s.bb.storage.kv.list(),
    s.harness.inspection.pendingInteractions, s.harness.logEntries, s.harness.inspection.realtimeSignals]);
  for (const privateValue of [key, s.grant.capability, nextGrant.capability, frame.png, frame.frameRef, syntheticText, s.root]) {
    assert.equal(visible.includes(privateValue), false, "private content must stay out of logs and durable/public job state");
  }
});

test("protected cancellation closes the real browser and a public submission cannot resume the cancelled call", {
  skip: !supportedHost, timeout: 30_000, concurrency: false,
}, async (t) => {
  const s = await system(t);
  assert.equal((await s.post("start", {}, s.grant.capability)).status, 200);
  assert.equal(s.worker.experimental_getRetainedWorkerLeaseCount(), 1);
  const closed = await s.post("close", {}, s.grant.capability);
  assert.equal(closed.status, 200);
  assert.deepEqual(await closed.json(), { closed: true });
  assert.equal(s.worker.experimental_getRetainedWorkerLeaseCount(), 0);
  assert.deepEqual((await readdir(s.dataDir)).sort(), ["control-budget.json", "control-root.json"]);
  const cancelled = await s.status();
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.verification, null);
  assert.equal(cancelled.resume.state, "none");
  assert.equal((await s.post("handback", {}, s.grant.capability)).status, 409);
  s.harness.behavior.submitInteraction(s.interaction.id, { attemptId: s.attemptId });
  const native = await s.native;
  assert.equal(typeof native === "object" && native.isError, true);
  assert.deepEqual(nativeValue(native), { error: "unavailable" });
  assert.equal((await s.status()).resume.state, "none");
});
