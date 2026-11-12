import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { controlKeyFingerprint, provisionControlRoot } from "../control-authority.ts";
import { OwnedResourceLedger } from "../owned-resource-ledger.ts";
import hostEntry from "../host.ts";

const supported = process.platform === "darwin" && process.arch === "arm64" && existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");

test("known real synthetic cleanup neither initializes an unrelated Console journal nor requires a UUID scope", { skip: !supported, timeout: 20000 }, async t => {
  const parent = await mkdtemp(join(await realpath(tmpdir()), "console-cleanup-synthetic-")), dataDir = join(parent, "private");
  const key = Buffer.alloc(32, 83).toString("base64url");
  await provisionControlRoot(dataDir, key, controlKeyFingerprint(key));
  const worker = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir, tempDir: join(parent, "unused") } });
  t.after(async () => { await worker.experimental_dispose(); await rm(parent, { recursive: true, force: true }); });
  const scope = { threadId: "known-synthetic-thread", attemptId: "known-non-uuid-attempt", browserContextId: "known-synthetic-browser", generation: 1 };
  const authenticated = await worker.experimental_call("authenticateControl", { key, scope });
  assert.equal(authenticated.ok, true); if (!authenticated.ok) throw new Error("Temporary fixture control required");
  const proof = { capability: authenticated.grant.capability, scope };
  assert.equal((await worker.experimental_call("ociStatus", proof)).ok, true);
  assert.equal((await worker.experimental_call("consoleStatus", proof)).ok, true);
  assert.equal((await worker.experimental_call("startFixture", proof)).ok, true);
  assert.equal(worker.experimental_getRetainedWorkerLeaseCount(), 1);
  let recoveryCalls = 0;
  t.mock.method(OwnedResourceLedger.prototype, "recover", async () => { recoveryCalls++; throw new Error("Unrelated recovery must not be initialized"); });
  assert.deepEqual(await worker.experimental_call("stopAttempt", { scope }), { ok: true });
  assert.equal(recoveryCalls, 0);
  assert.equal(worker.experimental_getRetainedWorkerLeaseCount(), 0);
  assert.equal((await worker.experimental_call("frameFixture", proof)).ok, false);
  assert.deepEqual((await readdir(dataDir)).sort(), ["control-budget.json", "control-root.json"]);
});
