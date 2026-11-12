import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const context = { projectId: "project-integration", threadId: "thread-integration" };
function system() {
  const environment: Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>> = {
    baseBranch: null, branchName: null, createdAt: 1, defaultBranch: null,
    environmentProviderId: null, environmentProviderInstanceKey: null, environmentProviderSelection: null,
    hostId: "host-attached", hostLifecycle: "active", id: "environment-attached", isGitRepo: false, isWorktree: false,
    lifecycle: { phase: "active", retireAt: null, teardown: null }, managed: false, mergeBaseBranch: null,
    name: "fixture environment", path: "/private/fixture-environment", projectId: context.projectId,
    status: "ready", updatedAt: 1, workspaceProvisionType: "personal",
  };
  return createFakePluginHost({ pluginId: "remote-login", sdk: {
    threads: { get: () => makeThreadResponse({ projectId: context.projectId, id: context.threadId, environmentId: environment.id, deletedAt: null, archivedAt: null }) },
    environments: { get: () => environment },
  }, experimental_callHostRpc: async ({ method }) => {
    assert.equal(method, "controlInfo");
    return { provisioned: true, rootId: "root-observed", provisioningDirectory: "/private/fixture-root" };
  } });
}
function value(result: PluginAgentToolResult): Record<string, unknown> {
  assert.equal(typeof result, "object");
  if (typeof result === "string") throw new Error("Expected native result");
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0]?.type, "text");
  return JSON.parse(result.content[0]!.type === "text" ? result.content[0]!.text : "null") as Record<string, unknown>;
}

test("unified native request, read-only phone status and cancellation share the durable attempt", async (t) => {
  const { bb, harness } = system();
  t.after(() => harness.lifecycle.dispose());
  await plugin(bb);
  assert.equal(bb.storage.database().prepare("SELECT name FROM sqlite_master WHERE name='remote_login_owner_v1'").get(), undefined);
  const requested = value(await harness.behavior.callAgentTool("remote_login_request", { mode: "synthetic" }, context));
  const listed = await harness.behavior.callRpc("loginAttempts", { threadId: context.threadId }) as Array<Record<string, unknown>>;
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.attemptId, requested.attemptId);
  assert.equal(listed[0]!.phase, "awaiting_control");
  assert.equal(listed[0]!.hostId, "host-attached");
  assert.equal(listed[0]!.verification, null);
  await assert.rejects(harness.behavior.callRpc("verifyLoginAttempt", { attemptId: requested.attemptId, verified: true }), { code: "unknown_method" });
  await assert.rejects(harness.behavior.callRpc("loginAttempts", { threadId: context.threadId, verified: true }), { code: "invalid_input" });
  const cancelled = value(await harness.behavior.callAgentTool("remote_login_cancel", { attemptId: requested.attemptId }, context));
  assert.equal(cancelled.phase, "cancelled");
  const history = await harness.behavior.callRpc("loginAttempts", { threadId: context.threadId }) as Array<Record<string, unknown>>;
  assert.equal(history[0]!.phase, "cancelled");
  assert.equal(JSON.stringify([requested, history, harness.logEntries, harness.inspection.realtimeSignals]).includes("/private/"), false);
});

test("a failed complete plugin reload leaves the prior native coordinator operational", async (t) => {
  const { bb, harness } = system();
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  const requested = value(await harness.behavior.callAgentTool("remote_login_request", { mode: "synthetic" }, context));
  await assert.rejects(harness.lifecycle.reload(async (candidate) => { await plugin(candidate); throw new Error("candidate rejected"); }));
  const status = value(await harness.behavior.callAgentTool("remote_login_status", { attemptId: requested.attemptId }, context));
  assert.equal(status.phase, "awaiting_control");
});

test("a committed replacement service activates only after reload and preserves safe waiting state", async (t) => {
  const { bb, harness } = system();
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  const requested = value(await harness.behavior.callAgentTool("remote_login_request", { mode: "synthetic" }, context));
  const next = await harness.lifecycle.reload(plugin);
  t.after(() => next.harness.lifecycle.dispose());
  const service = next.harness.behavior.runService("login-coordinator");
  await setImmediate();
  const status = value(await next.harness.behavior.callAgentTool("remote_login_status", { attemptId: requested.attemptId }, context));
  assert.equal(status.phase, "awaiting_control");
  assert.equal(status.attemptId, requested.attemptId);
  service.controller.abort(); await service.done;
});
