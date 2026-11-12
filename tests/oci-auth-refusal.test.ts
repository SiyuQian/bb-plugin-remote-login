import assert from "node:assert/strict";
import cp from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { OciChildError, startOciAuthenticationChild } from "../oci-child-job.ts";
import { createOwnedOciSession, releaseOwnedOciSession, type OwnedOciSession } from "../oci-owned-session.ts";
import type { CliExpectedIdentity } from "../oci-cli-protocol.ts";
import { OwnedResourceLedger } from "../owned-resource-ledger.ts";

const target: CliExpectedIdentity = {
  mode: "oci_cli", tenancyOcid: "ocid1.tenancy.oc1..fixturetenancy", userOcid: "ocid1.user.oc1..fixtureuser",
  region: "ap-sydney-1", realm: "oc1",
};

async function fixture(t: TestContext, region = target.region) {
  const dataDir = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "oci-auth-refusal-fixture-"));
  await fs.chmod(dataDir, 0o700);
  const attemptId = randomUUID();
  const session = await createOwnedOciSession(dataDir, attemptId, { ...target, region });
  t.after(async () => {
    await releaseOwnedOciSession(session);
    assert.deepEqual(await fs.readdir(dataDir), ["owned-resources-v1"]);
    await fs.rm(dataDir, { recursive: true, force: false });
  });
  let spawns = 0, retentions = 0, consumers = 0;
  let confirmedRelease!: () => void;
  const released = new Promise<void>((resolve) => { confirmedRelease = resolve; });
  // This guard never starts Python, even if the production gate regresses.
  t.mock.method(cp, "spawn", () => { spawns++; throw new Error("unexpected synthetic auth spawn"); });
  const controller = new AbortController();
  return {
    controller,
    released, counts: () => ({ spawns, retentions, consumers }),
    session,
    input: { attemptId, lifetimeMs: 5000, signal: controller.signal, lifecycle: new AbortController().signal,
      retainWorker: () => { retentions++; return () => { confirmedRelease(); }; },
      consumeBrowser: async () => { consumers++; }, session, authorize: async () => {},
    },
    assertNoSideEffects: () => {
      assert.equal(spawns, 0, "a refused request cannot start an authentication child");
      assert.equal(retentions, 0, "a refused request cannot retain a worker");
      assert.equal(consumers, 0, "a refused request cannot receive a browser URL");
    },
  };
}
function privateRefusal(error: unknown): boolean {
  assert.ok(error instanceof OciChildError);
  assert.equal(error.message, "OCI child unavailable.");
  return true;
}

test("forged session paths cannot enter the parent authentication runner", async (t) => {
  const f = await fixture(t);
  const forged: OwnedOciSession = { paths: f.session.paths, expectedIdentity: f.session.expectedIdentity };
  await assert.rejects(startOciAuthenticationChild({ ...f.input, session: forged }), privateRefusal);
  f.assertNoSideEffects();
});

test("another attempt cannot authenticate using an existing owned profile", async (t) => {
  const f = await fixture(t);
  await assert.rejects(startOciAuthenticationChild({ ...f.input, attemptId: randomUUID() }), privateRefusal);
  f.assertNoSideEffects();
});

test("a valid target outside the reviewed region is refused before child startup", async (t) => {
  const f = await fixture(t, "us-ashburn-1");
  await assert.rejects(startOciAuthenticationChild(f.input), privateRefusal);
  f.assertNoSideEffects();
});

test("failed private authorization cannot retain, spawn, or deliver a browser URL", async (t) => {
  const f = await fixture(t);
  let authorizationCalls = 0;
  await assert.rejects(startOciAuthenticationChild({ ...f.input, authorize: async () => {
    authorizationCalls++; throw new Error("synthetic private authorization failure");
  } }), privateRefusal);
  assert.equal(authorizationCalls, 1);
  f.assertNoSideEffects();
});

test("cancellation during durable writer preparation cannot spawn an authentication child", async (t) => {
  const f = await fixture(t), begin = OwnedResourceLedger.prototype.beginWriter;
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; }), held = new Promise<void>((resolve) => { finish = resolve; });
  t.mock.method(OwnedResourceLedger.prototype, "beginWriter", async function(this: OwnedResourceLedger, ...args: Parameters<typeof begin>) {
    const result = await begin.apply(this, args); enter(); await held; return result;
  });
  const pending = startOciAuthenticationChild(f.input);
  await entered; f.controller.abort(); finish();
  await assert.rejects(pending, privateRefusal);
  await f.released;
  assert.deepEqual(f.counts(), { spawns: 0, retentions: 1, consumers: 0 });
});
