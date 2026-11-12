import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { controlKeyFingerprint, provisionControlRoot } from "../control-authority.ts";
import hostEntry from "../host.ts";

test("registered OCI host refuses real startup before control acceptance and preserves synthetic pairing", async (t) => {
  const parent = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "oci-entry-negative-")), dataDir = join(parent, "private");
  const key = Buffer.alloc(32, 31).toString("base64url");
  await provisionControlRoot(dataDir, key, controlKeyFingerprint(key));
  const worker = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir, tempDir: join(parent, "unused") } });
  t.after(async () => { await worker.experimental_dispose(); await fs.rm(parent, { recursive: true, force: true }); });
  const scope = { threadId: "entry-negative-thread", attemptId: "entry-negative-attempt", browserContextId: "entry-negative-browser", generation: 1 };
  const authenticated = await worker.experimental_call("authenticateControl", { key, scope });
  assert.equal(authenticated.ok, true);
  if (!authenticated.ok) throw new Error("Expected temporary fixture proof");
  const proof = { scope, capability: authenticated.grant.capability };
  assert.deepEqual(await worker.experimental_call("ociStatus", proof), { ok: true,
    status: { configured: false, phoneControlAccepted: false, phase: "unconfigured", failure: null } });
  const expected = { mode: "oci_cli", tenancyOcid: "ocid1.tenancy.oc1..fixturetenancy", userOcid: "ocid1.user.oc1..fixtureuser", region: "ap-sydney-1", realm: "oc1" } as const;
  assert.equal((await worker.experimental_call("configureOci", { ...proof, expected })).ok, false);
  assert.equal((await worker.experimental_call("startOci", proof)).ok, false);
  assert.deepEqual(await worker.experimental_call("consoleStatus", proof), { ok: true,
    status: { configured: false, phoneControlAccepted: false, phase: "unconfigured", failure: null } });
  const consoleExpected = { ...expected, mode: "oci_web", domainOcid: "ocid1.domain.oc1..fixturedomain", domainOrigin: "https://fixture.identity.oraclecloud.com" } as const;
  assert.equal((await worker.experimental_call("configureConsole", { ...proof, expected: consoleExpected })).ok, false);
  assert.equal((await worker.experimental_call("startConsole", proof)).ok, false);
  for (const method of ["frameConsole", "handbackConsole", "closeConsole"] as const) assert.equal((await worker.experimental_call(method, proof)).ok, false);
  for (const method of ["consoleResumeProof", "readConsoleTask"] as const) {
    const selection = { scope, receipt: "11111111-1111-4111-8111-111111111111" };
    const request = method === "readConsoleTask" ? { ...selection, browserRef: "22222222-2222-4222-8222-222222222222", request: { operation: "read_identity" as const } } : selection;
    assert.equal((await worker.experimental_call(method, request as never)).ok, false);
  }
  const syntheticScope = { ...scope, attemptId: "entry-synthetic-next", browserContextId: "entry-synthetic-next-browser" };
  const next = await worker.experimental_call("authenticateControl", { key, scope: syntheticScope });
  assert.equal(next.ok, true, "a prior refused OCI status must not prevent obtaining a synthetic control proof");
  assert.equal(worker.experimental_getRetainedWorkerLeaseCount(), 0);
  assert.deepEqual((await fs.readdir(dataDir)).sort(), ["control-budget.json", "control-root.json"]);
});
