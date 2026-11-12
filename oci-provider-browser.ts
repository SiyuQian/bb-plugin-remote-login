import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import puppeteer, { ProtocolError, type Browser, type BrowserContext, type Page, type Target } from "puppeteer-core";
import { fixtureInputSchema, type FixtureFrame, type FixtureInput } from "./fixture-wire.ts";
import { StaleFrameError } from "./frame-error.ts";
import { FrameObservation } from "./frame-observation.ts";
import { isPinnedOciAuthorizationUrl } from "./oci-child-job.ts";
import type { OwnedOciSession } from "./oci-owned-session.ts";
import { prepareOwnedOciWriter, observeOwnedOciWriter, abandonOwnedOciWriter, recordOwnedOciWriterDirectory, finishOwnedOciWriterCleanup, waitForOwnedOciWriterCleanup, type PreparedOwnedOciWriter } from "./oci-writer-journal.ts";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// Chrome auto-updates must fail closed until the private-browser probe is revalidated.
const testedChromeVersion = "157.0.8103.50";
const runFile = promisify(execFile);

/** Human frame/input only; no URL, DOM, script, selector, cookie, profile or CDP operations. */
export interface OciProviderBrowser {
  frame(): Promise<FixtureFrame>;
  input(event: FixtureInput, frameRef: string, claimInput: () => void): Promise<void>;
  invalidateFrame(): void;
  close(): Promise<void>;
}

/** A fixed failure code; uncertain cleanup requires worker retention and owner recovery. */
export class OciProviderBrowserError extends Error {
  readonly code = "browser_unavailable";
  constructor(readonly cleanupUncertain = false) { super("OCI browser unavailable."); }
}

// This closed Oracle-only set deliberately excludes external federation providers.
const oracleHosts = new Set(["login.ap-sydney-1.oraclecloud.com", "cloud.oracle.com", "signin.oracle.com"]);
const allowlist = ["about\\:blank", ...[...oracleHosts].map((host) => `https://${host}/*`),
  "https://*.identity.oraclecloud.com/*", "http://localhost:8181/*", "http://127.0.0.1:8181/*"];
const ipv4Callback = "--host-resolver-rules=MAP localhost 127.0.0.1";
const directConnections = "--no-proxy-server";

/** Fixed worker policy only. It accepts no caller-provided origin or external IdP. */
export function isSupportedOciBrowserUrl(value: string): boolean {
  try {
    if (typeof value !== "string" || value.length > 131072) return false;
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)) {
      return url.port === "8181" && ["/", "/token"].includes(url.pathname);
    }
    return url.protocol === "https:" && !url.port && (oracleHosts.has(url.hostname)
      || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.identity\.oraclecloud\.com$/.test(url.hostname));
  } catch { return false; }
}

function isOciCallbackUrl(value: string): boolean {
  return isSupportedOciBrowserUrl(value) && new URL(value).protocol === "http:";
}

function sameDirectory(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

async function privateDirectory(path: string): Promise<Stats> {
  const metadata = await lstat(path);
  if (!isAbsolute(path) || !metadata.isDirectory() || metadata.isSymbolicLink()
    || metadata.uid !== process.getuid?.() || (metadata.mode & 0o7777) !== 0o700
    || await realpath(path) !== path || !sameDirectory(metadata, await lstat(path))) {
    throw new OciProviderBrowserError();
  }
  return metadata;
}

function processExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: ChildProcess, timeout: number): Promise<boolean> {
  if (processExited(child)) return true;
  return await new Promise<boolean>((resolve) => {
    const finish = (exited: boolean) => { clearTimeout(timer); child.off("exit", onExit); resolve(exited); };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(processExited(child)), timeout);
    child.once("exit", onExit);
    if (processExited(child)) finish(true);
  });
}

async function boundedClose(browser: Browser): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 4000);
    void browser.close().then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(false); });
  });
}

/** Opens one captured authorization URL in a fresh owned Chrome context and private pipe. */
export async function openOciProviderBrowser(tempDir: string, capturedAuthorizationUrl: string, signal: AbortSignal, session?: OwnedOciSession): Promise<OciProviderBrowser> {
  if (!isPinnedOciAuthorizationUrl(capturedAuthorizationUrl)) throw new OciProviderBrowserError();
  let parent: Stats | undefined;
  let profile: { path: string; identity: Stats } | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let target: Target | undefined;
  let launchAttempted = false;
  let ready = false;
  let stopped = signal.aborted;
  let cleanupUncertain = false;
  let closing: Promise<void> | undefined;
  let pending: Promise<unknown> = Promise.resolve();
  let callbackNavigation: { ready: Promise<void>; controller: AbortController } | undefined;
  let writer: PreparedOwnedOciWriter | undefined;
  let writerProcess: ReturnType<typeof observeOwnedOciWriter> | undefined;
  const observation = new FrameObservation(), staleInput = Symbol();

  function clearCallbackNavigation(): void {
    const previous = callbackNavigation;
    callbackNavigation = undefined;
    previous?.controller.abort();
  }
  const close = (): Promise<void> => {
    stopped = true;
    observation.invalidate();
    clearCallbackNavigation();
    signal.removeEventListener("abort", onAbort);
    closing ??= (async () => {
      try {
        if (launchAttempted && !browser) throw new OciProviderBrowserError(true);
        if (browser) {
          const child = browser.process();
          if (!child) throw new OciProviderBrowserError(true);
          const closed = await boundedClose(browser);
          const exited = await waitForExit(child, 1500);
          if (!closed || !exited) {
            if (!processExited(child)) { child.kill("SIGKILL"); await waitForExit(child, 1500); }
            throw new OciProviderBrowserError(true);
          }
        }
        if (profile) {
          if (!parent || !sameDirectory(parent, await privateDirectory(tempDir))
            || !sameDirectory(profile.identity, await privateDirectory(profile.path))) throw new OciProviderBrowserError(true);
          await rm(profile.path, { recursive: true, force: false });
          try { await lstat(profile.path); throw new OciProviderBrowserError(true); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        if (writer) {
          if (writerProcess) { await waitForOwnedOciWriterCleanup(writerProcess.closed); await waitForOwnedOciWriterCleanup(finishOwnedOciWriterCleanup(writer)); }
          else if (!launchAttempted) await waitForOwnedOciWriterCleanup(abandonOwnedOciWriter(writer));
          else throw new OciProviderBrowserError(true);
        }
      } catch {
        cleanupUncertain = true;
        throw new OciProviderBrowserError(true);
      }
    })();
    return closing;
  };
  function onAbort(): void {
    stopped = true;
    observation.invalidate();
    if (ready) void close().catch(() => undefined);
  }
  function invalidate(): void { stopped = true; void close().catch(() => undefined); }
  function assertActive(): void {
    if (stopped || signal.aborted) throw new OciProviderBrowserError(cleanupUncertain);
  }
  async function assertTarget(): Promise<void> {
    assertActive();
    const viewport = page?.viewport();
    if (!browser || !context || !page || !target || !browser.connected || page.isClosed()
      || page.browser() !== browser || page.browserContext() !== context || page.target() !== target
      || !viewport || viewport.width !== 800 || viewport.height !== 600 || (viewport.deviceScaleFactor ?? 1) !== 1
      || !isSupportedOciBrowserUrl(page.url()) || page.frames().some((frame) => !isSupportedOciBrowserUrl(frame.url()))) {
      throw new OciProviderBrowserError();
    }
    assertActive();
  }
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(async () => {
      try {
        await assertTarget();
        const value = await operation();
        await assertTarget();
        return value;
      } catch {
        await close();
        throw new OciProviderBrowserError(cleanupUncertain);
      }
    });
    pending = result.catch(() => undefined);
    return result;
  };

  signal.addEventListener("abort", onAbort, { once: true });
  try {
    assertActive();
    parent = await privateDirectory(tempDir);
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new OciProviderBrowserError();
    const version = await runFile("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", "/Applications/Google Chrome.app/Contents/Info.plist"], { timeout: 2000 });
    if (version.stdout.trim() !== testedChromeVersion) throw new OciProviderBrowserError();
    assertActive();
    if (session) writer = await prepareOwnedOciWriter(session, "browser");
    const path = await mkdtemp(join(tempDir, "oci-browser-"));
    profile = { path, identity: await lstat(path) };
    await privateDirectory(path);
    if (writer) await recordOwnedOciWriterDirectory(writer, path);
    assertActive();
    launchAttempted = true;
    // During startup, caller abort is checked after launch returns an owned process.
    // A launch rejection without that handle retains the profile and reports uncertainty.
    browser = await puppeteer.launch({
      browser: "chrome", executablePath: chromePath, userDataDir: path,
      headless: true, pipe: true, dumpio: false, timeout: 10_000, protocolTimeout: 3000,
      args: [ipv4Callback, directConnections], allowlist, logger: () => undefined,
    });
    assertActive();
    const child = browser.process();
    if (child && writer) writerProcess = observeOwnedOciWriter(writer, child, { closeOnExit: false });
    if (writerProcess) await writerProcess.attached;
    if (!child || child.spawnargs[0] !== chromePath || !child.spawnargs.includes("--remote-debugging-pipe")
      || child.spawnargs.some((arg) => arg.startsWith("--remote-debugging-port"))
      || !child.spawnargs.includes(ipv4Callback)
      || !child.spawnargs.includes(directConnections)
      || child.spawnargs.includes("--no-sandbox") || child.spawnargs.includes("--disable-setuid-sandbox")
      || child.spawnargs.filter((arg) => arg.startsWith("--user-data-dir=")).length !== 1
      || !child.spawnargs.includes(`--user-data-dir=${path}`)
      || await browser.version() !== `Chrome/${testedChromeVersion}`) throw new OciProviderBrowserError();
    context = await browser.createBrowserContext({ downloadBehavior: { policy: "deny" } });
    page = await context.newPage();
    target = page.target();
    page.setDefaultTimeout(2000);
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
    await page.setCacheEnabled(false);
    await page.setRequestInterception(true);
    await page.setBypassServiceWorker(true);
    page.on("request", (request) => {
      if (stopped || signal.aborted) { void request.abort().catch(() => undefined); return; }
      if (!isSupportedOciBrowserUrl(request.url())) {
        void request.abort().catch(() => undefined);
        if (request.isNavigationRequest()) invalidate();
        return;
      }
      if (request.isNavigationRequest()) observation.invalidate();
      if (request.isNavigationRequest() && request.frame() === page!.mainFrame()) {
        clearCallbackNavigation();
        if (request.method() === "GET" && isOciCallbackUrl(request.url())) {
          const controller = new AbortController();
          // This internal Puppeteer 25.16 option is checked by the real hash-
          // navigation regression. Register before continuing the document.
          const options: NonNullable<Parameters<Page["waitForNavigation"]>[0]> & { ignoreSameDocumentNavigation: true } = {
            waitUntil: "domcontentloaded", ignoreSameDocumentNavigation: true,
            timeout: 1000, signal: AbortSignal.any([signal, controller.signal]),
          };
          const ready = page!.waitForNavigation(options).then(() => {});
          void ready.catch(() => undefined);
          callbackNavigation = { ready, controller };
        }
      }
      void request.continue().catch(() => invalidate());
    });
    for (const initial of await browser.pages()) if (initial !== page) await initial.close();
    browser.on("targetcreated", (created) => { if (created !== target) invalidate(); });
    browser.on("disconnected", invalidate);
    page.on("framenavigated", (frame) => { observation.invalidate(); if (!isSupportedOciBrowserUrl(frame.url())) invalidate(); });
    page.on("frameattached", () => observation.invalidate());
    page.on("framedetached", () => observation.invalidate());
    page.on("popup", invalidate);
    page.on("workercreated", invalidate);
    page.on("dialog", invalidate);
    page.on("error", invalidate);
    page.on("close", () => { if (!stopped) invalidate(); });
    await page.goto(capturedAuthorizationUrl, { waitUntil: "domcontentloaded", timeout: 6000 });
    ready = true;
    await assertTarget();
    const ownedPage = page;
    return {
      frame: async () => {
        const captured = await run(async () => {
          const navigation = callbackNavigation;
          if (navigation) {
            await navigation.ready;
            await assertTarget();
            if (callbackNavigation !== navigation || !isOciCallbackUrl(ownedPage.url())) throw new OciProviderBrowserError();
            clearCallbackNavigation();
          }
          const ticket = observation.begin();
          let screenshot: Uint8Array;
          try { screenshot = await ownedPage.screenshot({ type: "png", fullPage: false }); }
          catch (error) {
            if (!(error instanceof ProtocolError) || error.name !== "ProtocolError"
              || error.originalMessage !== "Unable to capture screenshot") throw error;
            await assertTarget();
            const assertCallback = (): void => {
              if (!isOciCallbackUrl(ownedPage.url())) throw error;
            };
            assertCallback();
            // Give the callback document one bounded rendering opportunity before
            // repeating this read. The original operation deadline still applies.
            const rendered = await ownedPage.waitForFunction(() => new Promise<boolean>((resolve) => {
              requestAnimationFrame(() => resolve(true));
            }), { timeout: 1000 });
            await rendered.dispose();
            await assertTarget();
            assertCallback();
            screenshot = await ownedPage.screenshot({ type: "png", fullPage: false });
          }
          try {
            const bytes = Buffer.from(screenshot.buffer, screenshot.byteOffset, screenshot.byteLength);
            if (bytes.length < 24 || bytes.length > 1_125_000
              || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
              || bytes.readUInt32BE(16) !== 800 || bytes.readUInt32BE(20) !== 600) throw new OciProviderBrowserError();
            const png = bytes.toString("base64");
            if (png.length > 1_500_000) throw new OciProviderBrowserError();
            return { ticket, frame: { png, width: 800 as const, height: 600 as const } };
          } finally { screenshot.fill(0); }
        });
        const frameRef = observation.issue(captured.ticket);
        if (frameRef === null) throw new StaleFrameError();
        return { ...captured.frame, frameRef };
      },
      input: async (event, frameRef, claimInput) => {
        const outcome = await run(async () => {
          const input = fixtureInputSchema.parse(event);
          claimInput();
          if (!observation.consume(frameRef)) return staleInput;
          if (input.type === "click") await ownedPage.mouse.click(input.x, input.y);
          else if (input.type === "text") await ownedPage.keyboard.sendCharacter(input.text);
          else if (input.type === "key") await ownedPage.keyboard.press(input.key);
          else await ownedPage.mouse.wheel({ deltaY: input.deltaY });
        });
        if (outcome === staleInput) throw new StaleFrameError();
      },
      invalidateFrame: () => observation.invalidate(),
      close,
    };
  } catch {
    await close();
    throw new OciProviderBrowserError(cleanupUncertain);
  }
}
