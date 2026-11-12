import { z } from "zod";
import { browserControlModeSchema } from "./browser-control.ts";

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const modeSchema = z.enum(["synthetic", "oci_cli", "oci_web"]);
const phaseSchema = z.enum([
  "awaiting_pairing", "awaiting_control", "checking_existing", "starting", "user_control", "verifying", "verified",
  "cancelled", "expired", "failed", "unsupported",
]);
const failureSchema = z.enum([
  "unsupported", "control_refused", "provider_failed", "worker_lost", "deadline_expired", "cancelled",
  "pairing_required", "host_changed", "verification_failed", "internal_error",
]);
export type LoginMode = z.infer<typeof modeSchema>;
export type AttemptPhase = z.infer<typeof phaseSchema>;
export type LoginFailureCode = z.infer<typeof failureSchema>;

const identitySchema = z.object({
  attemptId: id, projectId: id, threadId: id, environmentId: id, hostId: id, browserContextId: id,
  generation: integer, principalId: id.nullable(),
}).strict();
export type AttemptIdentity = z.infer<typeof identitySchema>;

function stopped(phase: AttemptPhase): boolean {
  return phase === "cancelled" || phase === "expired" || phase === "failed" || phase === "unsupported";
}

/** Non-secret durable attempt record; provider evidence is a bounded identifier only. */
export const loginAttemptSchema = identitySchema.extend({
  version: z.literal(1), mode: modeSchema, controlMode: browserControlModeSchema.optional(), phase: phaseSchema, revision: integer,
  createdAt: integer, updatedAt: integer, expiresAt: integer,
  verification: z.object({ id, kind: modeSchema, verifiedAt: integer }).strict().nullable(),
  resume: z.object({
    state: z.enum(["none", "pending", "claimed", "uncertain", "delivered"]), deliveryId: id.nullable(),
  }).strict(),
  failure: failureSchema.nullable(),
}).superRefine((attempt, context) => {
  const invalid = () => context.addIssue({ code: "custom", message: "Invalid attempt state." });
  const terminal = stopped(attempt.phase);
  if (attempt.updatedAt < attempt.createdAt || attempt.expiresAt <= attempt.createdAt) invalid();
  if (attempt.phase === "expired" && attempt.updatedAt < attempt.expiresAt) invalid();
  if (!terminal && attempt.phase !== "verified" && attempt.updatedAt >= attempt.expiresAt) invalid();
  if (attempt.phase === "awaiting_pairing" ? attempt.principalId !== null : !terminal && attempt.principalId === null) invalid();
  if (attempt.verification) {
    const proof = attempt.verification;
    if ((!terminal && attempt.phase !== "verified") || attempt.principalId === null || proof.kind !== attempt.mode
      || proof.verifiedAt < attempt.createdAt || proof.verifiedAt > attempt.updatedAt || proof.verifiedAt >= attempt.expiresAt) invalid();
  } else if (attempt.phase === "verified") invalid();
  if (attempt.resume.state === "none" || attempt.resume.state === "pending") {
    if (attempt.resume.deliveryId !== null) invalid();
  } else if (attempt.resume.deliveryId === null || attempt.verification === null) invalid();
  if (attempt.resume.state === "pending" || attempt.resume.state === "claimed") {
    if (attempt.phase !== "verified" || attempt.updatedAt >= attempt.expiresAt) invalid();
  }
  if (!terminal && attempt.phase !== "verified" && attempt.resume.state !== "none") invalid();
  if (attempt.phase === "verified" && attempt.resume.state === "none") invalid();
  const failures: Partial<Record<AttemptPhase, LoginFailureCode>> = {
    cancelled: "cancelled", expired: "deadline_expired", unsupported: "unsupported",
  };
  if (attempt.phase === "failed") {
    if (attempt.failure === null || attempt.failure === "unsupported") invalid();
  } else if (attempt.failure !== (failures[attempt.phase] ?? null)) invalid();
});
export type LoginAttempt = z.infer<typeof loginAttemptSchema>;

const eventBase = z.object({ expected: identitySchema, expectedRevision: integer }).strict();
/** Internal trusted-producer commands; no UI flag establishes principal or verification. */
export const attemptEventSchema = z.discriminatedUnion("type", [
  eventBase.extend({ type: z.literal("paired"), principalId: id }),
  eventBase.extend({ type: z.literal("check_existing") }),
  eventBase.extend({ type: z.literal("login_required") }),
  eventBase.extend({ type: z.literal("select_control"), controlMode: browserControlModeSchema }),
  eventBase.extend({ type: z.literal("start"), controlMode: browserControlModeSchema.optional() }),
  eventBase.extend({ type: z.literal("ready") }),
  eventBase.extend({ type: z.literal("handback") }),
  eventBase.extend({ type: z.literal("verification_retry") }),
  eventBase.extend({ type: z.literal("verified"), verificationId: id, kind: modeSchema }),
  eventBase.extend({ type: z.literal("reject"), code: failureSchema }),
  eventBase.extend({ type: z.literal("cancel") }),
  eventBase.extend({ type: z.literal("expire") }),
  eventBase.extend({ type: z.literal("worker_lost") }),
  eventBase.extend({ type: z.literal("resume_claim"), deliveryId: id }),
  eventBase.extend({ type: z.literal("resume_uncertain") }),
  eventBase.extend({ type: z.literal("resume_delivered") }),
]);
export type AttemptEvent = z.infer<typeof attemptEventSchema>;

type ProtocolCode = "invalid_attempt" | "invalid_event" | "binding_mismatch" | "stale_revision"
  | "invalid_transition" | "deadline_expired" | "invalid_time";
/** Fixed refusal only; submitted data and backend exceptions are never attached. */
export class LoginProtocolError extends Error {
  constructor(readonly code: ProtocolCode) {
    super("Login protocol refused.");
    this.name = "LoginProtocolError";
  }
}
function fail(code: ProtocolCode): never { throw new LoginProtocolError(code); }

/** Applies one well-bound trusted event without I/O or mutation of its inputs. */
export function reduceAttempt(input: LoginAttempt, command: AttemptEvent, now: number): LoginAttempt {
  const record = loginAttemptSchema.safeParse(input);
  if (!record.success) fail("invalid_attempt");
  const parsed = attemptEventSchema.safeParse(command);
  if (!parsed.success) fail("invalid_event");
  const attempt = record.data;
  const event = parsed.data;
  for (const field of Object.keys(event.expected) as Array<keyof AttemptIdentity>) {
    if (event.expected[field] !== attempt[field]) fail("binding_mismatch");
  }
  if (event.expectedRevision !== attempt.revision) fail("stale_revision");
  if (!Number.isSafeInteger(now) || now < attempt.updatedAt) fail("invalid_time");
  if ((event.type === "cancel" && attempt.phase === "cancelled")
    || (event.type === "expire" && attempt.phase === "expired")) return attempt;
  const receipt = event.type === "resume_uncertain" || event.type === "resume_delivered";
  if (now >= attempt.expiresAt && event.type !== "expire" && !receipt) fail("deadline_expired");
  if (attempt.resume.state === "delivered" || (stopped(attempt.phase) && !receipt)) fail("invalid_transition");
  if (attempt.revision === Number.MAX_SAFE_INTEGER) fail("invalid_transition");
  const next: LoginAttempt = { ...attempt, revision: attempt.revision + 1, updatedAt: now, resume: { ...attempt.resume } };
  const finish = (phase: AttemptPhase, failure: LoginFailureCode) => {
    next.phase = phase;
    next.failure = failure;
    next.resume = attempt.resume.state === "claimed" || attempt.resume.state === "uncertain"
      ? { state: "uncertain", deliveryId: attempt.resume.deliveryId }
      : { state: "none", deliveryId: null };
  };
  switch (event.type) {
    case "paired":
      if (attempt.phase !== "awaiting_pairing") fail("invalid_transition");
      next.principalId = event.principalId;
      next.phase = "awaiting_control";
      break;
    case "check_existing":
      if (attempt.phase !== "awaiting_control") fail("invalid_transition");
      next.phase = "checking_existing";
      break;
    case "login_required":
      if (attempt.phase !== "checking_existing") fail("invalid_transition");
      next.phase = "awaiting_control";
      break;
    case "select_control":
      if (attempt.phase !== "awaiting_control" || (attempt.controlMode !== undefined && attempt.controlMode !== event.controlMode)) fail("invalid_transition");
      next.controlMode = event.controlMode;
      break;
    case "start":
      if (attempt.phase !== "awaiting_control") fail("invalid_transition");
      if (attempt.controlMode !== undefined && event.controlMode !== undefined && attempt.controlMode !== event.controlMode) fail("invalid_transition");
      if (event.controlMode !== undefined) next.controlMode = event.controlMode;
      next.phase = "starting";
      break;
    case "ready":
      if (attempt.phase !== "starting") fail("invalid_transition");
      next.phase = "user_control";
      break;
    case "handback":
      if (attempt.phase !== "user_control") fail("invalid_transition");
      next.phase = "verifying";
      break;
    case "verified":
      if ((attempt.phase !== "verifying" && attempt.phase !== "checking_existing") || event.kind !== attempt.mode) fail("invalid_transition");
      next.phase = "verified";
      next.verification = { id: event.verificationId, kind: event.kind, verifiedAt: now };
      next.resume = { state: "pending", deliveryId: null };
      break;
    case "verification_retry":
      if (attempt.phase !== "verifying") fail("invalid_transition");
      next.phase = "user_control";
      break;
    case "reject":
      finish(event.code === "unsupported" ? "unsupported" : "failed", event.code);
      break;
    case "cancel":
      finish("cancelled", "cancelled");
      break;
    case "expire":
      if (now < attempt.expiresAt) fail("invalid_transition");
      finish("expired", "deadline_expired");
      break;
    case "worker_lost":
      finish("failed", "worker_lost");
      break;
    case "resume_claim":
      if (attempt.phase !== "verified" || attempt.resume.state !== "pending") fail("invalid_transition");
      next.resume = { state: "claimed", deliveryId: event.deliveryId };
      break;
    case "resume_uncertain":
      if (attempt.verification === null || attempt.resume.state !== "claimed") fail("invalid_transition");
      next.resume.state = "uncertain";
      break;
    case "resume_delivered":
      if (attempt.verification === null || (attempt.resume.state !== "claimed" && attempt.resume.state !== "uncertain")) fail("invalid_transition");
      next.resume.state = "delivered";
      break;
  }
  const result = loginAttemptSchema.safeParse(next);
  if (!result.success) fail("invalid_transition");
  return result.data;
}
