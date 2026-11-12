import { inputRequest } from "./input-operation-fixture.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeHostResponse, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { controlKeyFingerprint, provisionControlRoot } from "../control-authority.ts";
import { controlGrantSchema } from "../control-wire.ts";
import { fixtureFrameSchema, type FixtureInput } from "../fixture-wire.ts";
import { hostContract } from "../host-contract.ts";
import hostEntry from "../host.ts";
import { loginAttemptSchema } from "../login-protocol.ts";
import plugin from "../server.ts";
import { acquireCliFixtureLease } from "./cli-flow-lease.ts";

export const supportedHost = process.platform === "darwin" && process.arch === "arm64"
  && existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
  && existsSync("/opt/homebrew/Cellar/oci-cli/3.88.0/libexec/bin/python");
export const context = { projectId: "project-cli-flow-faults", threadId: "thread-cli-flow-faults" };
const hostId = "host-cli-flow-faults";
export const expected = { mode: "oci_cli", tenancyOcid: "ocid1.tenancy.oc1..faultfixturetenancy",
  userOcid: "ocid1.user.oc1..faultfixtureuser", region: "ap-sydney-1", realm: "oc1" } as const;
export const fixtureKey = Buffer.alloc(32, 51).toString("base64url");
const privateMarker = "private-cli-flow-fault-marker";

export function nativeValue(value: PluginAgentToolResult): Record<string, unknown> {
  assert.equal(typeof value, "object");
  if (typeof value === "string") throw new Error("Expected bounded native result");
  assert.equal(value.content.length, 1);
  const part = value.content[0]!;
  assert.equal(part.type, "text");
  if (part.type !== "text") throw new Error("Expected native text");
  assert.ok(part.text.length < 2048);
  return JSON.parse(part.text) as Record<string, unknown>;
}
export async function eventually(check: () => Promise<boolean>) {
  const deadline = performance.now() + 8000;
  while (performance.now() < deadline) { if (await check()) return; await delay(5); }
  assert.fail("CLI fault boundary did not settle");
}

// The production listener deliberately forbids address reuse. Its completed
// HTTP callback can leave 8181 in TIME_WAIT for 30 seconds on this pinned host.
// Wait for natural socket drain between test invocations; never change the
// production callback port, reuse policy or an existing listener.
async function waitForCallbackPort() {
  const source = String.raw`import errno, socket, sys
listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
if hasattr(socket, "SO_REUSEPORT"):
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 0)
try:
    listener.bind(("127.0.0.1", 8181))
except OSError as error:
    sys.exit(91 if error.errno == errno.EADDRINUSE else 92)
finally:
    listener.close()
`;
  const deadline = performance.now() + 35_000;
  while (performance.now() < deadline) {
    const available = await new Promise<boolean>((resolve, reject) => {
      execFile("/opt/homebrew/Cellar/oci-cli/3.88.0/libexec/bin/python", ["-I", "-S", "-c", source], {
        timeout: 2000, maxBuffer: 1024, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      }, (error, stdout, stderr) => {
        if (stdout || stderr) reject(new Error("callback availability probe emitted output"));
        else if (!error) resolve(true);
        else if (error.code === 91) resolve(false);
        else reject(new Error("callback availability probe failed"));
      });
    });
    if (available) return;
    await delay(500);
  }
  assert.fail("fixed CLI callback listener remains unavailable");
}

export async function createCliFlowFixtureBase(t: TestContext) {
  const releaseLease = await acquireCliFixtureLease();
  const cleanup: Array<() => Promise<unknown>> = [];
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    for (const operation of cleanup) await operation();
    await releaseLease(); disposed = true;
  };
  t.after(dispose);
  await waitForCallbackPort();
  const root = await mkdtemp(join(await realpath(tmpdir()), "cli-composed-faults-")), dataDir = join(root, "private");
  cleanup.unshift(() => rm(root, { recursive: true, force: true }));
  await provisionControlRoot(dataDir, fixtureKey, controlKeyFingerprint(fixtureKey));
  const worker = experimental_createHostEntryHarness(hostEntry, {
    experimental_paths: { dataDir, tempDir: join(root, "unused") },
  });
  cleanup.unshift(() => worker.experimental_dispose());
  const environment: Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>> = {
    baseBranch: null, branchName: null, createdAt: 1, defaultBranch: null,
    environmentProviderId: null, environmentProviderInstanceKey: null, environmentProviderSelection: null,
    hostId, hostLifecycle: "active", id: "environment-cli-flow-faults", isGitRepo: false, isWorktree: false,
    lifecycle: { phase: "active", retireAt: null, teardown: null }, managed: false, mergeBaseBranch: null,
    name: "account-free fault fixture", path: "/private/cli-flow-faults-environment", projectId: context.projectId,
    status: "ready", updatedAt: 1, workspaceProvisionType: "personal",
  };
  const faults = { afterHostCall: async (_method: string, _response?: unknown) => {} };
  const privateValues = new Set([fixtureKey, root, privateMarker, expected.tenancyOcid, expected.userOcid]);
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login", sdk: {
    threads: { get: () => makeThreadResponse({ ...context, id: context.threadId, environmentId: environment.id, deletedAt: null, archivedAt: null }) },
    environments: { get: () => environment },
    hosts: { list: () => [makeHostResponse({ id: hostId, name: "Account-free fixture host" })] },
  }, experimental_callHostRpc: async ({ hostId: target, method, input, signal }) => {
    assert.equal(target, hostId);
    const response = await worker.experimental_call(method as keyof typeof hostContract, input as never, { signal });
    if (typeof response === "object" && response !== null && "grant" in response) {
      const grant = controlGrantSchema.safeParse(response.grant);
      if (grant.success) privateValues.add(grant.data.capability);
    }
    await faults.afterHostCall(method, response);
    return response;
  } });
  cleanup.unshift(() => harness.lifecycle.dispose());
  const waits: Array<{ controller: AbortController; native: Promise<PluginAgentToolResult> }> = [];
  cleanup.unshift(async () => {
    for (const wait of waits) wait.controller.abort();
    await Promise.allSettled(waits.map(({ native }) => native));
  });
  await plugin(bb);
  const request = async (mode: "synthetic" | "oci_cli") => {
    const result = await harness.behavior.callAgentTool("remote_login_request", { mode }, context);
    assert.equal(typeof result === "object" && result.isError, undefined);
    return nativeValue(result).attemptId as string;
  };
  const post = (attemptId: string, action: string, extra = {}, capability?: string) => harness.behavior.fetchHttp("POST", `/login/${action}`, {
    headers: { "content-type": "application/json", ...(capability ? { authorization: `Bearer ${capability}` } : {}) },
    body: JSON.stringify(inputRequest({ attemptId, ...extra })),
  });
  const status = async (attemptId: string) => {
    const response = await post(attemptId, "status");
    assert.equal(response.status, 200);
    return loginAttemptSchema.parse(await response.json());
  };
  // Explicit manual fixture setup, never an implicit observation substitution
  // in post() or a stale/replay test.
  const freshInput = async (attemptId: string, event: FixtureInput, capability: string) => {
    const response = await post(attemptId, "frame", {}, capability); assert.equal(response.status, 200);
    const frame = fixtureFrameSchema.parse(await response.json());
    return post(attemptId, "input", { event, frameRef: frame.frameRef }, capability);
  };
  const wait = async (mode: "synthetic" | "oci_cli") => {
    const before = new Set(harness.inspection.pendingInteractions.map(({ id }) => id));
    const controller = new AbortController();
    let settled = false;
    const native = harness.behavior.callAgentTool("remote_login_request", { mode, wait: true }, { ...context, signal: controller.signal })
      .finally(() => { settled = true; });
    void native.catch(() => {});
    waits.push({ controller, native });
    const pending = () => harness.inspection.pendingInteractions.find(({ id }) => !before.has(id));
    await eventually(async () => Boolean(pending()));
    const interaction = pending()!;
    assert.equal(interaction.rendererId, "login-control");
    assert.equal(interaction.threadId, context.threadId);
    const { attemptId } = interaction.payload as { attemptId: string };
    assert.equal(typeof attemptId, "string");
    assert.deepEqual(interaction.payload, { attemptId });
    return { attemptId, interaction, native, settled: () => settled, status: () => status(attemptId),
      post: (action: string, extra = {}, capability?: string) => post(attemptId, action, extra, capability),
      freshInput: (event: FixtureInput, capability: string) => freshInput(attemptId, event, capability) };
  };
  const assertPrivate = async (extraValues: string[] = [], extraSurfaces: unknown[] = []) => {
    const visible = JSON.stringify([await harness.behavior.callRpc("loginAttempts", { threadId: context.threadId }), await bb.storage.kv.list(),
      bb.storage.database().prepare("SELECT record FROM remote_login_attempts_v1").all(),
      harness.inspection.pendingInteractions, harness.logEntries, harness.inspection.realtimeSignals, ...extraSurfaces]);
    for (const value of [...privateValues, ...extraValues]) {
      assert.equal(visible.includes(value), false, "private inputs must not reach public or durable login metadata");
    }
    assert.equal(harness.inspection.sdk.calls.some((call) => call.path === "threads.send"), false);
  };
  return { bb, harness, worker, root, dataDir, hostId, faults, request, post, freshInput, status, wait, assertPrivate };
}

export async function cliFlowFixture(t: TestContext) {
  const base = await createCliFlowFixtureBase(t);
  const authenticate = async (attemptId: string) => {
    const response = await base.post(attemptId, "session", { key: fixtureKey });
    assert.equal(response.status, 200);
    return controlGrantSchema.parse((await response.json() as { grant: unknown }).grant);
  };
  // The receipt comes only from the real browser verifier and confirmed closure.
  const pairingId = await base.request("synthetic"), pairingGrant = await authenticate(pairingId);
  assert.equal((await base.post(pairingId, "start", {}, pairingGrant.capability)).status, 200);
  for (const event of [{ type: "click", x: 80, y: 60 }, { type: "text", text: privateMarker }, { type: "click", x: 80, y: 130 }] as const) {
    assert.equal((await base.freshInput(pairingId, event, pairingGrant.capability)).status, 200);
  }
  assert.equal((await base.post(pairingId, "handback", {}, pairingGrant.capability)).status, 200);
  assert.equal(base.worker.experimental_getRetainedWorkerLeaseCount(), 0);
  assert.ok((await readdir(base.dataDir)).includes("paired-control-acceptance.json"));

  const attemptId = await base.request("oci_cli"), grant = await authenticate(attemptId);
  const send = (action: string, extra = {}) => base.post(attemptId, action, extra, grant.capability);
  const configured = await send("oci-target", { expected });
  assert.equal(configured.status, 200);
  const ready = await send("oci-status");
  assert.deepEqual(await ready.json(), { configured: true, phoneControlAccepted: true, phase: "ready", failure: null });
  const waiting = await base.wait("oci_cli");
  assert.equal(waiting.attemptId, attemptId);
  return { ...base, attemptId, send, status: () => base.status(attemptId), native: waiting.native,
    interaction: waiting.interaction, settled: waiting.settled };
}
