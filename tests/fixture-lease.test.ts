import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ControlAuthority, controlKeyFingerprint, provisionControlRoot, type ControlScope } from "../control-authority.ts";
import type { FixtureBrowser } from "../fixture-browser.ts";
import type { FixtureFrame, FixtureInput } from "../fixture-wire.ts";
import { FixtureLease, FixtureLeaseError } from "../fixture-lease.ts";
import { StaleFrameError } from "../frame-error.ts";
import { InputReplayGuard } from "../input-replay.ts";

// Public deterministic bytes authorize only these temporary synthetic fixtures.
const KEY = Buffer.alloc(32, 73).toString("base64url");
const SCOPE: ControlScope = { threadId: "fixture-thread", attemptId: "fixture-attempt", browserContextId: "fixture-browser", generation: 1 };
const FRAME_REF = "00000000-0000-4000-8000-000000000001";
const FRAME: FixtureFrame = { frameRef: FRAME_REF, png: "iVBORw0KGgo=", width: 800, height: 600 };
const INPUT: FixtureInput = { type: "text", text: "synthetic" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Chrome is the external boundary. This driver lets a real lease experience
// in-flight browser work, and records observable synthetic input and closure.
class Driver implements FixtureBrowser {
  frameRef: string | undefined = FRAME_REF;
  beforeStale: (() => void) | undefined;
  inputFailure: unknown;
  frames = 0;
  verifications = 0;
  verified = false;
  inputs: FixtureInput[] = [];
  closed = 0;
  frameGate: Promise<FixtureFrame> | undefined;
  verifyGate: Promise<boolean> | undefined;
  inputGate: Promise<void> | undefined;
  closeGate: Promise<void> | undefined;
  async frame() { this.frames++; const frame = this.frameGate ? await this.frameGate : FRAME; this.frameRef = frame.frameRef; return frame; }
  async verify() { this.verifications++; return this.verifyGate ? await this.verifyGate : this.verified; }
  async input(event: FixtureInput, frameRef: string, claimInput?: () => void) {
    claimInput?.();
    if (this.inputFailure) throw this.inputFailure;
    if (frameRef !== this.frameRef) { this.beforeStale?.(); throw new StaleFrameError(); }
    this.frameRef = undefined; this.inputs.push(event); await this.inputGate;
  }
  invalidateFrame() { this.frameRef = undefined; }
  async close() { this.closed++; await this.closeGate; }
}

async function fixture(t: TestContext, options: { open?: (signal: AbortSignal) => Promise<FixtureBrowser> } = {}) {
  const parent = await fs.mkdtemp(join(tmpdir(), "remote-login-lease-test-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const dataDir = join(parent, "private");
  await provisionControlRoot(dataDir, KEY, controlKeyFingerprint(KEY));
  let now = 1_000;
  const authority = new ControlAuthority(dataDir, { now: () => now });
  const lifecycle = new AbortController();
  const driver = new Driver();
  let retained = 0;
  let dropped = 0;
  let opened = 0;
  let afterAuthorize: ((capability: string) => Promise<void>) | undefined;
  const retain = () => { retained++; return { dispose: async () => { retained--; dropped++; } }; };
  const lease = new FixtureLease({
    authorize: async (capability, scope) => {
      const expiry = await authority.authorize(capability, scope);
      await afterAuthorize?.(capability);
      return expiry;
    },
    open: async (signal) => { opened++; return options.open ? await options.open(signal) : driver; },
    lifecycle: lifecycle.signal,
    now: () => now,
  });
  t.after(() => lease.dispose().catch(() => {}));
  const grant = await authority.authenticate(KEY, SCOPE);
  return {
    lease, authority, grant, lifecycle, driver, dataDir,
    now: () => now, advance: (milliseconds: number) => { now += milliseconds; },
    retained: () => retained, dropped: () => dropped, opened: () => opened, retain,
    afterAuthorize: (hook: (capability: string) => Promise<void>) => { afterAuthorize = hook; },
  };
}

function refused(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof FixtureLeaseError);
    assert.equal(error.code, code);
    assert.equal(error.message, "Fixture control refused.");
    return true;
  };
}

const request = () => new AbortController();
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "expected lease lifecycle transition");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("owned synthetic input refuses the same operation ID before repeating a browser effect", async (t) => {
  for (const changed of [false, true]) await t.test(String(changed), async t => {
    const f = await fixture(t), inputId = randomUUID();
    await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
    await f.lease.input(f.grant.capability, SCOPE, INPUT, request().signal, inputId, FRAME_REF);
    await assert.rejects(f.lease.input(f.grant.capability, SCOPE, changed ? { type: "key", key: "Enter" } : INPUT, request().signal, inputId, FRAME_REF), FixtureLeaseError);
    assert.equal(f.driver.inputs.length, 1);
    await assert.rejects(f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain), FixtureLeaseError);
  });
});

test("synthetic input IDs grant no authority and remain spent after proof renewal", async t => {
  const f = await fixture(t), inputId = randomUUID();
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  await assert.rejects(f.lease.input("wrong-proof", SCOPE, INPUT, request().signal, inputId, FRAME_REF), FixtureLeaseError);
  assert.equal(f.driver.inputs.length, 0);
  await f.lease.input(f.grant.capability, SCOPE, INPUT, request().signal, inputId, FRAME_REF);
  const next = await f.lease.renewProof(f.grant.capability, SCOPE, request().signal, () => f.authority.renew(f.grant.capability, SCOPE));
  await assert.rejects(f.lease.input(next.capability, SCOPE, INPUT, request().signal, inputId, FRAME_REF), FixtureLeaseError);
  assert.equal(f.driver.inputs.length, 1);
});

test("synthetic input refuses missing or malformed operation IDs before browser input", async t => {
  for (const inputId of [undefined, "invalid", "12345678-1234-4123-8123-ABCDEF012345"]) await t.test(String(inputId), async t => {
    const f = await fixture(t); await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
    await assert.rejects(f.lease.input(f.grant.capability, SCOPE, INPUT, request().signal, inputId as string, FRAME_REF), FixtureLeaseError);
    assert.equal(f.driver.inputs.length, 0);
  });
});

// Removing authorization, ownership checks, or cleanup makes these real calls
// expose a frame, accept input, or retain a worker after its lease has ended.
test("a paired grant owns one synthetic browser through its confirmed cleanup", async (t) => {
  const f = await fixture(t);
  const firstRequest = request();
  assert.deepEqual(await f.lease.start(f.grant.capability, SCOPE, firstRequest.signal, f.retain), { width: 800, height: 600 });
  assert.equal(f.retained(), 1);
  firstRequest.abort(); // Completed request lifetime must not become browser lifetime.
  assert.deepEqual(await f.lease.frame(f.grant.capability, SCOPE, request().signal), FRAME);
  await f.lease.input(f.grant.capability, SCOPE, INPUT, request().signal, randomUUID(), FRAME_REF);
  assert.deepEqual(f.driver.inputs, [INPUT]);
  await f.lease.close(f.grant.capability, SCOPE, request().signal);
  assert.equal(f.driver.closed, 1);
  assert.equal(f.retained(), 0);
  assert.equal(f.dropped(), 1);
  await f.lease.dispose();
  assert.equal(f.dropped(), 1);
  await assert.rejects(f.lease.frame(f.grant.capability, SCOPE, request().signal), refused("unavailable"));
});

test("unpaired calls and different valid scopes cannot read, control, or close an owned browser", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.lease.start("client", SCOPE, request().signal, f.retain), refused("unauthorized"));
  assert.equal(f.opened(), 0);
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  const other = { ...SCOPE, generation: 2 };
  const otherGrant = await f.authority.authenticate(KEY, other);
  for (const operation of [
    () => f.lease.frame(otherGrant.capability, other, request().signal),
    () => f.lease.verify(otherGrant.capability, other, request().signal),
    () => f.lease.input(otherGrant.capability, other, INPUT, request().signal, randomUUID(), FRAME_REF),
    () => f.lease.close(otherGrant.capability, other, request().signal),
  ]) await assert.rejects(operation(), refused("inactive"));
  await assert.rejects(f.lease.close("client", SCOPE, request().signal), refused("unauthorized"));
  await assert.rejects(f.lease.verify("client", SCOPE, request().signal), refused("unauthorized"));
  assert.equal(f.driver.frames, 0);
  assert.equal(f.driver.verifications, 0);
  assert.equal(f.driver.inputs.length, 0);
  assert.equal(f.driver.closed, 0);
  assert.deepEqual(await f.lease.frame(f.grant.capability, SCOPE, request().signal), FRAME);
});

test("verification returns only the matching browser's boolean without reading frames or submitting input", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.lease.verify(f.grant.capability, SCOPE, request().signal), refused("inactive"));
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  assert.equal(await f.lease.verify(f.grant.capability, SCOPE, request().signal), false);
  f.driver.verified = true;
  assert.equal(await f.lease.verify(f.grant.capability, SCOPE, request().signal), true);
  assert.equal(f.driver.frames, 0);
  assert.deepEqual(f.driver.inputs, []);
});

test("a cancelled verification holds exclusive browser ownership until its read settles", async (t) => {
  const f = await fixture(t);
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  const checking = deferred<boolean>();
  f.driver.verifyGate = checking.promise;
  const caller = request();
  const result = f.lease.verify(f.grant.capability, SCOPE, caller.signal);
  const rejected = assert.rejects(result, refused("aborted"));
  await until(() => f.driver.verifications === 1);
  caller.abort();
  await rejected;
  for (const operation of [
    () => f.lease.frame(f.grant.capability, SCOPE, request().signal),
    () => f.lease.input(f.grant.capability, SCOPE, INPUT, request().signal, randomUUID(), FRAME_REF),
    () => f.lease.verify(f.grant.capability, SCOPE, request().signal),
  ]) await assert.rejects(operation(), refused("busy"));
  assert.equal(f.driver.closed, 0);
  checking.resolve(true);
  await new Promise((resolve) => setTimeout(resolve, 2));
  f.driver.verifyGate = undefined;
  assert.equal(await f.lease.verify(f.grant.capability, SCOPE, request().signal), false);
  assert.equal(f.driver.closed, 0);
});

for (const stop of ["close", "lifecycle", "expiry", "revocation"] as const) {
  test(`${stop} discards an in-flight verification before its private predicate completes`, async (t) => {
    const f = await fixture(t);
    if (stop === "expiry") f.advance(299_980);
    await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
    const checking = deferred<boolean>();
    f.driver.verifyGate = checking.promise;
    const result = f.lease.verify(f.grant.capability, SCOPE, request().signal);
    const rejected = assert.rejects(result, refused(stop === "lifecycle" ? "unavailable" : stop === "expiry" ? "expired" : "inactive"));
    await until(() => f.driver.verifications === 1);
    if (stop === "close") await f.lease.close(f.grant.capability, SCOPE, request().signal);
    else if (stop === "lifecycle") f.lifecycle.abort();
    else if (stop === "expiry") f.advance(20);
    else await f.lease.stopForScope(SCOPE);
    await rejected;
    await until(() => f.dropped() === 1);
    checking.resolve(true);
    assert.equal(f.driver.closed, 1);
    assert.equal(f.retained(), 0);
  });
}

test("proof consumed during verification cannot release a verified result", async (t) => {
  const f = await fixture(t);
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  const checking = deferred<boolean>();
  f.driver.verifyGate = checking.promise;
  const result = f.lease.verify(f.grant.capability, SCOPE, request().signal);
  const rejected = assert.rejects(result, refused("unauthorized"));
  await until(() => f.driver.verifications === 1);
  await f.authority.revoke(f.grant.capability, SCOPE);
  checking.resolve(true);
  await rejected;
  await until(() => f.dropped() === 1);
  assert.equal(f.driver.closed, 1);
});

test("renewal discards an old verification without destroying the refreshed lease", async (t) => {
  const f = await fixture(t);
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  const checking = deferred<boolean>();
  f.driver.verifyGate = checking.promise;
  const result = f.lease.verify(f.grant.capability, SCOPE, request().signal);
  const rejected = assert.rejects(result, refused("unauthorized"));
  await until(() => f.driver.verifications === 1);
  const renewed = await f.authority.renew(f.grant.capability, SCOPE);
  await f.lease.refreshProof(renewed.capability, SCOPE);
  checking.resolve(true);
  await rejected;
  f.driver.verifyGate = undefined;
  assert.equal(await f.lease.verify(renewed.capability, SCOPE, request().signal), false);
  assert.equal(f.driver.closed, 0);
});

test("a delayed start rejects competing attempts without launching another browser", async (t) => {
  const opening = deferred<FixtureBrowser>();
  const f = await fixture(t, { open: () => opening.promise });
  const starting = f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  await until(() => f.opened() === 1);
  await assert.rejects(f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain), refused("busy"));
  const other = { ...SCOPE, attemptId: "competing-attempt" };
  const grant = await f.authority.authenticate(KEY, other);
  await assert.rejects(f.lease.start(grant.capability, other, request().signal, f.retain), refused("busy"));
  assert.equal(f.opened(), 1);
  opening.resolve(f.driver);
  await starting;
});

test("close preempts an in-flight frame and holds retention until the browser confirms closure", async (t) => {
  const f = await fixture(t);
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  const screenshot = deferred<FixtureFrame>();
  const closing = deferred<void>();
  f.driver.frameGate = screenshot.promise;
  f.driver.closeGate = closing.promise;
  const frame = f.lease.frame(f.grant.capability, SCOPE, request().signal);
  const rejectedFrame = assert.rejects(frame, refused("inactive"));
  await until(() => f.driver.frames === 1);
  const close = f.lease.close(f.grant.capability, SCOPE, request().signal);
  await until(() => f.driver.closed === 1);
  await rejectedFrame;
  assert.equal(f.retained(), 1);
  await assert.rejects(f.lease.start(f.grant.capability, { ...SCOPE, generation: 2 }, request().signal, f.retain), refused("unauthorized"));
  closing.resolve();
  await close;
  assert.equal(f.retained(), 0);
  screenshot.resolve(FRAME);
  await assert.rejects(f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain), refused("inactive"));
});

test("host lifecycle abort invalidates a delayed start while retaining its eventual cleanup", async (t) => {
  const opening = deferred<FixtureBrowser>();
  let browserSignal: AbortSignal | undefined;
  const f = await fixture(t, { open: (signal) => { browserSignal = signal; return opening.promise; } });
  const start = f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  const rejected = assert.rejects(start, refused("unavailable"));
  await until(() => f.opened() === 1);
  f.lifecycle.abort(new Error("host detail must not escape"));
  await rejected;
  assert.equal(browserSignal?.aborted, true);
  assert.equal(f.retained(), 1);
  opening.resolve(f.driver);
  await f.lease.dispose();
  assert.equal(f.driver.closed, 1);
  assert.equal(f.retained(), 0);
  assert.equal(f.dropped(), 1);
});

test("aborting a start drops the result and closes a browser that opens later", async (t) => {
  const opening = deferred<FixtureBrowser>();
  const f = await fixture(t, { open: () => opening.promise });
  const caller = request();
  const start = f.lease.start(f.grant.capability, SCOPE, caller.signal, f.retain);
  const rejected = assert.rejects(start, refused("aborted"));
  await until(() => f.opened() === 1);
  caller.abort(new Error("caller detail must not escape"));
  await rejected;
  assert.equal(f.retained(), 1);
  opening.resolve(f.driver);
  await until(() => f.dropped() === 1);
  assert.equal(f.driver.closed, 1);
  await assert.rejects(f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain), refused("inactive"));
});

test("overlapping browser operations are rejected while a cancelled frame remains in flight", async (t) => {
  const f = await fixture(t);
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  const screenshot = deferred<FixtureFrame>();
  f.driver.frameGate = screenshot.promise;
  const caller = request();
  const frame = f.lease.frame(f.grant.capability, SCOPE, caller.signal);
  const rejected = assert.rejects(frame, refused("aborted"));
  await until(() => f.driver.frames === 1);
  caller.abort();
  await rejected;
  await assert.rejects(f.lease.input(f.grant.capability, SCOPE, INPUT, request().signal, randomUUID(), FRAME_REF), refused("busy"));
  assert.equal(f.driver.closed, 0);
  screenshot.resolve(FRAME);
  await until(() => f.driver.frames === 1); // Permit the settled frame's continuation to clear ownership.
  await new Promise((resolve) => setTimeout(resolve, 2));
  f.driver.frameGate = undefined;
  assert.deepEqual(await f.lease.frame(f.grant.capability, SCOPE, request().signal), FRAME);
});

test("aborting uncertain browser input closes the lease and prevents scope replay", async (t) => {
  const f = await fixture(t);
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  const typing = deferred<void>();
  f.driver.inputGate = typing.promise;
  const caller = request();
  const input = f.lease.input(f.grant.capability, SCOPE, INPUT, caller.signal, randomUUID(), FRAME_REF);
  const rejected = assert.rejects(input, refused("aborted"));
  await until(() => f.driver.inputs.length === 1);
  caller.abort();
  await rejected;
  await until(() => f.dropped() === 1);
  typing.resolve();
  assert.equal(f.driver.closed, 1);
  await assert.rejects(f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain), refused("inactive"));
});

test("verified grant expiry invalidates an in-flight frame without waiting for screenshot completion", async (t) => {
  const f = await fixture(t);
  f.advance(299_980);
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  const screenshot = deferred<FixtureFrame>();
  f.driver.frameGate = screenshot.promise;
  const frame = f.lease.frame(f.grant.capability, SCOPE, request().signal);
  const rejected = assert.rejects(frame, refused("expired"));
  await until(() => f.driver.frames === 1);
  f.advance(20);
  await rejected;
  assert.equal(f.driver.closed, 1);
  await until(() => f.dropped() === 1);
  screenshot.resolve(FRAME);
});

test("a current renewed proof extends the lease to its verified expiry", async (t) => {
  const f = await fixture(t);
  f.advance(299_980);
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  const renewed = await f.authority.renew(f.grant.capability, SCOPE);
  assert.deepEqual(await f.lease.frame(renewed.capability, SCOPE, request().signal), FRAME);
  f.advance(20);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.driver.closed, 0);
  assert.deepEqual(await f.lease.frame(renewed.capability, SCOPE, request().signal), FRAME);
});

test("a grant consumed during a screenshot cannot authorize its returned frame", async (t) => {
  const f = await fixture(t);
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  const screenshot = deferred<FixtureFrame>();
  f.driver.frameGate = screenshot.promise;
  const frame = f.lease.frame(f.grant.capability, SCOPE, request().signal);
  const rejected = assert.rejects(frame, refused("unauthorized"));
  await until(() => f.driver.frames === 1);
  await f.authority.revoke(f.grant.capability, SCOPE);
  screenshot.resolve(FRAME);
  await rejected;
  await until(() => f.dropped() === 1);
  assert.equal(f.driver.closed, 1);
});

test("trusted scope revocation preempts input and discards its completion", async (t) => {
  const f = await fixture(t);
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  const typing = deferred<void>();
  f.driver.inputGate = typing.promise;
  const input = f.lease.input(f.grant.capability, SCOPE, INPUT, request().signal, randomUUID(), FRAME_REF);
  const rejected = assert.rejects(input, refused("inactive"));
  await until(() => f.driver.inputs.length === 1);
  await f.lease.stopForScope(SCOPE);
  await rejected;
  typing.resolve();
  assert.equal(f.driver.closed, 1);
  assert.equal(f.retained(), 0);
  await assert.rejects(f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain), refused("inactive"));
});

test("root replacement during opening discards the browser and releases its worker", async (t) => {
  const opening = deferred<FixtureBrowser>();
  const f = await fixture(t, { open: () => opening.promise });
  const start = f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  const rejected = assert.rejects(start, refused("unauthorized"));
  await until(() => f.opened() === 1);
  const path = join(f.dataDir, "control-root.json");
  const root = JSON.parse(await fs.readFile(path, "utf8"));
  root.rootId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  await fs.writeFile(path, JSON.stringify(root), { mode: 0o600 });
  opening.resolve(f.driver);
  await rejected;
  await until(() => f.dropped() === 1);
  assert.equal(f.driver.closed, 1);
});

test("uncertain cleanup keeps retention and poisons replacement starts without exposing browser errors", async (t) => {
  const f = await fixture(t);
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  f.driver.closeGate = Promise.reject(new Error(`private driver detail ${KEY} ${f.grant.capability}`));
  f.driver.closeGate.catch(() => {});
  await assert.rejects(f.lease.close(f.grant.capability, SCOPE, request().signal), refused("failed"));
  assert.equal(f.retained(), 1);
  assert.equal(f.dropped(), 0);
  const other = { ...SCOPE, generation: 2 };
  const grant = await f.authority.authenticate(KEY, other);
  await assert.rejects(f.lease.start(grant.capability, other, request().signal, f.retain), refused("unavailable"));
  await assert.rejects(f.lease.dispose(), refused("failed"));
  assert.equal(f.driver.closed, 1);
});

test("trusted renewal refresh discards an old in-flight frame while preserving the renewed lease", async (t) => {
  const f = await fixture(t);
  assert.equal(typeof f.lease.refreshProof, "function", "host renewal must refresh an existing lease");
  f.advance(299_980);
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  const screenshot = deferred<FixtureFrame>();
  f.driver.frameGate = screenshot.promise;
  const frame = f.lease.frame(f.grant.capability, SCOPE, request().signal);
  const rejected = assert.rejects(frame, refused("unauthorized"));
  await until(() => f.driver.frames === 1);
  const renewed = await f.authority.renew(f.grant.capability, SCOPE);
  await f.lease.refreshProof(renewed.capability, SCOPE);
  screenshot.resolve(FRAME);
  await rejected;
  f.advance(20);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.driver.closed, 0);
  f.driver.frameGate = undefined;
  assert.deepEqual(await f.lease.frame(renewed.capability, SCOPE, request().signal), FRAME);
});

test("trusted renewal refresh cannot resurrect a closed scope or change another scope's lease", async (t) => {
  const f = await fixture(t);
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  const other = { ...SCOPE, generation: 2 };
  const otherGrant = await f.authority.authenticate(KEY, other);
  assert.equal(typeof f.lease.refreshProof, "function", "host renewal must be scoped to a live lease");
  await f.lease.refreshProof(otherGrant.capability, other);
  assert.deepEqual(await f.lease.frame(f.grant.capability, SCOPE, request().signal), FRAME);
  await f.lease.close(f.grant.capability, SCOPE, request().signal);
  const renewed = await f.authority.renew(f.grant.capability, SCOPE);
  await f.lease.refreshProof(renewed.capability, SCOPE);
  await assert.rejects(f.lease.start(renewed.capability, SCOPE, request().signal, f.retain), refused("inactive"));
  assert.equal(f.opened(), 1);
  assert.equal(f.retained(), 0);
});

test("unconfirmed launch cleanup retains worker ownership and blocks replacement", async (t) => {
  const { FixtureBrowserError } = await import("../fixture-browser.ts");
  const f = await fixture(t, { open: async () => { throw new FixtureBrowserError(true); } });
  await assert.rejects(f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain), refused("failed"));
  await assert.rejects(f.lease.dispose(), refused("failed"));
  assert.equal(f.retained(), 1);
  assert.equal(f.dropped(), 0);
});

test("a launch failure with confirmed cleanup releases worker ownership exactly once", async (t) => {
  const { FixtureBrowserError } = await import("../fixture-browser.ts");
  const f = await fixture(t, { open: async () => { throw new FixtureBrowserError(false); } });
  await assert.rejects(f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain), refused("failed"));
  await f.lease.dispose();
  assert.equal(f.retained(), 0);
  assert.equal(f.dropped(), 1);
});

test("renewal after a permitted clock rollback uses the new proof's shorter verified expiry", async (t) => {
  const f = await fixture(t);
  f.advance(240_000);
  const first = await f.authority.renew(f.grant.capability, SCOPE);
  await f.lease.start(first.capability, SCOPE, request().signal, f.retain);
  f.advance(-239_980); // Still later than the authority's original proof time.
  const second = await f.authority.renew(first.capability, SCOPE);
  assert.equal(second.expiresAt, 301_020);
  f.advance(299_980);
  await f.lease.refreshProof(second.capability, SCOPE);
  f.advance(20);
  await until(() => f.driver.closed === 1);
  await until(() => f.dropped() === 1);
});

test("the closed-scope ledger stays full through time advances until worker replacement", async () => {
  let now = 1_000;
  let opened = 0;
  let retained = 0;
  // The real authority rate budget deliberately prevents this many live grants.
  // This trusted authorizer fixture stress-tests the lease's independent bound.
  const lease = new FixtureLease({
    authorize: async () => now + 100_000,
    open: async () => { opened++; return new Driver(); },
    lifecycle: request().signal,
    now: () => now,
  });
  const retain = () => { retained++; return { dispose: async () => { retained--; } }; };
  let refusedNewScope = false;
  try {
    for (let index = 0; index < 300; index++) {
      const scope = { ...SCOPE, generation: index };
      try { await lease.start("synthetic-proof", scope, request().signal, retain); }
      catch (error) { refused("busy")(error); refusedNewScope = true; break; }
      await lease.close("synthetic-proof", scope, request().signal);
    }
    assert.equal(refusedNewScope, true, "the replay ledger must have a fixed memory bound");
    const beforeReplay = opened;
    await assert.rejects(lease.start("synthetic-proof", { ...SCOPE, generation: 0 }, request().signal, retain), refused("inactive"));
    assert.equal(opened, beforeReplay);
    assert.equal(retained, 0);
    now += 100_000;
    await assert.rejects(lease.start("new-synthetic-proof", { ...SCOPE, generation: 0 }, request().signal, retain), refused("inactive"));
    await assert.rejects(lease.start("new-synthetic-proof", { ...SCOPE, generation: 1_000 }, request().signal, retain), refused("busy"));
    assert.equal(opened, beforeReplay);
  } finally { await lease.dispose(); }
  assert.equal(retained, 0);
});

test("a replacement current proof preserves closed-scope protection after the replaced proof expires", async (t) => {
  const f = await fixture(t);
  f.advance(1_000);
  const longer = await f.authority.authenticate(KEY, SCOPE);
  await f.lease.start(longer.capability, SCOPE, request().signal, f.retain);
  await assert.rejects(f.lease.frame(f.grant.capability, SCOPE, request().signal), refused("unauthorized"));
  await f.lease.frame(longer.capability, SCOPE, request().signal);
  await f.lease.close(longer.capability, SCOPE, request().signal);
  f.advance(299_000);
  await f.authority.authorize(longer.capability, SCOPE);
  await assert.rejects(f.lease.start(longer.capability, SCOPE, request().signal, f.retain), refused("inactive"));
  assert.equal(f.opened(), 1);
});

test("renewal after close cannot replay its scope after the original grant expires", async (t) => {
  const f = await fixture(t);
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  f.advance(240_000);
  await f.lease.close(f.grant.capability, SCOPE, request().signal);
  const renewed = await f.authority.renew(f.grant.capability, SCOPE);
  await f.lease.refreshProof(renewed.capability, SCOPE);
  f.advance(60_001);
  await f.authority.authorize(renewed.capability, SCOPE);
  await assert.rejects(f.lease.start(renewed.capability, SCOPE, request().signal, f.retain), refused("inactive"));
  assert.equal(f.opened(), 1);
  assert.equal(f.retained(), 0);
});

test("each fresh start obtains retention from that request's still-live owner", async (t) => {
  const f = await fixture(t);
  let firstContextOpen = true;
  let firstHeld = 0;
  let secondHeld = 0;
  const firstRetain = () => {
    assert.equal(firstContextOpen, true, "a completed RPC context cannot retain its worker");
    firstHeld++;
    return { dispose: async () => { firstHeld--; } };
  };
  await f.lease.start(f.grant.capability, SCOPE, request().signal, firstRetain);
  assert.equal(firstHeld, 1);
  firstContextOpen = false;
  await f.lease.close(f.grant.capability, SCOPE, request().signal);
  assert.equal(firstHeld, 0);
  const other = { ...SCOPE, generation: 2 };
  const grant = await f.authority.authenticate(KEY, other);
  await f.lease.start(grant.capability, other, request().signal, () => {
    secondHeld++;
    return { dispose: async () => { secondHeld--; } };
  });
  assert.equal(secondHeld, 1);
  await f.lease.close(grant.capability, other, request().signal);
  assert.equal(secondHeld, 0);
});

test("atomic renewal protects a lease while the new proof authorization is still in flight", async (t) => {
  const f = await fixture(t);
  assert.equal(typeof f.lease.renewProof, "function", "renewal must mark the lease before consuming its old proof");
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  const screenshot = deferred<FixtureFrame>();
  f.driver.frameGate = screenshot.promise;
  const frame = f.lease.frame(f.grant.capability, SCOPE, request().signal);
  const rejected = assert.rejects(frame, refused("unauthorized"));
  await until(() => f.driver.frames === 1);
  const verifying = deferred<void>();
  const releaseProof = deferred<void>();
  f.afterAuthorize(async (capability) => {
    if (capability !== f.grant.capability) { verifying.resolve(); await releaseProof.promise; }
  });
  const rotating = f.lease.renewProof(f.grant.capability, SCOPE, request().signal,
    () => f.authority.renew(f.grant.capability, SCOPE));
  await verifying.promise;
  screenshot.resolve(FRAME);
  await rejected;
  assert.equal(f.driver.closed, 0);
  releaseProof.resolve();
  const renewed = await rotating;
  f.driver.frameGate = undefined;
  assert.deepEqual(await f.lease.frame(renewed.capability, SCOPE, request().signal), FRAME);
});

test("closing while a trusted new proof is verified preserves the closed scope without reopening", async (t) => {
  const f = await fixture(t);
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  f.advance(240_000);
  const newGrant = await f.authority.authenticate(KEY, SCOPE);
  const verifying = deferred<void>();
  const releaseProof = deferred<void>();
  f.afterAuthorize(async (capability) => {
    if (capability === newGrant.capability) { verifying.resolve(); await releaseProof.promise; }
  });
  const refreshing = f.lease.refreshProof(newGrant.capability, SCOPE);
  await verifying.promise;
  await assert.rejects(f.lease.close(f.grant.capability, SCOPE, request().signal), refused("unauthorized"));
  assert.equal(await f.lease.stopForScope(SCOPE), true);
  releaseProof.resolve();
  await refreshing;
  f.advance(60_001);
  await assert.rejects(f.lease.start(newGrant.capability, SCOPE, request().signal, f.retain), refused("inactive"));
  assert.equal(f.opened(), 1);
  assert.equal(f.retained(), 0);
});

for (const transition of ["refresh", "renew"] as const) {
  test(`${transition} preserves a closed scope across grant expiry and another scope start`, async (t) => {
    const f = await fixture(t);
    await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
    f.advance(299_990);
    const verifying = deferred<void>();
    const releaseProof = deferred<void>();
    let newCapability = "";
    f.afterAuthorize(async (capability) => {
      if (capability === newCapability) { verifying.resolve(); await releaseProof.promise; }
    });
    const newGrant = transition === "refresh" ? await f.authority.authenticate(KEY, SCOPE) : undefined;
    if (newGrant) newCapability = newGrant.capability;
    const pending = transition === "refresh"
      ? f.lease.refreshProof(newCapability, SCOPE)
      : f.lease.renewProof(f.grant.capability, SCOPE, request().signal, async () => {
        const grant = await f.authority.renew(f.grant.capability, SCOPE);
        newCapability = grant.capability;
        return grant;
      });
    await verifying.promise;
    // Rotation consumes the old capability; trusted cleanup can still close the
    // exact owned lease while authorization of the new capability is held.
    await assert.rejects(f.lease.close(f.grant.capability, SCOPE, request().signal), refused("unauthorized"));
    assert.equal(await f.lease.stopForScope(SCOPE), true);
    f.advance(11);
    const other = { ...SCOPE, generation: 2 };
    const otherGrant = await f.authority.authenticate(KEY, other);
    await f.lease.start(otherGrant.capability, other, request().signal, f.retain);
    releaseProof.resolve();
    await pending;
    await f.lease.close(otherGrant.capability, other, request().signal);
    await assert.rejects(f.lease.start(newCapability, SCOPE, request().signal, f.retain), refused("inactive"));
    assert.equal(f.opened(), 2);
    assert.equal(f.retained(), 0);
  });
}

test("a current replacement grant issued before lease creation cannot reopen a closed scope", async (t) => {
  const parent = await fs.mkdtemp(join(tmpdir(), "remote-login-unseen-grant-test-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const dataDir = join(parent, "private");
  await provisionControlRoot(dataDir, KEY, controlKeyFingerprint(KEY));
  let now = 1_000;
  const authority = new ControlAuthority(dataDir, { now: () => now });
  const first = await authority.authenticate(KEY, SCOPE);
  now = 241_000;
  const unseen = await authority.authenticate(KEY, SCOPE);
  assert.equal(unseen.expiresAt, 541_000);
  let opened = 0;
  const lease = new FixtureLease({
    authorize: (capability, scope) => authority.authorize(capability, scope),
    open: async () => { opened++; return new Driver(); },
    lifecycle: request().signal,
    now: () => now,
  });
  t.after(() => lease.dispose());
  const retain = () => ({ dispose: async () => {} });
  await assert.rejects(lease.start(first.capability, SCOPE, request().signal, retain), refused("unauthorized"));
  await lease.start(unseen.capability, SCOPE, request().signal, retain);
  await lease.close(unseen.capability, SCOPE, request().signal);
  now = 301_001;
  await authority.authorize(unseen.capability, SCOPE);
  await assert.rejects(lease.start(unseen.capability, SCOPE, request().signal, retain), refused("inactive"));
  assert.equal(opened, 1);
});

test("trusted stop does not confirm cleanup for an unknown scope", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.lease.stopForScope(SCOPE), false);
  assert.equal(f.opened(), 0);
  assert.equal(f.driver.closed, 0);
  assert.equal(f.retained(), 0);
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  assert.equal(await f.lease.stopForScope({ ...SCOPE, generation: 2 }), false);
  assert.equal(f.driver.closed, 0);
  assert.equal(f.retained(), 1);
});

test("trusted stop confirms owned cleanup and its known completed closure", async (t) => {
  const f = await fixture(t);
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  assert.equal(await f.lease.stopForScope(SCOPE), true);
  assert.equal(f.driver.closed, 1);
  assert.equal(f.retained(), 0);
  assert.equal(await f.lease.stopForScope(SCOPE), true);
  assert.equal(f.driver.closed, 1);
  assert.equal(f.dropped(), 1);
});

test("a replacement lease cannot confirm the previous worker's cleanup from shared authorization", async (t) => {
  const f = await fixture(t);
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  await f.lease.stopForScope(SCOPE);
  const replacement = new FixtureLease({
    authorize: (capability, scope) => f.authority.authorize(capability, scope),
    open: async () => { assert.fail("an unknown scope must not launch or inspect a browser"); },
    lifecycle: request().signal,
    now: f.now,
  });
  t.after(() => replacement.dispose());
  assert.equal(await replacement.stopForScope(SCOPE), false);
  assert.equal(f.driver.closed, 1);
});

test("trusted stop waits for retiring cleanup before confirming it", async (t) => {
  const f = await fixture(t);
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  const closing = deferred<void>();
  f.driver.closeGate = closing.promise;
  const close = f.lease.close(f.grant.capability, SCOPE, request().signal);
  await until(() => f.driver.closed === 1);
  let confirmed = false;
  const stopped = f.lease.stopForScope(SCOPE).then((result) => { confirmed = result; return result; });
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(confirmed, false);
  assert.equal(f.retained(), 1);
  closing.resolve();
  assert.equal(await stopped, true);
  await close;
  assert.equal(f.retained(), 0);
});

test("trusted stop rejects unconfirmed cleanup while keeping the failed worker retained", async (t) => {
  const f = await fixture(t);
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  f.driver.closeGate = Promise.reject(new Error("private cleanup detail"));
  f.driver.closeGate.catch(() => {});
  await assert.rejects(f.lease.stopForScope(SCOPE), refused("failed"));
  await assert.rejects(f.lease.stopForScope(SCOPE), refused("failed"));
  assert.equal(f.retained(), 1);
  assert.equal(f.dropped(), 0);
  assert.equal(f.driver.closed, 1);
});


test("frame binding synthetic stale refusal preserves ownership, fresh input and spent IDs", async t => {
  const f = await fixture(t), staleId = randomUUID();
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  await assert.rejects(f.lease.input(f.grant.capability, SCOPE, INPUT, request().signal, staleId, randomUUID()), refused("stale_frame"));
  assert.equal(f.driver.inputs.length, 0); assert.equal(f.driver.closed, 0); assert.equal(f.retained(), 1);
  const fresh = await f.lease.frame(f.grant.capability, SCOPE, request().signal);
  await f.lease.input(f.grant.capability, SCOPE, INPUT, request().signal, randomUUID(), fresh.frameRef);
  assert.equal(f.driver.inputs.length, 1);
  await assert.rejects(f.lease.input(f.grant.capability, SCOPE, INPUT, request().signal, staleId, fresh.frameRef), refused("failed"));
  await until(() => f.driver.closed === 1); assert.equal(f.driver.inputs.length, 1);
});

test("frame binding synthetic claims only after browser preparation", async t => {
  const f = await fixture(t), prepared = deferred<void>(), entered = deferred<void>(); let claims = 0;
  const claim = InputReplayGuard.prototype.claim;
  t.mock.method(InputReplayGuard.prototype, "claim", function(this: InputReplayGuard, id: unknown) { claims++; return claim.call(this, id); });
  const input = f.driver.input.bind(f.driver);
  t.mock.method(f.driver, "input", async (...args: Parameters<typeof input>) => { entered.resolve(); await prepared.promise; return input(...args); });
  await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  const pending = f.lease.input(f.grant.capability, SCOPE, INPUT, request().signal, randomUUID(), FRAME_REF); void pending.catch(() => {});
  try { await entered.promise; assert.equal(claims, 0); }
  finally { prepared.resolve(); await pending.catch(() => {}); }
  assert.equal(claims, 1); assert.equal(f.driver.inputs.length, 1);
});

test("frame binding synthetic proof changes and verification invalidate the displayed observation", async t => {
  for (const transition of ["renew", "refresh", "capability", "verify"] as const) await t.test(transition, async t => {
    const f = await fixture(t); let capability = f.grant.capability;
    await f.lease.start(capability, SCOPE, request().signal, f.retain);
    const old = await f.lease.frame(capability, SCOPE, request().signal);
    if (transition === "renew") capability = (await f.lease.renewProof(capability, SCOPE, request().signal, () => f.authority.renew(capability, SCOPE))).capability;
    if (transition === "refresh" || transition === "capability") {
      capability = (await f.authority.authenticate(KEY, SCOPE)).capability;
      if (transition === "refresh") await f.lease.refreshProof(capability, SCOPE);
    }
    if (transition === "verify") assert.equal(await f.lease.verify(capability, SCOPE, request().signal), false);
    await assert.rejects(f.lease.input(capability, SCOPE, INPUT, request().signal, randomUUID(), old.frameRef), refused("stale_frame"));
    assert.equal(f.driver.inputs.length, 0); assert.equal(f.driver.closed, 0);
    const fresh = await f.lease.frame(capability, SCOPE, request().signal);
    await f.lease.input(capability, SCOPE, INPUT, request().signal, randomUUID(), fresh.frameRef);
    assert.equal(f.driver.inputs.length, 1);
  });
});

test("frame binding synthetic stale still runs final checks and spoofed errors close", async t => {
  for (const condition of ["authority", "spoof"] as const) await t.test(condition, async t => {
    const f = await fixture(t); await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
    if (condition === "authority") { let checks = 0; f.afterAuthorize(async () => { if (++checks === 2) throw new Error("refused"); }); }
    else f.driver.inputFailure = Object.assign(new Error("private fixture refusal"), { name: "StaleFrameError", code: "stale_frame" });
    await assert.rejects(f.lease.input(f.grant.capability, SCOPE, INPUT, request().signal, randomUUID(), randomUUID()), refused(condition === "authority" ? "unauthorized" : "failed"));
    await until(() => f.driver.closed === 1); assert.equal(f.driver.inputs.length, 0);
  });
});


test("capture change synthetic read preserves its owned lease until a fresh observation", async t => {
  const f = await fixture(t); await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
  const frame = f.driver.frame.bind(f.driver); let changed = true;
  t.mock.method(f.driver, "frame", async () => { if (changed) { changed = false; throw new StaleFrameError(); } return frame(); });
  await assert.rejects(f.lease.frame(f.grant.capability, SCOPE, request().signal), refused("stale_frame"));
  assert.equal(f.driver.closed, 0); assert.equal(f.retained(), 1); assert.equal(f.driver.inputs.length, 0);
  const fresh = await f.lease.frame(f.grant.capability, SCOPE, request().signal);
  await f.lease.input(f.grant.capability, SCOPE, INPUT, request().signal, randomUUID(), fresh.frameRef);
  assert.equal(f.driver.inputs.length, 1);
});

test("capture change synthetic read still closes on post-authorization loss or spoofed errors", async t => {
  for (const condition of ["authority", "spoof"] as const) await t.test(condition, async t => {
    const f = await fixture(t); await f.lease.start(f.grant.capability, SCOPE, request().signal, f.retain);
    if (condition === "authority") { let checks = 0; f.afterAuthorize(async () => { if (++checks === 2) throw new Error("refused"); }); }
    t.mock.method(f.driver, "frame", async () => { throw condition === "authority" ? new StaleFrameError() : Object.assign(new Error("private frame failure"), { name: "StaleFrameError", code: "stale_frame" }); });
    await assert.rejects(f.lease.frame(f.grant.capability, SCOPE, request().signal), refused(condition === "authority" ? "unauthorized" : "failed"));
    await until(() => f.driver.closed === 1); assert.equal(f.driver.inputs.length, 0);
  });
});
