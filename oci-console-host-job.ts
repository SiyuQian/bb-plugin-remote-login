import { randomUUID } from "node:crypto";
import type { ControlGrant, ControlScope } from "./control-authority.ts";
import { controlScopeSchema } from "./control-wire.ts";
import { consoleExpectedIdentitySchema, type ConsoleExpectedIdentity } from "./oci-console-protocol.ts";
import { consoleHandbackSchema, consoleReadRequestSchema, consoleReadResultSchema, type ConsoleReadRequest, type ConsoleReadResult } from "./oci-console-wire.ts";
import { openOciConsoleBrowser, ConsoleBrowserError, type ConsoleBrowser } from "./oci-console-browser.ts";
import type { ConsoleIdentityMatch } from "./oci-console-verifier.ts";
import type { OciHostStatus } from "./oci-host-wire.ts";
import type { FixtureFrame, FixtureInput } from "./fixture-wire.ts";
import { OwnedResourceLedger } from "./owned-resource-ledger.ts";
import { InputReplayGuard } from "./input-replay.ts";
import { StaleFrameError } from "./frame-error.ts";
const staleInput = Symbol();
const staleFrame = Symbol();

type Retention = { dispose(): Promise<void> };
type Failure = Exclude<OciHostStatus["failure"], null>;
type ErrorCode = Failure | "busy" | "inactive" | "aborted" | "invalid_target" | "stale_frame";
type Options = {
  dataDir: string; lifecycle: AbortSignal;
  authorize(capability: string, scope: ControlScope): Promise<number>;
  requirePhoneGate(): Promise<void>;
  now?: () => number;
  dependencies?: { openBrowser?: typeof openOciConsoleBrowser };
};
type Handback = OciHostStatus & { verified: boolean; receipt?: string; browserRef?: string };
type Slot = { done: Promise<void>; release(): void };
type Run = {
  key: string; scope: ControlScope; expected: ConsoleExpectedIdentity; capability: string;
  expiresAt: number; hardDeadline: number; controller: AbortController; retained: Retention;
  opening: Promise<ConsoleBrowser>; browser?: ConsoleBrowser; launchAttempted: boolean;
  phase: OciHostStatus["phase"]; failure: OciHostStatus["failure"]; stopped: boolean;
  slot?: Slot; verifying?: Promise<void>; proofRevision: number; rotating?: Promise<void>;
  receipt?: string; browserRef?: string; timer?: ReturnType<typeof setTimeout>;
  cleanup?: Promise<void>; cleanupWork?: Promise<void>; retainedReleased: boolean;
  inputIds: InputReplayGuard;
};
export class ConsoleHostJobError extends Error {
  readonly cleanupUncertain: boolean;
  constructor(readonly code: ErrorCode) { super("Console host job refused."); this.name = "ConsoleHostJobError"; this.cleanupUncertain = code === "cleanup_uncertain"; }
}
function fail(code: ErrorCode): never { throw new ConsoleHostJobError(code); }
const viewport = { width: 800 as const, height: 600 as const };
function scopeValue(scope: ControlScope): ControlScope { const parsed = controlScopeSchema.safeParse(scope); if (!parsed.success) fail("authorization"); return parsed.data; }
function keyOf(scope: ControlScope): string { return JSON.stringify([scope.threadId, scope.attemptId, scope.browserContextId, scope.generation]); }
function failureOf(error: unknown): Failure {
  if ((error as { cleanupUncertain?: unknown } | null)?.cleanupUncertain === true) return "cleanup_uncertain";
  if (error instanceof ConsoleHostJobError && ["authorization", "unsupported", "expired", "cancelled", "verification_failed", "cleanup_uncertain"].includes(error.code)) return error.code as Failure;
  return "unavailable";
}
function fixed(error: unknown): ConsoleHostJobError { return error instanceof ConsoleHostJobError ? error : new ConsoleHostJobError(failureOf(error)); }
async function race<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(new ConsoleHostJobError("aborted")); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); });
  try { const value = await Promise.race([pending, cancelled]); if (signal.aborted) fail("aborted"); return value; }
  finally { signal.removeEventListener("abort", abort); }
}

/** Private Console ownership and handback. No CLI credentials, browser handles or caller code cross this boundary. */
export class ConsoleHostJobs {
  #options: Options;
  #openBrowser: typeof openOciConsoleBrowser;
  #configured = new Map<string, ConsoleExpectedIdentity>();
  #runs = new Map<string, Run>();
  #closedScopes = new Set<string>();
  #active?: Run;
  #disposed = false;
  #poisoned = false;
  #disposing?: Promise<void>;
  #renewing = false;
  #onLifecycle = () => {
    this.#disposed = true;
    for (const run of this.#runs.values()) if (!run.stopped) void this.#stop(run, "unavailable").catch(() => {});
  };
  constructor(options: Options) {
    this.#options = options; this.#openBrowser = options.dependencies?.openBrowser ?? openOciConsoleBrowser;
    options.lifecycle.addEventListener("abort", this.#onLifecycle, { once: true }); if (options.lifecycle.aborted) this.#onLifecycle();
  }
  #time(): number { const value = (this.#options.now ?? Date.now)(); if (!Number.isSafeInteger(value) || value < 0) fail("unavailable"); return value; }
  #available(signal?: AbortSignal): void {
    if (this.#disposed || this.#options.lifecycle.aborted) fail("unavailable");
    if (this.#poisoned) fail("cleanup_uncertain"); if (signal?.aborted) fail("aborted");
  }
  async #phone(signal: AbortSignal): Promise<void> {
    try { await race(Promise.resolve().then(this.#options.requirePhoneGate), AbortSignal.any([signal, this.#options.lifecycle, AbortSignal.timeout(8000)])); }
    catch { fail("unsupported"); } this.#available(signal);
  }
  async #authorize(capability: string, scope: ControlScope, signal: AbortSignal, phone = true): Promise<number> {
    this.#available(signal);
    const stopped = AbortSignal.any([signal, this.#options.lifecycle, AbortSignal.timeout(8000)]);
    if (phone) await this.#phone(stopped);
    let expiry: number;
    try { expiry = await race(Promise.resolve().then(() => this.#options.authorize(capability, scope)), stopped); }
    catch { fail("authorization"); }
    this.#available(signal); if (!Number.isSafeInteger(expiry) || expiry <= this.#time()) fail("authorization"); return expiry;
  }
  #live(run: Run): void {
    this.#available(); if (run.stopped || run.controller.signal.aborted) fail("inactive");
    if (this.#time() >= Math.min(run.expiresAt, run.hardDeadline)) { void this.#stop(run, "expired").catch(() => {}); fail("expired"); }
  }
  #schedule(run: Run): void {
    clearTimeout(run.timer);
    run.timer = setTimeout(() => {
      try { if (!run.stopped) { if (this.#time() < Math.min(run.expiresAt, run.hardDeadline)) this.#schedule(run); else void this.#stop(run, "expired").catch(() => {}); } }
      catch { void this.#stop(run, "unavailable").catch(() => {}); }
    }, Math.max(0, Math.min(2_147_483_647, Math.min(run.expiresAt, run.hardDeadline) - this.#time()))); run.timer.unref();
  }
  #refresh(run: Run, capability: string, expiry: number, revision = run.proofRevision): void {
    this.#live(run); if (revision !== run.proofRevision && capability !== run.capability) fail("authorization");
    if (capability !== run.capability) run.browser?.invalidateFrame();
    run.capability = capability; run.expiresAt = Math.min(expiry, run.hardDeadline); this.#schedule(run);
  }
  async #authorizeRun(run: Run, signal = run.controller.signal): Promise<void> {
    const stopped = AbortSignal.any([signal, run.controller.signal]);
    for (;;) {
      if (run.rotating) await race(run.rotating, stopped);
      this.#live(run); stopped.throwIfAborted();
      const revision = run.proofRevision, capability = run.capability;
      let expiry: number;
      try { expiry = await this.#authorize(capability, run.scope, stopped); }
      catch (error) { if (revision !== run.proofRevision && !run.stopped) continue; throw error; }
      if (revision !== run.proofRevision) continue;
      this.#refresh(run, capability, expiry, revision); return;
    }
  }
  #take(run: Run): Slot {
    this.#live(run); if (run.slot) fail("busy");
    let release!: () => void; const done = new Promise<void>((resolve) => { release = resolve; });
    const slot: Slot = { done, release: () => { if (run.slot === slot) run.slot = undefined; release(); } }; run.slot = slot; return slot;
  }
  #public(run: Run | undefined, key: string, accepted: boolean): OciHostStatus {
    return { configured: this.#configured.has(key), phoneControlAccepted: accepted,
      phase: run?.phase ?? (this.#closedScopes.has(key) ? "cancelled" : this.#configured.has(key) ? "ready" : "unconfigured"),
      failure: run?.failure ?? (this.#closedScopes.has(key) ? "cancelled" : null) };
  }
  async configure(capability: string, supplied: ControlScope, expected: ConsoleExpectedIdentity, signal: AbortSignal): Promise<void> {
    const scope = scopeValue(supplied), key = keyOf(scope); await this.#authorize(capability, scope, signal);
    if (this.#closedScopes.has(key)) fail("inactive");
    const parsed = consoleExpectedIdentitySchema.safeParse(expected);
    if (!parsed.success || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(scope.attemptId)) fail("invalid_target");
    const prior = this.#configured.get(key);
    if (prior) { if (JSON.stringify(prior) !== JSON.stringify(parsed.data)) fail("invalid_target"); return; }
    if (this.#configured.size >= 256) fail("busy"); this.#configured.set(key, Object.freeze(parsed.data));
  }
  async start(capability: string, supplied: ControlScope, signal: AbortSignal, retain: () => Retention): Promise<typeof viewport> {
    const scope = scopeValue(supplied), key = keyOf(scope), prior = this.#runs.get(key), revision = prior?.proofRevision;
    const expiry = await this.#authorize(capability, scope, signal), expected = this.#configured.get(key);
    if (!expected) fail("invalid_target"); if (this.#closedScopes.has(key)) fail("inactive");
    if (prior) { this.#refresh(prior, capability, expiry, revision); if (!["starting", "user_control"].includes(prior.phase)) fail("inactive"); return { ...viewport }; }
    if (this.#active || [...this.#runs.values()].some(run => run.cleanup && !run.retainedReleased)) fail("busy");
    let retained: Retention;
    try { retained = retain(); } catch { fail("unavailable"); }
    try { this.#available(signal); } catch (error) { try { await retained.dispose(); } catch { this.#poisoned = true; fail("cleanup_uncertain"); } throw error; }
    const run: Run = { key, scope, expected, capability, expiresAt: expiry, hardDeadline: this.#time() + 900000,
      retained, controller: new AbortController(), opening: Promise.resolve(undefined as never), launchAttempted: false,
      phase: "starting", failure: null, stopped: false, proofRevision: 0, retainedReleased: false, inputIds: new InputReplayGuard() };
    this.#runs.set(key, run); this.#active = run; this.#schedule(run);
    run.opening = Promise.resolve().then(async () => {
      await this.#authorizeRun(run); run.launchAttempted = true;
      const browser = await this.#openBrowser({ tempDir: this.#options.dataDir, expected: run.expected, scope: run.scope,
        expiresAt: run.hardDeadline, lifecycle: run.controller.signal,
        assertOwned: async (bound, stopped) => { if (keyOf(scopeValue(bound)) !== run.key) fail("authorization"); await this.#authorizeRun(run, stopped); } });
      run.browser = browser; this.#live(run); await this.#authorizeRun(run); this.#live(run); run.phase = "user_control"; return browser;
    });
    void run.opening.catch((error) => { void this.#stop(run, failureOf(error)).catch(() => {}); }); return { ...viewport };
  }
  async status(capability: string, supplied: ControlScope, signal: AbortSignal): Promise<OciHostStatus> {
    const scope = scopeValue(supplied), key = keyOf(scope); await this.#authorize(capability, scope, signal, false);
    let accepted = true; try { await this.#phone(signal); } catch { accepted = false; }
    const run = this.#runs.get(key); if (run && !run.stopped) this.#live(run); return this.#public(run, key, accepted);
  }
  #operation<T>(run: Run, signal: AbortSignal, trusted: boolean, stopOnAbort: boolean,
    execute: (stopped: AbortSignal, authorized: () => void) => Promise<T>, proofRevision?: number): Promise<T> {
    const slot = this.#take(run), stopped = AbortSignal.any([signal, run.controller.signal, this.#options.lifecycle, AbortSignal.timeout(7500)]);
    let authorized = trusted;
    const abort = () => { if (authorized && stopOnAbort && !run.stopped) void this.#stop(run, "cancelled").catch(() => {}); };
    stopped.addEventListener("abort", abort, { once: true }); if (stopped.aborted) abort();
    const working = Promise.resolve().then(async () => {
      try { this.#live(run); return await execute(stopped, () => { authorized = true; if (stopped.aborted) abort(); }); }
      catch (error) {
        const superseded = error instanceof ConsoleHostJobError && error.code === "authorization"
          && proofRevision !== undefined && proofRevision !== run.proofRevision;
        if (authorized && !superseded && !run.stopped && !(signal.aborted && !stopOnAbort)) void this.#stop(run, failureOf(error)).catch(() => {});
        throw fixed(error);
      } finally { stopped.removeEventListener("abort", abort); slot.release(); }
    });
    return race(working, stopped);
  }
  async frame(capability: string, supplied: ControlScope, signal: AbortSignal): Promise<FixtureFrame> {
    const result = await this.#human<FixtureFrame | typeof staleFrame>(capability, supplied, signal, false, async browser => {
      try { return await browser.frame(); }
      catch (error) { if (error instanceof StaleFrameError) return staleFrame; throw error; }
    });
    if (result === staleFrame) fail("stale_frame");
    return result;
  }
  async input(capability: string, supplied: ControlScope, event: FixtureInput, signal: AbortSignal, inputId: string, frameRef: string): Promise<void> {
    const result = await this.#human(capability, supplied, signal, true, async (browser, run) => {
      try {
        await browser.input(event, frameRef, () => { try { run.inputIds.claim(inputId); } catch { fail("unavailable"); } });
      } catch (error) {
        if (error instanceof StaleFrameError) return staleInput;
        throw error;
      }
    });
    if (result === staleInput) fail("stale_frame");
  }
  #human<T>(capability: string, supplied: ControlScope, signal: AbortSignal, input: boolean, action: (browser: ConsoleBrowser, run: Run) => Promise<T>): Promise<T> {
    const scope = scopeValue(supplied), run = this.#runs.get(keyOf(scope)); if (!run) fail("inactive");
    if (run.phase === "starting") fail("busy"); if (run.phase !== "user_control" || !run.browser) fail("inactive");
    const revision = run.proofRevision;
    return this.#operation(run, signal, false, input, async (stopped, authorized) => {
      const expiry = await this.#authorize(capability, scope, stopped); this.#refresh(run, capability, expiry, revision); authorized(); this.#live(run);
      const result = await action(run.browser!, run); this.#live(run);
      const after = await this.#authorize(capability, scope, stopped); this.#refresh(run, capability, after, revision); return result;
    }, revision);
  }
  async handback(capability: string, supplied: ControlScope, signal: AbortSignal): Promise<Handback> {
    const scope = scopeValue(supplied), run = this.#runs.get(keyOf(scope)); if (!run) fail("inactive");
    if (run.phase === "starting") fail("busy");
    if (run.phase === "verifying" || run.phase === "verified") {
      const revision = run.proofRevision, expiry = await this.#authorize(capability, scope, signal); this.#refresh(run, capability, expiry, revision);
      return consoleHandbackSchema.parse({ ...this.#public(run, run.key, true), verified: run.phase === "verified",
        ...(run.phase === "verified" ? { receipt: run.receipt, browserRef: run.browserRef } : {}) });
    }
    if (run.phase !== "user_control") fail("inactive");
    const slot = this.#take(run), revision = run.proofRevision; let transferred = false;
    try {
      const expiry = await this.#authorize(capability, scope, signal); this.#refresh(run, capability, expiry, revision); this.#live(run);
      run.phase = "verifying"; run.browser?.invalidateFrame(); transferred = true;
      const stopped = AbortSignal.any([run.controller.signal, this.#options.lifecycle, AbortSignal.timeout(7500)]);
      const abort = () => { if (!run.stopped) void this.#stop(run, "verification_failed").catch(() => {}); };
      stopped.addEventListener("abort", abort, { once: true });
      run.verifying = Promise.resolve().then(async () => {
        try {
          await this.#authorizeRun(run, stopped); const identity = await run.browser!.verify(stopped); this.#match(identity);
          await run.browser!.assertRetained(stopped); await this.#authorizeRun(run, stopped); await run.browser!.assertRetained(stopped);
          this.#live(run); stopped.throwIfAborted(); run.receipt = randomUUID(); run.browserRef = randomUUID(); run.phase = "verified";
          if (this.#active === run) this.#active = undefined;
        } catch (error) { if (!run.stopped) void this.#stop(run, failureOf(error) === "cleanup_uncertain" ? "cleanup_uncertain" : "verification_failed").catch(() => {}); throw fixed(error); }
        finally { stopped.removeEventListener("abort", abort); slot.release(); }
      });
      void run.verifying.catch(() => {}); return { ...this.#public(run, run.key, true), verified: false };
    } finally { if (!transferred) slot.release(); }
  }
  #match(identity: ConsoleIdentityMatch): void { try { consoleReadResultSchema.parse({ ...identity, operation: "read_identity" }); } catch { fail("verification_failed"); } }
  #selection(scope: ControlScope, receipt: string, browserRef?: string): Run {
    const run = this.#runs.get(keyOf(scope));
    if (!run || run.stopped || run.phase !== "verified" || !run.receipt || !run.browserRef || run.receipt !== receipt || (browserRef !== undefined && run.browserRef !== browserRef)) fail("authorization");
    return run;
  }
  async #post(run: Run, stopped: AbortSignal): Promise<void> {
    await run.browser!.assertRetained(stopped); await this.#authorizeRun(run, stopped); await run.browser!.assertRetained(stopped); this.#live(run); stopped.throwIfAborted();
  }
  async resumeProof(supplied: ControlScope, receipt: string): Promise<{ browserRef: string; expiresAt: number }> {
    const scope = scopeValue(supplied), run = this.#selection(scope, receipt);
    return this.#operation(run, run.controller.signal, true, true, async (stopped) => {
      await this.#authorizeRun(run, stopped); this.#match(await run.browser!.verify(stopped)); await this.#post(run, stopped);
      this.#selection(scope, receipt); return { browserRef: run.browserRef!, expiresAt: run.expiresAt };
    });
  }
  async readTask(selection: { scope: ControlScope; receipt: string; browserRef: string }, supplied: ConsoleReadRequest, signal: AbortSignal): Promise<{ result: ConsoleReadResult; expiresAt: number }> {
    const scope = scopeValue(selection.scope), run = this.#selection(scope, selection.receipt, selection.browserRef), request = consoleReadRequestSchema.safeParse(supplied);
    if (!request.success) fail("invalid_target");
    return this.#operation(run, signal, true, true, async (stopped) => {
      await this.#authorizeRun(run, stopped);
      let result: ConsoleReadResult;
      if (request.data.operation === "read_identity") result = consoleReadResultSchema.parse({ ...await run.browser!.verify(stopped), operation: "read_identity" });
      else {
        const outline = await run.browser!.readPage(stopped);
        const page = consoleReadResultSchema.parse({ operation: "read_page", title: outline.title, headings: [...outline.headings] });
        if (page.operation !== "read_page") fail("verification_failed");
        result = page;
        const text = [page.title, ...page.headings].join("\n");
        if ([run.expected.userOcid, run.expected.tenancyOcid, run.expected.domainOcid].some(value => text.includes(value)) || /https?:\/\/|-----BEGIN|<\/?[a-z]|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(text)) fail("verification_failed");
      }
      await this.#post(run, stopped); this.#selection(scope, selection.receipt, selection.browserRef);
      return { result, expiresAt: run.expiresAt };
    });
  }
  #stop(run: Run, reason: Failure): Promise<void> {
    if (run.cleanup) return run.cleanup;
    let done!: () => void, reject!: (error: unknown) => void;
    run.cleanup = new Promise<void>((yes, no) => { done = yes; reject = no; }); void run.cleanup.catch(() => {});
    run.stopped = true; run.failure = reason; run.phase = reason === "cancelled" ? "cancelled" : "failed";
    run.receipt = undefined; run.browserRef = undefined; this.#closedScopes.add(run.key); clearTimeout(run.timer);
    if (this.#active === run) this.#active = undefined;
    run.cleanupWork = Promise.resolve().then(async () => {
      let browser = run.browser;
      try { browser = await run.opening; }
      catch (error) { browser = run.browser; if (!browser && run.launchAttempted && (!(error instanceof ConsoleBrowserError) || error.cleanupUncertain)) fail("cleanup_uncertain"); }
      if (browser) await browser.close();
      if (run.slot) await run.slot.done;
      await run.retained.dispose(); run.retainedReleased = true;
    });
    void race(run.cleanupWork, AbortSignal.timeout(7500)).then(done, () => { run.failure = "cleanup_uncertain"; run.phase = "failed"; this.#poisoned = true; reject(new ConsoleHostJobError("cleanup_uncertain")); });
    run.controller.abort(); return run.cleanup;
  }
  async close(capability: string, supplied: ControlScope, signal: AbortSignal): Promise<void> {
    const scope = scopeValue(supplied); await this.#authorize(capability, scope, signal, false);
    const run = this.#runs.get(keyOf(scope));
    if (run) await race(this.#stop(run, "cancelled"), AbortSignal.any([signal, this.#options.lifecycle]));
    else if (!await this.stopForScope(scope)) fail("inactive");
    await this.#authorize(capability, scope, signal, false);
  }
  async renewProof(capability: string, supplied: ControlScope, signal: AbortSignal, issue: () => Promise<ControlGrant>): Promise<ControlGrant> {
    const scope = scopeValue(supplied), run = this.#runs.get(keyOf(scope)); if (this.#renewing) fail("busy"); this.#renewing = true;
    let releaseRotation: (() => void) | undefined;
    try {
      const revision = run?.proofRevision, expiry = await this.#authorize(capability, scope, signal);
      if (run && !run.stopped) { this.#refresh(run, capability, expiry, revision); run.proofRevision++; run.browser?.invalidateFrame(); run.rotating = new Promise<void>((resolve) => { releaseRotation = resolve; }); }
      const grant = await race(Promise.resolve().then(issue), AbortSignal.any([signal, this.#options.lifecycle, AbortSignal.timeout(8000)]));
      const issuedRevision = run?.proofRevision, verifiedExpiry = await this.#authorize(grant.capability, scope, signal);
      if (run && !run.stopped) this.#refresh(run, grant.capability, verifiedExpiry, issuedRevision);
      return { capability: grant.capability, expiresAt: run && !run.stopped ? run.expiresAt : verifiedExpiry };
    } catch (error) { if (releaseRotation && run && !run.stopped) void this.#stop(run, failureOf(error)).catch(() => {}); throw fixed(error); }
    finally { releaseRotation?.(); if (run) run.rotating = undefined; this.#renewing = false; }
  }
  observeAuthenticatedGrant(supplied: ControlScope, grant: ControlGrant): void {
    const run = this.#runs.get(keyOf(scopeValue(supplied))); if (!run || run.stopped || this.#disposed || this.#poisoned) return;
    if (this.#time() >= Math.min(run.expiresAt, run.hardDeadline)) { void this.#stop(run, "expired").catch(() => {}); return; }
    if (typeof grant.capability !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(grant.capability) || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= this.#time()) return;
    run.browser?.invalidateFrame(); run.capability = grant.capability; run.expiresAt = Math.min(grant.expiresAt, run.hardDeadline); run.proofRevision++; this.#schedule(run);
  }
  async refreshProof(capability: string, supplied: ControlScope): Promise<void> {
    const scope = scopeValue(supplied), run = this.#runs.get(keyOf(scope)); if (!run || run.stopped) return;
    const revision = run.proofRevision;
    let expiry: number;
    try { expiry = await this.#authorize(capability, scope, this.#options.lifecycle); }
    catch (error) { if (revision !== run.proofRevision) return; throw error; }
    if (!run.stopped) { this.#refresh(run, capability, expiry, revision); run.proofRevision++; run.browser?.invalidateFrame(); }
  }
  hasScope(supplied: ControlScope): boolean { return this.#configured.has(keyOf(scopeValue(supplied))); }
  async stopForScope(supplied: ControlScope): Promise<boolean> {
    const scope = scopeValue(supplied), key = keyOf(scope), run = this.#runs.get(key);
    if (run) { await this.#stop(run, "cancelled"); return true; }
    if (this.#configured.has(key)) { this.#closedScopes.add(key); return true; }
    return await new OwnedResourceLedger(this.#options.dataDir).recover(scope, "browser_profile") === "recovered";
  }
  dispose(): Promise<void> {
    if (this.#disposing) return this.#disposing; this.#disposed = true; this.#options.lifecycle.removeEventListener("abort", this.#onLifecycle);
    this.#disposing = Promise.all([...this.#runs.values()].map(run => this.#stop(run, "unavailable"))).then(() => {}); return this.#disposing;
  }
}
