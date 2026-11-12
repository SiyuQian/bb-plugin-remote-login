import assert from "node:assert/strict";
import test from "node:test";

test("native process observation binds this exact process start and returns no command line", async () => {
  const api = await import("../owned-process-identity.ts").catch(() => null);
  assert.ok(api, "exact private process observation must exist");
  const first = await api.inspectOwnedProcess(process.pid), second = await api.inspectOwnedProcess(process.pid);
  assert.ok(first); assert.deepEqual(first, second); assert.equal(first.pid, process.pid); assert.equal(first.uid, process.getuid!());
  assert.match(first.started, /^[0-9]+:[0-9]+(?::[a-f0-9-]+)?$/); assert.match(first.executableId, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(first).sort(), ["executableId", "pid", "started", "uid"]);
  assert.equal(await api.inspectOwnedProcess(2_147_483_647), null);
});
