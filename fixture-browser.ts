import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import puppeteer, { type Browser, type BrowserContext, type Page, type Target } from "puppeteer-core";
import { fixtureInputSchema, type FixtureFrame, type FixtureInput } from "./fixture-wire.ts";
import { FrameObservation } from "./frame-observation.ts";
import { StaleFrameError } from "./frame-error.ts";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// Chrome auto-updates must fail closed until the private-browser probe is revalidated.
const testedChromeVersion = "157.0.8103.50";
const runFile = promisify(execFile);

/** A single synthetic page; no URL, script, selector, profile or CDP capabilities. */
export interface FixtureBrowser {
  frame(): Promise<FixtureFrame>;
  verify(): Promise<boolean>;
  input(event: FixtureInput, frameRef: string, claimInput: () => void): Promise<void>;
  invalidateFrame(): void;
  close(): Promise<void>;
}

/** A fixed failure code; uncertain cleanup requires worker retention and owner recovery. */
export class FixtureBrowserError extends Error {
  readonly code = "fixture_unavailable";
  constructor(readonly cleanupUncertain = false) { super("fixture_unavailable"); }
}

function sameDirectory(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

async function privateDirectory(path: string): Promise<Stats> {
  const metadata = await lstat(path);
  if (!isAbsolute(path) || !metadata.isDirectory() || metadata.isSymbolicLink()
    || metadata.uid !== process.getuid?.() || (metadata.mode & 0o7777) !== 0o700
    || await realpath(path) !== path || !sameDirectory(metadata, await lstat(path))) {
    throw new FixtureBrowserError();
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

function fixture(marker: string): string {
  return `<!doctype html><html data-fixture="${marker}"><head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${marker}'; style-src 'nonce-${marker}'; connect-src 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'">
    <title>Private synthetic fixture</title><style nonce="${marker}">
    body{height:1800px;margin:0;background:#fafafa;font:16px sans-serif}input{position:absolute;left:40px;top:40px;width:300px;height:40px}
    button{position:absolute;left:40px;top:110px;width:200px;height:40px}output{position:absolute;left:40px;top:180px}
    </style></head><body><input aria-label="Synthetic text" autocomplete="off"><button type="button">Apply synthetic text</button><output></output>
    <script nonce="${marker}">document.querySelector('button').addEventListener('click',()=>{document.querySelector('output').textContent=document.querySelector('input').value})</script></body></html>`;
}

/** Open only the version-validated, no-network synthetic fixture in an existing private parent. */
export async function openFixtureBrowser(tempDir: string, signal: AbortSignal): Promise<FixtureBrowser> {
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
  const marker = randomUUID();
  const observation = new FrameObservation(), staleInput = Symbol("stale input");

  const close = (): Promise<void> => {
    observation.invalidate();
    stopped = true;
    signal.removeEventListener("abort", onAbort);
    closing ??= (async () => {
      try {
        if (launchAttempted && !browser) throw new FixtureBrowserError(true);
        if (browser) {
          const child = browser.process();
          if (!child) throw new FixtureBrowserError(true);
          const closed = await boundedClose(browser);
          const exited = await waitForExit(child, 1500);
          if (!closed || !exited) {
            if (!processExited(child)) { child.kill("SIGKILL"); await waitForExit(child, 1500); }
            throw new FixtureBrowserError(true);
          }
        }
        if (profile) {
          if (!parent || !sameDirectory(parent, await privateDirectory(tempDir))
            || !sameDirectory(profile.identity, await privateDirectory(profile.path))) throw new FixtureBrowserError(true);
          await rm(profile.path, { recursive: true, force: false });
          try { await lstat(profile.path); throw new FixtureBrowserError(true); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
      } catch {
        cleanupUncertain = true;
        throw new FixtureBrowserError(true);
      }
    })();
    return closing;
  };
  function onAbort(): void {
    observation.invalidate();
    stopped = true;
    if (ready) void close().catch(() => undefined);
  }
  function invalidate(): void { stopped = true; void close().catch(() => undefined); }
  function assertActive(): void {
    if (stopped || signal.aborted) throw new FixtureBrowserError(cleanupUncertain);
  }
  async function assertTarget(): Promise<void> {
    assertActive();
    if (!browser || !context || !page || !target || !browser.connected || page.isClosed()
      || page.browser() !== browser || page.browserContext() !== context || page.target() !== target
      || page.url() !== "about:blank" || page.frames().length !== 1
      || !await page.evaluate((expected) => document.documentElement.dataset.fixture === expected, marker)) {
      throw new FixtureBrowserError();
    }
    const viewport = page.viewport();
    if (!viewport || viewport.width !== 800 || viewport.height !== 600 || viewport.deviceScaleFactor !== 1) {
      observation.invalidate();
      throw new FixtureBrowserError();
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
        throw new FixtureBrowserError(cleanupUncertain);
      }
    });
    pending = result.catch(() => undefined);
    return result;
  };

  signal.addEventListener("abort", onAbort, { once: true });
  try {
    assertActive();
    parent = await privateDirectory(tempDir);
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new FixtureBrowserError();
    const version = await runFile("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", "/Applications/Google Chrome.app/Contents/Info.plist"], { timeout: 2000 });
    if (version.stdout.trim() !== testedChromeVersion) throw new FixtureBrowserError();
    assertActive();
    const path = await mkdtemp(join(tempDir, "fixture-browser-"));
    profile = { path, identity: await lstat(path) };
    await privateDirectory(path);
    assertActive();
    launchAttempted = true;
    // During startup, caller abort is checked after launch returns an owned process.
    // A launch rejection without that handle retains the profile and reports uncertainty.
    browser = await puppeteer.launch({
      browser: "chrome", executablePath: chromePath, userDataDir: path,
      headless: true, pipe: true, dumpio: false, timeout: 10_000, protocolTimeout: 3000,
      allowlist: ["about\\:blank"], logger: () => undefined,
    });
    assertActive();
    const child = browser.process();
    if (!child || child.spawnargs[0] !== chromePath || !child.spawnargs.includes("--remote-debugging-pipe")
      || child.spawnargs.some((arg) => arg.startsWith("--remote-debugging-port"))
      || child.spawnargs.includes("--no-sandbox") || child.spawnargs.includes("--disable-setuid-sandbox")
      || child.spawnargs.filter((arg) => arg.startsWith("--user-data-dir=")).length !== 1
      || !child.spawnargs.includes(`--user-data-dir=${path}`)
      || await browser.version() !== `Chrome/${testedChromeVersion}`) throw new FixtureBrowserError();
    context = await browser.createBrowserContext({ downloadBehavior: { policy: "deny" } });
    page = await context.newPage();
    target = page.target();
    page.setDefaultTimeout(2000);
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
    await page.setCacheEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (request) => { void request.abort().catch(() => undefined); invalidate(); });
    await page.setContent(fixture(marker), { waitUntil: "domcontentloaded", timeout: 2000 });
    for (const initial of await browser.pages()) if (initial !== page) await initial.close();
    browser.on("targetcreated", (created) => { if (created !== target) invalidate(); });
    browser.on("disconnected", invalidate);
    page.on("framenavigated", invalidate);
    page.on("frameattached", invalidate);
    page.on("framedetached", () => observation.invalidate());
    page.on("popup", invalidate);
    page.on("workercreated", invalidate);
    page.on("dialog", invalidate);
    page.on("error", invalidate);
    page.on("close", () => { if (!stopped) invalidate(); });
    ready = true;
    await assertTarget();
    const ownedPage = page;
    return {
      frame: async () => {
        const captured = await run(async () => {
          const ticket = observation.begin();
          const screenshot = await ownedPage.screenshot({ type: "png", fullPage: false });
          try {
            const bytes = Buffer.from(screenshot.buffer, screenshot.byteOffset, screenshot.byteLength);
            if (bytes.length < 24 || bytes.length > 1_125_000
              || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
              || bytes.readUInt32BE(16) !== 800 || bytes.readUInt32BE(20) !== 600) throw new FixtureBrowserError();
            const png = bytes.toString("base64");
            if (png.length > 1_500_000) throw new FixtureBrowserError();
            return { ticket, frame: { png, width: 800 as const, height: 600 as const } };
          } finally { screenshot.fill(0); }
        });
        const frameRef = observation.issue(captured.ticket);
        if (frameRef === null) throw new StaleFrameError();
        return { ...captured.frame, frameRef };
      },
      verify: () => { observation.invalidate(); return run(() => ownedPage.evaluate(() => Boolean(document.querySelector("output")?.textContent?.trim()))); },
      input: async (event, frameRef, claimInput) => {
        const result = await run(async () => {
          const input = fixtureInputSchema.parse(event);
          claimInput();
          if (!observation.consume(frameRef)) return staleInput;
          if (input.type === "click") await ownedPage.mouse.click(input.x, input.y);
          else if (input.type === "text") await ownedPage.keyboard.sendCharacter(input.text);
          else if (input.type === "key") await ownedPage.keyboard.press(input.key);
          else await ownedPage.mouse.wheel({ deltaY: input.deltaY });
        });
        if (result === staleInput) throw new StaleFrameError();
      },
      invalidateFrame: () => observation.invalidate(),
      close,
    };
  } catch {
    await close();
    throw new FixtureBrowserError(cleanupUncertain);
  }
}
