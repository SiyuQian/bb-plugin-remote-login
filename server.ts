import { defineRpcContract, type BbPluginApi, type PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract } from "./host-contract.ts";
import { controlCheckReceiptSchema, controlScopeSchema } from "./control-wire.ts";
import { probeControlChannel } from "./control-client.ts";
import { fixtureInputSchema, frameRefSchema, inputIdSchema } from "./fixture-wire.ts";
import { loginAttemptSchema } from "./login-protocol.ts";
import { LoginCoordinator } from "./login-coordinator.ts";
import { registerLoginTools } from "./login-tools.ts";
import { registerLoginRuntime } from "./login-runtime.ts";
import { registerLoginGateway } from "./login-gateway.ts";
import { controlPayload } from "./private-http.ts";
import { loginCapabilitiesSchema } from "./provider-wire.ts";

const hostSelection = z.object({ hostId: z.string().trim().min(1).max(200) }).strict();
const controlTarget = hostSelection.extend({ scope: controlScopeSchema }).strict();
const controlSession = controlTarget.extend({ key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const fixtureInput = controlTarget.extend({ event: fixtureInputSchema, inputId: inputIdSchema, frameRef: frameRefSchema }).strict();

export const rpcContract = defineRpcContract({
  loginCapabilities: { input: hostSelection, output: z.object({ hostId: z.string(), report: loginCapabilitiesSchema }).strict() },
  callerInfo: {
    input: z.null(),
    output: z.object({ kind: z.enum(["client", "plugin"]), humanVerified: z.literal(false) }).strict(),
  },
  inspectHost: {
    input: z.object({ hostId: z.string().trim().min(1).max(200) }).strict(),
    output: z.object({ hostId: z.string(), runtime: hostContract.inspectRuntime.output }).strict(),
  },
  ociCompatibility: {
    input: hostSelection,
    output: z.object({ hostId: z.string(), compatibility: hostContract.inspectOciCompatibility.output }).strict(),
  },
  hostChoices: {
    input: z.null(),
    output: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
  },
  controlStatus: {
    input: hostSelection,
    output: z.object({ hostId: z.string(), provisioned: z.boolean(), rootId: z.string().nullable(), lastCheck: controlCheckReceiptSchema.nullable() }).strict(),
  },
  loginAttempts: {
    input: z.object({ threadId: z.string().min(1).max(200) }).strict(),
    output: z.array(loginAttemptSchema),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const coordinator = new LoginCoordinator(bb.storage);
  registerLoginTools(bb, coordinator);
  registerLoginRuntime(bb, coordinator);
  registerLoginGateway(bb, coordinator);
  const isJobScope = (scope: z.infer<typeof controlScopeSchema>): boolean => {
    coordinator.activate();
    return coordinator.get(scope.attemptId) !== null;
  };
  const receiptKey = (hostId: string) => `control-check/v1/${encodeURIComponent(hostId)}`;
  const receiptWrites = new Map<string, Promise<void>>();
  const recordCheck = async (hostId: string, scope: z.infer<typeof controlScopeSchema>) => {
    const checkedAt = Date.now();
    // Serialize per host so an earlier, delayed write cannot replace a later check.
    const write = (receiptWrites.get(hostId) ?? Promise.resolve()).catch(() => {}).then(() =>
      bb.storage.kv.set(receiptKey(hostId), {
        checkedAt, hostId,
        scope: { threadId: scope.threadId, attemptId: scope.attemptId, browserContextId: scope.browserContextId, generation: scope.generation },
      }),
    );
    receiptWrites.set(hostId, write);
    try { await write; }
    finally { if (receiptWrites.get(hostId) === write) receiptWrites.delete(hostId); }
  };
  const settings = bb.settings.define({
    probeThreadId: { type: "string", label: "无凭据测试线程", default: "" },
  });
  let probeThreadId = (await settings.get()).probeThreadId;
  settings.onChange((next) => { probeThreadId = next.probeThreadId; });
  const inspectHost = async (hostId: string, signal?: AbortSignal) => ({
    hostId,
    runtime: await host.call("inspectRuntime", null, { hostId, signal }),
  });
  const inspectOci = async (hostId: string, signal?: AbortSignal) => ({
    hostId,
    compatibility: await host.call("inspectOciCompatibility", null, { hostId, signal }),
  });
  bb.rpc.register(rpcContract, {
    loginCapabilities: async ({ hostId }, context) => ({ hostId,
      report: await host.call("inspectLoginCapabilities", null, { hostId, signal: context.experimental_signal }),
    }),
    callerInfo: (_input, context) => ({
      kind: context.experimental_caller.kind,
      humanVerified: false as const,
    }),
    inspectHost: ({ hostId }, context) => inspectHost(hostId, context.experimental_signal),
    ociCompatibility: ({ hostId }, context) => inspectOci(hostId, context.experimental_signal),
    hostChoices: async () => (await bb.sdk.hosts.list()).map(({ id, name }) => ({ id, name })),
    controlStatus: async ({ hostId }, context) => {
      const { provisioned, rootId } = await host.call("controlInfo", null, { hostId, signal: context.experimental_signal });
      const stored = controlCheckReceiptSchema.safeParse(await bb.storage.kv.get(receiptKey(hostId)));
      const lastCheck = stored.success && stored.data.hostId === hostId ? stored.data : null;
      return { hostId, provisioned, rootId, lastCheck };
    },
    loginAttempts: async ({ threadId }, context) => {
      try {
        const thread = await bb.sdk.threads.get({ threadId, signal: context.experimental_signal });
        context.experimental_signal?.throwIfAborted();
        if (!thread || thread.id !== threadId) return [];
        coordinator.activate();
        return coordinator.list(thread.projectId, threadId);
      } catch { throw new Error("Login status unavailable."); }
    },
  });
  for (const action of ["session", "check", "renew", "release"] as const) {
    bb.http.route("POST", `/control/${action}`, async (context) => {
      context.header("Cache-Control", "no-store");
      let value: unknown;
      try { value = await controlPayload(context.req.raw); }
      catch { return context.json({ error: "invalid_request" }, 400); }
      try {
        let result;
        if (action === "session") {
          const parsed = controlSession.safeParse(value);
          if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
          const { hostId, key, scope } = parsed.data;
          if (isJobScope(scope)) return context.json({ error: "control_authorization_failed" }, 403);
          result = await host.call("authenticateControl", { key, scope }, { hostId, signal: context.req.raw.signal });
        } else {
          const parsed = controlTarget.safeParse(value);
          if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
          const capability = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(context.req.header("authorization") ?? "")?.[1];
          if (!capability) return context.json({ error: "control_authorization_failed" }, 401);
          const { hostId, scope } = parsed.data;
          if (isJobScope(scope)) return context.json({ error: "control_authorization_failed" }, 403);
          const method = action === "check" ? "authorizeControl" : action === "renew" ? "renewControl" : "revokeControl";
          result = await host.call(method, { capability, scope }, { hostId, signal: context.req.raw.signal });
          if (action === "check" && result.ok) await recordCheck(hostId, scope);
        }
        if (!result.ok) {
          if (result.reason === "rate_limited" || result.reason === "auth_busy") {
            context.header("Retry-After", "60");
            return context.json({ error: "control_rate_limited" }, 429);
          }
          return context.json({ error: "control_authorization_failed" }, 403);
        }
        if ("grant" in result) return context.json(result.grant);
        return context.json(action === "release" ? { released: true } : { authorized: true });
      } catch {
        return context.json({ error: "control_unavailable" }, 503);
      }
    }, { auth: "local" });
  }
  for (const action of ["start", "frame", "input", "close"] as const) {
    bb.http.route("POST", `/fixture/${action}`, async (context) => {
      context.header("Cache-Control", "no-store");
      let value: unknown;
      try { value = await controlPayload(context.req.raw); }
      catch { return context.json({ error: "invalid_request" }, 400); }
      const parsed = (action === "input" ? fixtureInput : controlTarget).safeParse(value);
      if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
      const capability = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(context.req.header("authorization") ?? "")?.[1];
      if (!capability) return context.json({ error: "fixture_control_failed" }, 401);
      const { hostId, scope } = parsed.data;
      const options = { hostId, signal: context.req.raw.signal };
      try {
        if (isJobScope(scope)) return context.json({ error: "fixture_control_failed" }, 403);
        const result = action === "input"
          ? await host.call("inputFixture", { capability, scope, event: fixtureInput.parse(value).event, inputId: fixtureInput.parse(value).inputId, frameRef: fixtureInput.parse(value).frameRef }, options)
          : await host.call(action === "start" ? "startFixture" : action === "frame" ? "frameFixture" : "closeFixture", { capability, scope }, options);
        if (!result.ok) {
          if ((action === "input" || action === "frame") && result.reason === "stale_frame") {
            context.req.raw.signal.throwIfAborted();
            if (isJobScope(scope)) return context.json({ error: "fixture_control_failed" }, 403);
            return context.json({ error: "stale_frame" }, 409);
          }
          const status = result.reason === "busy" ? 409 : ["unauthorized", "inactive", "expired", "aborted"].includes(result.reason) ? 403 : 503;
          return context.json({ error: "fixture_control_failed" }, status);
        }
        if ("viewport" in result) return context.json(result.viewport);
        if ("frame" in result) return context.json(result.frame);
        return context.json(action === "close" ? { closed: true } : { accepted: true });
      } catch { return context.json({ error: "fixture_control_failed" }, 503); }
    }, { auth: "local" });
  }
  bb.cli.register({
    name: "remote-login",
    summary: "Inspect the remote-login plugin's non-secret runtime capabilities",
    commands: [
      { name: "probe-methods", summary: "Check registered login methods and runtime limits without authentication", usage: "bb remote-login probe-methods <host-id> [--json]" },
      { name: "probe-host", summary: "Inspect an explicit host without starting a browser", usage: "bb remote-login probe-host <host-id> [--json]" },
      { name: "probe-oci", summary: "Inspect fixed OCI source compatibility without starting authentication", usage: "bb remote-login probe-oci <host-id> [--json]" },
      { name: "provisioning-info", summary: "Show the fixed owner provisioning directory; never initializes credentials", usage: "bb remote-login provisioning-info <host-id> [--json]" },
      { name: "check-channel", summary: "Check the control HTTP route without credentials", usage: "bb remote-login check-channel <host-id> [--json]" },
    ],
    async run(argv, context) {
      const args = argv.filter((arg) => arg !== "--json");
      if (args.length !== 2 || !["probe-methods", "probe-host", "probe-oci", "provisioning-info", "check-channel"].includes(args[0] ?? "") || !args[1]?.trim() || args[1].startsWith("--")) {
        return { exitCode: 1, stderr: "Usage: bb remote-login <probe-methods|probe-host|probe-oci|provisioning-info|check-channel> <host-id> [--json]" };
      }
      if (args[0] === "check-channel") {
        const reachable = await probeControlChannel(bb.server.loopbackBaseUrl, {
          hostId: args[1], scope: { threadId: "pairing-probe", attemptId: "connectivity-probe", browserContextId: "unopened", generation: 0 },
        });
        return { exitCode: reachable ? 0 : 1, stdout: JSON.stringify({ hostId: args[1], reachable, authenticated: false }) };
      }
      if (args[0] === "probe-methods") {
        return { exitCode: 0, stdout: JSON.stringify({ hostId: args[1], report: await host.call("inspectLoginCapabilities", null, { hostId: args[1], signal: context.signal }) }) };
      }
      if (args[0] === "probe-oci") {
        return { exitCode: 0, stdout: JSON.stringify(await inspectOci(args[1], context.signal)) };
      }
      const result = args[0] === "probe-host" ? await inspectHost(args[1], context.signal)
        : { hostId: args[1], ...(await host.call("controlInfo", null, { hostId: args[1], signal: context.signal })) };
      return { exitCode: 0, stdout: JSON.stringify(result) };
    },
  });
  const result = (phase: string, threadId: string, isError = false): PluginAgentToolResult => ({
    content: [{ type: "text", text: JSON.stringify({ phase, threadId, authenticationAttempted: false }) }],
    ...(isError ? { isError: true } : {}),
  });
  bb.agents.registerTool({
    name: "remote_login_wait_probe",
    description: "Test BB's wait-and-continue interaction with a public, non-credential fixture. This does not authenticate any account or prove a human identity.",
    parameters: z.object({}).strict(),
    async execute(_input, context) {
      const interaction = await bb.ui.requestInput({
        threadId: context.threadId,
        rendererId: "wait-probe",
        title: "远程登录：无凭据等待测试",
        payload: { fixture: true },
        timeoutMs: 120_000,
        describeSubmission: () => ({ title: "已提交无凭据测试" }),
      }, { signal: context.signal });
      if (interaction.outcome === "cancelled") return result("fixture_cancelled", context.threadId, true);
      // A public fixture tests result delivery only; it is never proof of human control or authentication.
      const verified = z.object({ confirmation: z.literal("fixture-only") }).strict().safeParse(interaction.value);
      return result(verified.success ? "fixture_complete" : "fixture_rejected", context.threadId, !verified.success);
    },
  });
  bb.agents.configure((context) => ({
    tools: ["remote_login_request", "remote_login_status", "remote_login_cancel", "remote_login_oci_read", "remote_login_console_read",
      ...(context.thread.id === probeThreadId ? ["remote_login_wait_probe"] : [])],
    skills: [],
  }));
}
