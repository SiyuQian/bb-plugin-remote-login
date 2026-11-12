import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createOwnedOciSession, releaseOwnedOciSession } from "../oci-owned-session.ts";
import { OwnedResourceLedger } from "../owned-resource-ledger.ts";
import { verifyOwnedOciSession } from "../oci-owned-verifier.ts";
import { runOwnedOciDiagnostic } from "../oci-official-diagnostic.ts";
import { startOciAuthenticationChild } from "../oci-child-job.ts";
import { fixturePrivateKey, fixturePublicKey, fixtureTarget, fixtureToken } from "./oci-verifier-fixture.ts";

type Runner = "authentication" | "diagnostic" | "verifier";
async function fixture(t: TestContext, runner: Runner, heldJournal: boolean, spawnThrows = false, heldBegin = false) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "oci-bounded-cleanup-")); await fs.chmod(root, 0o700);
  const attemptId = randomUUID(), session = await createOwnedOciSession(root, attemptId, fixtureTarget);
  if (runner !== "authentication") {
    await fs.writeFile(session.paths.privateKeyFile, fixturePrivateKey);
    await fs.writeFile(session.paths.publicKeyFile, fixturePublicKey);
    await fs.writeFile(session.paths.tokenFile, fixtureToken());
    await fs.writeFile(session.paths.configFile, `[${session.paths.profileName}]\nfingerprint=${Array(16).fill("aa").join(":")}\nkey_file=${session.paths.privateKeyFile}\nsecurity_token_file=${session.paths.tokenFile}\ntenancy=${fixtureTarget.tenancyOcid}\nregion=${fixtureTarget.region}\n`);
  }
  t.after(async () => { try { await releaseOwnedOciSession(session); } catch { /* Unconfirmed cleanup must retain its journal. */ } await fs.rm(root, { recursive: true, force: true }); });
  let releaseBegin!: () => void, enterBegin!: () => void, cleanupStarted!: () => void;
  const beginning = new Promise<void>((resolve) => { enterBegin = resolve; }), beginHeld = new Promise<void>((resolve) => { releaseBegin = resolve; });
  const cleanup = new Promise<void>((resolve) => { cleanupStarted = resolve; });
  if (heldBegin) {
    const begin = OwnedResourceLedger.prototype.beginWriter;
    t.mock.method(OwnedResourceLedger.prototype, "beginWriter", async function(this: OwnedResourceLedger, ...args: Parameters<typeof begin>) {
      const result = await begin.apply(this, args); enterBegin(); await beginHeld; return result;
    });
  }
  let releaseJournal!: () => void;
  const held = new Promise<void>((resolve) => { releaseJournal = resolve; });
  if (heldJournal) {
    const confirm = OwnedResourceLedger.prototype.confirmWriterClosed;
    t.mock.method(OwnedResourceLedger.prototype, "confirmWriterClosed", async function(this: OwnedResourceLedger, ...args: Parameters<typeof confirm>) {
      await held; return confirm.apply(this, args);
    });
  }
  const controller = new AbortController(), messages = new PassThrough();
  let closeObserved = false, configured = false, retained = 0, spawns = 0;
  const signals: string[] = [];
  const child = Object.assign(new EventEmitter(), { pid: process.pid, exitCode: null as number | null, signalCode: null as string | null,
    kill: (signal: string) => { signals.push(signal); return true; } });
  const close = () => { if (!closeObserved) { closeObserved = true; child.exitCode = 0; child.emit("close", 0); } };
  const commands = new Writable({ write(chunk, _encoding, done) {
    const packet = JSON.parse(String(chunk)); done();
    if (packet.type === "cancel" || configured) return;
    configured = true; cleanupStarted();
    queueMicrotask(() => { if (heldJournal) close(); controller.abort(); });
  } });
  Object.assign(child, { stdio: [null, null, null, commands, messages] });
  t.mock.method(cp, "spawn", () => { spawns++; if (spawnThrows) { cleanupStarted(); throw new Error("synthetic spawn refusal"); } return child as never; });
  const options = { attemptId, session, signal: controller.signal, lifecycle: new AbortController().signal,
    authorize: async () => {}, retainWorker: () => { retained++; return () => { retained--; }; } };
  const run = () => runner === "authentication" ? startOciAuthenticationChild({ ...options, lifetimeMs: 5000, consumeBrowser: async () => {} })
    : runner === "diagnostic" ? runOwnedOciDiagnostic(options) : verifyOwnedOciSession({ ...options, timeoutMs: 4000 });
  return { run, beginning, cleanup, abort: () => controller.abort(), spawns: () => spawns, configured: () => configured, retained: () => retained, signals, async finish() {
    releaseBegin(); releaseJournal(); close(); messages.destroy(); commands.destroy();
    for (let attempt = 0; attempt < 400 && retained; attempt++) await delay(5);
    assert.equal(retained, 0, "confirmed late journal closure releases its own child retention");
  } };
}
async function boundedFailure(pending: Promise<unknown>): Promise<unknown> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([pending.then(() => { assert.fail("unconfirmed cleanup returned success"); }, (error: unknown) => error),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("cleanup exceeded the owned-process escalation and journal budget")), 3000); })]);
  } finally { clearTimeout(timer); }
}
for (const runner of ["authentication", "diagnostic", "verifier"] as const) {
  for (const heldJournal of [false, true]) {
    test(`${runner} returns uncertain cleanup when ${heldJournal ? "its journal close never settles" : "its exact child never confirms close"}`, { timeout: 10000 }, async (t) => {
      const s = await fixture(t, runner, heldJournal), pending = s.run();
      try {
        await Promise.race([s.cleanup, pending.then(() => { assert.fail("runner settled before the cleanup boundary"); })]);
        const error = await boundedFailure(pending);
        assert.equal(s.configured(), true);
        assert.equal((error as { cleanupUncertain?: boolean }).cleanupUncertain, true);
        assert.equal((error as { code?: string }).code, "cleanup_uncertain");
        assert.equal(s.retained(), 1, "unconfirmed ownership keeps worker retention");
        if (!heldJournal) assert.deepEqual(s.signals, ["SIGTERM", "SIGKILL"]);
      } finally { await s.finish(); await pending.catch(() => {}); }
    });
  }
  test(`${runner} bounds a stalled journal abandonment after a spawn throw`, { timeout: 10000 }, async (t) => {
    const s = await fixture(t, runner, true, true), pending = s.run();
    try {
      await Promise.race([s.cleanup, pending.then(() => { assert.fail("runner settled before spawn failure"); })]);
      const error = await boundedFailure(pending);
      assert.equal((error as { cleanupUncertain?: boolean }).cleanupUncertain, true);
      assert.equal((error as { code?: string }).code, "cleanup_uncertain");
      assert.equal(s.configured(), false); assert.equal(s.retained(), 1); assert.deepEqual(s.signals, []);
    } finally { await s.finish(); await pending.catch(() => {}); }
  });
  test(`${runner} bounds cancelled writer preparation and abandons only its exact late intent`, { timeout: 10000 }, async (t) => {
    const s = await fixture(t, runner, false, false, true), pending = s.run();
    try {
      await Promise.race([s.beginning, pending.then(() => { assert.fail("runner settled before writer preparation"); })]);
      s.abort();
      const error = await boundedFailure(pending);
      assert.equal((error as { cleanupUncertain?: boolean }).cleanupUncertain, true);
      assert.equal((error as { code?: string }).code, "cleanup_uncertain");
      assert.equal(s.configured(), false); assert.equal(s.retained(), 1); assert.equal(s.spawns(), 0);
    } finally { await s.finish(); await pending.catch(() => {}); }
  });
}
