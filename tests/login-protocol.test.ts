import assert from "node:assert/strict";
import test from "node:test";
import { attemptEventSchema, loginAttemptSchema, LoginProtocolError, reduceAttempt, type AttemptEvent, type LoginAttempt } from "../login-protocol.ts";

const INITIAL: LoginAttempt = {
  version: 1, attemptId: "attempt-fixture", projectId: "project-fixture", threadId: "thread-fixture",
  environmentId: "environment-fixture", hostId: "host-fixture", browserContextId: "browser-fixture", generation: 1,
  principalId: null, mode: "synthetic", phase: "awaiting_pairing", revision: 0,
  createdAt: 1_000, updatedAt: 1_000, expiresAt: 10_000,
  verification: null, resume: { state: "none", deliveryId: null }, failure: null,
};

test("host presentation is persisted at start and cannot be changed by a later event", () => {
  const paired = reduceAttempt(INITIAL, event(INITIAL, "paired", { principalId: "principal-fixture" }), 1_001);
  const started = reduceAttempt(paired, event(paired, "start", { controlMode: "host" }), 1_002);
  assert.equal((started as any).controlMode, "host");
  const ready = reduceAttempt(started, event(started, "ready"), 1_003);
  assert.equal((ready as any).controlMode, "host");
  assert.throws(() => reduceAttempt(ready, event(ready, "handback", { controlMode: "remote" }), 1_004), refused("invalid_event"));
  assert.equal(loginAttemptSchema.safeParse({ ...INITIAL, controlMode: "automatic" }).success, false);
});

function event(attempt: LoginAttempt, type: AttemptEvent["type"], fields: Record<string, unknown> = {}): AttemptEvent {
  const { attemptId, projectId, threadId, environmentId, hostId, browserContextId, generation, principalId } = attempt;
  return { expected: { attemptId, projectId, threadId, environmentId, hostId, browserContextId, generation, principalId }, expectedRevision: attempt.revision, type, ...fields } as AttemptEvent;
}
function refused(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof LoginProtocolError);
    assert.equal(error.code, code);
    assert.equal(error.message, "Login protocol refused.");
    return true;
  };
}
async function verifying(mode: LoginAttempt["mode"] = "synthetic") {
  let attempt = { ...INITIAL, mode };
  attempt = reduceAttempt(attempt, event(attempt, "paired", { principalId: "principal-fixture" }), 1_001);
  attempt = reduceAttempt(attempt, event(attempt, "start"), 1_002);
  attempt = reduceAttempt(attempt, event(attempt, "ready"), 1_003);
  return reduceAttempt(attempt, event(attempt, "handback"), 1_004);
}
async function verified() {
  const attempt = await verifying();
  return reduceAttempt(attempt, event(attempt, "verified", { verificationId: "verification-fixture", kind: "synthetic" }), 1_005);
}

test("a trusted paired principal precedes control and handback precedes verification", async () => {
  const original = structuredClone(INITIAL);
  const paired = reduceAttempt(INITIAL, event(INITIAL, "paired", { principalId: "principal-fixture" }), 1_001);
  assert.equal(paired.phase, "awaiting_control");
  assert.equal(paired.principalId, "principal-fixture");
  assert.equal(paired.revision, 1);
  const ready = await verifying();
  assert.equal(ready.phase, "verifying");
  assert.equal(ready.revision, 4);
  assert.equal(ready.updatedAt, 1_004);
  assert.deepEqual(INITIAL, original);
  assert.throws(() => reduceAttempt(INITIAL, event(INITIAL, "start"), 1_001), refused("invalid_transition"));
});

test("strict records reject secret, browser, path and freeform fields at every level", async () => {
  assert.equal(loginAttemptSchema.safeParse(INITIAL).success, true);
  for (const name of ["capability", "controlKey", "cookies", "url", "html", "input", "image", "path", "log"]) {
    assert.equal(loginAttemptSchema.safeParse({ ...INITIAL, [name]: "public-test-material" }).success, false);
    assert.equal(attemptEventSchema.safeParse({ ...event(INITIAL, "cancel"), [name]: "public-test-material" }).success, false);
  }
  assert.equal(loginAttemptSchema.safeParse({ ...INITIAL, resume: { ...INITIAL.resume, token: "fixture" } }).success, false);
  assert.equal(loginAttemptSchema.safeParse({ ...INITIAL, failure: "freeform backend exception" }).success, false);
});

test("identifiers, counters, timestamps and record versions have strict bounds", async () => {
  for (const field of ["attemptId", "projectId", "threadId", "environmentId", "hostId", "browserContextId"]) {
    for (const value of ["", "a".repeat(201), "https://fixture.invalid", "/private/file", "<html>", "has space"]) {
      assert.equal(loginAttemptSchema.safeParse({ ...INITIAL, [field]: value }).success, false);
    }
  }
  for (const changed of [
    { version: 2 }, { generation: -1 }, { revision: 0.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { updatedAt: 999 }, { expiresAt: 1_000 }, { createdAt: -1 },
    { phase: "user_control", principalId: null },
  ]) assert.equal(loginAttemptSchema.safeParse({ ...INITIAL, ...changed }).success, false);
});

test("every immutable binding including environment and principal rejects substitution", async () => {
  const attempt = await verifying();
  for (const [field, value] of [
    ["attemptId", "other-attempt"], ["projectId", "other-project"], ["threadId", "other-thread"],
    ["environmentId", "other-environment"], ["hostId", "other-host"], ["browserContextId", "other-browser"],
    ["generation", 2], ["principalId", "other-principal"],
  ] as const) {
    const command = event(attempt, "cancel");
    assert.throws(() => reduceAttempt(attempt, { ...command, expected: { ...command.expected, [field]: value } }, 1_005), refused("binding_mismatch"));
  }
  assert.throws(() => reduceAttempt(attempt, { ...event(attempt, "cancel"), expectedRevision: 3 }, 1_005), refused("stale_revision"));
});

test("manual-login verification follows handback and creates pending resumption", async () => {
  const attempt = await verifying();
  assert.throws(() => reduceAttempt(attempt, event(attempt, "verified", { verificationId: "verification-fixture", kind: "oci_cli" }), 1_005), refused("invalid_transition"));
  assert.throws(() => reduceAttempt(INITIAL, event(INITIAL, "verified", { verificationId: "verification-fixture", kind: "synthetic" }), 1_005), refused("invalid_transition"));
  const result = await verified();
  assert.equal(result.phase, "verified");
  assert.equal(result.revision, 5);
  assert.deepEqual(result.verification, { id: "verification-fixture", kind: "synthetic", verifiedAt: 1_005 });
  assert.deepEqual(result.resume, { state: "pending", deliveryId: null });
  assert.equal(result.failure, null);
});

test("only an in-progress trusted verifier can return a rejected fixture to user control", async () => {
  const a = await verifying();
  const retry = reduceAttempt(a, event(a, "verification_retry"), 1_005);
  assert.equal(retry.phase, "user_control");
  assert.equal(retry.verification, null);
  assert.equal(retry.resume.state, "none");
  assert.throws(() => reduceAttempt(retry, event(retry, "verification_retry"), 1_006), refused("invalid_transition"));
  assert.throws(() => reduceAttempt(a, { ...event(a, "verification_retry"), expectedRevision: 1 }, 1_005), refused("stale_revision"));
});

test("synthetic evidence cannot be recorded as OCI verification", async () => {
  for (const mode of ["oci_cli", "oci_web"] as const) {
    const attempt = await verifying(mode);
    assert.throws(() => reduceAttempt(attempt, event(attempt, "verified", { verificationId: "synthetic-evidence", kind: "synthetic" }), 1_005), refused("invalid_transition"));
  }
});

test("deadline rejects late control, verification and resume claims without mutating evidence", async () => {
  const attempt = await verifying();
  assert.throws(() => reduceAttempt(attempt, event(attempt, "verified", { verificationId: "late-evidence", kind: "synthetic" }), 10_000), refused("deadline_expired"));
  assert.throws(() => reduceAttempt(INITIAL, event(INITIAL, "paired", { principalId: "principal-fixture" }), 10_001), refused("deadline_expired"));
  const complete = await verified();
  assert.throws(() => reduceAttempt(complete, event(complete, "resume_claim", { deliveryId: "delivery-fixture" }), 10_000), refused("deadline_expired"));
  assert.deepEqual(complete.resume, { state: "pending", deliveryId: null });
  assert.throws(() => reduceAttempt(attempt, event(attempt, "expire"), 9_999), refused("invalid_transition"));
});

test("claiming a pending resume never infers delivery or permits a second claim", async () => {
  const complete = await verified();
  const claimed = reduceAttempt(complete, event(complete, "resume_claim", { deliveryId: "delivery-fixture" }), 1_006);
  assert.deepEqual(claimed.resume, { state: "claimed", deliveryId: "delivery-fixture" });
  assert.equal(claimed.phase, "verified");
  assert.throws(() => reduceAttempt(claimed, event(claimed, "resume_claim", { deliveryId: "another-delivery" }), 1_007), refused("invalid_transition"));
  assert.throws(() => reduceAttempt(INITIAL, event(INITIAL, "resume_claim", { deliveryId: "delivery-fixture" }), 1_007), refused("invalid_transition"));
});

test("cancellation, expiry and worker loss preserve verification but clear an unclaimed resume", async () => {
  for (const [type, now, phase, failure] of [
    ["cancel", 1_006, "cancelled", "cancelled"], ["expire", 10_000, "expired", "deadline_expired"],
    ["worker_lost", 1_006, "failed", "worker_lost"],
  ] as const) {
    const complete = await verified();
    const ended = reduceAttempt(complete, event(complete, type), now);
    assert.equal(ended.phase, phase);
    assert.equal(ended.failure, failure);
    assert.deepEqual(ended.verification, { id: "verification-fixture", kind: "synthetic", verifiedAt: 1_005 });
    assert.deepEqual(ended.resume, { state: "none", deliveryId: null });
  }
});

test("a claimed delivery remains uncertain through cancellation, expiry or worker loss", async () => {
  for (const [type, now] of [["cancel", 1_007], ["expire", 10_000], ["worker_lost", 1_007]] as const) {
    const complete = await verified();
    const claimed = reduceAttempt(complete, event(complete, "resume_claim", { deliveryId: "delivery-fixture" }), 1_006);
    const ended = reduceAttempt(claimed, event(claimed, type), now);
    assert.deepEqual(ended.resume, { state: "uncertain", deliveryId: "delivery-fixture" });
    assert.throws(() => reduceAttempt(ended, event(ended, "resume_claim", { deliveryId: "retry-delivery" }), now), (error) => refused(now === 10_000 ? "deadline_expired" : "invalid_transition")(error));
  }
});

test("late trusted receipts only record history and never reopen an expired attempt", async () => {
  const complete = await verified();
  const claimed = reduceAttempt(complete, event(complete, "resume_claim", { deliveryId: "delivery-fixture" }), 1_006);
  const uncertain = reduceAttempt(claimed, event(claimed, "resume_uncertain"), 10_001);
  assert.equal(uncertain.phase, "verified");
  assert.deepEqual(uncertain.resume, { state: "uncertain", deliveryId: "delivery-fixture" });
  const expired = reduceAttempt(uncertain, event(uncertain, "expire"), 10_002);
  const acknowledged = reduceAttempt(expired, event(expired, "resume_delivered"), 10_003);
  assert.equal(acknowledged.phase, "expired");
  assert.equal(acknowledged.failure, "deadline_expired");
  assert.deepEqual(acknowledged.resume, { state: "delivered", deliveryId: "delivery-fixture" });
  assert.throws(() => reduceAttempt(acknowledged, event(acknowledged, "resume_claim", { deliveryId: "retry-delivery" }), 10_004), refused("deadline_expired"));
});

test("delivered history rejects new terminal commands and unclaimed attempts reject receipt events", async () => {
  const complete = await verified();
  for (const type of ["resume_uncertain", "resume_delivered"] as const) {
    assert.throws(() => reduceAttempt(complete, event(complete, type), 1_006), refused("invalid_transition"));
  }
  const claimed = reduceAttempt(complete, event(complete, "resume_claim", { deliveryId: "delivery-fixture" }), 1_006);
  const delivered = reduceAttempt(claimed, event(claimed, "resume_delivered"), 1_007);
  for (const type of ["cancel", "worker_lost", "reject"] as const) {
    assert.throws(() => reduceAttempt(delivered, event(delivered, type, type === "reject" ? { code: "provider_failed" } : {}), 1_008), refused("invalid_transition"));
  }
});

test("duplicate terminal cancel and expire are idempotent only with current immutable binding and revision", async () => {
  for (const [type, now] of [["cancel", 1_001], ["expire", 10_000]] as const) {
    const ended = reduceAttempt(INITIAL, event(INITIAL, type), now);
    assert.deepEqual(reduceAttempt(ended, event(ended, type), now + 1), ended);
    assert.throws(() => reduceAttempt(ended, { ...event(ended, type), expectedRevision: 0 }, now + 1), refused("stale_revision"));
    const command = event(ended, type);
    assert.throws(() => reduceAttempt(ended, { ...command, expected: { ...command.expected, hostId: "other-host" } }, now + 1), refused("binding_mismatch"));
  }
});

test("reload loss never promotes unfinished work to verified or invents delivery", async () => {
  const attempt = await verifying();
  const lost = reduceAttempt(attempt, event(attempt, "worker_lost"), 1_005);
  assert.equal(lost.phase, "failed");
  assert.equal(lost.failure, "worker_lost");
  assert.equal(lost.verification, null);
  assert.deepEqual(lost.resume, { state: "none", deliveryId: null });
  const unsupported = reduceAttempt(INITIAL, event(INITIAL, "reject", { code: "unsupported" }), 1_001);
  assert.equal(unsupported.phase, "unsupported");
  assert.equal(unsupported.failure, "unsupported");
});

test("invalid records, commands and backwards time return fixed errors without submitted material", async () => {
  assert.throws(() => reduceAttempt({ ...INITIAL, version: 2 } as unknown as LoginAttempt, event(INITIAL, "cancel"), 1_001), refused("invalid_attempt"));
  assert.throws(() => reduceAttempt(INITIAL, { ...event(INITIAL, "cancel"), token: "sensitive-fixture" } as unknown as AttemptEvent, 1_001), refused("invalid_event"));
  assert.throws(() => reduceAttempt(INITIAL, event(INITIAL, "cancel"), 999), refused("invalid_time"));
  assert.throws(() => reduceAttempt(INITIAL, event(INITIAL, "cancel"), Number.NaN), refused("invalid_time"));
});

test("stored terminal and verification records retain consistent timestamps and receipt shapes", async () => {
  const complete = await verified();
  for (const record of [
    { ...INITIAL, phase: "expired", failure: "deadline_expired" },
    { ...INITIAL, phase: "cancelled", failure: null },
    { ...complete, resume: { state: "pending", deliveryId: "delivery-fixture" } },
    { ...complete, verification: { ...complete.verification, kind: "oci_cli" } },
    { ...complete, updatedAt: 10_000, resume: { state: "uncertain", deliveryId: "delivery-fixture" }, verification: { ...complete.verification, verifiedAt: 10_000 } },
    { ...complete, verification: { ...complete.verification, token: "sensitive-fixture" } },
  ]) assert.equal(loginAttemptSchema.safeParse(record).success, false);
});

test("a trusted existing-session probe can verify without fabricating user-control events", () => {
  for (const mode of ["synthetic", "oci_cli", "oci_web"] as const) {
    const initial = { ...INITIAL, mode };
    const paired = reduceAttempt(initial, event(initial, "paired", { principalId: "principal-fixture" }), 1_001);
    const checking = reduceAttempt(paired, event(paired, "check_existing"), 1_002);
    assert.equal(checking.phase, "checking_existing");
    assert.equal(checking.principalId, "principal-fixture");
    assert.equal(checking.revision, 2);
    assert.equal(checking.verification, null);
    assert.deepEqual(checking.resume, { state: "none", deliveryId: null });
    const complete = reduceAttempt(checking, event(checking, "verified", { verificationId: "existing-session-receipt", kind: mode }), 1_003);
    assert.equal(complete.phase, "verified");
    assert.equal(complete.revision, 3);
    assert.deepEqual(complete.verification, { id: "existing-session-receipt", kind: mode, verifiedAt: 1_003 });
    assert.deepEqual(complete.resume, { state: "pending", deliveryId: null });
  }
});

test("a missing or nonreusable existing session returns to manual waiting without success evidence", () => {
  const paired = reduceAttempt(INITIAL, event(INITIAL, "paired", { principalId: "principal-fixture" }), 1_001);
  const checking = reduceAttempt(paired, event(paired, "check_existing"), 1_002);
  const waiting = reduceAttempt(checking, event(checking, "login_required"), 1_003);
  assert.equal(waiting.phase, "awaiting_control");
  assert.equal(waiting.principalId, "principal-fixture");
  assert.equal(waiting.verification, null);
  assert.deepEqual(waiting.resume, { state: "none", deliveryId: null });
  assert.equal(waiting.failure, null);
  const starting = reduceAttempt(waiting, event(waiting, "start"), 1_004);
  assert.equal(starting.phase, "starting");
  assert.throws(() => reduceAttempt(paired, event(paired, "login_required"), 1_004), refused("invalid_transition"));
});

test("existing-session evidence still requires matching kind, identity and a live deadline", () => {
  const paired = reduceAttempt(INITIAL, event(INITIAL, "paired", { principalId: "principal-fixture" }), 1_001);
  assert.throws(() => reduceAttempt(INITIAL, event(INITIAL, "check_existing"), 1_001), refused("invalid_transition"));
  assert.throws(() => reduceAttempt(paired, event(paired, "check_existing"), 10_000), refused("deadline_expired"));
  const checking = reduceAttempt(paired, event(paired, "check_existing"), 1_002);
  assert.throws(() => reduceAttempt(checking, event(checking, "verified", { verificationId: "wrong-kind", kind: "oci_cli" }), 1_003), refused("invalid_transition"));
  const proof = event(checking, "verified", { verificationId: "existing-session-receipt", kind: "synthetic" });
  assert.throws(() => reduceAttempt(checking, { ...proof, expected: { ...proof.expected, generation: 2 } }, 1_003), refused("binding_mismatch"));
  assert.throws(() => reduceAttempt(checking, proof, 10_000), refused("deadline_expired"));
  assert.equal(checking.verification, null);
  assert.deepEqual(checking.resume, { state: "none", deliveryId: null });
  assert.equal(attemptEventSchema.safeParse({ ...event(paired, "check_existing"), success: true }).success, false);
});

test("losing an existing-session probe fails without promoting it to verified", () => {
  const paired = reduceAttempt(INITIAL, event(INITIAL, "paired", { principalId: "principal-fixture" }), 1_001);
  const checking = reduceAttempt(paired, event(paired, "check_existing"), 1_002);
  const lost = reduceAttempt(checking, event(checking, "worker_lost"), 1_003);
  assert.equal(lost.phase, "failed");
  assert.equal(lost.failure, "worker_lost");
  assert.equal(lost.verification, null);
  assert.deepEqual(lost.resume, { state: "none", deliveryId: null });
  assert.equal(loginAttemptSchema.safeParse({ ...checking, principalId: null }).success, false);
});
