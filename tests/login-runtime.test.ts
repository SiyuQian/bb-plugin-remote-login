import assert from "node:assert/strict";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { LoginCoordinator, attemptIdentity } from "../login-coordinator.ts";
import { registerLoginRuntime } from "../login-runtime.ts";

async function system(t: TestContext, stop: () => Promise<unknown>) {
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login", experimental_callHostRpc: stop });
  t.after(() => harness.lifecycle.dispose());
  let now = 1_000;
  const coordinator = new LoginCoordinator(bb.storage, { now: () => now, ttlMs: 1000 });
  coordinator.activate();
  let a = coordinator.request({ projectId: "project", threadId: "thread", environmentId: "environment", hostId: "host-selected", principalId: "root", mode: "synthetic" });
  a = coordinator.apply(a.attemptId, { type: "start", expected: attemptIdentity(a), expectedRevision: a.revision });
  now = 2_000;
  registerLoginRuntime(bb, coordinator);
  return { bb, harness, coordinator, a };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await setImmediate(); }
  assert.ok(check(), "runtime boundary must settle");
}
test("background deadline expiry sends only the recorded owned scope and persists its acknowledgement", async (t) => {
  const { harness, coordinator, a } = await system(t, async () => ({ ok: true }));
  const service = harness.behavior.runService("login-coordinator");
  await until(() => harness.inspection.experimental_hostRpcCalls.length === 1 && coordinator.pendingCleanup().length === 0);
  assert.equal(coordinator.get(a.attemptId)?.phase, "expired");
  const [call] = harness.inspection.experimental_hostRpcCalls;
  assert.equal(call?.method, "stopAttempt");
  assert.equal(call?.hostId, "host-selected");
  assert.deepEqual(call?.input, { scope: { threadId: "thread", attemptId: a.attemptId, browserContextId: a.browserContextId, generation: 1 } });
  service.controller.abort(); await service.done;
});
test("a refused host cleanup remains pending and shutdown does not report it as complete", async (t) => {
  const { harness, coordinator, a } = await system(t, async () => ({ ok: false, reason: "control_unavailable" }));
  const service = harness.behavior.runService("login-coordinator");
  await until(() => harness.inspection.experimental_hostRpcCalls.length === 1);
  service.controller.abort(); await service.done;
  assert.equal(coordinator.pendingCleanup()[0]?.attemptId, a.attemptId);
  assert.equal(coordinator.get(a.attemptId)?.phase, "expired");
});
test("a late host acknowledgement after runtime cancellation cannot consume the durable cleanup", async (t) => {
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => { complete = resolve; });
  const { harness, coordinator, a } = await system(t, async () => { await pending; return { ok: true }; });
  const service = harness.behavior.runService("login-coordinator");
  await until(() => harness.inspection.experimental_hostRpcCalls.length === 1);
  service.controller.abort(); complete(); await service.done;
  assert.equal(coordinator.pendingCleanup()[0]?.attemptId, a.attemptId);
});

test("a failed cleanup does not starve the next owned scope", { timeout: 4000 }, async (t) => {
  let count = 0;
  const { harness, coordinator } = await system(t, async () => (++count === 1 ? { ok: false, reason: "control_unavailable" } : { ok: true }));
  let other = coordinator.request({ projectId: "project", threadId: "other-thread", environmentId: "environment", hostId: "host-selected", principalId: "root", mode: "synthetic" });
  other = coordinator.apply(other.attemptId, { type: "start", expected: attemptIdentity(other), expectedRevision: other.revision });
  coordinator.apply(other.attemptId, { type: "cancel", expected: attemptIdentity(other), expectedRevision: other.revision });
  const service = harness.behavior.runService("login-coordinator");
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline && (count < 2 || coordinator.pendingCleanup().length !== 1)) await delay(10);
  service.controller.abort(); await service.done;
  assert.equal(count, 2);
  const [first, second] = harness.inspection.experimental_hostRpcCalls;
  const firstId = (first!.input as { scope: { attemptId: string } }).scope.attemptId;
  const secondId = (second!.input as { scope: { attemptId: string } }).scope.attemptId;
  assert.notEqual(firstId, secondId);
  assert.equal(coordinator.pendingCleanup()[0]?.attemptId, firstId);
});

test("a late successful host reply after its own timeout cannot acknowledge cleanup", async (t) => {
  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => timeout.signal);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const { harness, coordinator } = await system(t, async () => { await pending; return { ok: true }; });
  const service = harness.behavior.runService("login-coordinator");
  await until(() => harness.inspection.experimental_hostRpcCalls.length === 1);
  timeout.abort(); finish(); await setImmediate();
  service.controller.abort(); await service.done;
  assert.equal(coordinator.pendingCleanup().length, 1);
});

test("runtime shutdown settles even if the host transport ignores cancellation", async (t) => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const { harness } = await system(t, async () => { await pending; return { ok: true }; });
  const service = harness.behavior.runService("login-coordinator");
  await until(() => harness.inspection.experimental_hostRpcCalls.length === 1);
  let finished = false;
  void service.done.then(() => { finished = true; });
  service.controller.abort(); await setImmediate();
  try { assert.equal(finished, true); }
  finally { finish(); await service.done; }
});
