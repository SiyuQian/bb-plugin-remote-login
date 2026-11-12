import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const scope = { threadId: "thread-fixture", attemptId: "attempt-fixture", browserContextId: "context-fixture", generation: 1 };
const token = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const hostId = "host-fixture";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function system(t: TestContext) {
  let decision: "accept" | "deny" | "throw" = "accept";
  const host = createFakePluginHost({
    pluginId: "remote-login",
    experimental_callHostRpc: async ({ method }) => {
      if (method === "controlInfo") return { provisioned: true, rootId: "root-fixture", provisioningDirectory: "/private/fixture" };
      if (decision === "throw") throw new Error(`private fixture ${token}`);
      if (decision === "deny") return { ok: false, reason: "invalid_capability" };
      return method === "authenticateControl" || method === "renewControl"
        ? { ok: true, grant: { capability: token, expiresAt: Date.now() + 300_000 } } : { ok: true };
    },
  });
  await plugin(host.bb);
  t.after(() => host.harness.lifecycle.dispose());
  const post = (action: string, selectedScope = scope, bearer: string | null = token) => host.harness.behavior.fetchHttp("POST", `/control/${action}`, {
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ hostId, scope: selectedScope, ...(action === "session" ? { key } : {}) }),
  });
  const status = () => host.harness.behavior.callRpc("controlStatus", { hostId }) as Promise<{ lastCheck: unknown }>;
  return { ...host, post, status, decide: (next: typeof decision) => { decision = next; } };
}

test("only an accepted control check persists an explicitly non-secret historical receipt", async (t) => {
  const { bb, harness, post, status, decide } = await system(t);
  assert.equal((await status()).lastCheck, null);
  for (const action of ["session", "renew", "release"]) assert.equal((await post(action)).status, 200);
  assert.equal((await status()).lastCheck, null);
  const startedAt = Date.now();
  const response = await post("check");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authorized: true });
  const receipt = (await status()).lastCheck as { checkedAt: number; hostId: string; scope: typeof scope };
  assert.ok(receipt.checkedAt >= startedAt && receipt.checkedAt <= Date.now());
  assert.deepEqual(receipt, { checkedAt: receipt.checkedAt, hostId, scope });
  assert.equal((await bb.storage.kv.list()).length, 1);
  decide("deny");
  assert.equal((await post("check")).status, 403);
  decide("throw");
  assert.equal((await post("check")).status, 503);
  assert.equal((await post("check", scope, null)).status, 401);
  assert.deepEqual((await status()).lastCheck, receipt);
  const persisted = await bb.storage.kv.get((await bb.storage.kv.list())[0]!);
  const visible = JSON.stringify([persisted, harness.logEntries, harness.inspection.realtimeSignals, await status()]);
  for (const secret of [token, key, "provisioningDirectory"]) assert.equal(visible.includes(secret), false);
  const replacement = await harness.lifecycle.reload(plugin);
  t.after(() => replacement.harness.lifecycle.dispose());
  assert.deepEqual((await replacement.harness.behavior.callRpc("controlStatus", { hostId }) as { lastCheck: unknown }).lastCheck, receipt);
});

test("public status rejects corrupt, cross-host and extra-field stored receipts", async (t) => {
  const { bb, post, status } = await system(t);
  await post("check");
  const storageKey = (await bb.storage.kv.list())[0]!;
  const receipt = (await status()).lastCheck as object;
  for (const invalid of [null, { ...receipt, hostId: "other-host" }, { ...receipt, checkedAt: -1 }, { ...receipt, scope: { ...scope, generation: -1 } }, { ...receipt, capability: token }]) {
    await bb.storage.kv.set(storageKey, invalid);
    assert.equal((await status()).lastCheck, null);
  }
});

test("check acknowledgment waits for persistence; a failed write cannot block the next receipt", { timeout: 1000 }, async (t) => {
  const { bb, post, status } = await system(t);
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const originalSet = bb.storage.kv.set.bind(bb.storage.kv);
  const entered = deferred();
  const release = deferred();
  let writes = 0;
  bb.storage.kv.set = async (name, value) => {
    writes++;
    if (writes === 1) { entered.resolve(); await release.promise; throw new Error(`private fixture ${token}`); }
    await originalSet(name, value);
  };
  let completed = false;
  const first = post("check").then((response) => { completed = true; return response; });
  await entered.promise;
  now = 2_000;
  const nextScope = { ...scope, attemptId: "next-attempt" };
  const second = post("check", nextScope);
  await setImmediate();
  assert.equal(completed, false);
  assert.equal(writes, 1);
  now = 600_000;
  release.resolve();
  const firstResponse = await first;
  assert.equal(firstResponse.status, 503);
  assert.deepEqual(await firstResponse.json(), { error: "control_unavailable" });
  assert.equal((await second).status, 200);
  assert.equal(writes, 2);
  const receipt = (await status()).lastCheck as { checkedAt: number; scope: unknown };
  assert.deepEqual(receipt.scope, nextScope);
  assert.equal(receipt.checkedAt, 2_000); // A delayed write must not make an old check look recent.
});
