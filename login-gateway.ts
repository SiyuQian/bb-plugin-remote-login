import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract } from "./host-contract.ts";
import { fixtureInputSchema, frameRefSchema, inputIdSchema } from "./fixture-wire.ts";
import { attemptIdentity, type LoginCoordinator } from "./login-coordinator.ts";
import { matchesBinding, resolveLoginContext } from "./login-context.ts";
import type { AttemptEvent, LoginAttempt } from "./login-protocol.ts";
import { controlPayload } from "./private-http.ts";
import { cliExpectedIdentitySchema } from "./oci-cli-protocol.ts";
import { consoleExpectedIdentitySchema } from "./oci-console-protocol.ts";

const selection = z.object({ attemptId: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/) }).strict();
const session = selection.extend({ key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const input = selection.extend({ event: fixtureInputSchema, inputId: inputIdSchema, frameRef: frameRefSchema }).strict();
const ociTarget = selection.extend({ expected: cliExpectedIdentitySchema }).strict();
const consoleTarget = selection.extend({ expected: consoleExpectedIdentitySchema }).strict();
class Refusal extends Error {
  constructor(readonly status: 403 | 409 | 503) { super("Login control unavailable."); }
}
const scopeOf = (a: LoginAttempt) => ({ threadId: a.threadId, attemptId: a.attemptId, browserContextId: a.browserContextId, generation: a.generation });
function live(a: LoginAttempt): boolean { return !["failed", "cancelled", "expired", "unsupported"].includes(a.phase); }
async function bounded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Refusal(503));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    const result = await Promise.race([pending, cancelled]);
    signal.throwIfAborted();
    return result;
  } finally { signal.removeEventListener("abort", abort); }
}

/** Private, job-scoped channel. There is no caller-supplied host, scope or verification producer. */
export function registerLoginGateway(bb: BbPluginApi, coordinator: LoginCoordinator): void {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const lifecycle = new AbortController();
  bb.onDispose(() => lifecycle.abort());
  const operations = new Set<string>();
  const get = (id: string): LoginAttempt => {
    const a = coordinator.get(id);
    if (!a || !["synthetic", "oci_cli", "oci_web"].includes(a.mode)) throw new Refusal(403);
    return a;
  };
  const unchanged = (a: LoginAttempt, signal: AbortSignal): LoginAttempt => {
    signal.throwIfAborted();
    const current = get(a.attemptId);
    if (current.revision !== a.revision) throw new Refusal(409);
    return current;
  };
  const transition = (a: LoginAttempt, fields: { type: AttemptEvent["type"]; [field: string]: unknown }) =>
    coordinator.apply(a.attemptId, { ...fields, expected: attemptIdentity(a), expectedRevision: a.revision } as AttemptEvent);
  const fail = (a: LoginAttempt, code: "host_changed" | "control_refused" | "provider_failed") => {
    const current = get(a.attemptId);
    if (current.revision === a.revision && live(current)) transition(current, { type: "reject", code });
  };
  const inspect = async (a: LoginAttempt, signal: AbortSignal, allowUnpaired = false) => {
    const context = { projectId: a.projectId, threadId: a.threadId, signal };
    const before = await bounded(resolveLoginContext(bb, context), signal);
    unchanged(a, signal);
    if (!matchesBinding(a, before)) { fail(a, "host_changed"); throw new Refusal(403); }
    const info = await bounded(host.call("controlInfo", null, { hostId: a.hostId, signal }), signal);
    const after = await bounded(resolveLoginContext(bb, context), signal);
    unchanged(a, signal);
    if (!matchesBinding(a, after)) { fail(a, "host_changed"); throw new Refusal(403); }
    if (!info.provisioned || !info.rootId || (!allowUnpaired && info.rootId !== a.principalId)) {
      if (a.principalId !== null) fail(a, "control_refused");
      throw new Refusal(403);
    }
    return info.rootId;
  };
  for (const action of ["status", "session", "oci-target", "oci-status", "console-target", "console-status", "start", "frame", "input", "renew", "handback", "close"] as const) {
    bb.http.route("POST", `/login/${action}`, async (context) => {
      context.header("Cache-Control", "no-store");
      let value: unknown;
      try { value = await controlPayload(context.req.raw); }
      catch { return context.json({ error: "invalid_request" }, 400); }
      const parsed = (action === "session" ? session : action === "input" ? input : action === "oci-target" ? ociTarget : action === "console-target" ? consoleTarget : selection).safeParse(value);
      if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
      const id = parsed.data.attemptId;
      const capability = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(context.req.header("authorization") ?? "")?.[1];
      if (action !== "status" && action !== "session" && !capability) return context.json({ error: "login_control_failed" }, 401);
      if (action !== "status" && operations.has(id)) return context.json({ error: "login_control_failed" }, 409);
      if (action !== "status") operations.add(id);
      const signal = AbortSignal.any([lifecycle.signal, context.req.raw.signal, AbortSignal.timeout(8000)]);
      let mutated: LoginAttempt | undefined;
      try {
        coordinator.activate();
        let a = get(id);
        if (action === "status") return context.json(a);
        if (!live(a) || (a.phase === "verified" && !(a.mode === "oci_web" && action === "close"))) throw new Refusal(409);
        if (action === "session") {
          if (a.phase !== "awaiting_pairing" && a.phase !== "awaiting_control" && !(a.mode === "oci_web" && a.phase === "verifying")) throw new Refusal(409);
          const principalId = await inspect(a, signal, a.principalId === null);
          if (a.principalId === null) a = transition(a, { type: "paired", principalId });
          const result = await bounded(host.call("authenticateControl", { key: session.parse(value).key, scope: scopeOf(a), deadline: a.expiresAt }, { hostId: a.hostId, signal }), signal);
          if (!result.ok) throw new Refusal(403);
          await inspect(a, signal);
          return context.json({ grant: result.grant, attempt: a });
        }
        const allowed = action === "start" || action === "oci-target" || action === "console-target" ? a.phase === "awaiting_control"
          : action === "close" && a.mode === "oci_web" && a.phase === "verified" ? true
          : action === "close" || action === "renew" || action === "oci-status" || action === "console-status" ? ["awaiting_control", "starting", "user_control", "verifying"].includes(a.phase)
          : action === "handback" && a.mode !== "synthetic" ? a.phase === "user_control" || a.phase === "verifying" : a.phase === "user_control";
        if (!allowed) throw new Refusal(409);
        await inspect(a, signal);
        const options = { hostId: a.hostId, signal };
        const proof = { capability: capability!, scope: scopeOf(a) };
        const authorization = await bounded(host.call("authorizeControl", proof, options), signal);
        if (!authorization.ok) throw new Refusal(403);
        await inspect(a, signal);
        if (action === "oci-target") {
          if (a.mode !== "oci_cli") throw new Refusal(409);
          const configured = await bounded(host.call("configureOci", { ...proof, expected: ociTarget.parse(value).expected }, options), signal);
          if (!configured.ok) throw new Refusal(403);
          await inspect(a, signal); return context.json({ configured: true });
        }
        if (action === "console-target") {
          if (a.mode !== "oci_web") throw new Refusal(409);
          const configured = await bounded(host.call("configureConsole", { ...proof, expected: consoleTarget.parse(value).expected }, options), signal);
          if (!configured.ok) throw new Refusal(403);
          await inspect(a, signal); return context.json({ configured: true });
        }
        if (action === "oci-status" || action === "console-status") {
          if (a.mode !== (action === "oci-status" ? "oci_cli" : "oci_web")) throw new Refusal(409);
          const current = await bounded(host.call(a.mode === "oci_web" ? "consoleStatus" : "ociStatus", proof, options), signal);
          if (!current.ok) throw new Refusal(403);
          await inspect(a, signal);
          if (a.phase === "starting" && current.status.phase === "user_control") a = transition(a, { type: "ready" });
          if (current.status.phase === "failed" || current.status.phase === "cancelled") {
            transition(a, { type: "reject", code: "provider_failed" });
          }
          return context.json(current.status);
        }
        if (action === "renew") {
          // The host may consume the old proof even if its reply never arrives.
          // Every later refusal must terminate this exact revision and queue owned cleanup.
          mutated = a;
          const rotated = await bounded(host.call("renewControl", { ...proof, deadline: a.expiresAt }, options), signal);
          if (!rotated.ok || rotated.grant.capability === capability || rotated.grant.expiresAt > a.expiresAt
            || rotated.grant.expiresAt <= Date.now()) throw new Refusal(503);
          await inspect(a, signal);
          const confirmed = await bounded(host.call("authorizeControl", { capability: rotated.grant.capability, scope: scopeOf(a) }, options), signal);
          if (!confirmed.ok) throw new Refusal(503);
          await inspect(a, signal);
          mutated = undefined;
          return context.json(rotated.grant);
        }
        if (action === "start") {
          if (a.mode !== "synthetic") {
            const available = await bounded(host.call(a.mode === "oci_web" ? "consoleStatus" : "ociStatus", proof, options), signal);
            if (!available.ok || !available.status.configured || !available.status.phoneControlAccepted) throw new Refusal(403);
            await inspect(a, signal);
          }
          a = transition(a, { type: "start" }); mutated = a;
          const opened = await bounded(host.call(a.mode === "oci_web" ? "startConsole" : a.mode === "oci_cli" ? "startOci" : "startFixture", proof, options), signal);
          if (!opened.ok) throw new Refusal(503);
          await inspect(a, signal);
          if (a.mode !== "synthetic") { mutated = undefined; return context.json({ pending: true }, 202); }
          a = transition(a, { type: "ready" }); mutated = undefined;
          return context.json(opened.viewport);
        }
        if (action === "handback") {
          if (a.phase === "user_control") a = transition(a, { type: "handback" });
          mutated = a;
          if (a.mode === "oci_web") {
            const result = await bounded(host.call("handbackConsole", proof, options), signal);
            if (!result.ok) throw new Refusal(503);
            await inspect(a, signal);
            if (result.result.phase === "verifying" || result.result.phase === "starting" || result.result.phase === "user_control") {
              mutated = undefined; return context.json({ pending: true }, 202);
            }
            if (!result.result.verified || !result.result.receipt || result.result.phase !== "verified") throw new Refusal(503);
            const authorized = await bounded(host.call("authorizeControl", proof, options), signal);
            if (!authorized.ok) throw new Refusal(503);
            await inspect(a, signal);
            const resume = await bounded(host.call("consoleResumeProof", { scope: scopeOf(a), receipt: result.result.receipt }, options), signal);
            if (!resume.ok || resume.browserRef !== result.result.browserRef) throw new Refusal(503);
            await inspect(a, signal);
            if (resume.expiresAt <= Date.now() || resume.expiresAt > a.expiresAt) throw new Refusal(503);
            transition(a, { type: "verified", verificationId: result.result.receipt, kind: "oci_web" }); mutated = undefined;
            return context.json({ verified: true });
          }
          if (a.mode === "oci_cli") {
            const result = await bounded(host.call("handbackOci", proof, options), signal);
            if (!result.ok) throw new Refusal(503);
            await inspect(a, signal);
            if (result.result.phase === "verifying" || result.result.phase === "starting" || result.result.phase === "user_control") {
              mutated = undefined; return context.json({ pending: true }, 202);
            }
            if (!result.result.verified || !result.result.receipt || result.result.phase !== "verified") throw new Refusal(503);
            const authorized = await bounded(host.call("authorizeControl", proof, options), signal);
            if (!authorized.ok) throw new Refusal(503);
            await inspect(a, signal);
            const resume = await bounded(host.call("ociResumeProof", { scope: scopeOf(a), receipt: result.result.receipt }, options), signal);
            if (!resume.ok || resume.accountRef !== result.result.accountRef) throw new Refusal(503);
            await inspect(a, signal);
            if (resume.expiresAt <= Date.now() || resume.expiresAt > a.expiresAt) throw new Refusal(503);
            transition(a, { type: "verified", verificationId: result.result.receipt, kind: "oci_cli" }); mutated = undefined;
            return context.json({ verified: true });
          }
          const checked = await bounded(host.call("completePhoneFixture", proof, options), signal);
          if (!checked.ok) throw new Refusal(503);
          await inspect(a, signal);
          if (!checked.verified) {
            transition(a, { type: "verification_retry" }); mutated = undefined;
            throw new Refusal(409);
          }
          const authorized = await bounded(host.call("authorizeControl", proof, options), signal);
          if (!authorized.ok) throw new Refusal(503);
          await inspect(a, signal);
          transition(a, { type: "verified", verificationId: randomUUID(), kind: "synthetic" }); mutated = undefined;
          return context.json({ verified: true });
        }
        if (action === "close") {
          // Persist cancellation first so in-flight results and original-call continuations lose authority immediately.
          const beforeOciStart = a.mode !== "synthetic" && a.phase === "awaiting_control";
          a = transition(a, { type: "cancel" });
          const closed = await bounded(host.call(beforeOciStart ? "revokeControl" : a.mode === "oci_web" ? "closeConsole" : a.mode === "oci_cli" ? "closeOci" : "closeFixture", proof, options), signal);
          if (!closed.ok) throw new Refusal(503);
          unchanged(a, signal);
          coordinator.acknowledgeCleanup(a.attemptId);
          return context.json({ closed: true });
        }
        const result = action === "frame" ? await bounded(host.call(a.mode === "oci_web" ? "frameConsole" : a.mode === "oci_cli" ? "frameOci" : "frameFixture", proof, options), signal)
          : await bounded(host.call(a.mode === "oci_web" ? "inputConsole" : a.mode === "oci_cli" ? "inputOci" : "inputFixture", { ...proof, event: input.parse(value).event, inputId: input.parse(value).inputId, frameRef: input.parse(value).frameRef }, options), signal);
        if (!result.ok) {
          if ((action === "input" || action === "frame") && result.reason === "stale_frame") {
            await inspect(a, signal);
            return context.json({ error: "stale_frame" }, 409);
          }
          throw new Refusal(result.reason === "busy" ? 409 : 403);
        }
        await inspect(a, signal);
        return "frame" in result ? context.json(result.frame) : context.json({ accepted: true });
      } catch (error) {
        if (mutated) { try { fail(mutated, "provider_failed"); } catch { /* A replacement owner or concurrent terminal transition owns cleanup. */ } }
        return context.json({ error: "login_control_failed" }, error instanceof Refusal ? error.status : 503);
      } finally { if (action !== "status") operations.delete(id); }
    }, { auth: "local" });
  }
}
