import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { provisionControlRoot } from "../control-authority.ts";
import { controlGrantSchema } from "../control-wire.ts";
import { fixtureFrameSchema } from "../fixture-wire.ts";
import { hostContract } from "../host-contract.ts";
import hostEntry from "../host.ts";
import plugin from "../server.ts";
import { inputRequest } from "./input-operation-fixture.ts";

const supportedHost = process.platform === "darwin" && process.arch === "arm64" && existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const fingerprint = "a9c4f1b05534fc01b30a65ef34a7bf09500d112aaf4e7169647049640365a7d9";

test("private HTTP reaches a retained real host browser and release destroys access and owned profiles", { skip: !supportedHost, timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "remote-login-host-fixture-"));
  const dataDir = join(root, "private");
  await provisionControlRoot(dataDir, key, fingerprint);
  const worker = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir, tempDir: join(root, "unused") } });
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login", experimental_callHostRpc: ({ hostId, method, input }) => {
    assert.equal(hostId, "host-fixture");
    return worker.experimental_call(method as keyof typeof hostContract, input as never);
  } });
  t.after(async () => { await harness.lifecycle.dispose(); await worker.experimental_dispose(); await rm(root, { recursive: true, force: true }); });
  await plugin(bb);
  const scope = { threadId: "host-fixture-thread", attemptId: "host-fixture-attempt", browserContextId: "owned-fixture", generation: 1 };
  const post = (path: string, value: unknown, token?: string) => harness.behavior.fetchHttp("POST", path, {
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(inputRequest(value)),
  });
  const grant = controlGrantSchema.parse(await (await post("/control/session", { hostId: "host-fixture", scope, key })).json());
  const payload = { hostId: "host-fixture", scope };
  const opened = await post("/fixture/start", payload, grant.capability);
  assert.equal(opened.status, 200);
  assert.deepEqual(await opened.json(), { width: 800, height: 600 });
  assert.equal(worker.experimental_getRetainedWorkerLeaseCount(), 1);
  const verify = () => worker.experimental_call("verifyFixture", { capability: grant.capability, scope });
  assert.deepEqual(await verify(), { ok: true, verified: false });
  assert.deepEqual(await worker.experimental_call("verifyFixture", { capability: "client", scope }), { ok: false, reason: "unauthorized" });
  const frameResponse = await post("/fixture/frame", payload, grant.capability);
  assert.equal(frameResponse.status, 200);
  const frame = fixtureFrameSchema.parse(await frameResponse.json());
  const observations = [frame];
  const freshInput = async (event: unknown) => {
    const response = await post("/fixture/frame", payload, grant.capability);
    assert.equal(response.status, 200);
    const displayed = fixtureFrameSchema.parse(await response.json());
    observations.push(displayed);
    return post("/fixture/input", { ...payload, event, frameRef: displayed.frameRef }, grant.capability);
  };
  const bytes = Buffer.from(frame.png, "base64");
  assert.equal(bytes.readUInt32BE(16), 800); assert.equal(bytes.readUInt32BE(20), 600);
  assert.equal((await post("/fixture/frame", { ...payload, scope: { ...scope, generation: 2 } }, grant.capability)).status, 403);
  for (const event of [{ type: "click", x: 80, y: 60 }, { type: "text", text: "synthetic 你好" }, { type: "key", key: "Backspace" }]) {
    assert.equal((await freshInput(event)).status, 200);
  }
  assert.deepEqual(await verify(), { ok: true, verified: false });
  assert.equal((await freshInput({ type: "click", x: 80, y: 130 })).status, 200);
  assert.deepEqual(await verify(), { ok: true, verified: true });
  assert.equal((await freshInput({ type: "wheel", deltaY: 200 })).status, 200);
  assert.equal((await post("/control/release", payload, grant.capability)).status, 200);
  assert.equal(worker.experimental_getRetainedWorkerLeaseCount(), 0);
  assert.deepEqual(await verify(), { ok: false, reason: "unauthorized" });
  assert.equal((await post("/fixture/frame", payload, grant.capability)).status, 403);
  const nextScope = { ...scope, attemptId: "next-host-fixture", generation: 2 };
  const nextGrant = controlGrantSchema.parse(await (await post("/control/session", { hostId: "host-fixture", scope: nextScope, key })).json());
  assert.equal((await post("/fixture/start", { hostId: "host-fixture", scope: nextScope }, nextGrant.capability)).status, 200);
  assert.equal(worker.experimental_getRetainedWorkerLeaseCount(), 1);
  await worker.experimental_dispose();
  assert.equal(worker.experimental_getRetainedWorkerLeaseCount(), 0);
  assert.deepEqual((await readdir(dataDir)).sort(), ["control-budget.json", "control-root.json"]);
  const visible = JSON.stringify([harness.logEntries, harness.inspection.realtimeSignals]);
  for (const privateValue of [key, grant.capability, nextGrant.capability, ...observations.flatMap(value => [value.png, value.frameRef]), "synthetic 你好"]) assert.equal(visible.includes(privateValue), false);
});
