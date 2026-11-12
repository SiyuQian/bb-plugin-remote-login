import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ControlScope } from "../control-authority.ts";
import type { ConsoleExpectedIdentity } from "../oci-console-protocol.ts";
import { consoleBuild } from "../oci-console-protocol.ts";
import { ConsoleBrowserError, type ConsoleBrowser } from "../oci-console-browser.ts";
import { StaleFrameError } from "../frame-error.ts";
import { InputReplayGuard } from "../input-replay.ts";

const FRAME_REF = "00000000-0000-4000-8000-000000000001";

const target: ConsoleExpectedIdentity = { mode: "oci_web", userOcid: "ocid1.user.oc1..fixtureuser", tenancyOcid: "ocid1.tenancy.oc1..fixturetenant",
  domainOcid: "ocid1.domain.oc1..fixturedomain", domainOrigin: "https://fixture.identity.oraclecloud.com", region: "ap-sydney-1", realm: "oc1" };
const match = { matched: true, userMatched: true, tenancyMatched: true, domainMatched: true, sourceBuild: consoleBuild } as const;
const capA = Buffer.alloc(32, 1).toString("base64url"), capB = Buffer.alloc(32, 2).toString("base64url");
const signal = () => new AbortController().signal;
function deferred() { let resolve!: () => void; const promise = new Promise<void>((value) => { resolve = value; }); return { promise, resolve }; }
async function eventually(condition: () => Promise<boolean>) { for (let index = 0; index < 400; index++) { if (await condition()) return; await delay(5); } assert.fail("Console job did not reach the expected state"); }

async function setup(t: TestContext, options: { phone?: boolean; holdOpen?: boolean; holdFrame?: boolean; holdVerify?: boolean; holdRead?: boolean; ignoreReadAbort?: boolean; closeFailure?: boolean; mismatch?: boolean; lifetimeMs?: number; outline?: { title: string; headings: string[] } } = {}) {
  const api = await import("../oci-console-host-job.ts").catch(() => null);
  assert.ok(api, "Console host lifecycle implementation must exist");
  const dataDir = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "console-host-job-")); await fs.chmod(dataDir, 0o700);
  const scope: ControlScope = { threadId: "console-host-thread", attemptId: randomUUID(), browserContextId: randomUUID(), generation: 2 };
  const opening = deferred(), framing = deferred(), frameStarted = deferred(), verifying = deferred(), reading = deferred(), verifyStarted = deferred(), readStarted = deferred();
  const lifecycle = new AbortController();
  let capability = capA, expiry = Date.now() + (options.lifetimeMs ?? 60000), retained = 0, launches = 0, verifications = 0, reads = 0, inputs = 0, closed = false;
  let document = 0, lastVerified = -1;
  let captured: Parameters<typeof import("../oci-console-browser.ts").openOciConsoleBrowser>[0] | undefined;
  let authorizationHold: { entered: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> } | undefined;
  const inputState = { frameRef: FRAME_REF as string | undefined, beforeStale: undefined as (() => void) | undefined, error: undefined as unknown };
  const browser: ConsoleBrowser = {
    frame: async () => { if (closed) throw new ConsoleBrowserError(); frameStarted.resolve(); if (options.holdFrame) await framing.promise; inputState.frameRef = FRAME_REF; return { frameRef: FRAME_REF, png: "iVBORw0KGgoAAAAA", width: 800, height: 600 }; },
    input: async (_event, frameRef, claimInput) => {
      if (closed) throw new ConsoleBrowserError(); claimInput?.(); if (inputState.error) throw inputState.error;
      if (frameRef !== inputState.frameRef) { inputState.beforeStale?.(); throw new StaleFrameError(); }
      inputState.frameRef = undefined; inputs++;
    },
    invalidateFrame: () => { inputState.frameRef = undefined; },
    verify: async (stopped) => {
      if (closed) throw new ConsoleBrowserError();
      const generation = document; verifications++; verifyStarted.resolve(); if (options.holdVerify) await verifying.promise;
      stopped.throwIfAborted(); await captured!.assertOwned(scope, stopped);
      if (generation !== document) throw new ConsoleBrowserError(); lastVerified = generation;
      return options.mismatch ? { ...match, matched: false } as never : match;
    },
    readPage: async (stopped) => {
      const generation = document; reads++; readStarted.resolve(); if (options.holdRead) await reading.promise;
      if (!options.ignoreReadAbort) { stopped.throwIfAborted(); await captured!.assertOwned(scope, stopped); }
      if (generation !== document) throw new ConsoleBrowserError(); lastVerified = document;
      return options.outline ?? { title: "Console fixture", headings: ["Instances", "Details"] };
    },
    assertRetained: async (stopped) => { stopped.throwIfAborted(); if (closed || lastVerified !== document) throw new ConsoleBrowserError(); await captured!.assertOwned(scope, stopped); },
    close: async () => { closed = true; if (options.closeFailure) throw new ConsoleBrowserError(true); },
  };
  const jobs = new api.ConsoleHostJobs({ dataDir, lifecycle: lifecycle.signal,
    authorize: async (capabilityValue, supplied) => {
      const held = authorizationHold;
      if (held) { authorizationHold = undefined; held.entered.resolve(); await held.released.promise; }
      if (capabilityValue !== capability || JSON.stringify(supplied) !== JSON.stringify(scope)) throw new Error("refused");
      return expiry;
    },
    requirePhoneGate: async () => { if (options.phone === false) throw new Error("unproven phone"); },
    dependencies: { openBrowser: async (input) => { launches++; captured = input; await input.assertOwned(scope, input.lifecycle); if (options.holdOpen) await opening.promise; return browser; } },
  });
  t.after(async () => { opening.resolve(); framing.resolve(); verifying.resolve(); reading.resolve(); authorizationHold?.released.resolve(); await jobs.dispose().catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { ...api, jobs, scope, browser, inputState, dataDir, options, lifecycle, opening, framing, frameStarted, verifying, reading, verifyStarted, readStarted,
    retain: () => { retained++; return { dispose: async () => { retained--; } }; },
    rotate: () => { capability = capB; expiry += 1000; return { capability, expiresAt: expiry }; },
    holdAuthorization: () => { const value = { entered: deferred(), released: deferred() }; authorizationHold = value; return value; },
    navigate: () => { document++; },
    get facts() { return { retained, launches, verifications, reads, inputs, closed, captured }; },
  };
}
async function start(s: Awaited<ReturnType<typeof setup>>) {
  await s.jobs.configure(capA, s.scope, target, signal());
  assert.deepEqual(await s.jobs.start(capA, s.scope, signal(), s.retain), { width: 800, height: 600 });
  await eventually(async () => (await s.jobs.status(capA, s.scope, signal())).phase === "user_control");
}
async function verify(s: Awaited<ReturnType<typeof setup>>) {
  await start(s); await s.jobs.handback(capA, s.scope, signal());
  await eventually(async () => (await s.jobs.status(capA, s.scope, signal())).phase === "verified");
  return s.jobs.handback(capA, s.scope, signal());
}

test("owned Console input keeps operation IDs spent across renewal, reauthentication and same-scope start", async t => {
  for (const transition of ["start", "renew", "reauthenticate"] as const) await t.test(transition, async t => {
    const s = await setup(t), inputId = randomUUID(); await start(s);
    await assert.rejects(s.jobs.input("wrong-proof", s.scope, { type: "key", key: "Enter" }, signal(), inputId, FRAME_REF), s.ConsoleHostJobError);
    assert.equal(s.facts.inputs, 0);
    await s.jobs.input(capA, s.scope, { type: "key", key: "Enter" }, signal(), inputId, FRAME_REF);
    let capability = capA;
    if (transition === "start") await s.jobs.start(capA, s.scope, signal(), s.retain);
    if (transition === "renew") capability = (await s.jobs.renewProof(capA, s.scope, signal(), async () => s.rotate())).capability;
    if (transition === "reauthenticate") { const grant = s.rotate(); s.jobs.observeAuthenticatedGrant(s.scope, grant); capability = grant.capability; }
    await assert.rejects(s.jobs.input(capability, s.scope, { type: "text", text: "different event" }, signal(), inputId, FRAME_REF), s.ConsoleHostJobError);
    assert.equal(s.facts.inputs, 1); assert.equal(s.facts.launches, 1);
    await assert.rejects(s.jobs.start(capability, s.scope, signal(), s.retain), s.ConsoleHostJobError);
  });
});

test("owned Console input refuses a missing operation ID before the browser effect", async t => {
  const s = await setup(t); await start(s);
  await assert.rejects(s.jobs.input(capA, s.scope, { type: "key", key: "Enter" }, signal(), undefined as never, FRAME_REF), s.ConsoleHostJobError);
  assert.equal(s.facts.inputs, 0);
});

test("Console construction and an unproven phone cannot create a browser or fake CLI credentials", async (t) => {
  const s = await setup(t, { phone: false });
  assert.deepEqual(await fs.readdir(s.dataDir), []);
  const status = await s.jobs.status(capA, s.scope, signal()); assert.equal(status.phoneControlAccepted, false);
  await assert.rejects(s.jobs.configure(capA, s.scope, target, signal()), s.ConsoleHostJobError);
  await assert.rejects(s.jobs.start(capA, s.scope, signal(), s.retain), s.ConsoleHostJobError);
  await s.jobs.refreshProof(capA, s.scope);
  assert.equal(s.facts.launches, 0); assert.equal(s.facts.retained, 0); assert.deepEqual(await fs.readdir(s.dataDir), []);
});

test("Console target is immutable and start returns before its owned opener settles", async (t) => {
  const s = await setup(t, { holdOpen: true });
  await s.jobs.configure(capA, s.scope, target, signal());
  await assert.rejects(s.jobs.configure(capA, s.scope, { ...target, userOcid: "ocid1.user.oc1..other" }, signal()), s.ConsoleHostJobError);
  assert.deepEqual(await s.jobs.start(capA, s.scope, signal(), s.retain), { width: 800, height: 600 });
  assert.equal((await s.jobs.status(capA, s.scope, signal())).phase, "starting"); assert.equal(s.facts.retained, 1);
  s.opening.resolve(); await eventually(async () => (await s.jobs.status(capA, s.scope, signal())).phase === "user_control");
  await s.jobs.input(capA, s.scope, { type: "text", text: "private human fixture" }, signal(), randomUUID(), FRAME_REF);
  assert.equal((await s.jobs.frame(capA, s.scope, signal())).width, 800); assert.equal(s.facts.inputs, 1);
  assert.deepEqual(s.facts.captured!.expected, target);
  await s.jobs.close(capA, s.scope, signal()); assert.equal(s.facts.retained, 0);
});

test("handback excludes human control and only the verified retained browser can serve fixed reads", async (t) => {
  const s = await setup(t, { holdVerify: true }); await start(s);
  await assert.rejects(s.jobs.readTask({ scope: s.scope, receipt: randomUUID(), browserRef: randomUUID() }, { operation: "read_page" }, signal()), s.ConsoleHostJobError);
  assert.equal((await s.jobs.handback(capA, s.scope, signal())).phase, "verifying"); await s.verifyStarted.promise;
  await assert.rejects(s.jobs.frame(capA, s.scope, signal()), s.ConsoleHostJobError);
  await assert.rejects(s.jobs.input(capA, s.scope, { type: "key", key: "Enter" }, signal(), randomUUID(), FRAME_REF), s.ConsoleHostJobError);
  s.verifying.resolve(); await eventually(async () => (await s.jobs.status(capA, s.scope, signal())).phase === "verified");
  const result = await s.jobs.handback(capA, s.scope, signal());
  assert.match(result.receipt!, /^[a-f0-9-]{36}$/); assert.match(result.browserRef!, /^[a-f0-9-]{36}$/);
  assert.equal(s.facts.closed, false); assert.equal(s.facts.retained, 1);
  const identity = await s.jobs.readTask({ scope: s.scope, receipt: result.receipt!, browserRef: result.browserRef! }, { operation: "read_identity" }, signal());
  assert.deepEqual(identity.result, { operation: "read_identity", ...match });
  const page = await s.jobs.readTask({ scope: s.scope, receipt: result.receipt!, browserRef: result.browserRef! }, { operation: "read_page" }, signal());
  assert.deepEqual(page.result, { operation: "read_page", title: "Console fixture", headings: ["Instances", "Details"] });
  assert.equal(JSON.stringify(page).includes(target.userOcid), false); assert.equal(JSON.stringify(result).includes(s.dataDir), false);
  await assert.rejects(s.jobs.input(capA, s.scope, { type: "key", key: "Enter" }, signal(), randomUUID(), FRAME_REF), s.ConsoleHostJobError);
});

test("verified renewal and the trusted synchronous authentication hook preserve fresh resume proof", async (t) => {
  const s = await setup(t); const result = await verify(s);
  const grant = await s.jobs.renewProof(capA, s.scope, signal(), async () => s.rotate());
  const after = await s.jobs.resumeProof(s.scope, result.receipt!); assert.equal(after.browserRef, result.browserRef);
  assert.ok(s.facts.verifications >= 2);
  await assert.rejects(s.jobs.frame(capA, s.scope, signal()), s.ConsoleHostJobError);
  s.jobs.observeAuthenticatedGrant(s.scope, { ...grant, capability: Buffer.alloc(32, 3).toString("base64url") });
  await assert.rejects(s.jobs.resumeProof(s.scope, result.receipt!), s.ConsoleHostJobError);
});

test("synchronous reauthentication repairs an in-flight old-proof check before Console verification commits", async (t) => {
  const s = await setup(t, { holdVerify: true }); await start(s); await s.jobs.handback(capA, s.scope, signal()); await s.verifyStarted.promise;
  const held = s.holdAuthorization(); s.verifying.resolve(); await held.entered.promise;
  const grant = s.rotate(); s.jobs.observeAuthenticatedGrant(s.scope, grant); held.released.resolve();
  await eventually(async () => (await s.jobs.status(capB, s.scope, signal())).phase === "verified");
  const result = await s.jobs.handback(capB, s.scope, signal()); assert.equal((await s.jobs.resumeProof(s.scope, result.receipt!)).browserRef, result.browserRef);
});

test("read reservation precedes authorization and cancellation fences a late outline before cleanup acknowledgement", async (t) => {
  const s = await setup(t, { holdRead: true, ignoreReadAbort: true }); const result = await verify(s);
  const selection = { scope: s.scope, receipt: result.receipt!, browserRef: result.browserRef! }, controller = new AbortController();
  const held = s.holdAuthorization(); const pending = s.jobs.readTask(selection, { operation: "read_page" }, controller.signal);
  await held.entered.promise;
  await assert.rejects(s.jobs.readTask(selection, { operation: "read_page" }, signal()), (error: unknown) => error instanceof s.ConsoleHostJobError && error.code === "busy");
  held.released.resolve(); await s.readStarted.promise; controller.abort();
  await assert.rejects(pending, s.ConsoleHostJobError);
  let acknowledged = false; const closing = s.jobs.stopForScope(s.scope).then(() => { acknowledged = true; });
  await delay(5); assert.equal(acknowledged, false); assert.equal(s.facts.retained, 1);
  s.reading.resolve(); await closing; assert.equal(s.facts.retained, 0); assert.equal(s.facts.closed, true);
});

test("wrong identity, uncertain close and unknown scopes cannot produce success or cleanup acknowledgement", async (t) => {
  const mismatch = await setup(t, { mismatch: true }); await start(mismatch); await mismatch.jobs.handback(capA, mismatch.scope, signal());
  await eventually(async () => (await mismatch.jobs.status(capA, mismatch.scope, signal())).phase === "failed");
  await assert.rejects(mismatch.jobs.resumeProof(mismatch.scope, randomUUID()), mismatch.ConsoleHostJobError);
  const uncertain = await setup(t, { closeFailure: true }); await start(uncertain);
  await assert.rejects(uncertain.jobs.stopForScope(uncertain.scope), uncertain.ConsoleHostJobError); assert.equal(uncertain.facts.retained, 1);
  const unknown = await setup(t); assert.equal(await unknown.jobs.stopForScope(unknown.scope), false);
});

test("close before startup and expiry release only matching owned Console resources", async (t) => {
  const configured = await setup(t); await configured.jobs.configure(capA, configured.scope, target, signal()); configured.options.phone = false;
  await configured.jobs.close(capA, configured.scope, signal()); assert.equal((await configured.jobs.status(capA, configured.scope, signal())).phase, "cancelled");
  await assert.rejects(configured.jobs.start(capA, configured.scope, signal(), configured.retain), configured.ConsoleHostJobError);
  const expiring = await setup(t, { lifetimeMs: 100 }); await start(expiring);
  await eventually(async () => expiring.facts.retained === 0); assert.equal(expiring.facts.closed, true);
});

test("cancellation retains a late owned opener until the browser actually returns and closes", async (t) => {
  const s = await setup(t, { holdOpen: true }); await s.jobs.configure(capA, s.scope, target, signal());
  await s.jobs.start(capA, s.scope, signal(), s.retain); await eventually(async () => s.facts.launches === 1);
  let acknowledged = false; const closing = s.jobs.stopForScope(s.scope).then(() => { acknowledged = true; });
  await delay(5); assert.equal(acknowledged, false); assert.equal(s.facts.retained, 1);
  s.opening.resolve(); await closing; assert.equal(s.facts.closed, true); assert.equal(s.facts.retained, 0);
  await assert.rejects(s.jobs.start(capA, s.scope, signal(), s.retain), s.ConsoleHostJobError);
});

test("a held opener reports bounded cleanup uncertainty while late exact closure still releases retention", async (t) => {
  const s = await setup(t, { holdOpen: true }); await s.jobs.configure(capA, s.scope, target, signal());
  await s.jobs.start(capA, s.scope, signal(), s.retain); await eventually(async () => s.facts.launches === 1);
  const outcome = await Promise.race([
    s.jobs.stopForScope(s.scope).then(() => "acknowledged", error => error instanceof s.ConsoleHostJobError && error.cleanupUncertain ? "uncertain" : "other"),
    delay(8000).then(() => "hung"),
  ]);
  assert.equal(outcome, "uncertain"); assert.equal(s.facts.retained, 1); assert.equal(s.facts.closed, false);
  s.opening.resolve(); await eventually(async () => s.facts.retained === 0); assert.equal(s.facts.closed, true);
  await assert.rejects(s.jobs.stopForScope(s.scope), (error: unknown) => error instanceof s.ConsoleHostJobError && error.cleanupUncertain);
});

test("a rotated proof cannot let an old in-flight frame stop the current owner", async (t) => {
  const s = await setup(t, { holdFrame: true }); await start(s);
  const frame = s.jobs.frame(capA, s.scope, signal()); await s.frameStarted.promise;
  await s.jobs.renewProof(capA, s.scope, signal(), async () => s.rotate()); s.framing.resolve();
  await assert.rejects(frame, (error: unknown) => error instanceof s.ConsoleHostJobError && error.code === "authorization");
  assert.equal((await s.jobs.status(capB, s.scope, signal())).phase, "user_control");
  assert.equal(s.facts.closed, false); await s.jobs.input(capB, s.scope, { type: "key", key: "Enter" }, signal(), randomUUID(), FRAME_REF);
});

test("resume proof rechecks fresh identity and refuses a changed document or phone gate", async (t) => {
  const changed = await setup(t); const verified = await verify(changed);
  changed.options.holdVerify = true; const pending = changed.jobs.resumeProof(changed.scope, verified.receipt!);
  await eventually(async () => changed.facts.verifications === 2); changed.navigate(); changed.verifying.resolve();
  await assert.rejects(pending, changed.ConsoleHostJobError);
  const unproven = await setup(t); const retained = await verify(unproven); unproven.options.phone = false;
  await assert.rejects(unproven.jobs.resumeProof(unproven.scope, retained.receipt!), unproven.ConsoleHostJobError);
});

test("a private outline cannot return expected identities, URLs, HTML or unbounded text", async (t) => {
  for (const title of [target.userOcid, "https://cloud.oracle.com/hidden", "<input value='secret'>", "x".repeat(129)]) {
    const s = await setup(t, { outline: { title, headings: [] } }); const verified = await verify(s);
    await assert.rejects(s.jobs.readTask({ scope: s.scope, receipt: verified.receipt!, browserRef: verified.browserRef! }, { operation: "read_page" }, signal()), s.ConsoleHostJobError);
  }
});


test("frame binding Console stale refusal preserves ownership, fresh input and spent IDs", async t => {
  const s = await setup(t), staleId = randomUUID(), event = { type: "key", key: "Enter" } as const; await start(s);
  await assert.rejects(s.jobs.input(capA, s.scope, event, signal(), staleId, randomUUID()), error => error instanceof s.ConsoleHostJobError && error.code === "stale_frame");
  assert.equal(s.facts.inputs, 0); assert.equal(s.facts.closed, false); assert.equal(s.facts.retained, 1);
  const fresh = await s.jobs.frame(capA, s.scope, signal());
  await s.jobs.input(capA, s.scope, event, signal(), randomUUID(), fresh.frameRef);
  await assert.rejects(s.jobs.input(capA, s.scope, event, signal(), staleId, fresh.frameRef), error => error instanceof s.ConsoleHostJobError && error.code !== "stale_frame");
  await eventually(async () => s.facts.closed); assert.equal(s.facts.inputs, 1);
});

test("frame binding Console claims only after browser preparation", async t => {
  const s = await setup(t), prepared = deferred(), entered = deferred(); let claims = 0; await start(s);
  const claim = InputReplayGuard.prototype.claim;
  t.mock.method(InputReplayGuard.prototype, "claim", function(this: InputReplayGuard, id: unknown) { claims++; return claim.call(this, id); });
  const input = s.browser.input.bind(s.browser);
  t.mock.method(s.browser, "input", async (...args: Parameters<typeof input>) => { entered.resolve(); await prepared.promise; return input(...args); });
  const pending = s.jobs.input(capA, s.scope, { type: "key", key: "Enter" }, signal(), randomUUID(), FRAME_REF); void pending.catch(() => {});
  try { await entered.promise; assert.equal(claims, 0); }
  finally { prepared.resolve(); await pending.catch(() => {}); }
  assert.equal(claims, 1); assert.equal(s.facts.inputs, 1);
});

test("frame binding Console proof changes invalidate the displayed observation", async t => {
  for (const transition of ["renew", "refresh", "reauthenticate", "capability"] as const) await t.test(transition, async t => {
    const s = await setup(t); await start(s); const old = await s.jobs.frame(capA, s.scope, signal());
    const grant = transition === "renew" ? await s.jobs.renewProof(capA, s.scope, signal(), async () => s.rotate()) : s.rotate();
    if (transition === "refresh") await s.jobs.refreshProof(grant.capability, s.scope);
    if (transition === "reauthenticate") s.jobs.observeAuthenticatedGrant(s.scope, grant);
    await assert.rejects(s.jobs.input(grant.capability, s.scope, { type: "key", key: "Enter" }, signal(), randomUUID(), old.frameRef), error => error instanceof s.ConsoleHostJobError && error.code === "stale_frame");
    assert.equal(s.facts.inputs, 0); assert.equal(s.facts.closed, false);
    const fresh = await s.jobs.frame(grant.capability, s.scope, signal());
    await s.jobs.input(grant.capability, s.scope, { type: "key", key: "Enter" }, signal(), randomUUID(), fresh.frameRef);
    assert.equal(s.facts.inputs, 1);
  });
});

test("frame binding Console stale still runs final checks and spoofed errors close", async t => {
  for (const condition of ["authority", "spoof"] as const) await t.test(condition, async t => {
    const s = await setup(t); await start(s);
    if (condition === "authority") s.inputState.beforeStale = () => { s.rotate(); };
    else s.inputState.error = Object.assign(new Error("private fixture refusal"), { name: "StaleFrameError", code: "stale_frame" });
    await assert.rejects(s.jobs.input(capA, s.scope, { type: "key", key: "Enter" }, signal(), randomUUID(), randomUUID()), error => error instanceof s.ConsoleHostJobError && error.code !== "stale_frame");
    await eventually(async () => s.facts.closed); assert.equal(s.facts.inputs, 0);
  });
});


test("capture change Console read preserves its owned run until a fresh observation", async t => {
  const s = await setup(t); await start(s); const frame = s.browser.frame.bind(s.browser); let changed = true;
  t.mock.method(s.browser, "frame", async () => { if (changed) { changed = false; throw new StaleFrameError(); } return frame(); });
  await assert.rejects(s.jobs.frame(capA, s.scope, signal()), error => error instanceof s.ConsoleHostJobError && error.code === "stale_frame");
  assert.equal(s.facts.closed, false); assert.equal(s.facts.retained, 1); assert.equal(s.facts.inputs, 0);
  const fresh = await s.jobs.frame(capA, s.scope, signal());
  await s.jobs.input(capA, s.scope, { type: "key", key: "Enter" }, signal(), randomUUID(), fresh.frameRef);
  assert.equal(s.facts.inputs, 1);
});

test("capture change Console read still closes on post-authorization loss or spoofed errors", async t => {
  for (const condition of ["authority", "spoof"] as const) await t.test(condition, async t => {
    const s = await setup(t); await start(s);
    t.mock.method(s.browser, "frame", async () => {
      if (condition === "authority") { s.rotate(); throw new StaleFrameError(); }
      throw Object.assign(new Error("private frame failure"), { name: "StaleFrameError", code: "stale_frame" });
    });
    await assert.rejects(s.jobs.frame(capA, s.scope, signal()), error => error instanceof s.ConsoleHostJobError && error.code !== "stale_frame");
    await eventually(async () => s.facts.closed); assert.equal(s.facts.inputs, 0);
  });
});
