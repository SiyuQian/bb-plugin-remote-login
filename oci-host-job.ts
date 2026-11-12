import { browserControlModeSchema, type BrowserControlMode } from "./browser-control.ts";
import { randomUUID } from "node:crypto";
import type { ControlGrant, ControlScope } from "./control-authority.ts";
import { controlScopeSchema } from "./control-wire.ts";
import { cliExpectedIdentitySchema, type CliExpectedIdentity } from "./oci-cli-protocol.ts";
import { createOwnedOciSession, releaseOwnedOciSession, recoverOwnedOciSession, captureOwnedOciGenerationSeal, assertOwnedOciGenerationSeal, type OwnedOciSession, type OwnedOciGenerationSeal } from "./oci-owned-session.ts";
import { OciChildError, startOciAuthenticationChild } from "./oci-child-job.ts";
import { openOciProviderBrowser, OciProviderBrowserError, type OciProviderBrowser } from "./oci-provider-browser.ts";
import { verifyOwnedOciSession } from "./oci-owned-verifier.ts";
import { runOwnedOciDiagnostic } from "./oci-official-diagnostic.ts";
import type { FixtureFrame, FixtureInput } from "./fixture-wire.ts";
import type { OciHostStatus } from "./oci-host-wire.ts";
import { runOwnedOciTask, type OciTaskRequest } from "./oci-owned-task.ts";
import { ociReadRequestSchema, ociReadResultSchema, type OciReadRequest, type OciReadResult } from "./oci-read-wire.ts";
import { InputReplayGuard } from "./input-replay.ts";
import { StaleFrameError } from "./frame-error.ts";
const staleInput = Symbol();
const staleFrame = Symbol();

type Retention = { dispose(): Promise<void> };
type Dependencies = {
  startChild: typeof startOciAuthenticationChild;
  openBrowser: typeof openOciProviderBrowser;
  verify: typeof verifyOwnedOciSession;
  diagnostic: typeof runOwnedOciDiagnostic;
  captureSeal: typeof captureOwnedOciGenerationSeal;
  assertSeal: typeof assertOwnedOciGenerationSeal;
  readTask: typeof runOwnedOciTask;
};
type Options = {
  dataDir: string;
  lifecycle: AbortSignal;
  authorize(capability: string, scope: ControlScope): Promise<number>;
  requirePhoneGate(controlMode: BrowserControlMode): Promise<void>;
  now?: () => number;
  // Worker-only external process/service boundaries, never accepted by RPC.
  dependencies?: Partial<Dependencies>;
};
type Failure = Exclude<OciHostStatus["failure"], null>;
type ErrorCode = Failure | "busy" | "inactive" | "aborted" | "invalid_target" | "stale_frame";
export class OciHostJobError extends Error {
  constructor(readonly code: ErrorCode) { super("OCI host job refused."); this.name = "OciHostJobError"; }
}
type Handback = OciHostStatus & { verified: boolean; receipt?: string; accountRef?: string };
type Run = {
  key: string; scope: ControlScope; controlMode: BrowserControlMode; capability: string; expected: CliExpectedIdentity;
  expiresAt: number; hardDeadline: number; controller: AbortController; retained: Retention;
  phase: OciHostStatus["phase"]; failure: OciHostStatus["failure"];
  starting: Promise<void>; child?: Awaited<ReturnType<typeof startOciAuthenticationChild>>;
  browser?: OciProviderBrowser; browserOpening?: Promise<OciProviderBrowser>; session?: OwnedOciSession; timer?: ReturnType<typeof setTimeout>;
  busy: boolean; proofRevision: number; stopped: boolean; uncertain: boolean;
  cleanup?: Promise<void>; verifying?: Promise<void>; receipt?: string; accountRef?: string;
  retainedReleased: boolean; childRetentions: number;
  rotating?: Promise<void>;
  generationSeal?: OwnedOciGenerationSeal;
  reading?: Promise<unknown>;
  compartments?: Map<string, string>;
  inputIds: InputReplayGuard;
};
const viewport = { width: 800 as const, height: 600 as const };
function fail(code: ErrorCode): never { throw new OciHostJobError(code); }
function scopeValue(scope: ControlScope): ControlScope {
  const parsed = controlScopeSchema.safeParse(scope);
  if (!parsed.success) fail("authorization");
  return parsed.data;
}
function keyOf(scope: ControlScope): string { return JSON.stringify([scope.threadId, scope.attemptId, scope.browserContextId, scope.generation]); }
function failureOf(error: unknown): Failure {
  if (error instanceof OciHostJobError) return ["authorization", "unsupported", "expired", "cancelled", "verification_failed", "cleanup_uncertain"].includes(error.code) ? error.code as Failure : "unavailable";
  if ((error as { cleanupUncertain?: unknown } | null)?.cleanupUncertain === true) return "cleanup_uncertain";
  return "child_failed";
}
async function race<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new OciHostJobError("aborted"));
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
  });
  try { const value = await Promise.race([promise, cancelled]); if (signal.aborted) fail("aborted"); return value; }
  finally { signal.removeEventListener("abort", abort); }
}

/** One private CLI job per worker. URLs, targets and session leases never leave this object. */
export class OciHostJobs {
  #options: Options;
  #dependencies: Dependencies;
  #configured = new Map<string, { expected: CliExpectedIdentity; controlMode: BrowserControlMode }>();
  #closedScopes = new Set<string>();
  #runs = new Map<string, Run>();
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
    this.#options = options;
    this.#dependencies = { startChild: startOciAuthenticationChild, openBrowser: openOciProviderBrowser,
      verify: verifyOwnedOciSession, diagnostic: runOwnedOciDiagnostic,
      captureSeal: captureOwnedOciGenerationSeal, assertSeal: assertOwnedOciGenerationSeal, readTask: runOwnedOciTask, ...options.dependencies };
    options.lifecycle.addEventListener("abort", this.#onLifecycle, { once: true });
    if (options.lifecycle.aborted) this.#onLifecycle();
  }
  #time(): number {
    const now = (this.#options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) fail("unavailable");
    return now;
  }
  #available(signal?: AbortSignal): void {
    if (this.#disposed || this.#options.lifecycle.aborted) fail("unavailable");
    if (this.#poisoned) fail("cleanup_uncertain");
    if (signal?.aborted) fail("aborted");
  }
  async #phone(signal: AbortSignal, controlMode: BrowserControlMode): Promise<void> {
    try { await race(Promise.resolve().then(() => this.#options.requirePhoneGate(controlMode)), AbortSignal.any([signal, this.#options.lifecycle, AbortSignal.timeout(8000)])); }
    catch { fail("unsupported"); }
    this.#available(signal);
  }
  async #authorize(capability: string, scope: ControlScope, signal: AbortSignal, phone = true, controlMode = this.#configured.get(keyOf(scope))?.controlMode ?? "remote"): Promise<number> {
    this.#available(signal);
    const bounded = AbortSignal.any([signal, this.#options.lifecycle, AbortSignal.timeout(8000)]);
    if (phone) await this.#phone(bounded, controlMode);
    let expiresAt: number;
    try { expiresAt = await race(Promise.resolve().then(() => this.#options.authorize(capability, scope)), bounded); }
    catch { fail("authorization"); }
    this.#available(signal);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.#time()) fail("authorization");
    return expiresAt;
  }
  #assertLive(run: Run): void {
    this.#available();
    if (run.stopped || run.controller.signal.aborted) fail("inactive");
    if (this.#time() >= Math.min(run.expiresAt, run.hardDeadline)) {
      void this.#stop(run, "expired").catch(() => {}); fail("expired");
    }
  }
  #schedule(run: Run): void {
    clearTimeout(run.timer);
    run.timer = setTimeout(() => {
      try {
        if (run.stopped) return;
        if (this.#time() < Math.min(run.expiresAt, run.hardDeadline)) this.#schedule(run);
        else void this.#stop(run, "expired").catch(() => {});
      } catch { void this.#stop(run, "unavailable").catch(() => {}); }
    }, Math.max(0, Math.min(2_147_483_647, Math.min(run.expiresAt, run.hardDeadline) - this.#time())));
    run.timer.unref();
  }
  #refresh(run: Run, capability: string, expiresAt: number): void {
    this.#assertLive(run);
    if (capability !== run.capability) run.browser?.invalidateFrame();
    run.capability = capability; run.expiresAt = Math.min(expiresAt, run.hardDeadline);
    this.#schedule(run);
  }
  async #authorizeRun(run: Run): Promise<void> {
    if (run.rotating) await race(run.rotating, run.controller.signal);
    this.#assertLive(run);
    const revision = run.proofRevision, capability = run.capability;
    try {
      const expiresAt = await this.#authorize(capability, run.scope, run.controller.signal);
      if (revision !== run.proofRevision) {
        if (run.rotating) await race(run.rotating, run.controller.signal);
        await this.#authorizeRun(run); return;
      }
      this.#refresh(run, capability, expiresAt);
    } catch (error) {
      // A rotation may consume the old proof while the child is checking it.
      if (revision !== run.proofRevision && !run.stopped) {
        if (run.rotating) await race(run.rotating, run.controller.signal);
        const expiresAt = await this.#authorize(run.capability, run.scope, run.controller.signal);
        this.#refresh(run, run.capability, expiresAt); return;
      }
      throw error;
    }
  }
  #retainChild(run: Run): () => void {
    this.#assertLive(run); run.childRetentions++;
    let released = false;
    return () => { if (!released) { released = true; run.childRetentions--; } };
  }
  async #releaseRetention(run: Run): Promise<void> {
    if (run.retainedReleased) return;
    if (run.childRetentions) fail("cleanup_uncertain");
    await run.retained.dispose(); run.retainedReleased = true;
  }
  async configure(capability: string, supplied: ControlScope, suppliedExpected: CliExpectedIdentity, signal: AbortSignal, suppliedMode: BrowserControlMode = "remote"): Promise<void> {
    const scope = scopeValue(supplied), key = keyOf(scope), mode = browserControlModeSchema.safeParse(suppliedMode);
    if (!mode.success) fail("invalid_target");
    const controlMode = mode.data;
    await this.#authorize(capability, scope, signal, true, controlMode);
    if (this.#closedScopes.has(key)) fail("inactive");
    const parsed = cliExpectedIdentitySchema.safeParse(suppliedExpected);
    if (!parsed.success || parsed.data.region !== "ap-sydney-1"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(scope.attemptId)) fail("invalid_target");
    const existing = this.#configured.get(key);
    if (existing) {
      if (existing.controlMode !== controlMode || JSON.stringify(existing.expected) !== JSON.stringify(parsed.data)) fail("invalid_target");
      return;
    }
    if (this.#configured.size >= 256) fail("busy");
    this.#configured.set(key, Object.freeze({ expected: Object.freeze(parsed.data), controlMode }));
  }
  async start(capability: string, supplied: ControlScope, signal: AbortSignal, retain: () => Retention, suppliedMode: BrowserControlMode = "remote"): Promise<typeof viewport> {
    const scope = scopeValue(supplied), key = keyOf(scope), mode = browserControlModeSchema.safeParse(suppliedMode);
    if (!mode.success) fail("invalid_target");
    const controlMode = mode.data;
    const expiresAt = await this.#authorize(capability, scope, signal, true, controlMode);
    const configured = this.#configured.get(key);
    if (!configured || configured.controlMode !== controlMode) fail("invalid_target");
    const expected = configured.expected;
    if (this.#closedScopes.has(key)) fail("inactive");
    const prior = this.#runs.get(key);
    if (prior) {
      this.#assertLive(prior); this.#refresh(prior, capability, expiresAt);
      if (!["starting", "user_control"].includes(prior.phase)) fail("inactive");
      return { ...viewport };
    }
    if (this.#active || [...this.#runs.values()].some((run) => run.cleanup && !run.retainedReleased)) fail("busy");
    let retained: Retention;
    try { retained = retain(); } catch { fail("unavailable"); }
    try { this.#available(signal); }
    catch (error) {
      try { await retained.dispose(); } catch { this.#poisoned = true; fail("cleanup_uncertain"); }
      throw error;
    }
    const run: Run = { key, scope, controlMode, expected, capability, expiresAt, hardDeadline: this.#time() + 900000,
      controller: new AbortController(), retained, phase: "starting", failure: null,
      starting: Promise.resolve(), busy: false, proofRevision: 0, stopped: false, uncertain: false,
      retainedReleased: false, childRetentions: 0, inputIds: new InputReplayGuard() };
    this.#runs.set(key, run); this.#active = run; this.#schedule(run);
    // A host RPC must not remain open through provider login or browser startup.
    run.starting = Promise.resolve().then(() => this.#launch(run));
    void run.starting.catch((error) => { void this.#stop(run, failureOf(error)).catch(() => {}); });
    return { ...viewport };
  }
  async #launch(run: Run): Promise<void> {
    await this.#authorizeRun(run);
    try { run.session = await createOwnedOciSession(this.#options.dataDir, run.scope.attemptId, run.expected, run.scope); }
    catch { run.uncertain = true; fail("unavailable"); }
    this.#assertLive(run);
    try {
      run.child = await this.#dependencies.startChild({ attemptId: run.scope.attemptId, lifetimeMs: 900000,
        session: run.session, signal: run.controller.signal, lifecycle: this.#options.lifecycle,
        authorize: () => this.#authorizeRun(run), retainWorker: () => this.#retainChild(run),
        consumeBrowser: async (url, childSignal) => {
          childSignal.throwIfAborted(); await this.#authorizeRun(run);
          run.browserOpening = Promise.resolve().then(() => this.#dependencies.openBrowser(this.#options.dataDir, url, run.controller.signal, run.session, run.controlMode));
          try { run.browser = await run.browserOpening; }
          catch (error) {
            // The child reports only browser_refused; preserve browser ownership uncertainty here.
            if (!(error instanceof OciProviderBrowserError) || error.cleanupUncertain) run.uncertain = true;
            throw error;
          }
          this.#assertLive(run); childSignal.throwIfAborted(); await this.#authorizeRun(run);
        },
      });
    } catch (error) {
      if (!(error instanceof OciChildError) || error.cleanupUncertain) run.uncertain = true;
      throw error;
    }
    this.#assertLive(run);
    run.phase = "user_control";
    void run.child.result.then((result) => {
      if (result.outcome !== "bootstrap_complete" && !run.stopped) void this.#stop(run, "child_failed").catch(() => {});
    }, (error) => {
      if (!(error instanceof OciChildError) || error.cleanupUncertain) run.uncertain = true;
      if (!run.stopped) void this.#stop(run, failureOf(error)).catch(() => {});
    });
  }
  #public(run: Run | undefined, configured: boolean, phoneControlAccepted: boolean): OciHostStatus {
    return { configured, phoneControlAccepted, phase: run?.phase ?? (configured ? "ready" : "unconfigured"), failure: run?.failure ?? null };
  }
  async status(capability: string, supplied: ControlScope, signal: AbortSignal, suppliedMode?: BrowserControlMode): Promise<OciHostStatus> {
    const scope = scopeValue(supplied), key = keyOf(scope), configured = this.#configured.get(key);
    await this.#authorize(capability, scope, signal, false);
    const mode = browserControlModeSchema.safeParse(suppliedMode ?? configured?.controlMode ?? "remote");
    if (!mode.success || (configured && mode.data !== configured.controlMode)) fail("invalid_target");
    let accepted = true; try { await this.#phone(signal, mode.data); } catch { accepted = false; }
    const run = this.#runs.get(key);
    if (run && !run.stopped && run.phase !== "verified") this.#assertLive(run);
    if (!run && this.#closedScopes.has(key)) return { configured: true, phoneControlAccepted: accepted, phase: "cancelled", failure: "cancelled" };
    return this.#public(run, this.#configured.has(key), accepted);
  }
  async #operate<T>(capability: string, supplied: ControlScope, signal: AbortSignal, input: boolean,
    operation: (browser: OciProviderBrowser, run: Run) => Promise<T>): Promise<T> {
    const scope = scopeValue(supplied), expiry = await this.#authorize(capability, scope, signal);
    const run = this.#runs.get(keyOf(scope));
    if (!run) fail("inactive");
    this.#refresh(run, capability, expiry);
    if (run.controlMode !== "remote") fail("inactive");
    if (run.phase === "starting" || run.busy) fail("busy");
    if (run.phase !== "user_control" || !run.browser) fail("inactive");
    run.busy = true;
    const revision = run.proofRevision;
    const abort = () => { void this.#stop(run, "cancelled").catch(() => {}); };
    if (input) { signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); }
    const working = (async () => {
      try {
        this.#assertLive(run);
        const value = await operation(run.browser!, run);
        this.#assertLive(run);
        const expiresAt = await this.#authorize(capability, scope, signal);
        this.#refresh(run, capability, expiresAt); return value;
      } catch (error) {
        if (!(error instanceof OciHostJobError && error.code === "authorization" && revision !== run.proofRevision)
          && (input || !signal.aborted)) void this.#stop(run, failureOf(error)).catch(() => {});
        throw error instanceof OciHostJobError ? error : new OciHostJobError("unavailable");
      } finally { run.busy = false; }
    })();
    try { return await race(working, AbortSignal.any([signal, run.controller.signal])); }
    finally { signal.removeEventListener("abort", abort); }
  }
  async frame(capability: string, scope: ControlScope, signal: AbortSignal): Promise<FixtureFrame> {
    const result = await this.#operate<FixtureFrame | typeof staleFrame>(capability, scope, signal, false, async (browser) => {
      try { return await browser.frame(); }
      catch (error) { if (error instanceof StaleFrameError) return staleFrame; throw error; }
    });
    if (result === staleFrame) fail("stale_frame");
    return result;
  }
  async input(capability: string, scope: ControlScope, event: FixtureInput, signal: AbortSignal, inputId: string, frameRef: string): Promise<void> {
    const result = await this.#operate(capability, scope, signal, true, async (browser, run) => {
      try {
        await browser.input(event, frameRef, () => { try { run.inputIds.claim(inputId); } catch { fail("unavailable"); } });
      } catch (error) {
        if (error instanceof StaleFrameError) return staleInput;
        throw error;
      }
    });
    if (result === staleInput) fail("stale_frame");
  }
  async handback(capability: string, supplied: ControlScope, signal: AbortSignal): Promise<Handback> {
    const scope = scopeValue(supplied), expiry = await this.#authorize(capability, scope, signal);
    const run = this.#runs.get(keyOf(scope));
    if (!run) fail("inactive");
    if (run.phase === "verified" && !run.stopped) return { ...this.#public(run, true, true), verified: true, receipt: run.receipt, accountRef: run.accountRef };
    this.#refresh(run, capability, expiry);
    if (run.phase === "starting" || run.busy) fail("busy");
    if (run.phase === "user_control") {
      // Synchronous phase change fences queued and concurrent input before waiting.
      run.phase = "verifying";
      run.browser?.invalidateFrame();
      run.verifying = this.#verify(run);
      void run.verifying.catch((error) => { void this.#stop(run, failureOf(error)).catch(() => {}); });
    }
    if (run.phase !== "verifying") fail("inactive");
    return { ...this.#public(run, true, true), verified: false };
  }
  async #verify(run: Run): Promise<void> {
    if (run.controlMode === "host") {
      const block = run.browser?.blockLocalInput;
      if (typeof block !== "function") fail("unsupported");
      // A visible browser must stop accepting local input before waiting for
      // the callback. Phase fencing alone protects only the remote API.
      await race(block.call(run.browser), AbortSignal.any([run.controller.signal, this.#options.lifecycle, AbortSignal.timeout(7500)]));
    }
    await this.#authorizeRun(run);
    const result = await race(run.child!.result, run.controller.signal);
    if (result.outcome !== "bootstrap_complete") fail("child_failed");
    await run.browser!.close();
    await this.#authorizeRun(run);
    const options = { attemptId: run.scope.attemptId, session: run.session!, signal: run.controller.signal,
      lifecycle: this.#options.lifecycle, authorize: () => this.#authorizeRun(run), retainWorker: () => this.#retainChild(run) };
    let verified: Awaited<ReturnType<typeof verifyOwnedOciSession>>;
    try {
      const seal = await this.#dependencies.captureSeal(run.session!);
      await this.#dependencies.diagnostic(options);
      await this.#dependencies.assertSeal(run.session!, seal);
      await this.#authorizeRun(run);
      verified = await this.#dependencies.verify({ ...options, timeoutMs: 30000 });
      if (!verified.match || verified.reason !== "matched") fail("verification_failed");
      await this.#authorizeRun(run);
      await this.#dependencies.assertSeal(run.session!, seal);
      run.generationSeal = seal;
    } catch (error) {
      if (failureOf(error) === "cleanup_uncertain") throw error;
      if (run.stopped) throw error;
      fail("verification_failed");
    }
    this.#assertLive(run);
    run.receipt = randomUUID(); run.accountRef = randomUUID(); run.phase = "verified";
    if (this.#active === run) this.#active = undefined;
  }
  #stop(run: Run, failure: Failure): Promise<void> {
    if (run.cleanup) return run.cleanup;
    run.stopped = true; run.failure = failure;
    this.#closedScopes.add(run.key);
    run.phase = failure === "cancelled" ? "cancelled" : "failed";
    run.receipt = undefined; run.accountRef = undefined;
    run.generationSeal = undefined;
    run.compartments?.clear();
    clearTimeout(run.timer); run.controller.abort();
    if (this.#active === run) this.#active = undefined;
    run.cleanup = this.#cleanup(run).catch(() => {
      run.failure = "cleanup_uncertain"; run.phase = "failed"; this.#poisoned = true;
      throw new OciHostJobError("cleanup_uncertain");
    });
    void run.cleanup.catch(() => {});
    return run.cleanup;
  }
  async #cleanup(run: Run): Promise<void> {
    await run.starting.catch(() => {});
    let uncertain = run.uncertain;
    try { await run.child?.cancel(); } catch { uncertain = true; }
    if (run.browserOpening) {
      try { run.browser = await run.browserOpening; }
      catch (error) { if (!(error instanceof OciProviderBrowserError) || error.cleanupUncertain) uncertain = true; }
    }
    try { await run.browser?.close(); } catch { uncertain = true; }
    if (run.verifying) await run.verifying.catch((error) => { if (failureOf(error) === "cleanup_uncertain") uncertain = true; });
    if (run.reading) await run.reading.catch((error) => { if (failureOf(error) === "cleanup_uncertain") uncertain = true; });
    if (uncertain || run.uncertain || run.childRetentions) fail("cleanup_uncertain");
    if (run.session) await releaseOwnedOciSession(run.session);
    await this.#releaseRetention(run);
  }
  async close(capability: string, supplied: ControlScope, signal: AbortSignal): Promise<void> {
    const scope = scopeValue(supplied); await this.#authorize(capability, scope, signal, false);
    const run = this.#runs.get(keyOf(scope));
    if (run) await race(this.#stop(run, "cancelled"), AbortSignal.any([signal, this.#options.lifecycle]));
    else if (!await this.stopForScope(scope)) fail("inactive");
    await this.#authorize(capability, scope, signal, false);
  }
  async renewProof(capability: string, supplied: ControlScope, signal: AbortSignal, issue: () => Promise<ControlGrant>): Promise<ControlGrant> {
    const scope = scopeValue(supplied), expiry = await this.#authorize(capability, scope, signal);
    if (this.#renewing) fail("busy");
    const run = this.#runs.get(keyOf(scope));
    let resolveRotation: (() => void) | undefined;
    if (run && !run.stopped) {
      this.#refresh(run, capability, expiry); run.proofRevision++; run.browser?.invalidateFrame();
      run.rotating = new Promise<void>((resolve) => { resolveRotation = resolve; });
    }
    this.#renewing = true;
    try {
      const grant = await race(Promise.resolve().then(issue), AbortSignal.any([signal, this.#options.lifecycle, AbortSignal.timeout(8000)]));
      const expiresAt = await this.#authorize(grant.capability, scope, signal);
      if (run && !run.stopped) this.#refresh(run, grant.capability, expiresAt);
      return { capability: grant.capability, expiresAt };
    } catch (error) {
      if (run && !run.stopped) void this.#stop(run, failureOf(error)).catch(() => {});
      throw new OciHostJobError("authorization");
    } finally { resolveRotation?.(); if (run) run.rotating = undefined; this.#renewing = false; }
  }
  async refreshProof(capability: string, supplied: ControlScope): Promise<void> {
    const scope = scopeValue(supplied), run = this.#runs.get(keyOf(scope));
    if (!run || run.stopped) return;
    const expiry = await this.#authorize(capability, scope, this.#options.lifecycle);
    if (!run.stopped) { this.#refresh(run, capability, expiry); run.proofRevision++; run.browser?.invalidateFrame(); }
  }
  async stopForScope(supplied: ControlScope): Promise<boolean> {
    const key = keyOf(scopeValue(supplied)), run = this.#runs.get(key);
    if (!run) {
      if (!this.#configured.has(key)) return await recoverOwnedOciSession(this.#options.dataDir, supplied) === "recovered";
      this.#closedScopes.add(key); return true;
    }
    await this.#stop(run, "cancelled"); return true;
  }
  hasScope(supplied: ControlScope): boolean { return this.#configured.has(keyOf(scopeValue(supplied))); }
  /** Trusted native completion only: never accepts a caller capability or a public success assertion. */
  async resumeProof(supplied: ControlScope, receipt: string): Promise<{ accountRef: string; expiresAt: number }> {
    const run = this.#runs.get(keyOf(scopeValue(supplied)));
    if (!run || run.stopped || run.phase !== "verified" || !run.accountRef || !run.generationSeal || run.receipt !== receipt) fail("authorization");
    await this.#authorizeRun(run);
    try { await this.#dependencies.assertSeal(run.session!, run.generationSeal); }
    catch { fail("verification_failed"); }
    await this.#authorizeRun(run);
    this.#assertLive(run);
    if (run.phase !== "verified" || run.receipt !== receipt || !run.accountRef) fail("authorization");
    return { accountRef: run.accountRef, expiresAt: run.expiresAt };
  }
  /** Fixed read delegation after verified handback. References alone confer no authority. */
  async readTask(selection: { scope: ControlScope; receipt: string; accountRef: string }, supplied: OciReadRequest, signal: AbortSignal): Promise<{ result: OciReadResult; expiresAt: number }> {
    const scope = scopeValue(selection.scope), run = this.#runs.get(keyOf(scope));
    if (!run || run.accountRef !== selection.accountRef || run.receipt !== selection.receipt || run.phase !== "verified" || run.stopped) fail("authorization");
    const request = ociReadRequestSchema.safeParse(supplied);
    if (!request.success) fail("invalid_target");
    if (run.busy) fail("busy");
    run.busy = true;
    const workingSignal = AbortSignal.any([signal, run.controller.signal, this.#options.lifecycle, AbortSignal.timeout(7500)]);
    const abort = () => { void this.#stop(run, "cancelled").catch(() => {}); };
    const working = Promise.resolve().then(async () => {
      try {
        await this.resumeProof(scope, selection.receipt);
        this.#available(workingSignal);
        let operation: OciTaskRequest;
        if (request.data.operation === "list_instances") {
          const compartmentOcid = request.data.compartmentRef ? run.compartments?.get(request.data.compartmentRef) : run.expected.tenancyOcid;
          if (!compartmentOcid) fail("authorization");
          operation = { operation: "list_instances", compartmentOcid };
        } else operation = { operation: "list_compartments" };
        await this.#authorizeRun(run);
        await this.#dependencies.assertSeal(run.session!, run.generationSeal!);
        const result = await this.#dependencies.readTask({ attemptId: scope.attemptId, session: run.session!, request: operation,
          signal: workingSignal, lifecycle: this.#options.lifecycle, authorize: () => this.#authorizeRun(run), retainWorker: () => this.#retainChild(run) });
        await this.#authorizeRun(run);
        await this.#dependencies.assertSeal(run.session!, run.generationSeal!);
        this.#assertLive(run); workingSignal.throwIfAborted();
        if (run.receipt !== selection.receipt || run.accountRef !== selection.accountRef || result.operation !== operation.operation) fail("authorization");
        let projected: OciReadResult;
        if (result.operation === "list_compartments") {
          const references = new Map(run.compartments ?? []);
          const reference = (ocid: string) => {
            for (const [ref, existing] of references) if (existing === ocid) return ref;
            if (references.size >= 256) fail("busy");
            const ref = randomUUID(); references.set(ref, ocid); return ref;
          };
          projected = ociReadResultSchema.parse({ operation: "list_compartments", rootCompartmentRef: reference(run.expected.tenancyOcid),
            rows: result.rows.map((row) => ({ compartmentRef: reference(row.ocid), name: row.name })), truncated: result.truncated });
          run.compartments = references;
        } else projected = ociReadResultSchema.parse(result);
        return { result: projected, expiresAt: run.expiresAt };
      } catch (error) {
        if ((error as { cleanupUncertain?: boolean })?.cleanupUncertain) void this.#stop(run, "cleanup_uncertain").catch(() => {});
        throw error instanceof OciHostJobError ? error : new OciHostJobError("unavailable");
      } finally { run.busy = false; }
    });
    run.reading = working;
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    try { return await race(working, workingSignal); }
    finally { signal.removeEventListener("abort", abort); }
  }
  dispose(): Promise<void> {
    if (this.#disposing) return this.#disposing;
    this.#disposed = true;
    this.#options.lifecycle.removeEventListener("abort", this.#onLifecycle);
    this.#disposing = Promise.all([...this.#runs.values()].map((run) => this.#stop(run, "unavailable"))).then(() => {});
    return this.#disposing;
  }
}
