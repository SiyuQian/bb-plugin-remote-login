import type { BbPluginApi, PluginAgentToolContext, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract } from "./host-contract.ts";
import { attemptIdentity, LoginCoordinatorError, type LoginCoordinator } from "./login-coordinator.ts";
import { matchesBinding, resolveLoginContext, type LoginBinding } from "./login-context.ts";
import type { AttemptIdentity, LoginAttempt, LoginMode } from "./login-protocol.ts";
import { ociReadRequestSchema } from "./oci-read-wire.ts";
import { consoleReadRequestSchema } from "./oci-console-wire.ts";

type RefusalCode = "unavailable" | "binding_changed" | "aborted";
class ToolRefusal extends Error {
  constructor(readonly code: RefusalCode) { super("Login request unavailable."); }
}
const attemptSelection = z.object({ attemptId: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/) }).strict();

function metadata(a: LoginAttempt, isError = false, accountRef?: string, browserRef?: string): PluginAgentToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ attemptId: a.attemptId, mode: a.mode, phase: a.phase,
      hostId: a.hostId, expiresAt: a.expiresAt, resume: a.resume.state, ...(accountRef ? { accountRef } : {}), ...(browserRef ? { browserRef } : {}) }) }],
    ...(isError ? { isError: true } : {}),
  };
}
function progressable(a: LoginAttempt): boolean {
  return !["cancelled", "expired", "failed", "unsupported"].includes(a.phase) && a.resume.state !== "delivered";
}
function matchesIdentity(a: AttemptIdentity, b: AttemptIdentity): boolean {
  return (Object.keys(a) as Array<keyof AttemptIdentity>).every((key) => a[key] === b[key]);
}
function bounded<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new ToolRefusal("unavailable")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    const finish = <V>(settle: (value: V) => void, value: V): void => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) abort(); else settle(value);
    };
    try { operation().then((value) => finish(resolve, value), (error: unknown) => finish(reject, error)); }
    catch (error) { finish(reject, error); }
  });
}

/** Registration is inert: only committed native-tool executions activate durable ownership. */
export function registerLoginTools(bb: BbPluginApi, coordinator: LoginCoordinator): void {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const bindingFor = (context: PluginAgentToolContext): Promise<LoginBinding> => {
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(8000)]);
    return bounded(signal, () => resolveLoginContext(bb, { ...context, signal }));
  };
  const rootFor = (hostId: string, context: PluginAgentToolContext) => {
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(8000)]);
    return bounded(signal, () => host.call("controlInfo", null, { hostId, signal }));
  };
  const liveReference = async (a: LoginAttempt, reference: string | undefined, signal: AbortSignal): Promise<number> => {
    if (a.mode === "synthetic" || !a.verification || !reference) throw new ToolRefusal("unavailable");
    const proof = await bounded(signal, () => host.call(a.mode === "oci_cli" ? "ociResumeProof" : "consoleResumeProof", {
      receipt: a.verification!.id,
      scope: { threadId: a.threadId, attemptId: a.attemptId, browserContextId: a.browserContextId, generation: a.generation },
    }, { hostId: a.hostId, signal }));
    if (!proof.ok || (a.mode === "oci_cli" ? !("accountRef" in proof) || proof.accountRef !== reference
      : !("browserRef" in proof) || proof.browserRef !== reference)
      || proof.expiresAt <= Date.now() || proof.expiresAt > a.expiresAt) throw new ToolRefusal("unavailable");
    return proof.expiresAt;
  };
  const execute = async (context: PluginAgentToolContext, operation: () => Promise<PluginAgentToolResult>): Promise<PluginAgentToolResult> => {
    try {
      if (context.signal.aborted) throw new ToolRefusal("aborted");
      coordinator.activate();
      const result = await operation();
      if (context.signal.aborted) throw new ToolRefusal("aborted");
      return result;
    } catch (error) {
      const code: RefusalCode = context.signal.aborted ? "aborted" : error instanceof ToolRefusal ? error.code
        : error instanceof LoginCoordinatorError && error.code === "binding_changed" ? "binding_changed" : "unavailable";
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code }) }] };
    }
  };
  const owned = (attemptId: string, context: PluginAgentToolContext): LoginAttempt => {
    const a = coordinator.get(attemptId);
    if (!a || a.projectId !== context.projectId || a.threadId !== context.threadId) throw new ToolRefusal("unavailable");
    return a;
  };
  const rejectMoved = (a: LoginAttempt): void => {
    if (progressable(a)) coordinator.apply(a.attemptId, {
      type: "reject", code: "host_changed", expected: attemptIdentity(a), expectedRevision: a.revision,
    });
  };
  const currentJob = async (attemptId: string, context: PluginAgentToolContext): Promise<LoginAttempt> => {
    owned(attemptId, context);
    const observed = await bindingFor(context);
    // Another execution can change the revision while the SDK requests are pending.
    const a = owned(attemptId, context);
    if (!matchesBinding(a, observed)) {
      rejectMoved(a);
      throw new ToolRefusal("binding_changed");
    }
    return a;
  };
  const rejectWaitingOn = (binding: LoginBinding, mode: LoginMode): void => {
    for (const a of coordinator.list(binding.projectId, binding.threadId)) {
      if (a.mode === mode && matchesBinding(a, binding)) rejectMoved(a);
    }
  };
  const waitForVerified = async (initial: LoginAttempt, context: PluginAgentToolContext): Promise<PluginAgentToolResult> => {
    if (initial.phase === "verified" && initial.resume.state !== "pending") throw new ToolRefusal("unavailable");
    const remainingMs = coordinator.remainingMs(initial.attemptId);
    if (remainingMs <= 0) throw new ToolRefusal("unavailable");
    const deadline = AbortSignal.timeout(remainingMs);
    const signal = AbortSignal.any([context.signal, deadline]);
    const waitingContext = { ...context, signal };
    const cancel = (): void => {
      const a = owned(initial.attemptId, context);
      if (progressable(a)) coordinator.apply(a.attemptId, {
        type: "cancel", expected: attemptIdentity(a), expectedRevision: a.revision,
      });
    };
    const stop = (): void => {
      if (deadline.aborted && !context.signal.aborted) owned(initial.attemptId, context);
      else cancel();
    };
    const onAbort = (): void => {
      try { stop(); }
      catch { /* A replaced owner cannot cancel or resume through an old callback. */ }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal.aborted) { stop(); throw new ToolRefusal("unavailable"); }
      let interaction;
      try {
        interaction = await bounded(signal, () => bb.ui.requestInput({
          threadId: context.threadId,
          rendererId: "login-control",
          title: initial.mode === "oci_cli" ? "远程登录：等待 OCI CLI 授权核验" : initial.mode === "oci_web" ? "远程登录：等待 OCI Console 身份核验" : "远程登录：等待受保护的测试验证",
          payload: { attemptId: initial.attemptId },
          timeoutMs: remainingMs,
          describeSubmission: () => ({ title: "已请求检查测试验证" }),
        }, { signal }));
      } catch {
        stop();
        throw new ToolRefusal("unavailable");
      }
      if (signal.aborted || interaction.outcome === "cancelled") {
        stop();
        throw new ToolRefusal(context.signal.aborted ? "aborted" : "unavailable");
      }
      // Public submission only asks us to recheck the independently verified durable record.
      const before = await currentJob(initial.attemptId, waitingContext);
      const expected = attemptIdentity(initial);
      if (expected.principalId === null) expected.principalId = before.principalId;
      if (!matchesIdentity(expected, attemptIdentity(before))) {
        rejectMoved(before);
        throw new ToolRefusal("binding_changed");
      }
      const info = await rootFor(before.hostId, waitingContext);
      const a = await currentJob(initial.attemptId, waitingContext);
      if (!matchesIdentity(attemptIdentity(before), attemptIdentity(a))
        || !info.provisioned || !info.rootId || info.rootId !== a.principalId) {
        rejectMoved(a);
        throw new ToolRefusal("binding_changed");
      }
      if (signal.aborted) throw new ToolRefusal("unavailable");
      if (a.phase !== "verified" || a.verification?.kind !== a.mode || a.resume.state !== "pending") {
        throw new ToolRefusal("unavailable");
      }
      let current = a, accountRef: string | undefined, browserRef: string | undefined, resourceExpiry: number | undefined;
      if (a.mode === "oci_cli") {
        const proof = await bounded(signal, () => host.call("ociResumeProof", { receipt: a.verification!.id,
          scope: { threadId: a.threadId, attemptId: a.attemptId, browserContextId: a.browserContextId, generation: a.generation },
        }, { hostId: a.hostId, signal }));
        if (!proof.ok) throw new ToolRefusal("unavailable");
        current = await currentJob(a.attemptId, waitingContext);
        if (current.revision !== a.revision || current.phase !== "verified" || current.resume.state !== "pending"
          || current.verification?.id !== a.verification?.id || proof.expiresAt <= Date.now()
          || proof.expiresAt > current.expiresAt) throw new ToolRefusal("unavailable");
        accountRef = proof.accountRef;
        resourceExpiry = proof.expiresAt;
      }
      if (a.mode === "oci_web") {
        const proof = await bounded(signal, () => host.call("consoleResumeProof", { receipt: a.verification!.id,
          scope: { threadId: a.threadId, attemptId: a.attemptId, browserContextId: a.browserContextId, generation: a.generation },
        }, { hostId: a.hostId, signal }));
        if (!proof.ok) throw new ToolRefusal("unavailable");
        current = await currentJob(a.attemptId, waitingContext);
        if (current.revision !== a.revision || current.phase !== "verified" || current.resume.state !== "pending"
          || current.verification?.id !== a.verification?.id || proof.expiresAt <= Date.now()
          || proof.expiresAt > current.expiresAt) throw new ToolRefusal("unavailable");
        browserRef = proof.browserRef;
        resourceExpiry = proof.expiresAt;
      }
      const finalRoot = await rootFor(current.hostId, waitingContext);
      const final = await currentJob(current.attemptId, waitingContext);
      if (!finalRoot.provisioned || finalRoot.rootId !== final.principalId) {
        rejectMoved(final); throw new ToolRefusal("binding_changed");
      }
      if (final.revision !== current.revision || final.phase !== "verified" || final.resume.state !== "pending"
        || final.verification?.id !== current.verification?.id || (resourceExpiry !== undefined
          && (resourceExpiry <= Date.now() || resourceExpiry > final.expiresAt))) throw new ToolRefusal("unavailable");
      current = final;
      if (current.mode !== "synthetic") {
        // The last asynchronous boundary must recheck the live private authority, including root-file generation.
        await liveReference(current, current.mode === "oci_cli" ? accountRef : browserRef, signal);
      }
      return metadata(coordinator.prepareResume(current.attemptId, attemptIdentity(current), current.revision), false, accountRef, browserRef);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };

  bb.agents.registerTool({
    name: "remote_login_request",
    description: "Request a remote login job on the current thread's actual host. Synthetic tests private control; OCI CLI and Console queue separately gated owner-controlled authorization and independent verification. wait=true waits for matching evidence. Console requires macOS arm64 and the pinned Chrome/Console build. Requesting does not authenticate an account.",
    parameters: z.object({ mode: z.enum(["synthetic", "oci_cli", "oci_web"]), wait: z.boolean().optional() }).strict(),
    execute: ({ mode, wait }, context) => execute(context, async () => {
      const binding = await bindingFor(context);
      const info = await rootFor(binding.hostId, context);
      const compatibilitySignal = AbortSignal.any([context.signal, AbortSignal.timeout(8000)]);
      const capabilities = mode !== "synthetic" ? await bounded(compatibilitySignal, () => host.call("inspectLoginCapabilities", null,
        { hostId: binding.hostId, signal: compatibilitySignal })) : null;
      const observed = await bindingFor(context);
      if (!matchesBinding(binding, observed)) {
        rejectWaitingOn(binding, mode);
        throw new ToolRefusal("binding_changed");
      }
      if (info.provisioned && !info.rootId) throw new ToolRefusal("unavailable");
      let a = coordinator.request({ ...binding, principalId: info.provisioned ? info.rootId : null, mode });
      if (mode !== "synthetic" && capabilities?.providers.find(provider => provider.id === mode)?.availability !== "candidate") {
        a = coordinator.apply(a.attemptId, { type: "reject", code: "unsupported", expected: attemptIdentity(a), expectedRevision: a.revision });
        return metadata(a, true);
      }
      return wait ? waitForVerified(a, context) : metadata(a);
    }),
  });
  bb.agents.registerTool({
    name: "remote_login_oci_read",
    description: "Use the current thread's verified OCI CLI session for a bounded read task. List up to 25 accessible compartments or Sydney instances. Omit compartmentRef for root-compartment instances, or use an opaque reference returned by this session. Results indicate truncation. Requires the accountRef from the original completed login call; accepts no command, endpoint, account identifier or credential.",
    parameters: attemptSelection.extend({ accountRef: z.string().uuid(), request: ociReadRequestSchema }).strict(),
    execute: ({ attemptId, accountRef, request }, context) => execute(context, async () => {
      const original = await currentJob(attemptId, context);
      const authorized = (a: LoginAttempt) => a.phase === "verified" && a.mode === "oci_cli" && a.verification?.kind === "oci_cli"
        && a.resume.state === "uncertain" && a.revision === original.revision && a.verification.id === original.verification?.id;
      if (!authorized(original)) throw new ToolRefusal("unavailable");
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(8000), AbortSignal.timeout(coordinator.remainingMs(attemptId))]);
      const working = { ...context, signal };
      const info = await rootFor(original.hostId, working);
      let current = await currentJob(attemptId, working);
      if (!info.provisioned || info.rootId !== current.principalId) { rejectMoved(current); throw new ToolRefusal("binding_changed"); }
      if (!authorized(current)) throw new ToolRefusal("unavailable");
      const selection = { scope: { threadId: current.threadId, attemptId, browserContextId: current.browserContextId, generation: current.generation },
        receipt: current.verification!.id, accountRef };
      const read = await bounded(signal, () => host.call("readOciTask", { ...selection, request }, { hostId: current.hostId, signal }));
      if (!read.ok || read.result.operation !== request.operation) throw new ToolRefusal("unavailable");
      current = await currentJob(attemptId, working);
      if (!authorized(current)) throw new ToolRefusal("unavailable");
      const proof = await bounded(signal, () => host.call("ociResumeProof", { scope: selection.scope, receipt: selection.receipt }, { hostId: current.hostId, signal }));
      if (!proof.ok || proof.accountRef !== accountRef) throw new ToolRefusal("unavailable");
      const finalRoot = await rootFor(original.hostId, working);
      current = await currentJob(attemptId, working);
      if (!finalRoot.provisioned || finalRoot.rootId !== current.principalId) { rejectMoved(current); throw new ToolRefusal("binding_changed"); }
      const expiresAt = Math.min(read.expiresAt, proof.expiresAt, await liveReference(current, accountRef, signal));
      if (!authorized(owned(attemptId, context)) || expiresAt <= Date.now() || read.expiresAt > current.expiresAt || proof.expiresAt > current.expiresAt) throw new ToolRefusal("unavailable");
      const output = JSON.stringify({ attemptId, ...read.result, expiresAt });
      if (Buffer.byteLength(output, "utf8") > 65536) throw new ToolRefusal("unavailable");
      return { content: [{ type: "text", text: output }] };
    }),
  });
  bb.agents.registerTool({
    name: "remote_login_console_read",
    description: "Read the current thread's retained, independently verified OCI Console browser. read_identity verifies the expected user, tenancy and domain. read_page returns only the current title and up to 20 headings after fresh identity checks. Requires the browserRef from the original login result. Accepts no URL, script, DOM selector, command or credential.",
    parameters: attemptSelection.extend({ browserRef: z.string().uuid(), request: consoleReadRequestSchema }).strict(),
    execute: ({ attemptId, browserRef, request }, context) => execute(context, async () => {
      const original = await currentJob(attemptId, context);
      const authorized = (a: LoginAttempt) => a.phase === "verified" && a.mode === "oci_web" && a.verification?.kind === "oci_web"
        && a.resume.state === "uncertain" && a.revision === original.revision && a.verification.id === original.verification?.id;
      if (!authorized(original)) throw new ToolRefusal("unavailable");
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(8000), AbortSignal.timeout(coordinator.remainingMs(attemptId))]);
      const working = { ...context, signal };
      const info = await rootFor(original.hostId, working);
      let current = await currentJob(attemptId, working);
      if (!info.provisioned || info.rootId !== current.principalId) { rejectMoved(current); throw new ToolRefusal("binding_changed"); }
      if (!authorized(current)) throw new ToolRefusal("unavailable");
      const selection = { scope: { threadId: current.threadId, attemptId, browserContextId: current.browserContextId, generation: current.generation },
        receipt: current.verification!.id, browserRef };
      const read = await bounded(signal, () => host.call("readConsoleTask", { ...selection, request }, { hostId: current.hostId, signal }));
      if (!read.ok || read.result.operation !== request.operation) throw new ToolRefusal("unavailable");
      current = await currentJob(attemptId, working);
      if (!authorized(current)) throw new ToolRefusal("unavailable");
      const proof = await bounded(signal, () => host.call("consoleResumeProof", { scope: selection.scope, receipt: selection.receipt }, { hostId: current.hostId, signal }));
      if (!proof.ok || proof.browserRef !== browserRef) throw new ToolRefusal("unavailable");
      const finalRoot = await rootFor(original.hostId, working);
      current = await currentJob(attemptId, working);
      if (!finalRoot.provisioned || finalRoot.rootId !== current.principalId) { rejectMoved(current); throw new ToolRefusal("binding_changed"); }
      if (!authorized(current) || Math.min(read.expiresAt, proof.expiresAt) <= Date.now()
        || read.expiresAt > current.expiresAt || proof.expiresAt > current.expiresAt) throw new ToolRefusal("unavailable");
      const expiresAt = Math.min(read.expiresAt, proof.expiresAt, await liveReference(current, browserRef, signal));
      if (!authorized(owned(attemptId, context)) || expiresAt <= Date.now()) throw new ToolRefusal("unavailable");
      const output = JSON.stringify({ attemptId, ...read.result, expiresAt });
      if (Buffer.byteLength(output, "utf8") > 16384) throw new ToolRefusal("unavailable");
      return { content: [{ type: "text", text: output }] };
    }),
  });
  bb.agents.registerTool({
    name: "remote_login_status",
    description: "Read a remote login job owned by the current thread. Job phase is not proof of an account login.",
    parameters: attemptSelection,
    execute: ({ attemptId }, context) => execute(context, async () => metadata(await currentJob(attemptId, context))),
  });
  bb.agents.registerTool({
    name: "remote_login_cancel",
    description: "Record cancellation of a remote login job owned by the current thread. Browser cleanup can remain pending; cancellation does not confirm that resources are gone.",
    parameters: attemptSelection,
    execute: ({ attemptId }, context) => execute(context, async () => {
      const a = await currentJob(attemptId, context);
      return metadata(progressable(a) ? coordinator.apply(a.attemptId, {
        type: "cancel", expected: attemptIdentity(a), expectedRevision: a.revision,
      }) : a);
    }),
  });
}
