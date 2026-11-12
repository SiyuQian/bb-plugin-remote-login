import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { BbPluginApi, PluginAgentToolContext } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { LoginContextError, matchesBinding, resolveLoginContext } from "../login-context.ts";

type Environment = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>>;
const binding = { projectId: "project-selected", threadId: "thread-injected", environmentId: "environment-attached", hostId: "host-from-environment" };

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    baseBranch: null, branchName: null, createdAt: 1, defaultBranch: null,
    environmentProviderId: null, environmentProviderInstanceKey: null, environmentProviderSelection: null,
    hostId: binding.hostId, hostLifecycle: "active", id: binding.environmentId,
    isGitRepo: false, isWorktree: false, lifecycle: { phase: "active", retireAt: null, teardown: null },
    managed: false, mergeBaseBranch: null, name: "private environment fixture title",
    path: "/private/environment-fixture-path", projectId: binding.projectId,
    status: "ready", updatedAt: 1, workspaceProvisionType: "personal", ...overrides,
  };
}

function fixture(t: TestContext, options: { thread?: Parameters<typeof makeThreadResponse>[0]; environment?: Partial<Environment> } = {}) {
  const controller = new AbortController();
  const context: PluginAgentToolContext = { projectId: binding.projectId, threadId: binding.threadId, signal: controller.signal };
  const thread = makeThreadResponse({
    id: binding.threadId, projectId: binding.projectId, environmentId: binding.environmentId,
    title: "private thread fixture title",
    deletedAt: null, archivedAt: null, ...options.thread,
  });
  const host = createFakePluginHost({ pluginId: "remote-login", sdk: {
    threads: { get: () => thread },
    environments: { get: () => environment(options.environment) },
  } });
  t.after(() => host.harness.lifecycle.dispose());
  return { ...host, controller, context, thread };
}

function refusal(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof LoginContextError);
    assert.equal(error.code, code);
    assert.equal(error.message, "Login context unavailable.");
    assert.equal(error.cause, undefined);
    for (const privateValue of ["private SDK failure", "/private/environment-fixture-path", "private thread fixture title"]) {
      assert.equal(String(error).includes(privateValue), false);
      assert.equal(JSON.stringify(error).includes(privateValue), false);
    }
    return true;
  };
}

test("login context comes from the injected thread and its environment, never an extra host selection", async (t) => {
  const { bb, harness, context } = fixture(t);
  const untrustedHostSelection = { ...context, hostId: "model-chosen-host-do-not-use" };
  const result = await resolveLoginContext(bb, untrustedHostSelection);
  assert.deepEqual(result, binding);
  assert.deepEqual(harness.inspection.sdk.callsTo("threads.get"), [[{ threadId: binding.threadId, signal: context.signal }]]);
  assert.deepEqual(harness.inspection.sdk.callsTo("environments.get"), [[{ environmentId: binding.environmentId, signal: context.signal }]]);
  assert.deepEqual(harness.inspection.sdk.calls.map((call) => call.path), ["threads.get", "environments.get"]);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("an idle thread and a ready active environment remain usable despite idle provisioning metadata", async (t) => {
  const { bb, harness, context } = fixture(t, { thread: { status: "idle" } });
  harness.inspection.sdk.stub("environments.get", () => ({ ...environment(), provision: { phase: "idle" } }));
  assert.deepEqual(await resolveLoginContext(bb, context), binding);
});

test("thread identity, project and missing environment never fall back to another host", async (t) => {
  for (const item of [
    { name: "wrong thread", thread: { id: "another-thread" }, code: "binding_mismatch" },
    { name: "wrong project", thread: { projectId: "another-project" }, code: "binding_mismatch" },
    { name: "deleted thread", thread: { deletedAt: 5 }, code: "thread_unavailable" },
    { name: "archived thread", thread: { archivedAt: 5 }, code: "thread_unavailable" },
    { name: "no environment", thread: { environmentId: null }, code: "environment_unavailable" },
    { name: "empty environment", thread: { environmentId: "" }, code: "environment_unavailable" },
  ]) {
    await t.test(item.name, async (t) => {
      const { bb, harness, context } = fixture(t, { thread: item.thread });
      await assert.rejects(resolveLoginContext(bb, context), refusal(item.code));
      assert.equal(harness.inspection.sdk.callsTo("environments.get").length, 0);
      assert.equal(harness.inspection.sdk.calls.length, 1);
    });
  }
});

test("environment identity and project must match the current thread binding", async (t) => {
  for (const overrides of [{ id: "other-environment" }, { projectId: "other-project" }]) {
    await t.test(Object.keys(overrides)[0]!, async (t) => {
      const { bb, context } = fixture(t, { environment: overrides });
      await assert.rejects(resolveLoginContext(bb, context), refusal("binding_mismatch"));
    });
  }
});

test("destroyed, unavailable or retiring environments cannot authorize login work", async (t) => {
  const cases: Partial<Environment>[] = [
    ...(["creating", "provisioning", "error", "destroyed"] as const).map((status) => ({ status })),
    ...(["retiring", "teardown", "destroyed"] as const).map((phase) => ({ lifecycle: { phase, retireAt: null, teardown: null } })),
  ];
  for (const [index, overrides] of cases.entries()) {
    await t.test(`unavailable environment ${index + 1}`, async (t) => {
      const { bb, context } = fixture(t, { environment: overrides });
      await assert.rejects(resolveLoginContext(bb, context), refusal("environment_unavailable"));
    });
  }
});

test("missing or removed environment hosts are rejected without host discovery", async (t) => {
  for (const overrides of [
    { hostId: "" }, { hostId: " " },
    ...(["removing", "removed", "cleanup-failed"] as const).map((hostLifecycle) => ({ hostLifecycle })),
  ]) {
    await t.test(JSON.stringify(overrides), async (t) => {
      const { bb, harness, context } = fixture(t, { environment: overrides });
      await assert.rejects(resolveLoginContext(bb, { ...context, ...{ hostId: "model-chosen-host-do-not-use" } }), refusal("host_unavailable"));
      assert.deepEqual(harness.inspection.sdk.calls.map((call) => call.path), ["threads.get", "environments.get"]);
    });
  }
});

test("SDK lookup failures never reveal their error text or DTO data", async (t) => {
  for (const [path, code] of [["threads.get", "thread_unavailable"], ["environments.get", "environment_unavailable"]]) {
    await t.test(path!, async (t) => {
      const { bb, harness, context } = fixture(t);
      harness.inspection.sdk.stub(path!, () => { throw new Error("private SDK failure /private/environment-fixture-path"); });
      await assert.rejects(resolveLoginContext(bb, context), refusal(code!));
    });
  }
});

test("an already aborted context is refused before any SDK request", async (t) => {
  const { bb, harness, context, controller } = fixture(t);
  controller.abort(new Error("private SDK failure"));
  await assert.rejects(resolveLoginContext(bb, context), refusal("aborted"));
  assert.equal(harness.inspection.sdk.calls.length, 0);
});

test("abort during either lookup wins over success or raw SDK rejection", async (t) => {
  for (const path of ["threads.get", "environments.get"]) {
    for (const rejects of [false, true]) {
      await t.test(`${path} ${rejects ? "reject" : "resolve"}`, async (t) => {
        const { bb, harness, context, controller, thread } = fixture(t);
        harness.inspection.sdk.stub(path, async () => {
          controller.abort(new Error("private SDK failure"));
          if (rejects) throw new Error("private SDK failure");
          return path === "threads.get" ? thread : environment();
        });
        await assert.rejects(resolveLoginContext(bb, context), refusal("aborted"));
        if (path === "threads.get") assert.equal(harness.inspection.sdk.callsTo("environments.get").length, 0);
      });
    }
  }
});

test("empty injected identities are rejected before a lookup", async (t) => {
  for (const field of ["projectId", "threadId"] as const) {
    const { bb, harness, context } = fixture(t);
    await assert.rejects(resolveLoginContext(bb, { ...context, [field]: "" }), refusal("invalid_context"));
    assert.equal(harness.inspection.sdk.calls.length, 0);
  }
});

test("sensitive steps can re-resolve and compare every binding identity without cached host state", async (t) => {
  const { bb, harness, context } = fixture(t);
  const bound = await resolveLoginContext(bb, context);
  harness.inspection.sdk.stub("environments.get", () => environment({ hostId: "new-environment-host" }));
  const observed = await resolveLoginContext(bb, context);
  assert.equal(observed.hostId, "new-environment-host");
  assert.equal(matchesBinding(bound, observed), false);
  assert.equal(matchesBinding(bound, { ...bound }), true);
  for (const field of ["projectId", "threadId", "environmentId", "hostId"] as const) {
    assert.equal(matchesBinding(bound, { ...bound, [field]: `different-${field}` }), false);
  }
  assert.equal(harness.inspection.sdk.callsTo("threads.get").length, 2);
  assert.equal(harness.inspection.sdk.callsTo("environments.get").length, 2);
});
