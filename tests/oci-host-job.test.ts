import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { OciHostJobs, OciHostJobError } from "../oci-host-job.ts";
import type { ControlScope } from "../control-authority.ts";
import type { CliExpectedIdentity } from "../oci-cli-protocol.ts";
import type { OwnedOciSession } from "../oci-owned-session.ts";
import { OciChildError } from "../oci-child-job.ts";
import { OciProviderBrowserError } from "../oci-provider-browser.ts";
import { StaleFrameError } from "../frame-error.ts";
import { InputReplayGuard } from "../input-replay.ts";

const FRAME_REF = "00000000-0000-4000-8000-000000000001";

const expected: CliExpectedIdentity = { mode: "oci_cli", tenancyOcid: "ocid1.tenancy.oc1..fixture", userOcid: "ocid1.user.oc1..fixture", region: "ap-sydney-1", realm: "oc1" };
const signal = () => new AbortController().signal;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
async function eventually(check: () => Promise<boolean>) {
  const deadline = performance.now() + 8000;
  while (performance.now() < deadline) { if (await check()) return; await delay(5); }
  assert.fail("owned job did not settle");
}
async function ownedRoots(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => name !== "owned-resources-v1");
}
async function setup(t: TestContext, options: { holdInputFence?: boolean; refuseInputFence?: boolean; missingInputFence?: boolean; acceptedMode?: "remote" | "host"; phone?: boolean; cleanupFailure?: boolean; unknownArtifact?: boolean; verificationMatch?: boolean; lifetimeMs?: number; diagnosticFailure?: boolean; holdVerification?: boolean; browserCleanupFailure?: boolean; childFailsDuringBrowser?: boolean; sealFailureAt?: number; captureSealFailure?: boolean; holdRead?: boolean; holdSealAt?: number } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "oci-host-job-")); await chmod(root, 0o700);
  const lifecycle = new AbortController(), childResult = deferred<{ outcome: "bootstrap_complete" | "cancelled" }>();
  const startup = deferred<void>(); let childFinished = false, browserClosed = false, inputs = 0, verifications = 0, retained = 0;
  const verification = deferred<void>(), verificationStarted = deferred<void>();
  const reading = deferred<void>(), readStarted = deferred<void>(), requests: unknown[] = [];
  const sealStarted = deferred<void>(), sealRelease = deferred<void>();
  const browserOpening = deferred<void>(), browserRelease = deferred<void>();
  const seal = Object.freeze({}), chain: string[] = [];
  let sealChecks = 0; const gateModes: unknown[] = []; let browserMode: unknown;
  const inputFence = deferred<void>(); let fenceRequests = 0, childResultReads = 0;
  let capability = "phone-capability", expiresAt = Date.now() + (options.lifetimeMs ?? 60_000), session: OwnedOciSession | undefined;
  const inputState = { frameRef: FRAME_REF as string | undefined, beforeStale: undefined as (() => void) | undefined, error: undefined as unknown };
  const browser = {
    blockLocalInput: options.missingInputFence ? undefined : async () => { fenceRequests++; if (options.holdInputFence) await inputFence.promise; if (options.refuseInputFence) throw new OciProviderBrowserError(); },
    frame: async () => { inputState.frameRef = FRAME_REF; return { frameRef: FRAME_REF, png: "iVBORw0KGgoAAAAA", width: 800 as const, height: 600 as const }; },
    input: async (_event: unknown, frameRef: string, claimInput?: () => void) => {
      claimInput?.(); if (inputState.error) throw inputState.error;
      if (frameRef !== inputState.frameRef) { inputState.beforeStale?.(); throw new StaleFrameError(); }
      inputState.frameRef = undefined; inputs++;
    },
    invalidateFrame: () => { inputState.frameRef = undefined; },
    close: async () => { browserClosed = true; },
  };
  const scope: ControlScope = { threadId: "thread-fixture", attemptId: randomUUID(), browserContextId: randomUUID(), generation: 0 };
  const jobs = new OciHostJobs({ dataDir: root, lifecycle: lifecycle.signal,
    authorize: async (cap, supplied) => { if (cap !== capability || JSON.stringify(supplied) !== JSON.stringify(scope)) throw new Error("refused"); return expiresAt; },
    requirePhoneGate: async (mode) => { gateModes.push(mode); if (options.phone === false || (options.acceptedMode && mode !== options.acceptedMode)) throw new Error("unproven phone"); },
    dependencies: {
      startChild: async (input) => {
        session = input.session; await input.authorize(); await startup.promise;
        if (input.signal.aborted) throw new OciChildError("aborted");
        if (options.unknownArtifact) await writeFile(join(session.paths.root, "unknown"), "synthetic sentinel");
        try {
          const consuming = input.consumeBrowser("captured-private-url", input.signal);
          void consuming.catch(() => {});
          if (options.childFailsDuringBrowser) { await browserOpening.promise; throw new OciChildError("deadline"); }
          await consuming;
        }
        catch { throw new OciChildError("browser_refused"); }
        return { get result() { childResultReads++; return childResult.promise.then((value) => { childFinished = true; return value; }); }, cancel: async () => { if (options.cleanupFailure) throw new Error("unknown child"); childResult.resolve({ outcome: "cancelled" }); } };
      },
      openBrowser: async (...args) => {
        browserMode = args[4]; browserOpening.resolve();
        if (options.childFailsDuringBrowser) await browserRelease.promise;
        if (options.browserCleanupFailure) throw new OciProviderBrowserError(true);
        return browser;
      },
      captureSeal: async (value) => { assert.ok(childFinished); assert.ok(browserClosed); assert.equal(value, session); chain.push("capture"); if (options.captureSealFailure) throw new Error("changed artifact"); return seal as never; },
      assertSeal: async (value, captured) => { assert.equal(value, session); assert.equal(captured, seal); chain.push("seal"); ++sealChecks; if (sealChecks === options.holdSealAt) { sealStarted.resolve(); await sealRelease.promise; } if (sealChecks === options.sealFailureAt) throw new Error("changed artifact"); },
      diagnostic: async (input) => { chain.push("diagnostic"); assert.ok(childFinished); assert.ok(browserClosed); await input.authorize(); if (options.diagnosticFailure) throw new Error("rejected diagnostic"); },
      verify: async (input) => { chain.push("verify"); assert.ok(childFinished); assert.ok(browserClosed); assert.equal(input.session, session); verificationStarted.resolve(); if (options.holdVerification) await verification.promise; await input.authorize(); verifications++; return options.verificationMatch === false ? { match: false, reason: "identity_mismatch" } : { match: true, reason: "matched" }; },
      readTask: async (input) => { requests.push(input.request); readStarted.resolve(); if (options.holdRead) await reading.promise; await input.authorize(); return input.request.operation === "list_compartments"
        ? { operation: "list_compartments", rows: [{ ocid: "ocid1.compartment.oc1..ownedchild", name: "task compartment" }], truncated: true }
        : { operation: "list_instances", rows: [{ id: "ocid1.instance.oc1.ap-sydney-1.fixture", displayName: "task instance", lifecycleState: "RUNNING", shape: "VM.Standard.E4.Flex", availabilityDomain: "test:AP-SYDNEY-1-AD-1" }], truncated: false }; },
    },
  });
  t.after(async () => {
    await jobs.dispose().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return { root, jobs, scope, browser, inputState, startup, childResult, inputFence, lifecycle, verification, verificationStarted, reading, readStarted, requests, sealStarted, sealRelease, browserOpening, browserRelease, chain, retain: () => { retained++; return { dispose: async () => { retained--; } }; }, rotate: (lifetimeMs?: number) => { capability = "rotated-phone-capability"; expiresAt = lifetimeMs === undefined ? expiresAt + 1000 : Date.now() + lifetimeMs; return { capability, expiresAt }; }, expire: () => { expiresAt = Date.now() - 1; }, get facts() { return { browserClosed, inputs, verifications, retained, browserMode, gateModes, fenceRequests, childResultReads }; } };
}

async function verifiedTask(t: TestContext, options: Parameters<typeof setup>[1] = {}) {
  const f = await setup(t, options); f.startup.resolve();
  await f.jobs.configure("phone-capability", f.scope, expected, signal());
  await f.jobs.start("phone-capability", f.scope, signal(), f.retain);
  await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "user_control");
  await f.jobs.handback("phone-capability", f.scope, signal()); f.childResult.resolve({ outcome: "bootstrap_complete" });
  await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "verified");
  return { ...f, completed: await f.jobs.handback("phone-capability", f.scope, signal()) };
}

test("owned CLI input refuses a replay before a second browser effect, including after renewal", async t => {
  for (const renewed of [false, true]) await t.test(String(renewed), async t => {
    const f = await setup(t), inputId = randomUUID(); f.startup.resolve();
    await f.jobs.configure("phone-capability", f.scope, expected, signal()); await f.jobs.start("phone-capability", f.scope, signal(), f.retain);
    await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "user_control");
    await assert.rejects(f.jobs.input("wrong-proof", f.scope, { type: "key", key: "Enter" }, signal(), inputId, FRAME_REF), OciHostJobError);
    assert.equal(f.facts.inputs, 0);
    await f.jobs.input("phone-capability", f.scope, { type: "key", key: "Enter" }, signal(), inputId, FRAME_REF);
    const capability = renewed ? (await f.jobs.renewProof("phone-capability", f.scope, signal(), async () => f.rotate())).capability : "phone-capability";
    await assert.rejects(f.jobs.input(capability, f.scope, { type: "text", text: "another event" }, signal(), inputId, FRAME_REF), OciHostJobError);
    assert.equal(f.facts.inputs, 1);
    await assert.rejects(f.jobs.start(capability, f.scope, signal(), f.retain), OciHostJobError);
  });
});

test("owned CLI input refuses a missing operation ID before the browser effect", async t => {
  const f = await setup(t); f.startup.resolve();
  await f.jobs.configure("phone-capability", f.scope, expected, signal()); await f.jobs.start("phone-capability", f.scope, signal(), f.retain);
  await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "user_control");
  await assert.rejects(f.jobs.input("phone-capability", f.scope, { type: "key", key: "Enter" }, signal(), undefined as never, FRAME_REF), OciHostJobError);
  assert.equal(f.facts.inputs, 0);
});

test("a verified CLI task reads compartments and instances through bound opaque references", async (t) => {
  const f = await verifiedTask(t);
  assert.equal(typeof f.jobs.readTask, "function", "verified CLI sessions need an actual task consumer");
  const select = { scope: f.scope, receipt: f.completed.receipt!, accountRef: f.completed.accountRef! };
  const first = await f.jobs.readTask(select, { operation: "list_compartments" }, signal());
  assert.equal(first.result.operation, "list_compartments");
  if (first.result.operation !== "list_compartments") throw new Error("Expected compartment projection");
  assert.equal(first.result.truncated, true);
  assert.match(first.result.rootCompartmentRef, /^[0-9a-f-]{36}$/);
  assert.equal(first.result.rows[0]!.name, "task compartment");
  assert.equal(JSON.stringify(first).includes("ocid1.compartment"), false);
  assert.equal(JSON.stringify(first).includes(expected.tenancyOcid), false);
  const next = await f.jobs.readTask(select, { operation: "list_compartments" }, signal());
  assert.deepEqual(next.result, first.result, "compartment references remain stable within this account lease");
  const instances = await f.jobs.readTask(select, { operation: "list_instances", compartmentRef: first.result.rows[0]!.compartmentRef }, signal());
  assert.equal(instances.result.operation, "list_instances");
  assert.deepEqual(f.requests.at(-1), { operation: "list_instances", compartmentOcid: "ocid1.compartment.oc1..ownedchild" });
  await f.jobs.readTask(select, { operation: "list_instances", compartmentRef: first.result.rootCompartmentRef }, signal());
  assert.deepEqual(f.requests.at(-1), { operation: "list_instances", compartmentOcid: expected.tenancyOcid });
});

test("task reads refuse foreign, forged, expired and changed-generation session authority", async (t) => {
  const f = await verifiedTask(t);
  const select = { scope: f.scope, receipt: f.completed.receipt!, accountRef: f.completed.accountRef! };
  for (const changed of [{ ...select, accountRef: randomUUID() }, { ...select, receipt: randomUUID() }, { ...select, scope: { ...f.scope, generation: 1 } }]) {
    await assert.rejects(f.jobs.readTask(changed, { operation: "list_compartments" }, signal()), OciHostJobError);
  }
  await assert.rejects(f.jobs.readTask(select, { operation: "list_instances", compartmentRef: randomUUID() }, signal()), OciHostJobError);
  assert.deepEqual(f.requests, []);
  f.expire();
  await assert.rejects(f.jobs.readTask(select, { operation: "list_compartments" }, signal()), OciHostJobError);
});

test("reading the root compartment does not depend on permission to enumerate compartments", async (t) => {
  const f = await verifiedTask(t);
  const select = { scope: f.scope, receipt: f.completed.receipt!, accountRef: f.completed.accountRef! };
  const result = await f.jobs.readTask(select, { operation: "list_instances" }, signal());
  assert.equal(result.result.operation, "list_instances");
  assert.deepEqual(f.requests, [{ operation: "list_instances", compartmentOcid: expected.tenancyOcid }]);
});

test("a read result cannot escape a cancellation or final generation check", async (t) => {
  for (const condition of ["cancel", "seal"] as const) {
    const f = await verifiedTask(t, { holdRead: true, ...(condition === "seal" ? { sealFailureAt: 5 } : {}) });
    const select = { scope: f.scope, receipt: f.completed.receipt!, accountRef: f.completed.accountRef! };
    const read = f.jobs.readTask(select, { operation: "list_compartments" }, signal()); void read.catch(() => {});
    await f.readStarted.promise;
    const closing = condition === "cancel" ? f.jobs.stopForScope(f.scope) : Promise.resolve();
    f.reading.resolve();
    await assert.rejects(read, OciHostJobError);
    await closing;
  }
});

test("the task slot is reserved before its first authority capture and cancellation drains it", async (t) => {
  const f = await verifiedTask(t, { holdSealAt: 3 });
  const read = f.jobs.readTask({ scope: f.scope, receipt: f.completed.receipt!, accountRef: f.completed.accountRef! }, { operation: "list_compartments" }, signal());
  void read.catch(() => {});
  await f.sealStarted.promise;
  try {
    await assert.rejects(f.jobs.readTask({ scope: f.scope, receipt: f.completed.receipt!, accountRef: f.completed.accountRef! }, { operation: "list_compartments" }, signal()),
      (error: unknown) => error instanceof OciHostJobError && error.code === "busy");
    const closing = f.jobs.stopForScope(f.scope);
    f.sealRelease.resolve();
    await assert.rejects(read, OciHostJobError); await closing;
    assert.deepEqual(await ownedRoots(f.root), []);
  } finally { f.sealRelease.resolve(); }
});

test("an unproven phone cannot configure or start a provider or create owned files", async (t) => {
  const f = await setup(t, { phone: false });
  await assert.rejects(f.jobs.configure("phone-capability", f.scope, expected, signal()), OciHostJobError);
  await assert.rejects(f.jobs.start("phone-capability", f.scope, signal(), f.retain), OciHostJobError);
  assert.deepEqual(await ownedRoots(f.root), []);
  assert.equal(f.facts.retained, 0);
});

test("start returns before child startup, and immutable configured target is required", async (t) => {
  const f = await setup(t);
  await assert.rejects(f.jobs.start("phone-capability", f.scope, signal(), f.retain), OciHostJobError);
  await f.jobs.configure("phone-capability", f.scope, expected, signal());
  await assert.rejects(f.jobs.configure("phone-capability", f.scope, { ...expected, userOcid: "ocid1.user.oc1..other" }, signal()), OciHostJobError);
  assert.deepEqual(await f.jobs.start("phone-capability", f.scope, signal(), f.retain), { width: 800, height: 600 });
  assert.equal((await f.jobs.status("phone-capability", f.scope, signal())).phase, "starting");
  assert.equal(f.facts.retained, 1);
  f.startup.resolve();
  await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "user_control");
  await f.jobs.input("phone-capability", f.scope, { type: "text", text: "private input" }, signal(), randomUUID(), FRAME_REF);
  assert.equal(f.facts.inputs, 1);
  await f.jobs.close("phone-capability", f.scope, signal());
  assert.equal(f.facts.retained, 0);
  assert.deepEqual(await ownedRoots(f.root), []);
});

test("handback excludes input and waits for the original child before private verification", async (t) => {
  const f = await setup(t); f.startup.resolve();
  await f.jobs.configure("phone-capability", f.scope, expected, signal());
  await f.jobs.start("phone-capability", f.scope, signal(), f.retain);
  await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "user_control");
  assert.equal((await f.jobs.handback("phone-capability", f.scope, signal())).phase, "verifying");
  await assert.rejects(f.jobs.input("phone-capability", f.scope, { type: "text", text: "late private input" }, signal(), randomUUID(), FRAME_REF), OciHostJobError);
  assert.equal(f.facts.verifications, 0);
  f.childResult.resolve({ outcome: "bootstrap_complete" });
  await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "verified");
  const result = await f.jobs.handback("phone-capability", f.scope, signal());
  assert.equal(result.verified, true);
  assert.match(result.receipt!, /^[0-9a-f-]{36}$/); assert.match(result.accountRef!, /^[0-9a-f-]{36}$/);
  assert.equal(f.facts.verifications, 1); assert.equal(f.facts.retained, 1);
  assert.equal(JSON.stringify(result).includes("ocid"), false); assert.equal(JSON.stringify(result).includes(f.root), false);
  await f.jobs.close("phone-capability", f.scope, signal());
  assert.equal(f.facts.retained, 0);
});

test("proof renewal keeps one browser and fences the consumed capability", async (t) => {
  const f = await setup(t); f.startup.resolve();
  await f.jobs.configure("phone-capability", f.scope, expected, signal()); await f.jobs.start("phone-capability", f.scope, signal(), f.retain);
  await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "user_control");
  const grant = await f.jobs.renewProof("phone-capability", f.scope, signal(), async () => f.rotate());
  await assert.rejects(f.jobs.frame("phone-capability", f.scope, signal()), OciHostJobError);
  assert.equal((await f.jobs.frame(grant.capability, f.scope, signal())).width, 800);
  assert.equal(f.facts.browserClosed, false); assert.equal((await ownedRoots(f.root)).length, 1);
});

test("an unauthorized capability or changed scope cannot terminate the authorized viewer", async (t) => {
  const f = await setup(t); f.startup.resolve();
  await f.jobs.configure("phone-capability", f.scope, expected, signal()); await f.jobs.start("phone-capability", f.scope, signal(), f.retain);
  await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "user_control");
  await assert.rejects(f.jobs.input("unrelated-capability", f.scope, { type: "text", text: "bad" }, signal(), randomUUID(), FRAME_REF), OciHostJobError);
  await assert.rejects(f.jobs.frame("phone-capability", { ...f.scope, generation: 1 }, signal()), OciHostJobError);
  await f.jobs.input("phone-capability", f.scope, { type: "text", text: "valid private input" }, signal(), randomUUID(), FRAME_REF);
  assert.equal(f.facts.inputs, 1); assert.equal(f.facts.browserClosed, false);
});

test("renewal during delayed verification waits for the replacement proof before authorization", async (t) => {
  const f = await setup(t, { holdVerification: true }); f.startup.resolve();
  await f.jobs.configure("phone-capability", f.scope, expected, signal()); await f.jobs.start("phone-capability", f.scope, signal(), f.retain);
  await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "user_control");
  await f.jobs.handback("phone-capability", f.scope, signal()); f.childResult.resolve({ outcome: "bootstrap_complete" });
  await f.verificationStarted.promise;
  const consumed = deferred<void>(), replacement = deferred<void>();
  const renewing = f.jobs.renewProof("phone-capability", f.scope, signal(), async () => {
    const grant = f.rotate(); consumed.resolve(); await replacement.promise; return grant;
  });
  await consumed.promise; f.verification.resolve(); await delay(5);
  assert.equal(f.facts.verifications, 0);
  replacement.resolve(); const grant = await renewing;
  await eventually(async () => (await f.jobs.status(grant.capability, f.scope, signal())).phase === "verified");
  assert.equal((await f.jobs.handback(grant.capability, f.scope, signal())).verified, true);
  assert.equal(f.facts.verifications, 1);
});

test("unknown worker cleanup never acknowledges resources it did not own", async (t) => {
  const f = await setup(t);
  assert.equal(await f.jobs.stopForScope(f.scope), false);
});

test("a configured but unstarted scope can be cancelled and never reopened", async (t) => {
  const f = await setup(t);
  await f.jobs.configure("phone-capability", f.scope, expected, signal());
  assert.equal(f.jobs.hasScope(f.scope), true);
  assert.equal(await f.jobs.stopForScope(f.scope), true);
  await assert.rejects(f.jobs.start("phone-capability", f.scope, signal(), f.retain), OciHostJobError);
  assert.equal((await f.jobs.status("phone-capability", f.scope, signal())).phase, "cancelled");
  assert.deepEqual(await ownedRoots(f.root), []);
});

test("cancellation during startup waits for the owned startup before releasing storage", async (t) => {
  const f = await setup(t);
  await f.jobs.configure("phone-capability", f.scope, expected, signal()); await f.jobs.start("phone-capability", f.scope, signal(), f.retain);
  await eventually(async () => (await ownedRoots(f.root)).length === 1);
  const closing = f.jobs.stopForScope(f.scope);
  assert.equal(f.facts.retained, 1);
  f.startup.resolve(); await closing;
  assert.equal(f.facts.retained, 0); assert.deepEqual(await ownedRoots(f.root), []);
});

test("control expiry closes its exact child and browser and releases the owned storage", async (t) => {
  const f = await setup(t); f.startup.resolve();
  await f.jobs.configure("phone-capability", f.scope, expected, signal()); await f.jobs.start("phone-capability", f.scope, signal(), f.retain);
  await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "user_control");
  await f.jobs.renewProof("phone-capability", f.scope, signal(), async () => f.rotate(150));
  await eventually(async () => f.facts.retained === 0);
  assert.equal(f.facts.browserClosed, true); assert.deepEqual(await ownedRoots(f.root), []);
  assert.equal(await f.jobs.stopForScope(f.scope), true);
});

test("diagnostic refusal and service identity mismatch cannot mint a receipt", async (t) => {
  for (const options of [{ diagnosticFailure: true }, { verificationMatch: false }]) {
    const f = await setup(t, options); f.startup.resolve();
    await f.jobs.configure("phone-capability", f.scope, expected, signal()); await f.jobs.start("phone-capability", f.scope, signal(), f.retain);
    await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "user_control");
    await f.jobs.handback("phone-capability", f.scope, signal()); f.childResult.resolve({ outcome: "bootstrap_complete" });
    await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "failed");
    const status = await f.jobs.status("phone-capability", f.scope, signal());
    assert.equal(status.failure, "verification_failed");
    await assert.rejects(f.jobs.handback("phone-capability", f.scope, signal()), OciHostJobError);
  }
});

test("uncertain child or unknown artifact cleanup retains the worker and refuses acknowledgement", async (t) => {
  for (const options of [{ cleanupFailure: true }, { unknownArtifact: true }]) {
    const f = await setup(t, options); f.startup.resolve();
    await f.jobs.configure("phone-capability", f.scope, expected, signal()); await f.jobs.start("phone-capability", f.scope, signal(), f.retain);
    await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "user_control");
    await assert.rejects(f.jobs.stopForScope(f.scope), OciHostJobError);
    assert.equal(f.facts.retained, 1);
    assert.equal((await ownedRoots(f.root)).length, 1);
  }
});

test("a child wrapping a browser refusal cannot erase uncertain browser cleanup", async (t) => {
  const f = await setup(t, { browserCleanupFailure: true }); f.startup.resolve();
  await f.jobs.configure("phone-capability", f.scope, expected, signal()); await f.jobs.start("phone-capability", f.scope, signal(), f.retain);
  await eventually(async () => {
    try { return (await f.jobs.status("phone-capability", f.scope, signal())).phase === "failed"; }
    catch (error) { return error instanceof OciHostJobError && error.code === "cleanup_uncertain"; }
  });
  await assert.rejects(f.jobs.stopForScope(f.scope), OciHostJobError);
  assert.equal(f.facts.retained, 1);
  assert.equal((await ownedRoots(f.root)).length, 1);
});

test("a child startup timeout retains cleanup ownership until a delayed browser opener settles", async (t) => {
  const f = await setup(t, { childFailsDuringBrowser: true }); f.startup.resolve();
  await f.jobs.configure("phone-capability", f.scope, expected, signal()); await f.jobs.start("phone-capability", f.scope, signal(), f.retain);
  await f.browserOpening.promise;
  await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "failed");
  let cleaned = false;
  const stopping = f.jobs.stopForScope(f.scope).then(() => { cleaned = true; });
  try {
    await delay(5);
    assert.equal(cleaned, false); assert.equal(f.facts.retained, 1);
  } finally { f.browserRelease.resolve(); }
  await stopping;
  assert.equal(f.facts.browserClosed, true); assert.equal(f.facts.retained, 0);
  assert.deepEqual(await ownedRoots(f.root), []);
});

test("resume proof reauthorizes the exact verified receipt and rejects stale root or phone authority", async (t) => {
  for (const rejection of ["scope", "receipt", "root", "phone", "expired"] as const) {
    const options = { phone: true };
    const f = await setup(t, options); f.startup.resolve();
    await f.jobs.configure("phone-capability", f.scope, expected, signal()); await f.jobs.start("phone-capability", f.scope, signal(), f.retain);
    await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "user_control");
    await f.jobs.handback("phone-capability", f.scope, signal()); f.childResult.resolve({ outcome: "bootstrap_complete" });
    await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "verified");
    const result = await f.jobs.handback("phone-capability", f.scope, signal());
    const accepted = await f.jobs.resumeProof(f.scope, result.receipt!);
    assert.equal(accepted.accountRef, result.accountRef); assert.ok(accepted.expiresAt > Date.now());
    let scope = f.scope, receipt = result.receipt!;
    if (rejection === "scope") scope = { ...scope, generation: scope.generation + 1 };
    if (rejection === "receipt") receipt = randomUUID();
    if (rejection === "root") f.rotate();
    if (rejection === "phone") options.phone = false;
    if (rejection === "expired") f.expire();
    await assert.rejects(f.jobs.resumeProof(scope, receipt), OciHostJobError);
  }
});

test("official diagnostic and independent verification remain bound to one private generation seal", async (t) => {
  const f = await setup(t); f.startup.resolve();
  await f.jobs.configure("phone-capability", f.scope, expected, signal()); await f.jobs.start("phone-capability", f.scope, signal(), f.retain);
  await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "user_control");
  await f.jobs.handback("phone-capability", f.scope, signal()); f.childResult.resolve({ outcome: "bootstrap_complete" });
  await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "verified");
  assert.deepEqual(f.chain, ["capture", "diagnostic", "seal", "verify", "seal"]);
});

test("generation capture or either chain recheck refusal prevents a verified receipt", async (t) => {
  for (const options of [{ captureSealFailure: true }, { sealFailureAt: 1 }, { sealFailureAt: 2 }]) {
    const f = await setup(t, options); f.startup.resolve();
    await f.jobs.configure("phone-capability", f.scope, expected, signal()); await f.jobs.start("phone-capability", f.scope, signal(), f.retain);
    await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "user_control");
    await f.jobs.handback("phone-capability", f.scope, signal()); f.childResult.resolve({ outcome: "bootstrap_complete" });
    await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "failed");
    assert.equal((await f.jobs.status("phone-capability", f.scope, signal())).failure, "verification_failed");
    await assert.rejects(f.jobs.handback("phone-capability", f.scope, signal()), OciHostJobError);
    assert.equal(f.facts.verifications, options.sealFailureAt === 2 ? 1 : 0);
  }
});

test("an unused OCI manager does not impose its phone gate on another control refresh", async (t) => {
  const f = await setup(t, { phone: false });
  await f.jobs.refreshProof("phone-capability", f.scope);
  assert.equal(f.jobs.hasScope(f.scope), false);
  assert.deepEqual(await ownedRoots(f.root), []);
});

test("renewal after host verification preserves the proof used by original-call completion", async (t) => {
  const f = await setup(t); f.startup.resolve();
  await f.jobs.configure("phone-capability", f.scope, expected, signal()); await f.jobs.start("phone-capability", f.scope, signal(), f.retain);
  await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "user_control");
  await f.jobs.handback("phone-capability", f.scope, signal()); f.childResult.resolve({ outcome: "bootstrap_complete" });
  await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "verified");
  const grant = await f.jobs.renewProof("phone-capability", f.scope, signal(), async () => f.rotate());
  const completed = await f.jobs.handback(grant.capability, f.scope, signal());
  assert.equal((await f.jobs.resumeProof(f.scope, completed.receipt!)).accountRef, completed.accountRef);
  assert.equal(f.facts.retained, 1);
});

test("resume proof rejects a changed retained session generation after verification", async (t) => {
  const f = await setup(t, { sealFailureAt: 3 }); f.startup.resolve();
  await f.jobs.configure("phone-capability", f.scope, expected, signal()); await f.jobs.start("phone-capability", f.scope, signal(), f.retain);
  await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "user_control");
  await f.jobs.handback("phone-capability", f.scope, signal()); f.childResult.resolve({ outcome: "bootstrap_complete" });
  await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "verified");
  const completed = await f.jobs.handback("phone-capability", f.scope, signal());
  await assert.rejects(f.jobs.resumeProof(f.scope, completed.receipt!), OciHostJobError);
});

test("authorized close stops a known configured or running scope even when its phone gate is no longer accepted", async (t) => {
  for (const started of [false, true]) {
    const options = { phone: true }, f = await setup(t, options); f.startup.resolve();
    await f.jobs.configure("phone-capability", f.scope, expected, signal());
    if (started) {
      await f.jobs.start("phone-capability", f.scope, signal(), f.retain);
      await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "user_control");
    }
    options.phone = false;
    await f.jobs.close("phone-capability", f.scope, signal());
    assert.equal((await f.jobs.status("phone-capability", f.scope, signal())).phase, "cancelled");
    assert.equal(f.facts.retained, 0); assert.deepEqual(await ownedRoots(f.root), []);
  }
});

test("close without a phone gate still refuses an unknown scope cleanup acknowledgement", async (t) => {
  const f = await setup(t, { phone: false });
  await assert.rejects(f.jobs.close("phone-capability", f.scope, signal()), OciHostJobError);
  assert.equal(await f.jobs.stopForScope(f.scope), false);
  assert.equal(f.jobs.hasScope(f.scope), false);
});


async function controlledCli(t: TestContext) {
  const f = await setup(t); f.startup.resolve();
  await f.jobs.configure("phone-capability", f.scope, expected, signal());
  await f.jobs.start("phone-capability", f.scope, signal(), f.retain);
  await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal())).phase === "user_control");
  return f;
}

test("frame binding CLI stale refusal preserves ownership, fresh input and spent IDs", async t => {
  const f = await controlledCli(t), staleId = randomUUID(), event = { type: "key", key: "Enter" } as const;
  await assert.rejects(f.jobs.input("phone-capability", f.scope, event, signal(), staleId, randomUUID()), error => error instanceof OciHostJobError && error.code === "stale_frame");
  assert.equal(f.facts.inputs, 0); assert.equal(f.facts.browserClosed, false); assert.equal(f.facts.retained, 1);
  const fresh = await f.jobs.frame("phone-capability", f.scope, signal());
  await f.jobs.input("phone-capability", f.scope, event, signal(), randomUUID(), fresh.frameRef);
  await assert.rejects(f.jobs.input("phone-capability", f.scope, event, signal(), staleId, fresh.frameRef), error => error instanceof OciHostJobError && error.code !== "stale_frame");
  await eventually(async () => f.facts.browserClosed); assert.equal(f.facts.inputs, 1);
});

test("frame binding CLI claims only after browser preparation", async t => {
  const f = await controlledCli(t), prepared = deferred<void>(), entered = deferred<void>(); let claims = 0;
  const claim = InputReplayGuard.prototype.claim;
  t.mock.method(InputReplayGuard.prototype, "claim", function(this: InputReplayGuard, id: unknown) { claims++; return claim.call(this, id); });
  const input = f.browser.input.bind(f.browser);
  t.mock.method(f.browser, "input", async (...args: Parameters<typeof input>) => { entered.resolve(); await prepared.promise; return input(...args); });
  const pending = f.jobs.input("phone-capability", f.scope, { type: "key", key: "Enter" }, signal(), randomUUID(), FRAME_REF); void pending.catch(() => {});
  try { await entered.promise; assert.equal(claims, 0); }
  finally { prepared.resolve(); await pending.catch(() => {}); }
  assert.equal(claims, 1); assert.equal(f.facts.inputs, 1);
});

test("frame binding CLI proof changes invalidate the displayed observation", async t => {
  for (const transition of ["renew", "refresh", "capability"] as const) await t.test(transition, async t => {
    const f = await controlledCli(t), old = await f.jobs.frame("phone-capability", f.scope, signal());
    const grant = transition === "renew" ? await f.jobs.renewProof("phone-capability", f.scope, signal(), async () => f.rotate()) : f.rotate();
    if (transition === "refresh") await f.jobs.refreshProof(grant.capability, f.scope);
    await assert.rejects(f.jobs.input(grant.capability, f.scope, { type: "key", key: "Enter" }, signal(), randomUUID(), old.frameRef), error => error instanceof OciHostJobError && error.code === "stale_frame");
    assert.equal(f.facts.inputs, 0); assert.equal(f.facts.browserClosed, false);
    const fresh = await f.jobs.frame(grant.capability, f.scope, signal());
    await f.jobs.input(grant.capability, f.scope, { type: "key", key: "Enter" }, signal(), randomUUID(), fresh.frameRef);
    assert.equal(f.facts.inputs, 1);
  });
});

test("frame binding CLI stale still runs final checks and spoofed errors close", async t => {
  for (const condition of ["expiry", "spoof"] as const) await t.test(condition, async t => {
    const f = await controlledCli(t);
    if (condition === "expiry") f.inputState.beforeStale = f.expire;
    else f.inputState.error = Object.assign(new Error("private fixture refusal"), { name: "StaleFrameError", code: "stale_frame" });
    await assert.rejects(f.jobs.input("phone-capability", f.scope, { type: "key", key: "Enter" }, signal(), randomUUID(), randomUUID()), error => error instanceof OciHostJobError && error.code !== "stale_frame");
    await eventually(async () => f.facts.browserClosed); assert.equal(f.facts.inputs, 0);
  });
});


test("capture change CLI read preserves its owned run until a fresh observation", async t => {
  const f = await controlledCli(t), frame = f.browser.frame.bind(f.browser); let changed = true;
  t.mock.method(f.browser, "frame", async () => { if (changed) { changed = false; throw new StaleFrameError(); } return frame(); });
  await assert.rejects(f.jobs.frame("phone-capability", f.scope, signal()), error => error instanceof OciHostJobError && error.code === "stale_frame");
  assert.equal(f.facts.browserClosed, false); assert.equal(f.facts.retained, 1); assert.equal(f.facts.inputs, 0);
  const fresh = await f.jobs.frame("phone-capability", f.scope, signal());
  await f.jobs.input("phone-capability", f.scope, { type: "key", key: "Enter" }, signal(), randomUUID(), fresh.frameRef);
  assert.equal(f.facts.inputs, 1);
});

test("capture change CLI read still closes on post-authorization loss or spoofed errors", async t => {
  for (const condition of ["authority", "spoof"] as const) await t.test(condition, async t => {
    const f = await controlledCli(t);
    t.mock.method(f.browser, "frame", async () => {
      if (condition === "authority") { f.expire(); throw new StaleFrameError(); }
      throw Object.assign(new Error("private frame failure"), { name: "StaleFrameError", code: "stale_frame" });
    });
    await assert.rejects(f.jobs.frame("phone-capability", f.scope, signal()), error => error instanceof OciHostJobError && error.code !== "stale_frame");
    await eventually(async () => f.facts.browserClosed); assert.equal(f.facts.inputs, 0);
  });
});


test("host CLI pins its selected control gate and opener while keeping native verification", async t => {
  const f = await setup(t, { acceptedMode: "host" }); f.startup.resolve();
  assert.equal((await f.jobs.status("phone-capability", f.scope, signal(), "host")).phoneControlAccepted, true);
  assert.equal((await f.jobs.status("phone-capability", f.scope, signal(), "remote")).phoneControlAccepted, false);
  await f.jobs.configure("phone-capability", f.scope, expected, signal(), "host");
  await assert.rejects(f.jobs.configure("phone-capability", f.scope, expected, signal(), "remote"), OciHostJobError);
  await assert.rejects(f.jobs.start("phone-capability", f.scope, signal(), f.retain, "remote"), OciHostJobError);
  await f.jobs.start("phone-capability", f.scope, signal(), f.retain, "host");
  await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal(), "host")).phase === "user_control");
  assert.equal(f.facts.browserMode, "host");
  for (const action of ["frame", "input"] as const) {
    await assert.rejects(action === "frame" ? f.jobs.frame("phone-capability", f.scope, signal())
      : f.jobs.input("phone-capability", f.scope, { type: "key", key: "Enter" }, signal(), randomUUID(), FRAME_REF), OciHostJobError);
  }
  assert.equal(f.facts.inputs, 0); assert.equal(f.facts.browserClosed, false);
  await f.jobs.handback("phone-capability", f.scope, signal()); f.childResult.resolve({ outcome: "bootstrap_complete" });
  await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal(), "host")).phase === "verified");
  const done = await f.jobs.handback("phone-capability", f.scope, signal());
  assert.equal(done.verified, true); assert.equal(f.facts.browserClosed, true); assert.equal(f.facts.verifications, 1);
  await f.jobs.resumeProof(f.scope, done.receipt!);
  const page = await f.jobs.readTask({ scope: f.scope, receipt: done.receipt!, accountRef: done.accountRef! }, { operation: "list_instances" }, signal());
  assert.equal(page.result.operation, "list_instances");
});


test("host CLI handback must receive the local input fence ACK before waiting for its child result", async t => {
  const f = await setup(t, { acceptedMode: "host", holdInputFence: true }); f.startup.resolve();
  await f.jobs.configure("phone-capability", f.scope, expected, signal(), "host");
  await f.jobs.start("phone-capability", f.scope, signal(), f.retain, "host");
  await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal(), "host")).phase === "user_control");
  const childResultReads = f.facts.childResultReads;
  await f.jobs.handback("phone-capability", f.scope, signal());
  try {
    await eventually(async () => f.facts.fenceRequests === 1);
    assert.equal(f.facts.childResultReads, childResultReads, "The handback cannot wait on the CLI child before local input is blocked.");
    assert.equal(f.facts.browserClosed, false); assert.equal(f.facts.verifications, 0);
    f.childResult.resolve({ outcome: "bootstrap_complete" });
    await delay(5); assert.equal(f.facts.verifications, 0); assert.equal(f.facts.browserClosed, false);
    f.inputFence.resolve();
    await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal(), "host")).phase === "verified");
    assert.equal(f.facts.browserClosed, true); assert.equal(f.facts.verifications, 1);
  } finally { f.inputFence.resolve(); }
});

test("host CLI missing or refused local input fence cannot mint verification", async t => {
  for (const condition of ["missing", "refused"] as const) await t.test(condition, async t => {
    const f = await setup(t, { acceptedMode: "host", ...(condition === "missing" ? { missingInputFence: true } : { refuseInputFence: true }) }); f.startup.resolve();
    await f.jobs.configure("phone-capability", f.scope, expected, signal(), "host"); await f.jobs.start("phone-capability", f.scope, signal(), f.retain, "host");
    await eventually(async () => (await f.jobs.status("phone-capability", f.scope, signal(), "host")).phase === "user_control");
    await f.jobs.handback("phone-capability", f.scope, signal()); f.childResult.resolve({ outcome: "bootstrap_complete" });
    await eventually(async () => ["failed", "verified"].includes((await f.jobs.status("phone-capability", f.scope, signal(), "host")).phase));
    assert.equal((await f.jobs.status("phone-capability", f.scope, signal(), "host")).phase, "failed");
    assert.equal(f.facts.verifications, 0);
  });
});
