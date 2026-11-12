import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer, { ProtocolError, type Browser } from "puppeteer-core";
import { FixtureBrowserError, openFixtureBrowser } from "../fixture-browser.ts";
import type { FixtureFrame, FixtureInput } from "../fixture-wire.ts";
import { StaleFrameError } from "../frame-error.ts";
import { recoveryChromeGuard } from "./mobile-recovery-fixture.ts";

const liveHost = process.platform === "darwin" && process.arch === "arm64";
async function parentDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "fixture-browser-test-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function expectedError(error: unknown, uncertain = false): boolean {
  return error instanceof FixtureBrowserError && error.message === "fixture_unavailable"
    && error.code === "fixture_unavailable" && error.cleanupUncertain === uncertain;
}
function frameHash(frame: FixtureFrame): string {
  assert.equal(frame.width, 800);
  assert.equal(frame.height, 600);
  assert.ok(frame.png.length <= 1_500_000 && frame.png.length % 4 === 0);
  const bytes = Buffer.from(frame.png, "base64");
  assert.equal(bytes.toString("base64") === frame.png, true);
  assert.equal(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), true);
  assert.equal(bytes.readUInt32BE(16), 800);
  assert.equal(bytes.readUInt32BE(20), 600);
  return createHash("sha256").update(bytes).digest("hex");
}
async function eventually(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await condition()) return;
    await delay(25);
  }
  assert.fail("owned fixture did not reach the expected lifecycle state");
}

// Valid-input setup only; refusal tests keep their actual prior observation.
async function freshInput(driver: Awaited<ReturnType<typeof openFixtureBrowser>>, event: FixtureInput) {
  const frame = await driver.frame();
  await driver.input(event, frame.frameRef, () => {});
}

test("unsafe parent directories are rejected without repair or profile creation", async (t) => {
  const root = await parentDirectory(t);
  const unsafe = join(root, "unsafe");
  await writeFile(unsafe, "synthetic parent sentinel");
  await assert.rejects(() => openFixtureBrowser(unsafe, new AbortController().signal), expectedError);
  const alias = join(root, "alias");
  await symlink(root, alias);
  await assert.rejects(() => openFixtureBrowser(alias, new AbortController().signal), expectedError);
  await chmod(root, 0o755);
  await assert.rejects(() => openFixtureBrowser(root, new AbortController().signal), expectedError);
  assert.equal((await lstat(root)).mode & 0o777, 0o755);
  assert.equal((await readdir(root)).length, 2);
});

test("a superseded synthetic observation refuses before a real keyboard effect and fresh input remains usable", { skip: !liveHost, timeout: 20000 }, async t => {
  const guard = recoveryChromeGuard(t), root = await parentDirectory(t), launch = puppeteer.launch.bind(puppeteer);
  let owned: Browser | undefined;
  t.mock.method(puppeteer, "launch", async (options: Parameters<typeof puppeteer.launch>[0]) => {
    try { owned = await launch(options); return owned; }
    catch (error) {
      const message = error instanceof ProtocolError && error.originalMessage ? error.originalMessage : error instanceof Error ? error.message : "";
      t.diagnostic(JSON.stringify({ classification: "synthetic_launch_failure_only", protocolError: error instanceof ProtocolError,
        timeout: /timed out|timeout/i.test(message), targetClosed: /target closed|session closed/i.test(message),
        command: ["Target.setAutoAttach", "Target.getTargets", "Browser.getVersion", "Network.enable", "Page.enable", "Emulation.setDeviceMetricsOverride"]
          .find(name => message.includes(name)) ?? "other" }));
      throw error;
    }
  });
  const driver = await openFixtureBrowser(root, new AbortController().signal).catch(error => {
    t.diagnostic(JSON.stringify({ classification: "synthetic_startup_failure_only", launchReturned: Boolean(owned), browserConnected: owned?.connected ?? false,
      childExited: Boolean(owned?.process() && (owned.process()!.exitCode !== null || owned.process()!.signalCode !== null)) }));
    throw error;
  });
  try {
    const page = (await owned!.pages())[0]!;
    await page.focus("input");
    const send = page.keyboard.sendCharacter.bind(page.keyboard);
    let effects = 0, claims = 0;
    t.mock.method(page.keyboard, "sendCharacter", async (text: string) => { effects++; await send(text); });
    const a = await driver.frame(), b = await driver.frame(), claim = () => { claims++; };
    const refused = await driver.input({ type: "text", text: "old observation" }, a.frameRef, claim).then(() => false, error => error instanceof StaleFrameError);
    t.diagnostic(JSON.stringify({ classification: "actual_synthetic_frame_supersession", refused, keyboardEffects: effects, inputClaims: claims }));
    assert.equal(effects, 0); assert.equal(refused, true); assert.equal(claims, 1);
    await driver.input({ type: "text", text: "fresh observation" }, b.frameRef, claim);
    assert.equal(effects, 1); assert.equal(claims, 2);
    assert.equal(await page.$eval("input", input => input.value === "fresh observation"), true);
    await assert.rejects(driver.input({ type: "text", text: "consumed observation" }, b.frameRef, claim), error => error instanceof StaleFrameError);
    assert.equal(effects, 1); assert.equal(claims, 3);
  } finally {
    await driver.close();
    await eventually(async () => guard.counts().closed === guard.counts().total);
    guard.assertClosed(); assert.equal(await guard.profilesRemoved("all"), true);
  }
});

test("an already aborted startup creates no profile", async (t) => {
  const root = await parentDirectory(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => openFixtureBrowser(root, controller.signal), expectedError);
  assert.equal((await readdir(root)).length, 0);
});

test("a configured synthetic viewport change is refused before claiming or dispatching input", { skip: !liveHost, timeout: 20000 }, async t => {
  const guard = recoveryChromeGuard(t), root = await parentDirectory(t), launch = puppeteer.launch.bind(puppeteer);
  let owned: Browser | undefined;
  t.mock.method(puppeteer, "launch", async (options: Parameters<typeof puppeteer.launch>[0]) => { owned = await launch(options); return owned; });
  const driver = await openFixtureBrowser(root, new AbortController().signal);
  try {
    const page = (await owned!.pages())[0]!, frame = await driver.frame();
    let effects = 0, claims = 0;
    const send = page.keyboard.sendCharacter.bind(page.keyboard);
    t.mock.method(page.keyboard, "sendCharacter", async (text: string) => { effects++; await send(text); });
    await page.setViewport({ width: 801, height: 600, deviceScaleFactor: 1 });
    const refused = await driver.input({ type: "text", text: "mismatched geometry" }, frame.frameRef, () => { claims++; }).then(() => false, expectedError);
    t.diagnostic(JSON.stringify({ classification: "actual_synthetic_viewport_change", refused, keyboardEffects: effects, inputClaims: claims }));
    assert.equal(effects, 0); assert.equal(claims, 0); assert.equal(refused, true);
  } finally {
    await driver.close();
    await eventually(async () => guard.counts().closed === guard.counts().total);
    guard.assertClosed(); assert.equal(await guard.profilesRemoved("all"), true);
  }
});

test("a launch rejection preserves its private profile and reports only uncertain cleanup", { skip: !liveHost }, async (t) => {
  const root = await parentDirectory(t);
  t.mock.method(puppeteer, "launch", async () => { throw new Error("synthetic private launcher failure"); });
  await assert.rejects(() => openFixtureBrowser(root, new AbortController().signal), (error) => expectedError(error, true));
  const profiles = await readdir(root);
  assert.equal(profiles.length, 1);
  assert.equal((await lstat(join(root, profiles[0]!))).mode & 0o777, 0o700);
});

test("real Chrome uses a fresh private profile and supports bounded synthetic frame/input/close", { skip: !liveHost, timeout: 20_000 }, async (t) => {
  const root = await parentDirectory(t);
  await writeFile(join(root, "parent-sentinel"), "keep synthetic parent state");
  const driver = await openFixtureBrowser(root, new AbortController().signal);
  t.after(() => driver.close());
  const profiles = (await readdir(root)).filter((name) => name !== "parent-sentinel");
  assert.equal(profiles.length, 1);
  const profile = await lstat(join(root, profiles[0]!));
  assert.equal(profile.uid, process.getuid?.());
  assert.equal(profile.mode & 0o777, 0o700);
  const first = await driver.frame(), before = frameHash(first);
  await freshInput(driver, { type: "click", x: 80, y: 60 });
  await freshInput(driver, { type: "text", text: "synthetic-你好" });
  await freshInput(driver, { type: "key", key: "Backspace" });
  await freshInput(driver, { type: "click", x: 80, y: 130 });
  const after = frameHash(await driver.frame());
  assert.notEqual(after, before);
  await freshInput(driver, { type: "wheel", deltaY: 420 });
  await delay(150);
  assert.notEqual(frameHash(await driver.frame()), after);
  await Promise.all([driver.close(), driver.close()]);
  assert.deepEqual(await readdir(root), ["parent-sentinel"]);
  assert.equal(await readFile(join(root, "parent-sentinel"), "utf8"), "keep synthetic parent state");
  await assert.rejects(() => driver.frame(), expectedError);
  await assert.rejects(() => driver.verify(), expectedError);
  await assert.rejects(() => driver.input({ type: "text", text: "synthetic" }, first.frameRef, () => {}), expectedError);
});

test("verification requires the fixed button to commit nonempty synthetic text", { skip: !liveHost, timeout: 20_000 }, async (t) => {
  const root = await parentDirectory(t);
  const driver = await openFixtureBrowser(root, new AbortController().signal);
  try {
    assert.equal(await driver.verify(), false);
    await freshInput(driver, { type: "click", x: 80, y: 130 });
    assert.equal(await driver.verify(), false);
    await freshInput(driver, { type: "click", x: 80, y: 60 });
    await freshInput(driver, { type: "text", text: "   " });
    await freshInput(driver, { type: "click", x: 80, y: 130 });
    assert.equal(await driver.verify(), false);
    await freshInput(driver, { type: "click", x: 80, y: 60 });
    await freshInput(driver, { type: "text", text: "synthetic verifier 你好" });
    assert.equal(await driver.verify(), false);
    await freshInput(driver, { type: "click", x: 80, y: 130 });
    assert.equal(await driver.verify(), true);
  } finally { await driver.close(); }
});

test("startup abort closes a known owned process before removing its profile", { skip: !liveHost, timeout: 20_000 }, async (t) => {
  const root = await parentDirectory(t);
  const controller = new AbortController();
  const originalLaunch = puppeteer.launch.bind(puppeteer);
  let notify!: (browser: Browser) => void;
  const launched = new Promise<Browser>((resolve) => { notify = resolve; });
  let release!: () => void;
  const heldLaunch = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(puppeteer, "launch", async (options: Parameters<typeof puppeteer.launch>[0]) => {
    const browser = await originalLaunch(options);
    notify(browser);
    await heldLaunch;
    return browser;
  });
  const opening = openFixtureBrowser(root, controller.signal);
  const rejection = assert.rejects(opening, expectedError);
  const owned = await launched;
  const child = owned.process();
  assert.ok(child);
  controller.abort();
  release();
  await rejection;
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal((await readdir(root)).length, 0);
});

test("abort rejects an in-flight frame and cleans the owned profile", { skip: !liveHost, timeout: 20_000 }, async (t) => {
  const root = await parentDirectory(t);
  const controller = new AbortController();
  const driver = await openFixtureBrowser(root, controller.signal);
  t.after(() => driver.close());
  const frame = driver.frame();
  controller.abort();
  await assert.rejects(frame, expectedError);
  await driver.close();
  assert.equal((await readdir(root)).length, 0);
});

test("invalid input fails closed without printing its submitted value", { skip: !liveHost, timeout: 20_000 }, async (t) => {
  const root = await parentDirectory(t);
  const driver = await openFixtureBrowser(root, new AbortController().signal);
  t.after(() => driver.close());
  const frame = await driver.frame();
  await assert.rejects(() => driver.input({ type: "click", x: 800, y: 60 }, frame.frameRef, () => {}), expectedError);
  await assert.rejects(() => driver.frame(), expectedError);
  assert.equal((await readdir(root)).length, 0);
});

test("an unexpected extra target invalidates the real private browser", { skip: !liveHost, timeout: 20_000 }, async (t) => {
  const root = await parentDirectory(t);
  const originalLaunch = puppeteer.launch.bind(puppeteer);
  let owned: Browser | undefined;
  t.mock.method(puppeteer, "launch", async (options: Parameters<typeof puppeteer.launch>[0]) => { owned = await originalLaunch(options); return owned; });
  const driver = await openFixtureBrowser(root, new AbortController().signal);
  t.after(() => driver.close());
  const captured = owned as Browser | undefined;
  assert.ok(captured);
  const child = captured.process();
  assert.ok(child);
  void captured.newPage().catch(() => undefined);
  await eventually(async () => child.exitCode !== null || child.signalCode !== null);
  await assert.rejects(() => driver.frame(), expectedError);
  await driver.close();
  assert.equal((await readdir(root)).length, 0);
});


test("host fixture opens a visible private browser and refuses remote frame and input", { skip: !liveHost, timeout: 20000 }, async t => {
  recoveryChromeGuard(t);
  const root = await parentDirectory(t), launch = puppeteer.launch.bind(puppeteer);
  let owned: Browser | undefined, headless: unknown;
  t.mock.method(puppeteer, "launch", async (options: Parameters<typeof puppeteer.launch>[0]) => {
    headless = options?.headless; owned = await launch(options); return owned;
  });
  const driver = await Reflect.apply(openFixtureBrowser, undefined, [root, new AbortController().signal, "host"]);
  try {
    assert.equal(headless, false, "Explicit host mode must create a visible owned browser.");
    let claims = 0;
    await assert.rejects(driver.frame(), FixtureBrowserError);
    await assert.rejects(driver.input({ type: "text", text: "remote effect" }, "00000000-0000-4000-8000-000000000000", () => { claims++; }), FixtureBrowserError);
    assert.equal(claims, 0);
    const page = (await owned!.pages())[0]!;
    await page.focus("input"); await page.keyboard.type("local fixture");
    assert.equal(await driver.verify(), false, "A text draft alone cannot complete the local fixture.");
    await page.click("button");
    assert.equal(await driver.verify(), true);
    const before = await page.$eval("input", input => input.value);
    await page.focus("input"); await page.keyboard.type("after handback");
    assert.equal(await page.$eval("input", input => input.value), before, "Completed host fixture must keep renderer input fenced until close.");
  } finally { await driver.close(); }
});


test("unknown fixture presentation modes refuse before browser launch", async t => {
  const root = await parentDirectory(t); let launches = 0;
  t.mock.method(puppeteer, "launch", async () => { launches++; throw new Error("unexpected launch"); });
  await assert.rejects(Reflect.apply(openFixtureBrowser, undefined, [root, new AbortController().signal, "unknown"]), error => expectedError(error));
  assert.equal(launches, 0); assert.deepEqual(await readdir(root), []);
});
