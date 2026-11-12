import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { provisionControlRoot } from "../control-authority.ts";
import { controlGrantSchema } from "../control-wire.ts";
import { hostContract } from "../host-contract.ts";
import hostEntry from "../host.ts";
import plugin from "../server.ts";

const fixtureKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const fingerprint = "a9c4f1b05534fc01b30a65ef34a7bf09500d112aaf4e7169647049640365a7d9";
const scope = { threadId: "thread-a", attemptId: "attempt-a", browserContextId: "context-a", generation: 2 };

async function system(t: TestContext, provisioned = true) {
  const root = await mkdtemp(join(tmpdir(), "remote-login-wire-"));
  const dataDir = join(root, "host-a");
  if (provisioned) await provisionControlRoot(dataDir, fixtureKey, fingerprint);
  const worker = (name: string) => experimental_createHostEntryHarness(hostEntry, {
    experimental_paths: { dataDir: join(root, name), tempDir: join(root, `${name}-temporary`) },
  });
  const workers = new Map([["host-a", worker("host-a")], ["host-b", worker("host-b")]]);
  const { bb, harness } = createFakePluginHost({
    pluginId: "remote-login",
    experimental_callHostRpc: async ({ method, input, hostId }) => {
      const active = workers.get(hostId); assert.ok(active);
      return active.experimental_call(method as keyof typeof hostContract, input as never);
    },
  });
  await plugin(bb);
  t.after(async () => {
    await harness.lifecycle.dispose();
    for (const active of workers.values()) await active.experimental_dispose();
    await rm(root, { recursive: true, force: true });
  });
  const post = (action: string, payload: unknown, capability?: string) => harness.behavior.fetchHttp("POST", `/control/${action}`, {
    headers: { "content-type": "application/json", ...(capability ? { authorization: `Bearer ${capability}` } : {}) },
    body: JSON.stringify(payload),
  });
  return { harness, post, workers, worker, dataDir };
}

test("HTTP to real host authority binds scope and host, rotates and revokes grants", async (t) => {
  const { harness, post } = await system(t);
  const login = await post("session", { hostId: "host-a", key: fixtureKey, scope });
  assert.equal(login.status, 200);
  const grant = controlGrantSchema.parse(await login.json());
  assert.equal((await post("check", { hostId: "host-a", scope }, grant.capability)).status, 200);
  assert.equal((await post("check", { hostId: "host-b", scope }, grant.capability)).status, 403);
  for (const changed of [{ threadId: "other" }, { attemptId: "other" }, { browserContextId: "other" }, { generation: 3 }]) {
    assert.equal((await post("check", { hostId: "host-a", scope: { ...scope, ...changed } }, grant.capability)).status, 403);
  }
  const renewed = controlGrantSchema.parse(await (await post("renew", { hostId: "host-a", scope }, grant.capability)).json());
  assert.notEqual(renewed.capability, grant.capability);
  assert.equal((await post("check", { hostId: "host-a", scope }, grant.capability)).status, 403);
  assert.equal((await post("check", { hostId: "host-a", scope }, renewed.capability)).status, 200);
  assert.deepEqual(await (await post("release", { hostId: "host-a", scope }, renewed.capability)).json(), { released: true });
  assert.equal((await post("check", { hostId: "host-a", scope }, renewed.capability)).status, 403);
  const status = await harness.behavior.callRpc("controlStatus", { hostId: "host-a" });
  assert.deepEqual(Object.keys(status as object).sort(), ["hostId", "lastCheck", "provisioned", "rootId"]);
  const visible = JSON.stringify([harness.logEntries, harness.inspection.realtimeSignals, status]);
  for (const privateValue of [fixtureKey, grant.capability, renewed.capability]) assert.equal(visible.includes(privateValue), false);
});

test("unconfigured runtime cannot register a root and rejects control credentials", async (t) => {
  const { harness, post } = await system(t, false);
  assert.deepEqual(await harness.behavior.callRpc("controlStatus", { hostId: "host-a" }), { hostId: "host-a", provisioned: false, rootId: null, lastCheck: null });
  assert.equal((await post("session", { hostId: "host-a", key: fixtureKey, scope })).status, 403);
  await assert.rejects(harness.behavior.callRpc("provisionControlRoot", { key: fixtureKey }), { code: "unknown_method" });
  assert.deepEqual(await harness.behavior.callRpc("controlStatus", { hostId: "host-a" }), { hostId: "host-a", provisioned: false, rootId: null, lastCheck: null });
});

test("new host worker invalidates an old grant without losing the operator root", async (t) => {
  const { harness, post, workers, worker } = await system(t);
  const grant = controlGrantSchema.parse(await (await post("session", { hostId: "host-a", key: fixtureKey, scope })).json());
  assert.equal((await post("check", { hostId: "host-a", scope }, grant.capability)).status, 200);
  const before = await harness.behavior.callRpc("controlStatus", { hostId: "host-a" }) as { lastCheck: unknown };
  await workers.get("host-a")!.experimental_dispose();
  workers.set("host-a", worker("host-a"));
  assert.equal((await post("check", { hostId: "host-a", scope }, grant.capability)).status, 403);
  const status = await harness.behavior.callRpc("controlStatus", { hostId: "host-a" }) as { provisioned: boolean; lastCheck: unknown };
  assert.equal(status.provisioned, true);
  assert.deepEqual(status.lastCheck, before.lastCheck); // History survives; the old grant above is still refused.
  assert.equal((await post("session", { hostId: "host-a", key: fixtureKey, scope })).status, 200);
});
