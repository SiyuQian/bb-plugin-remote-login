import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import puppeteer, { ProtocolError } from "puppeteer-core";
import { StaleFrameError } from "../frame-error.ts";
import { isSupportedOciBrowserUrl, openOciProviderBrowser, OciProviderBrowserError } from "../oci-provider-browser.ts";
import { createOwnedOciSession, releaseOwnedOciSession } from "../oci-owned-session.ts";
import { OwnedResourceLedger } from "../owned-resource-ledger.ts";

const expected = { mode: "oci_cli" as const, tenancyOcid: "ocid1.tenancy.oc1..fixture", userOcid: "ocid1.user.oc1..fixture", region: "ap-sydney-1", realm: "oc1" as const };
const supported = process.platform === "darwin" && process.arch === "arm64";
// Only the driver's bounded PNG header checks are exercised by this unit fixture.
function pngHeader(): Uint8Array {
  const bytes = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(800, 16); bytes.writeUInt32BE(600, 20); return bytes;
}
function callbackCaptureError(message = "Unable to capture screenshot"): ProtocolError {
  const error = new ProtocolError("Synthetic callback capture failure"); error.originalMessage = message; return error;
}
async function journal(root: string) {
  const directory = join(root, "owned-resources-v1"), file = (await readdir(directory)).find((name) => name.endsWith(".json"));
  return JSON.parse(await (await import("node:fs/promises")).readFile(join(directory, file!), "utf8"));
}

function authorizationUrl(): string {
  const url = new URL("https://login.ap-sydney-1.oraclecloud.com/v1/oauth2/authorize");
  url.search = new URLSearchParams({ action: "login", client_id: "iaas_console", response_type: "token id_token", scope: "openid",
    redirect_uri: "http://localhost:8181", nonce: randomUUID(),
    public_key: Buffer.from(JSON.stringify({ kty: "RSA", n: Buffer.alloc(256, 0x80).toString("base64url"), e: "AQAB", kid: "Ignored" })).toString("base64url") }).toString();
  return url.href;
}

test("provider request policy permits only reviewed Oracle destinations and exact IPv4 callback", () => {
  for (const value of ["https://login.ap-sydney-1.oraclecloud.com/v1/oauth2/authorize", "https://cloud.oracle.com/", "https://signin.oracle.com/", "https://tenant.identity.oraclecloud.com/ui/v1/signin", "http://localhost:8181/", "http://127.0.0.1:8181/token"]) {
    assert.equal(isSupportedOciBrowserUrl(value), true, value);
  }
  for (const value of ["http://cloud.oracle.com/", "https://cloud.oracle.com.evil.invalid/", "https://oraclecloud.com/", "https://evil.identity.oraclecloud.com.evil.invalid/", "https://a.b.identity.oraclecloud.com/", "https://cloud.oracle.com:444/", "https://user@cloud.oracle.com/", "https://accounts.google.com/", "http://localhost:8182/", "http://[::1]:8181/", "http://127.0.0.2:8181/", "file:///private/account", "data:text/html,private"]) {
    assert.equal(isSupportedOciBrowserUrl(value), false, value);
  }
});

test("arbitrary browser URLs are refused before launch or storage access", async (t) => {
  let launched = false;
  t.mock.method(puppeteer, "launch", async () => { launched = true; throw new Error("must not launch"); });
  for (const url of ["https://cloud.oracle.com/", "https://login.ap-sydney-1.oraclecloud.com/v1/oauth2/authorize", "http://localhost:8181/"]) {
    await assert.rejects(openOciProviderBrowser("/not-an-owned-directory", url, new AbortController().signal), (error) => error instanceof OciProviderBrowserError && !error.cleanupUncertain);
  }
  assert.equal(launched, false);
});

test("a valid captured URL never enters process arguments and uncertain launch retains its exact profile", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "oci-browser-boundary-")); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = authorizationUrl();
  let launchedOptions: Parameters<typeof puppeteer.launch>[0];
  t.mock.method(puppeteer, "launch", async (options: Parameters<typeof puppeteer.launch>[0]) => {
    launchedOptions = options;
    throw new Error("synthetic launcher failure");
  });
  await assert.rejects(openOciProviderBrowser(root, url, new AbortController().signal), (error) => error instanceof OciProviderBrowserError && error.cleanupUncertain);
  assert.ok(launchedOptions);
  assert.equal(launchedOptions.pipe, true); assert.equal(launchedOptions.headless, true);
  assert.ok(launchedOptions.args?.includes("--host-resolver-rules=MAP localhost 127.0.0.1"));
  assert.ok(launchedOptions.args?.includes("--no-proxy-server"));
  assert.equal(JSON.stringify(launchedOptions.args).includes(url), false);
  assert.equal(JSON.stringify(launchedOptions.args).includes("public_key"), false);
  const profiles = await readdir(root); assert.equal(profiles.length, 1);
  assert.equal((await lstat(join(root, profiles[0]!))).mode & 0o777, 0o700);
});

async function ownedBrowserFixture(t: TestContext, closing: Promise<void> = Promise.resolve()) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "oci-browser-close-")); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = await createOwnedOciSession(root, randomUUID(), expected);
  const url = authorizationUrl(), target = {}, mainFrame = { url: () => url }, controller = new AbortController();
  const page = new EventEmitter();
  const child = Object.assign(new EventEmitter(), { pid: process.pid, exitCode: null as number | null, signalCode: null as string | null, spawnargs: [] as string[] });
  const context = { newPage: async () => page };
  let browserClosures = 0;
  const browser = Object.assign(new EventEmitter(), {
    connected: true, process: () => child, version: async () => "Chrome/157.0.8103.50",
    createBrowserContext: async () => context, pages: async () => [page],
    close: async () => { browserClosures++; await closing; child.exitCode = 0; child.emit("exit", 0); child.emit("close", 0); },
  });
  const sourcePage = Object.assign(page, { isClosed: () => false, browser: () => browser, browserContext: () => context,
    target: () => target, url: () => url, frames: () => [mainFrame], mainFrame: () => mainFrame,
    setDefaultTimeout: () => {}, setViewport: async () => {}, viewport: () => ({ width: 800, height: 600, deviceScaleFactor: 1 }), setCacheEnabled: async () => {},
    setRequestInterception: async () => {}, setBypassServiceWorker: async () => {}, goto: async () => {},
    keyboard: { sendCharacter: async () => {} },
    screenshot: async (): Promise<Uint8Array> => pngHeader(),
    waitForFunction: async () => ({ dispose: async () => {} }),
    waitForNavigation: async (): Promise<null> => null,
  });
  t.mock.method(puppeteer, "launch", async (options: Parameters<typeof puppeteer.launch>[0]) => {
    child.spawnargs = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--remote-debugging-pipe", `--user-data-dir=${options?.userDataDir}`, ...options?.args ?? []];
    return browser as never;
  });
  const driver = await openOciProviderBrowser(root, url, controller.signal, session);
  return { root, session, page: sourcePage, controller, driver, browserClosures: () => browserClosures };
}

test("provider input from a displayed frame refuses a known allowed document change before dispatch", { skip: !supported }, async t => {
  const f = await ownedBrowserFixture(t), mainFrame = f.page.mainFrame();
  const owner = { browser: f.page.browser(), context: f.page.browserContext(), target: f.page.target() };
  const sendCharacter = f.page.keyboard.sendCharacter;
  let effects = 0, claims = 0;
  t.mock.method(f.page.keyboard, "sendCharacter", (...args: unknown[]) => {
    effects++;
    return Reflect.apply(sendCharacter, f.page.keyboard, args);
  });
  try {
    const frameA = await f.driver.frame();
    assert.equal(frameA.width, 800); assert.equal(effects, 0);
    // Keep the same owned target and frame. This is an allowed document change,
    // not the forbidden-navigation policy or the fixed callback navigation gate.
    const nextDocument = "https://cloud.oracle.com/";
    t.mock.method(f.page, "url", () => nextDocument);
    t.mock.method(mainFrame, "url", () => nextDocument);
    f.page.emit("framenavigated", mainFrame);
    const sameOwner = f.page.browser() === owner.browser && f.page.browserContext() === owner.context
      && f.page.target() === owner.target && f.page.mainFrame() === mainFrame;
    assert.equal(sameOwner, true); assert.equal(f.browserClosures(), 0);
    const refused = await f.driver.input({ type: "text", text: "fabricated input from old document" }, frameA.frameRef, () => { claims++; }).then(
      () => false,
      (error: unknown) => { assert.ok(error instanceof StaleFrameError); return true; },
    );
    t.diagnostic(JSON.stringify({ classification: "source_driver_stale_allowed_document_unit", capturedFrameA: true,
      knownAllowedDocumentChange: true, sameOwner, inputRefused: refused, keyboardEffects: effects, actualChrome: false }));
    assert.equal(effects, 0, "An input based on the prior document must refuse before its keyboard effect.");
    assert.equal(refused, true); assert.equal(claims, 1);

    // A refresh must permit a current observation; closing every allowed
    // navigation must not satisfy the eventual regression.
    const frameB = await f.driver.frame();
    assert.equal(frameB.width, 800);
    await f.driver.input({ type: "text", text: "fabricated input from refreshed document" }, frameB.frameRef, () => { claims++; });
    assert.equal(effects, 1); assert.equal(claims, 2); assert.equal(f.browserClosures(), 0);
  } finally { await f.driver.close(); await releaseOwnedOciSession(f.session); }
});

test("provider frame references reject newer, consumed and forged observations before input", { skip: !supported }, async t => {
  for (const condition of ["newer", "consumed", "forged"] as const) await t.test(condition, async t => {
    const f = await ownedBrowserFixture(t), send = f.page.keyboard.sendCharacter;
    let effects = 0, claims = 0;
    t.mock.method(f.page.keyboard, "sendCharacter", (...args: unknown[]) => { effects++; return Reflect.apply(send, f.page.keyboard, args); });
    try {
      const frameA = await f.driver.frame();
      if (condition === "newer") await f.driver.frame();
      if (condition === "consumed") await f.driver.input({ type: "text", text: "first fixture effect" }, frameA.frameRef, () => { claims++; });
      const previousEffects = effects, previousClaims = claims;
      const refused = await f.driver.input({ type: "text", text: "stale fixture effect" }, condition === "forged" ? randomUUID() : frameA.frameRef,
        () => { claims++; }).then(() => false, (error: unknown) => { assert.ok(error instanceof StaleFrameError); return true; });
      assert.equal(effects, previousEffects, "An obsolete observation cannot reach the input delegate.");
      assert.equal(refused, true); assert.equal(claims, previousClaims + 1); assert.equal(f.browserClosures(), 0);
      const current = await f.driver.frame();
      await f.driver.input({ type: "text", text: "current fixture effect" }, current.frameRef, () => { claims++; });
      assert.equal(effects, previousEffects + 1);
    } finally { await f.driver.close(); await releaseOwnedOciSession(f.session); }
  });
});

test("provider capture invalidated by known document changes never publishes its frame", { skip: !supported }, async t => {
  for (const timing of ["capture", "postcheck"] as const) await t.test(timing, async t => {
    const f = await ownedBrowserFixture(t), mainFrame = f.page.mainFrame();
    let captured = false, changed = false;
    const change = () => { changed = true; f.page.emit("framenavigated", mainFrame); };
    t.mock.method(f.page, "screenshot", async () => { captured = true; if (timing === "capture" && !changed) change(); return pngHeader(); });
    t.mock.method(f.page, "frames", () => { if (timing === "postcheck" && captured && !changed) change(); return [mainFrame]; });
    try {
      await assert.rejects(f.driver.frame(), StaleFrameError);
      assert.equal(changed, true); assert.equal(f.browserClosures(), 0);
      assert.equal(typeof (await f.driver.frame()).frameRef, "string");
    } finally { await f.driver.close(); await releaseOwnedOciSession(f.session); }
  });
});

test("provider configured viewport changes refuse frame and input before effects", { skip: !supported }, async t => {
  for (const operation of ["frame", "input"] as const) await t.test(operation, async t => {
    const f = await ownedBrowserFixture(t), frameA = await f.driver.frame(), send = f.page.keyboard.sendCharacter;
    let effects = 0, claims = 0;
    t.mock.method(f.page.keyboard, "sendCharacter", (...args: unknown[]) => { effects++; return Reflect.apply(send, f.page.keyboard, args); });
    t.mock.method(f.page, "viewport", () => ({ width: 801, height: 600, deviceScaleFactor: 1 }));
    try {
      await assert.rejects(operation === "frame" ? f.driver.frame()
        : f.driver.input({ type: "text", text: "wrong viewport fixture" }, frameA.frameRef, () => { claims++; }), OciProviderBrowserError);
      assert.equal(effects, 0); assert.equal(claims, 0); assert.equal(f.browserClosures(), 1);
    } finally { await f.driver.close(); await releaseOwnedOciSession(f.session); }
  });
});

test("provider private input claim failures precede stale classification and close the browser", { skip: !supported }, async t => {
  for (const error of [new Error("Private duplicate fixture"), new StaleFrameError()]) await t.test(error.name, async t => {
    const f = await ownedBrowserFixture(t), send = f.page.keyboard.sendCharacter;
    let effects = 0, claims = 0;
    t.mock.method(f.page.keyboard, "sendCharacter", (...args: unknown[]) => { effects++; return Reflect.apply(send, f.page.keyboard, args); });
    try {
      await f.driver.frame();
      await assert.rejects(f.driver.input({ type: "text", text: "duplicate fixture" }, randomUUID(), () => { claims++; throw error; }), OciProviderBrowserError);
      assert.equal(claims, 1); assert.equal(effects, 0); assert.equal(f.browserClosures(), 1);
    } finally { await f.driver.close(); await releaseOwnedOciSession(f.session); }
  });
});

test("provider stale input completes post-target checks before reporting a safe refusal", { skip: !supported }, async t => {
  const f = await ownedBrowserFixture(t), frameA = await f.driver.frame(), mainFrame = f.page.mainFrame();
  let checks = 0, claims = 0;
  f.page.emit("framenavigated", mainFrame);
  t.mock.method(f.page, "frames", () => ++checks === 1 ? [mainFrame] : [{ url: () => "https://unreviewed.invalid/" }]);
  try {
    await assert.rejects(f.driver.input({ type: "text", text: "postcheck fixture" }, frameA.frameRef, () => { claims++; }), OciProviderBrowserError);
    assert.equal(claims, 1); assert.equal(f.browserClosures(), 1);
  } finally { await f.driver.close(); await releaseOwnedOciSession(f.session); }
});

function navigationGate() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<null>((done, fail) => { resolve = () => done(null); reject = fail; });
  return { promise, resolve, reject };
}
function callbackRequest(f: Awaited<ReturnType<typeof ownedBrowserFixture>>, change: {
  url?: string; navigation?: boolean; main?: boolean; method?: string; continued?: () => void; aborted?: () => void;
} = {}) {
  return { url: () => change.url ?? "http://localhost:8181/", isNavigationRequest: () => change.navigation ?? true,
    frame: () => change.main === false ? {} : f.page.mainFrame(), method: () => change.method ?? "GET",
    continue: async () => { change.continued?.(); }, abort: async () => { change.aborted?.(); } };
}

test("callback document barrier registers before continuation and holds the first capture", { skip: !supported }, async t => {
  for (const callback of ["http://localhost:8181/", "http://127.0.0.1:8181/token"]) {
    await t.test(new URL(callback).pathname, async t => {
      const f = await ownedBrowserFixture(t), navigation = navigationGate(), order: string[] = [];
      let captures = 0, watchers = 0, watchSignal: AbortSignal | undefined;
      t.mock.method(f.page, "waitForNavigation", (...args: unknown[]) => {
        watchers++; order.push("watcher");
        const { signal, ...options } = args[0] as { signal: AbortSignal };
        assert.deepEqual(options, { waitUntil: "domcontentloaded", ignoreSameDocumentNavigation: true, timeout: 1000 });
        assert.ok(signal instanceof AbortSignal); assert.equal(signal.aborted, false); watchSignal = signal;
        return navigation.promise;
      });
      t.mock.method(f.page, "screenshot", async () => { captures++; return pngHeader(); });
      let pending: ReturnType<typeof f.driver.frame> | undefined;
      try {
        f.page.emit("request", callbackRequest(f, { url: callback, continued: () => order.push("continue") }));
        assert.deepEqual(order, ["watcher", "continue"]);
        pending = f.driver.frame(); void pending.catch(() => {});
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(captures, 0); assert.equal(watchers, 1); assert.equal(f.browserClosures(), 0);
        t.mock.method(f.page, "url", () => callback); navigation.resolve();
        assert.equal((await pending).width, 800); assert.equal(captures, 1);
        assert.equal(watchSignal?.aborted, true, "consuming the completed marker must release its watcher");
        await f.driver.frame(); assert.equal(captures, 2); assert.equal(watchers, 1, "a completed barrier must not install another wait");
      } finally { navigation.resolve(); await pending?.catch(() => {}); await f.driver.close(); await releaseOwnedOciSession(f.session); }
    });
  }
});

test("callback document barrier refuses failure, cancellation, changed ownership and supersession before capture", { skip: !supported, timeout: 20000 }, async t => {
  for (const condition of ["rejected", "aborted", "closed", "target changed", "wrong final URL", "superseded", "other document"] as const) {
    await t.test(condition, async t => {
      const f = await ownedBrowserFixture(t), first = navigationGate(), second = navigationGate();
      let captures = 0, watchers = 0; const signals: AbortSignal[] = [];
      t.mock.method(f.page, "waitForNavigation", (...args: unknown[]) => {
        const options = args[0] as { signal: AbortSignal };
        signals.push(options.signal);
        const navigation = ++watchers === 1 ? first : second;
        options.signal.addEventListener("abort", () => navigation.reject(new Error("Synthetic navigation cancellation")), { once: true });
        return navigation.promise;
      });
      t.mock.method(f.page, "screenshot", async () => { captures++; return pngHeader(); });
      let pending: ReturnType<typeof f.driver.frame> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      try {
        f.page.emit("request", callbackRequest(f)); assert.equal(watchers, 1);
        if (condition === "rejected") {
          t.mock.method(f.page, "url", () => "http://localhost:8181/");
          first.reject(new Error("Synthetic navigation refusal"));
          // The handler must observe rejection even before a frame consumes it.
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        pending = f.driver.frame(); void pending.catch(() => {});
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(captures, 0);
        if (condition === "aborted") f.controller.abort();
        if (condition === "closed") await f.driver.close();
        if (condition === "target changed") t.mock.method(f.page, "target", () => ({}));
        // Fulfill the old watch before replacing it, in the same turn. Its
        // queued continuation must still reject the now-superseded marker.
        if (condition === "superseded" || condition === "other document") first.resolve();
        if (condition === "superseded") f.page.emit("request", callbackRequest(f, { url: "http://localhost:8181/token" }));
        if (condition === "other document") f.page.emit("request", callbackRequest(f, { url: "https://cloud.oracle.com/" }));
        if (["aborted", "closed", "superseded", "other document"].includes(condition)) assert.equal(signals[0]?.aborted, true, "old navigation wait must be cancelled before proceeding");
        if (condition !== "wrong final URL") t.mock.method(f.page, "url", () => "http://localhost:8181/");
        first.resolve();
        const result = await Promise.race([pending.then(() => "captured", error => error instanceof OciProviderBrowserError ? "refused" : "other"),
          new Promise<string>(resolve => { timer = setTimeout(() => resolve("waiting for replacement"), 3000); })]);
        assert.equal(result, "refused", "superseded barriers must refuse rather than resetting the wait");
        assert.equal(captures, 0); assert.equal(f.browserClosures(), 1);
        assert.equal(watchers, condition === "superseded" ? 2 : 1);
      } finally { clearTimeout(timer); first.resolve(); second.resolve(); await pending?.catch(() => {}); await f.driver.close(); await releaseOwnedOciSession(f.session); }
    });
  }
});

test("callback document barrier excludes token XHR, other frames, methods and other URLs", { skip: !supported }, async t => {
  for (const condition of ["token XHR", "other frame", "POST", "provider", "wrong callback port"] as const) {
    await t.test(condition, async t => {
      const f = await ownedBrowserFixture(t); let watchers = 0, continued = 0, aborted = 0;
      t.mock.method(f.page, "waitForNavigation", async () => { watchers++; return null; });
      const change = condition === "token XHR" ? { url: "http://localhost:8181/token", navigation: false }
        : condition === "other frame" ? { main: false }
          : condition === "POST" ? { method: "POST" }
            : condition === "provider" ? { url: "https://cloud.oracle.com/" } : { url: "http://localhost:8182/" };
      try {
        f.page.emit("request", callbackRequest(f, { ...change, continued: () => { continued++; }, aborted: () => { aborted++; } }));
        assert.equal(watchers, 0); assert.equal(continued, condition === "wrong callback port" ? 0 : 1);
        assert.equal(aborted, condition === "wrong callback port" ? 1 : 0);
        if (condition !== "wrong callback port") assert.equal((await f.driver.frame()).width, 800);
      } finally { await f.driver.close(); await releaseOwnedOciSession(f.session); }
    });
  }
});

test("known callback capture failure retries one fresh read without closing its owned browser", { skip: !supported }, async (t) => {
  for (const callback of ["http://localhost:8181/#synthetic-fragment", "http://127.0.0.1:8181/token?synthetic=value"]) {
    await t.test(new URL(callback).hostname, async (t) => {
      const f = await ownedBrowserFixture(t); let captures = 0;
      t.mock.method(f.page, "url", () => callback);
      t.mock.method(f.page, "screenshot", async () => { if (++captures === 1) throw callbackCaptureError(); return pngHeader(); });
      try {
        const { frameRef, ...frame } = await f.driver.frame();
        assert.deepEqual(frame, { png: Buffer.from(pngHeader()).toString("base64"), width: 800, height: 600 });
        assert.equal(typeof frameRef, "string");
        assert.equal(captures, 2); assert.equal(f.browserClosures(), 0);
      } finally { await f.driver.close(); await releaseOwnedOciSession(f.session); }
    });
  }
});

test("callback capture recovery cannot cross ownership or URL policy changes", { skip: !supported }, async (t) => {
  for (const condition of ["target changed", "page closed", "context changed", "unsupported frame", "provider origin", "wrong callback port"] as const) {
    await t.test(condition, async (t) => {
      const f = await ownedBrowserFixture(t); let captures = 0;
      if (condition !== "provider origin") t.mock.method(f.page, "url", () => "http://localhost:8181/");
      t.mock.method(f.page, "screenshot", async () => {
        captures++;
        if (condition === "target changed") t.mock.method(f.page, "target", () => ({}));
        if (condition === "page closed") t.mock.method(f.page, "isClosed", () => true);
        if (condition === "context changed") t.mock.method(f.page, "browserContext", () => ({ newPage: async () => f.page }));
        if (condition === "unsupported frame") t.mock.method(f.page, "frames", () => [{ url: () => "https://unreviewed.invalid/" }]);
        if (condition === "wrong callback port") t.mock.method(f.page, "url", () => "http://localhost:8182/");
        throw callbackCaptureError();
      });
      try {
        await assert.rejects(f.driver.frame(), OciProviderBrowserError);
        assert.equal(captures, 1); assert.equal(f.browserClosures(), 1);
      } finally { await f.driver.close(); await releaseOwnedOciSession(f.session); }
    });
  }
});

test("only the real exact callback capture error is recoverable and invalid PNG is never retried", { skip: !supported }, async (t) => {
  for (const condition of ["ordinary error", "spoofed protocol error", "other protocol error", "invalid PNG"] as const) {
    await t.test(condition, async (t) => {
      const f = await ownedBrowserFixture(t); let captures = 0;
      t.mock.method(f.page, "url", () => "http://localhost:8181/");
      t.mock.method(f.page, "screenshot", async () => {
        captures++;
        if (condition === "invalid PNG") return new Uint8Array(24);
        if (condition === "ordinary error") throw new Error("Unable to capture screenshot");
        if (condition === "spoofed protocol error") throw Object.assign(new Error("Synthetic error"), { name: "ProtocolError", originalMessage: "Unable to capture screenshot" });
        throw callbackCaptureError("Execution context was destroyed");
      });
      try {
        await assert.rejects(f.driver.frame(), OciProviderBrowserError);
        assert.equal(captures, 1); assert.equal(f.browserClosures(), 1);
      } finally { await f.driver.close(); await releaseOwnedOciSession(f.session); }
    });
  }
});

test("a repeated known callback capture error stops after two reads", { skip: !supported }, async (t) => {
  const f = await ownedBrowserFixture(t); let captures = 0;
  t.mock.method(f.page, "url", () => "http://localhost:8181/");
  t.mock.method(f.page, "screenshot", async () => { captures++; throw callbackCaptureError(); });
  try {
    await assert.rejects(f.driver.frame(), OciProviderBrowserError);
    assert.equal(captures, 2); assert.equal(f.browserClosures(), 1);
  } finally { await f.driver.close(); await releaseOwnedOciSession(f.session); }
});

test("callback capture retry waits for the bounded render probe and disposes its handle", { skip: !supported }, async (t) => {
  const f = await ownedBrowserFixture(t); let captures = 0, probes = 0, disposed = 0;
  let entered!: () => void, release!: () => void;
  const probing = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(f.page, "url", () => "http://localhost:8181/");
  t.mock.method(f.page, "screenshot", async () => { if (++captures === 1) throw callbackCaptureError(); return pngHeader(); });
  t.mock.method(f.page, "waitForFunction", async (...args: unknown[]) => {
    assert.deepEqual(args[1], { timeout: 1000 }, "the render probe must keep its own finite bound");
    probes++; entered(); await held; return { dispose: async () => { disposed++; } };
  });
  const pending = f.driver.frame(); void pending.catch(() => {});
  try {
    assert.equal(await Promise.race([probing.then(() => "probing"), pending.then(() => "captured")]), "probing");
    assert.equal(captures, 1); assert.equal(f.browserClosures(), 0);
    release(); assert.equal((await pending).width, 800);
    assert.equal(captures, 2); assert.equal(probes, 1); assert.equal(disposed, 1);
  } finally { release(); await pending.catch(() => {}); await f.driver.close(); await releaseOwnedOciSession(f.session); }
});

test("render probe failure or changed callback ownership refuses a second capture", { skip: !supported }, async (t) => {
  for (const condition of ["probe rejected", "target changed", "callback left"] as const) {
    await t.test(condition, async (t) => {
      const f = await ownedBrowserFixture(t); let captures = 0, probes = 0, disposed = 0;
      t.mock.method(f.page, "url", () => "http://localhost:8181/");
      t.mock.method(f.page, "screenshot", async () => { if (++captures === 1) throw callbackCaptureError(); return pngHeader(); });
      t.mock.method(f.page, "waitForFunction", async () => {
        probes++;
        if (condition === "probe rejected") throw new Error("Synthetic readiness refusal");
        if (condition === "target changed") t.mock.method(f.page, "target", () => ({}));
        if (condition === "callback left") t.mock.method(f.page, "url", () => "https://cloud.oracle.com/");
        return { dispose: async () => { disposed++; } };
      });
      try {
        await assert.rejects(f.driver.frame(), OciProviderBrowserError);
        assert.equal(captures, 1); assert.equal(probes, 1); assert.equal(f.browserClosures(), 1);
        assert.equal(disposed, condition === "probe rejected" ? 0 : 1);
      } finally { await f.driver.close(); await releaseOwnedOciSession(f.session); }
    });
  }
});

test("browser teardown aborts a late callback request before its owned listener can be reused", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async (t) => {
  let release!: () => void;
  const heldClose = new Promise<void>((resolve) => { release = resolve; });
  const { root, session, page, driver, browserClosures } = await ownedBrowserFixture(t, heldClose);
  assert.equal((await journal(root)).writers[0]?.role, "browser");
  assert.equal((await journal(root)).writers[0]?.state, "attached");
  let closing: Promise<void> | undefined;
  let continued = 0, aborted = 0, claims = 0;
  const displayed = await driver.frame();
  try {
    page.emit("request", { url: () => "https://unreviewed-cdn.invalid/image.png", isNavigationRequest: () => false,
      continue: async () => { continued++; }, abort: async () => { aborted++; } });
    assert.equal(browserClosures(), 0);
    await driver.input({ type: "text", text: "synthetic input after blocked optional image" }, displayed.frameRef, () => { claims++; });
    assert.equal(claims, 1);
    assert.equal(continued, 0); assert.equal(aborted, 1);
    page.emit("request", { url: () => "https://foreign-navigation.invalid/", isNavigationRequest: () => true,
      continue: async () => { continued++; }, abort: async () => { aborted++; } });
    assert.equal(browserClosures(), 1);
    closing = driver.close();
    page.emit("request", { url: () => "http://localhost:8181/token?fixture=late", continue: async () => { continued++; }, abort: async () => { aborted++; } });
    assert.equal(continued, 0); assert.equal(aborted, 3);
  } finally { release(); await (closing ?? driver.close()); }
  await assert.rejects(driver.input({ type: "text", text: "input after forbidden navigation" }, displayed.frameRef, () => { claims++; }), OciProviderBrowserError);
  assert.equal(claims, 1);
  assert.equal((await journal(root)).writers[0]?.state, "closed");
  await releaseOwnedOciSession(session);
  assert.deepEqual(await readdir(root), ["owned-resources-v1"]);
});

test("a stalled browser journal close reports uncertainty without acknowledging session cleanup", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async (t) => {
  const { root, session, driver } = await ownedBrowserFixture(t);
  const original = OwnedResourceLedger.prototype.confirmWriterClosed;
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(OwnedResourceLedger.prototype, "confirmWriterClosed", async function (this: OwnedResourceLedger, writer: Parameters<typeof original>[0]) {
    entered(); await held; await original.call(this, writer);
  });
  const closing = driver.close(); void closing.catch(() => {});
  await waiting;
  let timer!: ReturnType<typeof setTimeout>;
  try {
    const outcome = await Promise.race([closing.then(() => "acknowledged", (error: unknown) =>
      error instanceof OciProviderBrowserError && error.cleanupUncertain ? "uncertain" : "other"),
    new Promise<string>((resolve) => { timer = setTimeout(() => resolve("hung"), 1000); })]);
    assert.equal(outcome, "uncertain");
    assert.equal((await readdir(root)).some((name) => name.startsWith("oci-browser-")), false);
    assert.equal((await journal(root)).writers[0]?.state, "attached");
    await assert.rejects(releaseOwnedOciSession(session));
  } finally {
    clearTimeout(timer); release(); await closing.catch(() => {});
  }
  for (let count = 0; count < 100 && (await journal(root)).writers[0]?.state !== "closed"; count++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await journal(root)).writers[0]?.state, "closed");
  await releaseOwnedOciSession(session);
});

test("uncertain browser launch leaves its session writer pending and forbids session cleanup", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "oci-browser-journal-")); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = await createOwnedOciSession(root, randomUUID(), expected);
  t.mock.method(puppeteer, "launch", async () => { throw new Error("synthetic uncertain launch"); });
  await assert.rejects(openOciProviderBrowser(root, authorizationUrl(), new AbortController().signal, session), (error) => error instanceof OciProviderBrowserError && error.cleanupUncertain);
  assert.equal((await journal(root)).writers[0]?.role, "browser");
  assert.equal((await journal(root)).writers[0]?.state, "pending");
  assert.ok((await journal(root)).writers[0]?.directory?.name.startsWith("oci-browser-"));
  await assert.rejects(releaseOwnedOciSession(session));
});
