import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { AttemptEvent, LoginAttempt } from "../login-protocol.ts";
import { LoginCoordinator } from "../login-coordinator.ts";

const request = { projectId: "project-fixture", threadId: "thread-fixture", environmentId: "environment-fixture", hostId: "host-fixture", principalId: "root-fixture", mode: "synthetic" as const };
async function system(t: TestContext) {
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login" });
  t.after(() => harness.lifecycle.dispose());
  let now = 1_000;
  const coordinator = new LoginCoordinator(bb.storage, { now: () => now, ttlMs: 10_000 });
  coordinator.activate();
  return { LoginCoordinator, bb, harness, coordinator, options: { now: () => now, ttlMs: 10_000 }, advance: (delta: number) => { now += delta; } };
}
function event(a: LoginAttempt, command: Record<string, unknown>): AttemptEvent {
  return { expected: { attemptId: a.attemptId, projectId: a.projectId, threadId: a.threadId, environmentId: a.environmentId,
    hostId: a.hostId, browserContextId: a.browserContextId, generation: a.generation, principalId: a.principalId }, expectedRevision: a.revision, ...command } as AttemptEvent;
}
function refused(code: string) {
  return (error: unknown) => error instanceof Error && (error as Error & { code: string }).code === code
    && ["Login coordinator refused.", "Login protocol refused."].includes(error.message);
}

test("requests persist an immutable generated binding and reuse one active request per thread/mode", async (t) => {
  const { coordinator } = await system(t);
  const first = coordinator.request(request);
  assert.ok(first);
  assert.equal(first.phase, "awaiting_control");
  assert.equal(first.expiresAt, 11_000);
  assert.notEqual(first.attemptId, first.browserContextId);
  assert.deepEqual(coordinator.request(request), first);
  assert.deepEqual(coordinator.get(first.attemptId), first);
  assert.throws(() => coordinator.request({ ...request, hostId: "different-host" }), refused("binding_changed"));
  const unpaired = coordinator.request({ ...request, threadId: "unpaired-thread", principalId: null });
  assert.equal(unpaired.phase, "awaiting_pairing");
  assert.equal(unpaired.principalId, null);
});

test("CAS rejects late or cross-target transitions and commits exactly one competing action", async (t) => {
  const { coordinator } = await system(t);
  const a = coordinator.request(request);
  assert.throws(() => coordinator.apply(a.attemptId, { ...event(a, { type: "start" }), expected: { ...event(a, {}).expected, hostId: "other" } }), refused("binding_mismatch"));
  const started = coordinator.apply(a.attemptId, event(a, { type: "start" }));
  assert.equal(started.phase, "starting");
  assert.throws(() => coordinator.apply(a.attemptId, event(a, { type: "cancel" })), refused("stale_revision"));
  assert.equal(coordinator.get(a.attemptId)?.phase, "starting");
});

test("terminal control attempts create an idempotent non-secret cleanup outbox", async (t) => {
  const { coordinator } = await system(t);
  let a = coordinator.request(request);
  a = coordinator.apply(a.attemptId, event(a, { type: "start" }));
  a = coordinator.apply(a.attemptId, event(a, { type: "ready" }));
  a = coordinator.apply(a.attemptId, event(a, { type: "cancel" }));
  const pending = coordinator.pendingCleanup();
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0], { attemptId: a.attemptId, hostId: a.hostId, scope: { threadId: a.threadId, attemptId: a.attemptId, browserContextId: a.browserContextId, generation: a.generation } });
  assert.deepEqual(coordinator.apply(a.attemptId, event(a, { type: "cancel" })), a);
  assert.equal(coordinator.pendingCleanup().length, 1);
  coordinator.acknowledgeCleanup(a.attemptId);
  coordinator.acknowledgeCleanup(a.attemptId);
  assert.deepEqual(coordinator.pendingCleanup(), []);
});

test("deadline rejection durably expires the attempt instead of rolling the expiry back", async (t) => {
  const { coordinator, advance } = await system(t);
  const a = coordinator.request(request);
  advance(10_000);
  assert.throws(() => coordinator.apply(a.attemptId, event(a, { type: "start" })), refused("deadline_expired"));
  assert.equal(coordinator.get(a.attemptId)?.phase, "expired");
  const next = coordinator.request(request);
  assert.notEqual(next.attemptId, a.attemptId);
});

test("reload fences old writers, preserves waiting requests and terminates unreconciled browser work", async (t) => {
  const { coordinator, bb, options, LoginCoordinator } = await system(t);
  const waiting = coordinator.request(request);
  let running = coordinator.request({ ...request, threadId: "running-thread" });
  running = coordinator.apply(running.attemptId, event(running, { type: "start" }));
  running = coordinator.apply(running.attemptId, event(running, { type: "ready" }));
  const replacement = new LoginCoordinator(bb.storage, options);
  replacement.activate();
  assert.throws(() => coordinator.get(waiting.attemptId), refused("coordinator_replaced"));
  assert.deepEqual(replacement.get(waiting.attemptId), waiting);
  assert.equal(replacement.get(running.attemptId)?.phase, "failed");
  assert.equal(replacement.get(running.attemptId)?.failure, "worker_lost");
  assert.equal(replacement.pendingCleanup().length, 1);
});

test("only independent matching verification permits a single uncertain result preparation", async (t) => {
  const { coordinator, bb, options, LoginCoordinator } = await system(t);
  let a = coordinator.request(request);
  assert.throws(() => coordinator.prepareResume(a.attemptId, event(a, {}).expected, a.revision), refused("invalid_transition"));
  for (const type of ["start", "ready", "handback"] as const) a = coordinator.apply(a.attemptId, event(a, { type }));
  assert.throws(() => coordinator.apply(a.attemptId, event(a, { type: "verified", verificationId: "proof", kind: "oci_cli" })), refused("invalid_transition"));
  a = coordinator.apply(a.attemptId, event(a, { type: "verified", verificationId: "synthetic-proof", kind: "synthetic" }));
  const prepared = coordinator.prepareResume(a.attemptId, event(a, {}).expected, a.revision);
  assert.equal(prepared.resume.state, "uncertain");
  assert.ok(prepared.resume.deliveryId);
  assert.equal(coordinator.get(a.attemptId)?.resume.state, "uncertain");
  assert.throws(() => coordinator.prepareResume(a.attemptId, event(a, {}).expected, prepared.revision), refused("resume_uncertain"));
  const replacement = new LoginCoordinator(bb.storage, options);
  replacement.activate();
  const recovered = replacement.get(a.attemptId)!;
  assert.equal(recovered.resume.state, "uncertain");
  assert.equal(recovered.resume.deliveryId, prepared.resume.deliveryId);
  assert.notEqual(recovered.resume.state, "delivered");
});

test("raw fields and corrupt persisted records never become metadata or backend error text", async (t) => {
  const { coordinator, bb } = await system(t);
  const marker = "fixture-private-marker";
  assert.throws(() => coordinator.request({ ...request, capability: marker } as never), refused("invalid_request"));
  const a = coordinator.request(request);
  bb.storage.database().prepare("UPDATE remote_login_attempts_v1 SET record = ? WHERE attempt_id = ?").run(JSON.stringify({ ...a, cookie: marker }), a.attemptId);
  try { coordinator.get(a.attemptId); assert.fail("unsafe stored record must not be returned"); }
  catch (error) { assert.ok(refused("storage_invalid")(error)); assert.equal(String(error).includes(marker), false); }
});

test("a historical delivery acknowledgement does not destroy a verified target context", async (t) => {
  const { coordinator } = await system(t);
  let a = coordinator.request(request);
  for (const type of ["start", "ready", "handback"] as const) a = coordinator.apply(a.attemptId, event(a, { type }));
  a = coordinator.apply(a.attemptId, event(a, { type: "verified", verificationId: "proof-fixture", kind: "synthetic" }));
  a = coordinator.prepareResume(a.attemptId, event(a, {}).expected, a.revision);
  coordinator.apply(a.attemptId, event(a, { type: "resume_delivered" }));
  assert.deepEqual(coordinator.pendingCleanup(), []);
});

test("a cleanup outbox write failure rolls the entire state transition back", async (t) => {
  const { coordinator, bb } = await system(t);
  let a = coordinator.request(request);
  a = coordinator.apply(a.attemptId, event(a, { type: "start" }));
  bb.storage.database().exec("CREATE TRIGGER refuse_cleanup BEFORE INSERT ON remote_login_cleanup_v1 BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  assert.throws(() => coordinator.apply(a.attemptId, event(a, { type: "cancel" })), refused("storage_unavailable"));
  assert.deepEqual(coordinator.get(a.attemptId), a);
  assert.deepEqual(coordinator.request(request), a);
  assert.deepEqual(coordinator.pendingCleanup(), []);
});

test("a rejected plugin candidate cannot take ownership from the still-running coordinator", async (t) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login" });
  t.after(() => harness.lifecycle.dispose());
  const coordinator = new LoginCoordinator(bb.storage, { now: () => 1_000 });
  coordinator.activate();
  let a = coordinator.request(request);
  a = coordinator.apply(a.attemptId, event(a, { type: "start" }));
  await assert.rejects(harness.lifecycle.reload(async (candidate) => {
    new LoginCoordinator(candidate.storage, { now: () => 1_000 });
    throw new Error("candidate rejected before commit");
  }));
  assert.deepEqual(coordinator.get(a.attemptId), a);
});

test("background expiry sweeps queue cleanup without a client reading each attempt", async (t) => {
  const { coordinator, advance } = await system(t);
  let a = coordinator.request(request);
  a = coordinator.apply(a.attemptId, event(a, { type: "start" }));
  advance(10_000);
  assert.equal(coordinator.expireDue(), 1);
  assert.equal(coordinator.expireDue(), 0);
  assert.equal(coordinator.pendingCleanup().length, 1);
  assert.equal(coordinator.get(a.attemptId)?.phase, "expired");
});

test("reload cannot promote or continue an interrupted existing-session probe", async (t) => {
  const { bb, coordinator, options } = await system(t);
  let a = coordinator.request(request);
  a = coordinator.apply(a.attemptId, event(a, { type: "check_existing" }));
  const replacement = new LoginCoordinator(bb.storage, options);
  replacement.activate();
  const recovered = replacement.get(a.attemptId)!;
  assert.equal(recovered.phase, "failed");
  assert.equal(recovered.failure, "worker_lost");
  assert.equal(recovered.verification, null);
  assert.equal(recovered.resume.state, "none");
});
