import type { ControlGrant, ControlScope } from "./control-authority.ts";
import { FixtureBrowserError, type FixtureBrowser } from "./fixture-browser.ts";
import type { FixtureFrame, FixtureInput } from "./fixture-wire.ts";
import { InputReplayGuard } from "./input-replay.ts";
import { StaleFrameError } from "./frame-error.ts";

type LeaseCode = "unauthorized" | "unavailable" | "busy" | "inactive" | "aborted" | "expired" | "failed" | "stale_frame";
const staleInput = Symbol();
const staleFrame = Symbol();
type Retention = { dispose(): Promise<void> };
type Options = {
  authorize(capability: string, scope: ControlScope): Promise<number>;
  open(signal: AbortSignal): Promise<FixtureBrowser>;
  lifecycle: AbortSignal;
  now?: () => number;
};
type Run = {
  key: string;
  capability: string;
  expiresAt: number;
  retained: Retention;
  controller: AbortController;
  opening: Promise<FixtureBrowser>;
  browser?: FixtureBrowser;
  ready: boolean;
  proofRevision: number;
  busy: boolean;
  inputIds: InputReplayGuard;
  stopped?: LeaseCode;
  timer?: ReturnType<typeof setTimeout>;
  cleanup?: Promise<void>;
};

export class FixtureLeaseError extends Error {
  readonly code: LeaseCode;
  constructor(code: LeaseCode) {
    super("Fixture control refused.");
    this.name = "FixtureLeaseError";
    this.code = code;
  }
}
function fail(code: LeaseCode): never { throw new FixtureLeaseError(code); }
function fixed(error: unknown): FixtureLeaseError {
  return error instanceof FixtureLeaseError ? error : new FixtureLeaseError("failed");
}
function scopeValue(scope: ControlScope): ControlScope {
  if (!scope || Object.keys(scope).sort().join() !== "attemptId,browserContextId,generation,threadId"
    || ![scope.threadId, scope.attemptId, scope.browserContextId].every((value) => typeof value === "string" && value.length > 0 && value.length <= 200)
    || !Number.isSafeInteger(scope.generation) || scope.generation < 0) fail("unauthorized");
  return { threadId: scope.threadId, attemptId: scope.attemptId, browserContextId: scope.browserContextId, generation: scope.generation };
}
function scopeKey(scope: ControlScope): string {
  return JSON.stringify([scope.threadId, scope.attemptId, scope.browserContextId, scope.generation]);
}

type Cancellation = { signal: AbortSignal; code: LeaseCode };
async function cancellable<T>(operation: Promise<T>, cancellations: Cancellation[]): Promise<T> {
  const listeners: Array<() => void> = [];
  const cancelled = new Promise<never>((_, reject) => {
    for (const { signal, code } of cancellations) {
      const abort = () => reject(signal.reason instanceof FixtureLeaseError ? signal.reason : new FixtureLeaseError(code));
      if (signal.aborted) abort();
      else {
        signal.addEventListener("abort", abort, { once: true });
        listeners.push(() => signal.removeEventListener("abort", abort));
      }
    }
  });
  try { return await Promise.race([cancelled, operation]); }
  finally { for (const remove of listeners) remove(); }
}

/** Owns one private synthetic browser; public callers must supply current proof. */
export class FixtureLease {
  #options: Options;
  #now: () => number;
  #active?: Run;
  #retiring = new Set<Run>();
  #failed = new Set<Run>();
  #closedScopes = new Set<string>();
  #disposed = false;
  #poisoned = false;
  #disposing?: Promise<void>;
  #renewing = false;
  #onLifecycle = () => {
    this.#disposed = true;
    if (this.#active) void this.#stop(this.#active, "unavailable").catch(() => {});
  };

  constructor(options: Options) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    options.lifecycle.addEventListener("abort", this.#onLifecycle, { once: true });
    if (options.lifecycle.aborted) this.#onLifecycle();
  }

  #time(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) fail("unavailable");
    return now;
  }
  #available(signal?: AbortSignal): void {
    if (this.#disposed || this.#poisoned || this.#options.lifecycle.aborted) fail("unavailable");
    if (signal?.aborted) fail("aborted");
  }
  async #authorize(capability: string, scope: ControlScope, signal: AbortSignal): Promise<number> {
    this.#available(signal);
    const authorization = Promise.resolve().then(() => this.#options.authorize(capability, scope)).catch(() => fail("unauthorized"));
    const expiresAt = await cancellable(authorization, [
      { signal, code: "aborted" }, { signal: this.#options.lifecycle, code: "unavailable" },
    ]);
    this.#available(signal);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.#time()) fail("unauthorized");
    return expiresAt;
  }
  #assertActive(run: Run): void {
    if (run.stopped) fail(run.stopped);
    this.#available();
    if (this.#active !== run) fail("inactive");
    if (this.#time() >= run.expiresAt) {
      void this.#stop(run, "expired").catch(() => {});
      fail("expired");
    }
  }
  #refresh(run: Run, expiresAt: number, capability: string): void {
    this.#assertActive(run);
    if (capability !== run.capability) run.browser?.invalidateFrame();
    run.capability = capability;
    if (expiresAt !== run.expiresAt) {
      run.expiresAt = expiresAt;
      this.#schedule(run);
    }
  }
  #schedule(run: Run): void {
    clearTimeout(run.timer);
    run.timer = setTimeout(() => {
      try {
        if (run.stopped) return;
        if (this.#time() < run.expiresAt) this.#schedule(run);
        else void this.#stop(run, "expired").catch(() => {});
      } catch { void this.#stop(run, "unavailable").catch(() => {}); }
    }, Math.min(2_147_483_647, Math.max(0, run.expiresAt - this.#time())));
    run.timer.unref();
  }
  #owned(scope: ControlScope, expiresAt: number, capability: string): Run {
    const run = this.#active;
    if (!run || run.key !== scopeKey(scope)) fail("inactive");
    this.#refresh(run, expiresAt, capability);
    if (!run.ready || !run.browser) fail("busy");
    return run;
  }
  #stopOnAbort(run: Run, signal: AbortSignal): () => void {
    const abort = () => { void this.#stop(run, "aborted").catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return () => signal.removeEventListener("abort", abort);
  }

  // Invalidation is synchronous. Cleanup must not queue behind a screenshot or
  // uncertain input, and retention must outlive even a delayed browser launch.
  #stop(run: Run, code: LeaseCode): Promise<void> {
    if (run.cleanup) return run.cleanup;
    run.stopped = code;
    if (this.#active === run) this.#active = undefined;
    clearTimeout(run.timer);
    this.#closedScopes.add(run.key);
    this.#retiring.add(run);
    run.controller.abort(new FixtureLeaseError(code));
    run.cleanup = this.#cleanup(run);
    void run.cleanup.then(() => this.#retiring.delete(run), () => {
      this.#retiring.delete(run);
      this.#failed.add(run);
      this.#poisoned = true;
    });
    return run.cleanup;
  }
  async #cleanup(run: Run): Promise<void> {
    let browser: FixtureBrowser;
    try { browser = await run.opening; }
    catch (error) {
      // Unknown failures cannot establish that a spawned process has stopped.
      if (!(error instanceof FixtureBrowserError) || error.cleanupUncertain) fail("failed");
      try { await run.retained.dispose(); }
      catch { fail("failed"); }
      return;
    }
    try {
      await browser.close();
      await run.retained.dispose();
    } catch { fail("failed"); }
  }

  async start(capability: string, suppliedScope: ControlScope, signal: AbortSignal, retain: () => Retention): Promise<{ width: 800; height: 600 }> {
    const scope = scopeValue(suppliedScope);
    const expiresAt = await this.#authorize(capability, scope, signal);
    if (this.#active || this.#retiring.size) fail("busy");
    const key = scopeKey(scope);
    if (this.#closedScopes.has(key)) fail("inactive");
    // Closed scopes stay blocked for this worker lifetime; capacity needs a worker restart.
    if (this.#closedScopes.size >= 256) fail("busy");
    let retained: Retention;
    try { retained = retain(); }
    catch { fail("failed"); }
    try { this.#available(signal); }
    catch (error) {
      try { await retained.dispose(); } catch { this.#poisoned = true; fail("failed"); }
      throw fixed(error);
    }
    const controller = new AbortController();
    const run: Run = {
      key, capability, expiresAt, retained, controller,
      opening: Promise.resolve().then(() => this.#options.open(controller.signal)),
      ready: false, proofRevision: 0, busy: false, inputIds: new InputReplayGuard(),
    };
    this.#active = run;
    this.#schedule(run);
    const detach = this.#stopOnAbort(run, signal);
    const starting = (async () => {
      run.browser = await run.opening;
      this.#assertActive(run);
      const expiry = await this.#authorize(capability, scope, signal);
      this.#refresh(run, expiry, capability);
      run.ready = true;
      return { width: 800 as const, height: 600 as const };
    })();
    try {
      return await cancellable(starting, [
        { signal, code: "aborted" }, { signal: controller.signal, code: "inactive" },
      ]);
    } catch (error) {
      void this.#stop(run, fixed(error).code).catch(() => {});
      throw fixed(error);
    } finally { detach(); }
  }

  async #operate<T>(capability: string, suppliedScope: ControlScope, signal: AbortSignal,
    uncertainInput: boolean, operation: (browser: FixtureBrowser, run: Run) => Promise<T>): Promise<T> {
    const scope = scopeValue(suppliedScope);
    const expiresAt = await this.#authorize(capability, scope, signal);
    const run = this.#owned(scope, expiresAt, capability);
    if (run.busy) fail("busy");
    run.busy = true;
    const proofRevision = run.proofRevision;
    const detach = uncertainInput ? this.#stopOnAbort(run, signal) : () => {};
    const working = (async () => {
      try {
        this.#assertActive(run);
        const result = await operation(run.browser!, run);
        this.#assertActive(run);
        const expiry = await this.#authorize(capability, scope, signal);
        this.#refresh(run, expiry, capability);
        return result;
      } catch (error) {
        const failure = fixed(error);
        // A cancelled read has no uncertain action; its pending driver call
        // still occupies the operation slot until it actually settles.
        const renewedRead = !uncertainInput && failure.code === "unauthorized" && run.proofRevision !== proofRevision;
        if (!renewedRead && (failure.code !== "aborted" || uncertainInput)) void this.#stop(run, failure.code).catch(() => {});
        throw failure;
      } finally { run.busy = false; }
    })();
    try {
      return await cancellable(working, [
        { signal, code: "aborted" }, { signal: run.controller.signal, code: "inactive" },
      ]);
    } finally { detach(); }
  }

  async frame(capability: string, scope: ControlScope, signal: AbortSignal): Promise<FixtureFrame> {
    const result = await this.#operate<FixtureFrame | typeof staleFrame>(capability, scope, signal, false, async (browser) => {
      try { return await browser.frame(); }
      catch (error) { if (error instanceof StaleFrameError) return staleFrame; throw error; }
    });
    if (result === staleFrame) fail("stale_frame");
    return result;
  }
  verify(capability: string, scope: ControlScope, signal: AbortSignal): Promise<boolean> {
    return this.#operate(capability, scope, signal, false, (browser) => { browser.invalidateFrame(); return browser.verify(); });
  }
  async input(capability: string, scope: ControlScope, event: FixtureInput, signal: AbortSignal, inputId: string, frameRef: string): Promise<void> {
    const result = await this.#operate(capability, scope, signal, true, async (browser, run) => {
      try {
        await browser.input(event, frameRef, () => { try { run.inputIds.claim(inputId); } catch { fail("failed"); } });
      } catch (error) {
        // Only the driver's before-effect refusal may survive the final checks.
        if (error instanceof StaleFrameError) return staleInput;
        throw error;
      }
    });
    if (result === staleInput) fail("stale_frame");
  }
  async close(capability: string, suppliedScope: ControlScope, signal: AbortSignal): Promise<void> {
    const scope = scopeValue(suppliedScope);
    const expiresAt = await this.#authorize(capability, scope, signal);
    const run = this.#active;
    if (!run || run.key !== scopeKey(scope)) fail("inactive");
    this.#refresh(run, expiresAt, capability);
    const cleanup = this.#stop(run, "inactive");
    await cancellable(cleanup, [{ signal, code: "aborted" }, { signal: this.#options.lifecycle, code: "unavailable" }]);
    await this.#authorize(capability, scope, signal);
    if (run.stopped !== "inactive" || this.#active === run) fail("inactive");
  }

  /** Trusted host rotation hook; marks ownership before the old proof is consumed. */
  async renewProof(capability: string, suppliedScope: ControlScope, signal: AbortSignal,
    issue: () => Promise<ControlGrant>): Promise<ControlGrant> {
    const scope = scopeValue(suppliedScope);
    const key = scopeKey(scope);
    const expiresAt = await this.#authorize(capability, scope, signal);
    if (this.#renewing) fail("busy");
    const run = this.#active?.key === key ? this.#active : undefined;
    if (run) { this.#refresh(run, expiresAt, capability); run.proofRevision++; run.browser?.invalidateFrame(); }
    this.#renewing = true;
    try {
      const issuing = Promise.resolve().then(issue).catch(() => fail("unauthorized"));
      const grant = await cancellable(issuing, [
        { signal, code: "aborted" }, { signal: this.#options.lifecycle, code: "unavailable" },
      ]);
      const verifiedExpiry = await this.#authorize(grant.capability, scope, signal);
      if (run && this.#active === run && !run.stopped) this.#refresh(run, verifiedExpiry, grant.capability);
      return { capability: grant.capability, expiresAt: verifiedExpiry };
    } catch (error) {
      if (run && this.#active === run) void this.#stop(run, fixed(error).code).catch(() => {});
      throw fixed(error);
    } finally { this.#renewing = false; }
  }

  /** Trusted host proof hook; refreshes only the same still-active lease. */
  async refreshProof(capability: string, suppliedScope: ControlScope): Promise<void> {
    const scope = scopeValue(suppliedScope);
    const key = scopeKey(scope);
    const run = this.#active;
    const expiresAt = await this.#authorize(capability, scope, this.#options.lifecycle);
    if (!run || this.#active !== run || run.key !== key || run.stopped) return;
    this.#refresh(run, expiresAt, capability);
    run.proofRevision++;
    run.browser?.invalidateFrame();
  }

  /** Trusted cleanup hook; only this worker's confirmed closure can return true. */
  async stopForScope(suppliedScope: ControlScope): Promise<boolean> {
    const key = scopeKey(scopeValue(suppliedScope));
    if (this.#active?.key === key) {
      await this.#stop(this.#active, "inactive");
      return true;
    }
    const retired = [...this.#retiring, ...this.#failed].find((run) => run.key === key);
    if (retired) {
      await retired.cleanup;
      return true;
    }
    return this.#closedScopes.has(key);
  }
  dispose(): Promise<void> {
    if (this.#disposing) return this.#disposing;
    this.#disposed = true;
    this.#options.lifecycle.removeEventListener("abort", this.#onLifecycle);
    if (this.#active) void this.#stop(this.#active, "unavailable").catch(() => {});
    this.#disposing = (async () => {
      await Promise.all([...this.#retiring, ...this.#failed].map((run) => run.cleanup));
      if (this.#poisoned) fail("failed");
    })();
    return this.#disposing;
  }
}
