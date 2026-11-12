import { execFile, type ChildProcess } from "node:child_process";
import fs, { lstat, mkdir, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import puppeteer, { type Browser, type BrowserContext, type CDPSession, type HTTPRequest, type Page, type Target } from "puppeteer-core";
import { fixtureInputSchema, type FixtureFrame, type FixtureInput } from "./fixture-wire.ts";
import { FrameObservation } from "./frame-observation.ts";
import { StaleFrameError } from "./frame-error.ts";
import { browserControlModeSchema, type BrowserControlMode } from "./browser-control.ts";
import { controlScopeSchema } from "./control-wire.ts";
import type { ControlScope } from "./control-authority.ts";
import { consoleExpectedIdentitySchema, type ConsoleExpectedIdentity } from "./oci-console-protocol.ts";
import { createConsoleSourceAttestor, type ConsoleSourceBoundary, type ConsoleSourceProof } from "./oci-console-source.ts";
import { createConsoleIdentityVerifier, type ConsoleIdentityMatch } from "./oci-console-verifier.ts";
import { inspectOwnedProcess } from "./owned-process-identity.ts";
import { OwnedResourceLedger, type OwnedResource, type OwnedResourceWriter } from "./owned-resource-ledger.ts";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chromeVersion = "157.0.8103.51";
const startUrl = "https://cloud.oracle.com/?region=ap-sydney-1";
const oracleHosts = new Set(["cloud.oracle.com", "login.ap-sydney-1.oraclecloud.com", "signin.oracle.com"]);
const networkAllowlist = ["about\\:blank", ...[...oracleHosts].map(host => `https://${host}/*`), "https://*.identity.oraclecloud.com/*"];
const blockedAllowlist = ["https://console-network-disabled.invalid/*"];
const runFile = promisify(execFile);
export class ConsoleBrowserError extends Error {
  readonly code = "browser_unavailable";
  constructor(readonly cleanupUncertain = false) { super("Console browser unavailable."); this.name = "ConsoleBrowserError"; }
}
export type ConsolePageOutline = Readonly<{ title: string; headings: readonly string[] }>;
export interface ConsoleBrowser {
  frame(): Promise<FixtureFrame>;
  input(event: FixtureInput, frameRef: string, claimInput: () => void): Promise<void>;
  invalidateFrame(): void;
  verify(signal: AbortSignal): Promise<ConsoleIdentityMatch>;
  readPage(signal: AbortSignal): Promise<ConsolePageOutline>;
  assertRetained(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
type Options = {
  controlMode?: BrowserControlMode;
  tempDir: string; expected: ConsoleExpectedIdentity; scope: ControlScope; expiresAt: number; lifecycle: AbortSignal;
  assertOwned(scope: ControlScope, signal: AbortSignal): Promise<void>;
  /** Worker-private external boundaries. No public entry accepts launch/source overrides. */
  dependencies?: { launch?: typeof puppeteer.launch; sources?: (page: Page, signal: AbortSignal) => ConsoleSourceBoundary };
};
function fail(uncertain = false): never { throw new ConsoleBrowserError(uncertain); }
function supported(value: string): boolean {
  if (value === "about:blank") return true;
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.port && (oracleHosts.has(u.hostname) || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.identity\.oraclecloud\.com$/.test(u.hostname)); } catch { return false; }
}
function same(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid; }
async function directory(path: string): Promise<Stats> {
  const s = await lstat(path);
  if (!isAbsolute(path) || !s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o7777) !== 0o700 || await realpath(path) !== path || !same(s, await lstat(path))) fail();
  return s;
}
async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => { abort = () => reject(new ConsoleBrowserError()); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); });
  try { const value = await Promise.race([promise, stopped]); signal.throwIfAborted(); return value; } finally { signal.removeEventListener("abort", abort); }
}
async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await bounded(new Promise<void>(resolve => child.once("close", () => resolve())), AbortSignal.timeout(1500));
}

/** Fresh private Console context. No arbitrary navigation, DOM, script, URL or browser handles escape. */
export async function openOciConsoleBrowser(input: Options): Promise<ConsoleBrowser> {
  const controlMode = input.controlMode === undefined ? "remote" : input.controlMode;
  if (!browserControlModeSchema.safeParse(controlMode).success) fail();
  let expected: ConsoleExpectedIdentity, scope: ControlScope;
  try { expected = Object.freeze(consoleExpectedIdentitySchema.parse(input.expected)); scope = Object.freeze(controlScopeSchema.parse(input.scope)); } catch { return fail(); }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now() || typeof input.assertOwned !== "function") fail();
  const lifetime = new AbortController(), lifecycle = AbortSignal.any([input.lifecycle, lifetime.signal]);
  const ledger = new OwnedResourceLedger(input.tempDir);
  let resource: OwnedResource | undefined, writer: OwnedResourceWriter | undefined, profile: { path: string; identity: Stats } | undefined, parent: Stats | undefined;
  let browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined, target: Target | undefined;
  let cdp: CDPSession | undefined, rootCdp: CDPSession | undefined, sources: ConsoleSourceBoundary | undefined, verifier: ReturnType<typeof createConsoleIdentityVerifier> | undefined;
  let child: ChildProcess | undefined, processClosed: Promise<void> | undefined;
  let launchAttempted = false, ready = false, stopped = false, uncertain = false, closing: Promise<void> | undefined;
  let phase: "human" | "blocked" = "human", epoch = 0, documentGeneration = 0, busy = false, retained: { proof: ConsoleSourceProof; document: number } | undefined;
  let slot: Promise<unknown> = Promise.resolve();
  const observation = new FrameObservation(), staleInput = Symbol("stale input");
  const requests = new Set<HTTPRequest>(), idleWaiters = new Set<() => void>();
  let allowance: { marker: string; url: string; get: boolean; preflight: boolean; frame: string; loader: string; requestId?: string;
    ready: Promise<void>; match(): void; signal: AbortSignal } | undefined;
  const close = (): Promise<void> => {
    observation.invalidate();
    stopped = true; phase = "blocked"; epoch++; allowance = undefined; retained = undefined; lifetime.abort();
    input.lifecycle.removeEventListener("abort", abort);
    closing ??= (async () => {
      try {
        verifier?.dispose(); sources?.dispose();
        if (launchAttempted && !browser) fail(true);
        if (browser) {
          if (!child) fail(true);
          const ownedChild = child;
          try { await bounded(browser.close(), AbortSignal.timeout(4000)); await exited(ownedChild); await bounded(processClosed!, AbortSignal.timeout(1500)); }
          catch { if (ownedChild.exitCode === null && ownedChild.signalCode === null) ownedChild.kill("SIGKILL"); await exited(ownedChild).catch(() => {}); fail(true); }
        }
        if (profile) {
          if (!parent || !same(parent, await directory(input.tempDir)) || !same(profile.identity, await directory(profile.path))) fail(true);
          if (!resource || !writer) fail(true);
          await bounded(ledger.prepareBrowserRemoval(resource, writer), AbortSignal.timeout(1000));
          await bounded(fs.rm(profile.path, { recursive: true, force: false }), AbortSignal.timeout(750));
          try { await lstat(profile.path); fail(true); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        if (writer) await bounded(ledger.confirmWriterClosed(writer), AbortSignal.timeout(1000));
        if (resource) await bounded(ledger.release(resource), AbortSignal.timeout(1000));
      } catch { uncertain = true; fail(true); }
    })();
    return closing;
  };
  function abort(): void { observation.invalidate(); stopped = true; phase = "blocked"; epoch++; allowance = undefined; retained = undefined; if (ready) void close().catch(() => {}); }
  function invalidate(): void { observation.invalidate(); stopped = true; phase = "blocked"; epoch++; allowance = undefined; retained = undefined; if (ready) void close().catch(() => {}); }
  function live(): void {
    if (stopped || lifecycle.aborted || Date.now() >= input.expiresAt || !browser || !context || !page || !target || !browser.connected || page.isClosed() || page.browser() !== browser || page.browserContext() !== context || page.target() !== target || !supported(page.url()) || page.frames().some(f => !supported(f.url()))) fail(uncertain);
    const viewport = page!.viewport();
    if (!viewport || viewport.width !== 800 || viewport.height !== 600 || viewport.deviceScaleFactor !== 1) { observation.invalidate(); fail(uncertain); }
  }
  const own = async (signal: AbortSignal) => { live(); signal.throwIfAborted(); await bounded(input.assertOwned(scope, signal), signal); live(); signal.throwIfAborted(); };
  const drain = async (signal: AbortSignal) => {
    await bounded(browser!.restrictNetwork({ allowlist: blockedAllowlist }), signal);
    await bounded(cdp!.send("Page.stopLoading"), signal);
    if (requests.size) await bounded(new Promise<void>(resolve => { const idle = () => { if (!requests.size) { idleWaiters.delete(idle); resolve(); } }; idleWaiters.add(idle); idle(); }), signal);
    live(); if (requests.size) fail(true);
  };
  const human = <T>(operation: () => Promise<T>): Promise<T> => {
    if (phase !== "human" || stopped) return Promise.reject(new ConsoleBrowserError(uncertain));
    const ticket = epoch;
    const result = slot.then(async () => { live(); if (phase !== "human" || ticket !== epoch) fail(); await own(lifecycle); if (phase !== "human" || ticket !== epoch) fail(); const value = await operation(); live(); if (phase !== "human" || ticket !== epoch) fail(); return value; });
    slot = result.catch(() => {}); return result;
  };
  const reserve = <T>(signal: AbortSignal, operation: (signal: AbortSignal, generation: number) => Promise<T>): Promise<T> => {
    if (busy || stopped) return Promise.reject(new ConsoleBrowserError(uncertain));
    busy = true; phase = "blocked"; epoch++; retained = undefined; allowance = undefined;
    observation.invalidate();
    const stoppedSignal = AbortSignal.any([signal, lifecycle, AbortSignal.timeout(7500)]), ticket = epoch;
    const result = slot.then(async () => {
      try {
        await own(stoppedSignal); if (ticket !== epoch) fail();
        // Retained local pages keep renderer input disabled until exact closure.
        if (controlMode === "host") await bounded(cdp!.send("Input.setIgnoreInputEvents", { ignore: true }), stoppedSignal);
        await drain(stoppedSignal);
        const generation = documentGeneration, value = await operation(stoppedSignal, generation);
        await own(stoppedSignal);
        if (generation !== documentGeneration || ticket !== epoch || phase !== "blocked") fail();
        return value;
      }
      catch { await close(); throw new ConsoleBrowserError(uncertain); }
      finally { busy = false; }
    });
    slot = result.catch(() => {}); return result;
  };
  input.lifecycle.addEventListener("abort", abort, { once: true });
  try {
    if (lifecycle.aborted) fail(); parent = await directory(input.tempDir);
    if (process.platform !== "darwin" || process.arch !== "arm64") fail();
    const version = await runFile("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", "/Applications/Google Chrome.app/Contents/Info.plist"], { timeout: 2000 });
    if (version.stdout.trim() !== chromeVersion) fail();
    resource = await ledger.prepare(scope, "browser_profile"); const path = ledger.path(resource);
    await mkdir(path, { mode: 0o700 }); profile = { path, identity: await directory(path) }; await ledger.recordEntry(resource, "", true);
    writer = await ledger.beginWriter(resource, "browser"); await ledger.recordWriterDirectory(writer, path);
    if (lifecycle.aborted) fail();
    launchAttempted = true;
    browser = await (input.dependencies?.launch ?? puppeteer.launch.bind(puppeteer))({ browser: "chrome", executablePath: chromePath, userDataDir: path, headless: controlMode !== "host", pipe: true, dumpio: false, timeout: 10000, protocolTimeout: 3000, args: ["--no-proxy-server", "--disable-quic"], allowlist: networkAllowlist, logger: () => undefined });
    child = browser.process() ?? undefined;
    if (child) { processClosed = new Promise<void>(resolve => child!.once("close", () => resolve())); const identity = child.pid ? await inspectOwnedProcess(child.pid) : null; if (!identity) fail(true); await ledger.attachWriter(writer, identity); }
    if (!child || child.spawnargs[0] !== chromePath || !child.spawnargs.includes("--remote-debugging-pipe") || child.spawnargs.some(a => a.startsWith("--remote-debugging-port") || a.startsWith("--ignore-certificate-errors") || a === "--no-sandbox" || a === "--disable-setuid-sandbox") || !child.spawnargs.includes("--no-proxy-server") || !child.spawnargs.includes("--disable-quic") || child.spawnargs.filter(a => a.startsWith("--user-data-dir=")).length !== 1 || !child.spawnargs.includes(`--user-data-dir=${path}`) || await browser.version() !== `Chrome/${chromeVersion}`) fail();
    context = await browser.createBrowserContext({ downloadBehavior: { policy: "deny" } }); page = await context.newPage(); target = page.target();
    page.setDefaultTimeout(2000); await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 }); await page.setCacheEnabled(false); await page.setBypassServiceWorker(true); await page.setRequestInterception(true);
    for (const initial of await browser.pages()) if (initial !== page) await initial.close();
    cdp = await page.createCDPSession(); rootCdp = await browser.target().createCDPSession(); await cdp.send("Network.enable");
    const ownedTarget = (await cdp.send("Target.getTargetInfo")).targetInfo.targetId;
    const rejectTarget = (event: { targetInfo: { type: string; targetId: string }; waitingForDebugger: boolean }) => {
      if (event.targetInfo.type === "page" && event.targetInfo.targetId === ownedTarget && !event.waitingForDebugger) return;
      invalidate(); void rootCdp?.send("Target.closeTarget", { targetId: event.targetInfo.targetId }).catch(() => {});
    };
    cdp.on("Target.attachedToTarget", rejectTarget); rootCdp.on("Target.attachedToTarget", rejectTarget);
    const workers = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "browser", exclude: true }, { type: "tab", exclude: true }, {}] };
    await cdp.send("Target.setAutoAttach", workers); await rootCdp.send("Target.setAutoAttach", workers);
    cdp.on("Network.webSocketCreated", invalidate); cdp.on("Network.webTransportCreated", invalidate);
    cdp.on("Network.requestWillBeSent", event => {
      const current = allowance;
      if (!current || !Object.entries(event.request.headers).some(([key,value]) => key.toLowerCase() === "opc-request-id" && value === current.marker)) return;
      if (current.requestId || event.request.url !== current.url || event.request.method !== "GET" || event.frameId !== current.frame || event.loaderId !== current.loader || event.type !== "Fetch" || event.redirectResponse || event.request.hasPostData) { invalidate(); return; }
      current.requestId = event.requestId; current.match();
    });
    // Freeze long-lived channel constructors before any provider script; HTTP remains governed below.
    await page.evaluateOnNewDocument('for (const name of ["WebSocket","WebSocketStream","WebTransport","EventSource","Worker","SharedWorker","RTCPeerConnection","webkitRTCPeerConnection"]) Object.defineProperty(globalThis,name,{value:function(){throw new Error("Channel unavailable.");},writable:false,configurable:false});');
    const finished = (request: HTTPRequest) => { requests.delete(request); for (const idle of idleWaiters) idle(); };
    page.on("requestfinished", finished); page.on("requestfailed", finished);
    page.on("request", request => { void (async () => {
      if (request.isNavigationRequest()) observation.invalidate();
      if (request.isInterceptResolutionHandled()) return;
      const headers = request.headers(); let current = allowance;
      if (phase === "blocked" && current && request.url() === current.url) {
        try { await bounded(current.ready, AbortSignal.any([current.signal, lifecycle, AbortSignal.timeout(1000)])); }
        catch { void request.abort().catch(() => {}); return; }
        if (current !== allowance) current = undefined;
        if (request.isInterceptResolutionHandled()) return;
      }
      let permitted = false;
      if (!stopped && !lifecycle.aborted && !request.redirectChain().length) {
        if (phase === "human") permitted = supported(request.url()) && !!request.frame() && !["eventsource", "websocket", "ping", "other"].includes(request.resourceType());
        else if (current && request.url() === current.url && !request.isNavigationRequest()) {
          if (request.method() === "GET" && request.resourceType() === "fetch" && request.frame() === page!.mainFrame() && !!current.requestId && headers["opc-request-id"] === current.marker && !request.postData() && !current.get) { current.get = true; permitted = true; }
          const initiator = request.initiator();
          if (request.method() === "OPTIONS" && request.resourceType() === "other" && initiator?.type === "preflight" && initiator.url === current.url && !!current.requestId && initiator.requestId === current.requestId && !current.preflight && headers.origin === "https://cloud.oracle.com" && headers["access-control-request-method"] === "GET" && (headers["access-control-request-headers"] ?? "").split(",").every(h => ["authorization", "content-type", "opc-request-id", "x-date"].includes(h.trim().toLowerCase())) && (headers["access-control-request-headers"] ?? "").includes("opc-request-id")) { current.preflight = true; permitted = true; }
        }
      }
      if (!permitted) { void request.abort().catch(() => {}); if (request.isNavigationRequest() && (phase !== "human" || !supported(request.url()))) invalidate(); return; }
      requests.add(request); void request.continue().catch(invalidate);
    })().catch(() => { void request.abort().catch(() => {}); invalidate(); }); });
    browser.on("targetcreated", created => { if (created !== target) invalidate(); }); browser.on("disconnected", invalidate);
    page.on("framenavigated", frame => { observation.invalidate(); if (frame === page!.mainFrame()) { documentGeneration++; if (phase !== "human") invalidate(); } if (!supported(frame.url())) invalidate(); });
    page.on("frameattached", () => observation.invalidate()); page.on("framedetached", () => observation.invalidate());
    page.on("popup", invalidate); page.on("workercreated", invalidate); page.on("dialog", invalidate); page.on("error", invalidate); page.on("close", () => { if (!stopped) invalidate(); });
    sources = (input.dependencies?.sources ?? createConsoleSourceAttestor)(page, lifecycle);
    const boundary = sources;
    verifier = createConsoleIdentityVerifier({ page, expected, scope, expiresAt: input.expiresAt, lifecycle, timeoutMs: 3000, assertOwned: input.assertOwned, dependencies: { sources: () => boundary },
      allowRead: async (request, signal) => {
        live(); if (phase !== "blocked" || requests.size || allowance) fail(true);
        const tree = await bounded(cdp!.send("Page.getFrameTree"), signal);
        let match!: () => void; const ready = new Promise<void>(resolve => { match = resolve; });
        allowance = { ...request, get: false, preflight: false, frame: tree.frameTree.frame.id, loader: tree.frameTree.frame.loaderId, ready, match, signal }; await bounded(browser!.restrictNetwork({ allowlist: [request.url] }), signal);
        return async () => { allowance = undefined; await browser!.restrictNetwork({ allowlist: blockedAllowlist }); };
      },
    });
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 6000 }); ready = true; live();
    if (controlMode === "host") await page.bringToFront();
    const ownedPage = page, identityVerifier = verifier;
    const verified = async (signal: AbortSignal, generation: number) => { const match = await identityVerifier.verify(signal); live(); if (generation !== documentGeneration) fail(); const proof = await boundary.capture(signal); boundary.assert(proof); retained = { proof, document: generation }; return match; };
    const assertRetained = async (signal: AbortSignal) => { await own(signal); if (phase !== "blocked" || busy || !retained || retained.document !== documentGeneration) fail(); boundary.assert(retained.proof); await own(signal); if (!retained || retained.document !== documentGeneration) fail(); boundary.assert(retained.proof); };
    const scrub = (value: string) => {
      let text = value;
      for (const secret of [expected.userOcid, expected.tenancyOcid, expected.domainOcid, expected.domainOrigin]) text = text.split(secret).join("[redacted]");
      if (/\b(?:authorization|password|passwd|secret|cookie|bearer|signature|private[ -]?key)\b|-----BEGIN/i.test(text)) text = "[redacted]";
      text = text.replace(/ocid1\.[A-Za-z0-9._-]+|ST\$\S+|https?:\/\/\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+/g, "[redacted]").replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim();
      let result = ""; for (const character of text) { if ((result + character).length > 128 || Buffer.byteLength(result + character) > 512) break; result += character; } return result;
    };
    return {
      frame: async () => {
        if (controlMode === "host") fail();
        const captured = await human(async () => {
          const ticket = observation.begin(), screenshot = await ownedPage.screenshot({ type: "png", fullPage: false });
          try {
            const bytes = Buffer.from(screenshot.buffer, screenshot.byteOffset, screenshot.byteLength);
            if (bytes.length < 24 || bytes.length > 1125000 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.readUInt32BE(16) !== 800 || bytes.readUInt32BE(20) !== 600) fail();
            return { ticket, frame: { png: bytes.toString("base64"), width: 800 as const, height: 600 as const } };
          } finally { screenshot.fill(0); }
        }).catch((error: unknown) => {
          if (error instanceof StaleFrameError) throw new ConsoleBrowserError(uncertain);
          throw error;
        });
        const frameRef = observation.issue(captured.ticket);
        if (frameRef === null) throw new StaleFrameError();
        return { ...captured.frame, frameRef };
      },
      input: async (event, frameRef, claimInput) => {
        if (controlMode === "host") fail();
        let result;
        try {
          result = await human(async () => {
            const value = fixtureInputSchema.parse(event);
            claimInput();
            if (!observation.consume(frameRef)) return staleInput;
            if (value.type === "click") await ownedPage.mouse.click(value.x, value.y);
            else if (value.type === "text") await ownedPage.keyboard.sendCharacter(value.text);
            else if (value.type === "key") await ownedPage.keyboard.press(value.key);
            else await ownedPage.mouse.wheel({ deltaY: value.deltaY });
          });
        } catch (error) {
          if (error instanceof StaleFrameError) throw new ConsoleBrowserError(uncertain);
          throw error;
        }
        if (result === staleInput) throw new StaleFrameError();
      },
      invalidateFrame: () => observation.invalidate(),
      verify: signal => reserve(signal, verified),
      readPage: signal => reserve(signal, async (stopped, generation) => { await verified(stopped, generation); const outline = await bounded(ownedPage.evaluate(() => ({ title: document.title.slice(0, 4096), headings: Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).filter(node => !node.closest("form,input,textarea,select,button,[contenteditable],label") && (node as HTMLElement).checkVisibility()).slice(0,20).map(node => (node as HTMLElement).innerText.slice(0,4096)) })), stopped); await verified(stopped, generation); const result = Object.freeze({ title: scrub(outline.title), headings: Object.freeze(outline.headings.map(scrub).filter(Boolean)) }); if (Buffer.byteLength(JSON.stringify(result)) > 16000) fail(); return result; }),
      assertRetained, close,
    };
  } catch { await close(); throw new ConsoleBrowserError(uncertain); }
}
