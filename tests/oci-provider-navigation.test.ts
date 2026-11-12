import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { HTTPRequest, ProtocolError, type CDPSession, type Page } from "puppeteer-core";
import { isSupportedOciBrowserUrl } from "../oci-provider-browser.ts";
import { fixtureFrameSchema } from "../fixture-wire.ts";
import { cliFlowFixture, context as nativeContext, eventually, nativeValue, supportedHost } from "./cli-flow-fixture.ts";
import { ownedCliServiceFixture } from "./owned-cli-service-fixture.ts";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function callbackKind(raw: string): "root" | "token" | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)
      || url.port !== "8181" || url.username || url.password) return null;
    return url.pathname === "/" ? "root" : url.pathname === "/token" ? "token" : null;
  } catch { return null; }
}

// Source host and real pinned bootstrap/callback/persistence/SDK; only provider
// documents and service acceptance are synthetic. This does not prove a cause
// for the separately observed intermittent mobile CLI frame refusal.
test("private CLI frame ignores same-document events and waits for its owned callback before capture", {
  skip: !supportedHost, timeout: 90_000, concurrency: false,
}, async (t) => {
  let page: Page | undefined;
  const service = await ownedCliServiceFixture(t, { onProviderPage: (value) => { page = value; } });
  const s = await cliFlowFixture(t);
  const gate = latch(), held = latch(), frameEntered = latch(), ignoredSameDocument = latch(), captureDispatched = latch(), gateExpired = latch();
  const facts = { order: [] as string[], rootRequests: 0, rootContinuations: 0, tokenContinuations: 0,
    unsupportedContinuations: 0, inputEffects: 0, callbackFetchDispatches: 0, framePrecheckObserved: false,
    navigationWaitsStarted: 0, navigationWaitsFulfilled: 0, navigationWaitsRejected: 0, ignoresSameDocumentOption: true,
    defaultSameDocumentObserved: false, defaultSameDocumentWaitFulfilled: false,
    ignoredSameDocumentObserved: false, ignoredWaitSettledAfterSameDocument: null as number | null, ignoredWaitCancelled: false,
    mainGetCallbackSeen: false, callbackState: "none", frameStatus: null as number | null,
    captureDispatchKind: "unobserved", callbackStateAtDispatch: "unobserved", captures: 0, captureFailures: 0, captureParametersMatch: true,
    rootResponses: [] as number[], tokenResponses: [] as number[],
    gateTimedOut: false, captureFailed: false, captureError: null as Record<string, unknown> | null,
    callbackCommitBeforeCaptureSettlement: false, sameContext: null as boolean | null, sameTarget: null as boolean | null };
  const refusals: Array<{ method: string; reason: string }> = [];
  s.faults.afterHostCall = async (method, response) => {
    if (response && typeof response === "object" && "ok" in response && response.ok === false && "reason" in response
      && typeof response.reason === "string" && /^[a-z_]{1,40}$/.test(response.reason)) refusals.push({ method, reason: response.reason });
  };
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let probe: CDPSession | undefined;
  const navigationProbes: Array<{ controller: AbortController; promise: Promise<unknown> }> = [];
  let gateOpen = false, frameActive = false, captureRequested = false, resumingCallback = false, tearingDown = false;
  let resumeCallback: (() => void) | undefined, firstCaptureParameters: string | undefined;
  let resumeCapture: (() => void) | undefined, rejectCapture: (() => void) | undefined;
  const release = () => { if (!gateOpen) { gateOpen = true; facts.order.push("callback_released"); resumeCallback?.(); gate.release(); } };
  try {
    assert.equal((await s.send("start")).status, 202);
    await eventually(async () => (await (await s.send("oci-status")).json() as { phase: string }).phase === "user_control");
    assert.ok(page, "the original provider page must be observed before its first navigation");
    const ownedPage = page, context = page.browserContext(), target = page.target();
    const pageUrl = ownedPage.url.bind(ownedPage);
    t.mock.method(ownedPage, "url", (...args: Parameters<typeof pageUrl>) => {
      const value = pageUrl(...args);
      if (frameActive && !facts.framePrecheckObserved) {
        facts.framePrecheckObserved = true; facts.order.push("frame_precheck_observed"); frameEntered.release();
      }
      return value;
    });
    const waitForNavigation = ownedPage.waitForNavigation.bind(ownedPage);
    assert.equal(service.state.documents, 1);
    assert.equal(service.state.browserTransports.length, 2);
    assert.ok(service.state.browserTransports.every(({ guardedBeforeSpawn, loopbackDocument, otherDnsDenied, directConnections }) =>
      guardedBeforeSpawn && loopbackDocument && otherDnsDenied && directConnections));
    assert.equal(isSupportedOciBrowserUrl("https://unreviewed.invalid/"), false);
    const click = ownedPage.mouse.click.bind(ownedPage.mouse);
    t.mock.method(ownedPage.mouse, "click", (...args: Parameters<typeof click>) => { facts.inputEffects++; return click(...args); });
    page.on("framenavigated", (frame) => {
      if (frame === ownedPage.mainFrame() && callbackKind(frame.url()) === "root") { facts.callbackState = "committed"; facts.order.push("callback_committed"); }
      else if (frame === ownedPage.mainFrame() && frame.url().endsWith("#fixture-same-document-default")) {
        facts.defaultSameDocumentObserved = true;
      } else if (frame === ownedPage.mainFrame() && frame.url().endsWith("#fixture-same-document-ignored")) {
        facts.ignoredSameDocumentObserved = true; ignoredSameDocument.release();
      }
    });
    // Check the pinned internal option on a steady document. Runtime evaluation
    // cannot reliably execute once the cross-document callback is held.
    const defaultProbeController = new AbortController();
    const defaultProbe = waitForNavigation({ waitUntil: "domcontentloaded", timeout: 1000, signal: defaultProbeController.signal });
    navigationProbes.push({ controller: defaultProbeController, promise: defaultProbe });
    void defaultProbe.catch(() => undefined);
    await ownedPage.evaluate(() => { history.replaceState(null, "", location.pathname + location.search + "#fixture-same-document-default"); });
    await defaultProbe;
    facts.defaultSameDocumentWaitFulfilled = true;
    assert.equal(facts.defaultSameDocumentObserved, true);
    const ignoredProbeController = new AbortController();
    const ignoredOptions: NonNullable<Parameters<typeof waitForNavigation>[0]> & { ignoreSameDocumentNavigation: true } = {
      waitUntil: "domcontentloaded", timeout: 1000, signal: ignoredProbeController.signal, ignoreSameDocumentNavigation: true,
    };
    const ignoredProbe = waitForNavigation(ignoredOptions);
    navigationProbes.push({ controller: ignoredProbeController, promise: ignoredProbe });
    let ignoredSettled = 0;
    void ignoredProbe.then(() => { ignoredSettled++; }, () => { ignoredSettled++; });
    await ownedPage.evaluate(() => { history.replaceState(null, "", location.pathname + location.search + "#fixture-same-document-ignored"); });
    await Promise.race([ignoredSameDocument.promise, ignoredProbe.then(() => {}, () => {})]);
    assert.equal(facts.ignoredSameDocumentObserved, true);
    await ownedPage.evaluate(() => undefined);
    facts.ignoredWaitSettledAfterSameDocument = ignoredSettled;
    assert.equal(ignoredSettled, 0, "the internal option must ignore an observed same-document event");
    ignoredProbeController.abort();
    facts.ignoredWaitCancelled = await ignoredProbe.then(() => false, () => true);
    assert.equal(facts.ignoredWaitCancelled, true);
    t.mock.method(ownedPage, "waitForNavigation", (...args: Parameters<typeof waitForNavigation>) => {
      facts.navigationWaitsStarted++;
      const options = args[0] as { ignoreSameDocumentNavigation?: unknown } | undefined;
      facts.ignoresSameDocumentOption &&= options?.ignoreSameDocumentNavigation === true;
      const promise = waitForNavigation(...args);
      void promise.then(() => { facts.navigationWaitsFulfilled++; }, () => { facts.navigationWaitsRejected++; });
      return promise;
    });
    page.on("response", (response) => {
      if (response.request().frame() !== ownedPage.mainFrame()) return;
      const kind = callbackKind(response.url());
      if (kind === "root") {
        facts.rootResponses.push(response.status());
        if (response.status() === 200) { facts.order.push("callback_root_response_observed"); resumeCapture?.(); }
      }
      if (kind === "token") facts.tokenResponses.push(response.status());
    });
    const originalContinue = HTTPRequest.prototype.continue;
    t.mock.method(HTTPRequest.prototype, "continue", function (this: HTTPRequest, ...args: Parameters<HTTPRequest["continue"]>) {
      if (!isSupportedOciBrowserUrl(this.url())) facts.unsupportedContinuations++;
      const kind = this.frame() === ownedPage.mainFrame() && this.method() === "GET" ? callbackKind(this.url()) : null;
      if (kind === "token") facts.tokenContinuations++;
      if (kind === "root" && this.isNavigationRequest()) {
        facts.rootRequests++; facts.mainGetCallbackSeen = true; facts.callbackState = "held";
        if (facts.rootRequests === 1 && !gateOpen) {
          facts.order.push("callback_held"); held.release();
          return new Promise<void>((resolve, reject) => {
            resumeCallback = () => {
              facts.rootContinuations++; facts.callbackState = "continued"; facts.order.push("callback_continued");
              resumingCallback = true;
              const promise = Reflect.apply(originalContinue, this, args) as Promise<void>;
              void promise.then(() => { resumingCallback = false; resolve(); }, error => { resumingCallback = false; reject(error); });
            };
          });
        }
        facts.rootContinuations++;
      }
      return Reflect.apply(originalContinue, this, args) as Promise<void>;
    });
    probe = await page.createCDPSession();
    const prototype = Object.getPrototypeOf(probe) as CDPSession, originalSend = prototype.send;
    t.mock.method(prototype, "send", (function (this: CDPSession, ...args: Parameters<CDPSession["send"]>) {
      const dispatch = () => {
        const promise = Reflect.apply(originalSend, this, args) as ReturnType<CDPSession["send"]>;
        if (args[0] === "Fetch.continueRequest" && resumingCallback) {
          facts.callbackFetchDispatches++; facts.order.push("callback_fetch_dispatched");
        }
        if (args[0] === "Page.captureScreenshot" && frameActive) {
          clearTimeout(watchdog);
          if (facts.captures === 0) {
            const raw = ownedPage.url(), callback = callbackKind(raw);
            facts.captureDispatchKind = callback ? "fixed_callback_" + callback : raw === "about:blank" ? "blank" : isSupportedOciBrowserUrl(raw) ? "provider" : "other";
            facts.callbackStateAtDispatch = facts.callbackState;
          }
          const attempt = ++facts.captures, parameters = JSON.stringify(args.slice(1));
          firstCaptureParameters ??= parameters; facts.captureParametersMatch &&= parameters === firstCaptureParameters;
          facts.order.push(attempt === 1 ? "capture_dispatched" : "capture_retry_dispatched");
          if (attempt === 1) captureDispatched.release();
          void promise.then(() => { facts.order.push(attempt === 1 ? "capture_completed" : "capture_retry_completed"); }, (error: unknown) => {
            const candidate = error as { name?: unknown; message?: unknown; originalMessage?: unknown; code?: unknown };
            const message = typeof candidate.message === "string" ? candidate.message : "";
            const originalMessage = typeof candidate.originalMessage === "string" ? candidate.originalMessage : "";
            const effective = originalMessage || message.replace(/^Protocol error \(Page\.captureScreenshot\): /, "");
            const name = ["ProtocolError", "TargetCloseError", "TimeoutError", "Error"].includes(String(candidate.name)) ? String(candidate.name) : "Other";
            const whitelist = effective === "Not attached to an active page" ? "inactive_page"
              : effective === "Not attached to a page" ? "detached"
                : effective === "Internal error" ? "internal"
                  : effective === "Unable to encode screenshot" ? "encode"
                    : effective === "Unable to capture screenshot" ? "exact_unable"
                      : /^Page\.captureScreenshot timed out\./.test(effective) ? "capture_protocol_timeout" : "other";
            let mainKind = "other";
            const mainUrl = ownedPage.url(), kind = callbackKind(mainUrl);
            if (kind) mainKind = kind === "root" ? "fixed_callback_root" : "fixed_callback_token";
            else if (mainUrl === "about:blank") mainKind = "blank";
            else { try { if (isSupportedOciBrowserUrl(mainUrl) && new URL(mainUrl).protocol === "https:") mainKind = "provider"; } catch {} }
            facts.captureFailed = true; facts.captureFailures++;
            facts.captureError = { name, realProtocolError: error instanceof ProtocolError, whitelist, originalEmpty: originalMessage === "",
              codeKind: candidate.code === -32603 ? "internal" : candidate.code === -32000 ? "server" : candidate.code === -32602 ? "invalid_params" : "other_or_absent",
              exactUnableToCaptureScreenshot: effective === "Unable to capture screenshot", captureScreenshotTimedOut: /^Page\.captureScreenshot timed out\./.test(effective),
              contextDestroyed: /execution context was destroyed|cannot find context with specified id/i.test(effective),
              targetClosed: /target closed/i.test(effective), sessionClosed: /session closed|connection closed/i.test(effective),
              mainKind, mainGetCallbackSeen: facts.mainGetCallbackSeen, callbackState: facts.callbackState,
              pageClosed: ownedPage.isClosed(), browserConnected: ownedPage.browser().connected,
              targetMatchesInitial: ownedPage.target() === target, contextMatchesInitial: ownedPage.browserContext() === context,
              isSupportedMainFrame: isSupportedOciBrowserUrl(mainUrl), allFramesSupported: ownedPage.frames().every(frame => isSupportedOciBrowserUrl(frame.url())) };
            facts.order.push(attempt === 1 ? "capture_failed" : "capture_retry_failed");
          });
        }
        return promise;
      };
      if (args[0] === "Page.captureScreenshot" && frameActive && !captureRequested) {
        captureRequested = true;
        facts.order.push("capture_requested");
        if (tearingDown || facts.gateTimedOut) return Promise.reject(new Error("Callback-response test gate expired."));
        if (facts.rootResponses.includes(200)) return dispatch();
        // Older drivers reach capture before commit. Dispatch that unchanged
        // command in the actual root-response callback to expose the race.
        const paused = new Promise<Awaited<ReturnType<CDPSession["send"]>>>((resolve, reject) => {
          let consumed = false;
          resumeCapture = () => { if (consumed) return; consumed = true; const original = dispatch(); void original.then(resolve, reject); };
          rejectCapture = () => { if (!consumed) { consumed = true; reject(new Error("Diagnostic callback-response gate expired.")); } };
        });
        return paused;
      }
      return dispatch();
    }) as CDPSession["send"]);
    const displayedResponse = await s.send("frame");
    assert.equal(displayedResponse.status, 200);
    const displayed = fixtureFrameSchema.parse(await displayedResponse.json());
    watchdog = setTimeout(() => { facts.gateTimedOut = true; release(); rejectCapture?.(); gateExpired.release(); }, 1500);
    assert.equal((await s.send("input", { event: { type: "click", x: 100, y: 130 }, frameRef: displayed.frameRef })).status, 200);
    facts.order.push("input_acknowledged");
    await Promise.race([held.promise, gate.promise]);
    assert.equal(facts.gateTimedOut, false, "the callback request must reach its bounded gate");
    assert.equal(facts.rootContinuations, 0);
    facts.order.push("frame_requested");
    frameActive = true;
    const pendingFrame = s.send("frame");
    void pendingFrame.catch(() => undefined);
    await Promise.race([frameEntered.promise, gateExpired.promise]);
    assert.equal(facts.gateTimedOut, false, "the original driver frame precheck must be reached");
    assert.equal(facts.framePrecheckObserved, true);
    assert.equal(facts.navigationWaitsStarted, 1, "the callback wait must be pre-armed while its original request is held");
    release();
    // The watchdog releases a failed setup; the production HTTP deadline stays unchanged.
    await Promise.race([captureDispatched.promise, gateExpired.promise]);
    assert.equal(facts.gateTimedOut, false, "capture must dispatch before the bounded gate expires");
    assert.equal(facts.captures, 1);
    const response = await pendingFrame;
    facts.frameStatus = response.status;
    frameActive = false;
    assert.equal(response.status, 200, "the actual private frame must survive callback navigation");
    const image = await response.json() as { png: string; width: number; height: number };
    assert.equal(image.width, 800); assert.equal(image.height, 600); assert.ok(image.png.length > 0);
    facts.order.push("frame_accepted");
    await eventually(async () => service.state.events.some(({ stage, value }) => stage === "authentication" && value.outcome === "bootstrap_complete"));
    facts.order.push("bootstrap_complete");
    facts.sameContext = page.browserContext() === context; facts.sameTarget = page.target() === target;
    assert.equal(facts.sameContext, true); assert.equal(facts.sameTarget, true);
    assert.equal(facts.captureDispatchKind, "fixed_callback_root");
    assert.equal(facts.callbackStateAtDispatch, "committed");
    assert.equal(facts.ignoresSameDocumentOption, true);
    assert.equal(facts.navigationWaitsFulfilled, 1); assert.equal(facts.navigationWaitsRejected, 0);
    assert.equal(facts.rootRequests, 1); assert.equal(facts.rootContinuations, 1); assert.equal(facts.tokenContinuations, 1);
    assert.equal(facts.unsupportedContinuations, 0); assert.equal(facts.inputEffects, 1);
    assert.ok(facts.captures >= 1 && facts.captures <= 2); assert.equal(facts.captureParametersMatch, true);
    if (facts.captureFailed) {
      assert.equal(facts.captures, 2); assert.equal(facts.captureFailures, 1);
      assert.equal(facts.captureError?.realProtocolError, true);
      assert.equal(facts.captureError?.exactUnableToCaptureScreenshot, true);
      for (const key of ["browserConnected", "targetMatchesInitial", "contextMatchesInitial", "isSupportedMainFrame", "allFramesSupported"]) assert.equal(facts.captureError?.[key], true);
      assert.equal(facts.captureError?.pageClosed, false);
      assert.ok(facts.order.indexOf("capture_failed") < facts.order.indexOf("capture_retry_dispatched"));
    } else { assert.equal(facts.captures, 1); assert.equal(facts.captureFailures, 0); }
    assert.deepEqual(facts.rootResponses, [200]); assert.deepEqual(facts.tokenResponses, [200]);
    const successfulCapture = facts.captureFailed ? "capture_retry_completed" : "capture_completed";
    for (const [before, after] of [["callback_held", "frame_precheck_observed"], ["frame_precheck_observed", "callback_released"],
      ["callback_released", "callback_continued"], ["callback_continued", "callback_fetch_dispatched"],
      ["callback_fetch_dispatched", "callback_root_response_observed"], ["callback_root_response_observed", "callback_committed"], ["callback_committed", "capture_dispatched"],
      ["capture_dispatched", successfulCapture], [successfulCapture, "frame_accepted"]]) {
      assert.ok(facts.order.indexOf(before!) >= 0 && facts.order.indexOf(before!) < facts.order.indexOf(after!), "capture and callback ordering must be observed");
    }
    assert.equal((await s.send("handback")).status, 202);
    let handback: Response | undefined;
    await eventually(async () => { handback = await s.send("handback"); return handback.status !== 202; });
    assert.equal(handback?.status, 200); assert.deepEqual(await handback!.json(), { verified: true });
    assert.deepEqual(service.state.stages, ["authentication", "diagnostic", "verifier"]);
    s.harness.behavior.submitInteraction(s.interaction.id, { attemptId: s.attemptId });
    const result = nativeValue(await s.native);
    assert.equal(result.phase, "verified"); assert.equal(result.mode, "oci_cli"); assert.equal(result.resume, "uncertain");
    assert.equal(typeof result.accountRef, "string");
    const task = nativeValue(await s.harness.behavior.callAgentTool("remote_login_oci_read", { attemptId: s.attemptId,
      accountRef: result.accountRef, request: { operation: "list_compartments" } }, nativeContext));
    assert.equal(task.operation, "list_compartments");
    assert.deepEqual((task.rows as Array<{ name: string }>).map(({ name }) => name), ["Composed fixture compartment"]);
    assert.deepEqual(service.state.stages, ["authentication", "diagnostic", "verifier", "task"]);
    assert.equal(page.isClosed(), true);
    assert.equal((await readdir(s.dataDir)).some((name) => name.startsWith("oci-browser-")), false);
    await eventually(async () => service.state.browserTransports.every(({ closed }) => closed));
    await s.assertPrivate([service.token, service.state.authorizationUrl, service.root, image.png], [result, task]);
    assert.deepEqual(refusals, []);
  } finally {
    tearingDown = true;
    clearTimeout(watchdog); release(); rejectCapture?.();
    for (const navigation of navigationProbes) navigation.controller.abort();
    await Promise.allSettled(navigationProbes.map(navigation => navigation.promise));
    await probe?.detach().catch(() => undefined);
    const commit = facts.order.indexOf("callback_committed"), settlement = facts.order.findIndex(value => ["capture_completed", "capture_failed"].includes(value));
    facts.callbackCommitBeforeCaptureSettlement = commit >= 0 && settlement > commit;
    t.diagnostic(JSON.stringify({ classification: "local_synthetic_owned_callback_document_before_first_capture", facts, hostRefusals: refusals,
      serviceStages: service.state.stages, noAccountOrOracleNetwork: true }));
  }
});
