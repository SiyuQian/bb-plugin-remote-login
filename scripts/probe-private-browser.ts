import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const vectors = ["goto", "navigation", "subresource", "fetch", "iframe", "popup", "worker"] as const;
type Vector = typeof vectors[number];
type ActionAcknowledgement = "vector_initiated" | "worker_security_denied";
type VectorOutcome = ActionAcknowledgement | "goto_loaded" | "goto_denied_by_allowlist";
type Cleanup = { mode: string; pipe: boolean; privateProfile: boolean; noTcpListeners: boolean; processExited: boolean; profileRemoved: boolean; gracefulClose: boolean };
class ProbeFailure extends Error {}
let phase = "self_check";
const cleanup: Cleanup[] = [];
const createdProfiles = new Set<string>();
const report: Record<string, unknown> = { probe: "RL01_local_fixture", scope: "no_credentials_no_external_services", networkSandbox: false, cleanup };
const runFile = promisify(execFile);
const deadline = AbortSignal.timeout(60_000);

function check(value: unknown, code: string): asserts value {
  if (!value) throw new ProbeFailure(code);
}

function assertLaunchArguments(args: readonly string[], profile: string): void {
  check(args[0] === chromePath, "unexpected_executable");
  check(args.includes("--remote-debugging-pipe"), "missing_pipe");
  check(!args.some((arg) => arg.startsWith("--remote-debugging-port")), "tcp_debugging_argument");
  check(!args.includes("--no-sandbox") && !args.includes("--disable-setuid-sandbox"), "sandbox_disabled");
  check(args.filter((arg) => arg.startsWith("--user-data-dir=")).length === 1
    && args.includes(`--user-data-dir=${profile}`), "unexpected_profile");
}

async function acknowledgeVector(action: () => Promise<unknown>): Promise<ActionAcknowledgement> {
  const acknowledgement = await action();
  check(acknowledgement === "vector_initiated" || acknowledgement === "worker_security_denied", "missing_vector_acknowledgement");
  return acknowledgement;
}

async function selfCheck(): Promise<void> {
  const profile = "/private/tmp/owned-fixture-profile";
  const args = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--remote-debugging-pipe", `--user-data-dir=${profile}`];
  assert.doesNotThrow(() => assertLaunchArguments(args, profile));
  for (const unsafe of ["--remote-debugging-port=0", "--no-sandbox", "--disable-setuid-sandbox"]) {
    assert.throws(() => assertLaunchArguments([...args, unsafe], profile));
  }
  assert.throws(() => assertLaunchArguments(args.filter((arg) => arg !== "--remote-debugging-pipe"), profile));
  assert.throws(() => assertLaunchArguments(args, "/private/tmp/another-profile"));
  const injected = new Error("injected_evaluate_rejection_before_action");
  await assert.rejects(() => acknowledgeVector(async () => { throw injected; }), (error) => error === injected);
  await assert.rejects(() => acknowledgeVector(async () => undefined), { message: "missing_vector_acknowledgement" });
  assert.equal(await acknowledgeVector(async () => "vector_initiated"), "vector_initiated");
}

async function assertNoTcpListeners(pid: number): Promise<void> {
  try {
    const { stdout } = await runFile("/usr/sbin/lsof", ["-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { timeout: 3000 });
    check(!stdout.split("\n").some((line) => line.startsWith("n")), "owned_process_tcp_listener");
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    if (result.code === 1 && result.stdout === "" && result.stderr === "") return;
    throw error;
  }
}

async function withBrowser<T>(mode: "baseline" | "restricted" | "cleanup_failure", operation: (browser: Browser) => Promise<T>): Promise<T> {
  phase = `${mode}_launch`;
  const profile = await mkdtemp(join(await realpath(tmpdir()), "bb-remote-login-fixture-"));
  await chmod(profile, 0o700);
  const identity = await lstat(profile);
  check(identity.isDirectory() && identity.uid === process.getuid?.() && (identity.mode & 0o777) === 0o700, "unsafe_owned_profile");
  check(!createdProfiles.has(profile), "profile_reused");
  createdProfiles.add(profile);
  const receipt: Cleanup = { mode, pipe: false, privateProfile: true, noTcpListeners: false, processExited: false, profileRemoved: false, gracefulClose: false };
  cleanup.push(receipt);
  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({
      browser: "chrome", executablePath: chromePath, userDataDir: profile,
      headless: true, pipe: true, dumpio: false, timeout: 10_000, protocolTimeout: 4000,
      signal: deadline,
      ...(mode === "baseline" ? {} : { allowlist: ["about\\:blank"] }),
    });
    const child = browser.process();
    check(child?.pid, "missing_owned_process");
    assertLaunchArguments(child.spawnargs, profile);
    receipt.pipe = true;
    await assertNoTcpListeners(child.pid);
    receipt.noTcpListeners = true;
    return await operation(browser);
  } finally {
    const child = browser?.process();
    if (browser && child) {
      receipt.gracefulClose = await Promise.race([
        browser.close().then(() => true, () => false), delay(4000).then(() => false),
      ]);
      if (!receipt.gracefulClose && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      for (let count = 0; count < 30 && child.exitCode === null && child.signalCode === null; count++) await delay(50);
      receipt.processExited = child.exitCode !== null || child.signalCode !== null;
      check(receipt.processExited, "owned_browser_still_running");
    }
    const current = await lstat(profile);
    check(current.isDirectory() && current.dev === identity.dev && current.ino === identity.ino
      && current.uid === identity.uid && await realpath(profile) === profile, "profile_replaced_before_cleanup");
    await rm(profile, { recursive: true, force: false });
    receipt.profileRemoved = await access(profile).then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    check(receipt.profileRemoved, "profile_cleanup_failed");
    if (browser) check(receipt.processExited && receipt.gracefulClose, "browser_cleanup_failed");
  }
}

async function exerciseVector(browser: Browser, vector: Vector, url: string, mode: "baseline" | "restricted"): Promise<VectorOutcome> {
  const context = await browser.createBrowserContext({ downloadBehavior: { policy: "deny" } });
  const page = await context.newPage();
  page.setDefaultTimeout(2000);
  try {
    await page.setContent("<!doctype html><title>Synthetic network probe</title><body>Local canary only</body>");
    let outcome: VectorOutcome;
    if (vector === "goto") {
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 1800 });
        check(mode === "baseline" && response?.status() === 200 && page.url() === url, "unexpected_navigation_success");
        outcome = "goto_loaded";
      } catch (error) {
        if (mode === "baseline") throw error;
        check(error instanceof Error && error.name === "Error"
          && error.message === `Navigation to ${url} is blocked by blocklist/allowlist rules`, "unexpected_navigation_failure");
        outcome = "goto_denied_by_allowlist";
      }
    } else {
      outcome = await acknowledgeVector(() => page.evaluate(async ({ vector, url }) => {
        if (vector === "navigation") {
          location.assign(url);
        } else if (vector === "subresource") {
          const image = document.createElement("img"); image.src = url; document.body.append(image);
        } else if (vector === "fetch") {
          void fetch(url, { mode: "no-cors", cache: "no-store" }).catch(() => undefined);
        } else if (vector === "iframe") {
          const frame = document.createElement("iframe"); frame.src = url; document.body.append(frame);
        } else if (vector === "popup") {
          if (!window.open(url, "_blank")) throw new Error("popup_not_created");
        } else {
          const source = `const request=fetch(${JSON.stringify(url)}, {mode:"no-cors",cache:"no-store"});postMessage("worker_fetch_initiated");request.then(()=>postMessage("worker_fetch_settled"),()=>postMessage("worker_fetch_settled"))`;
          const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
          let worker: Worker;
          try {
            worker = new Worker(blobUrl);
          } catch (error) {
            URL.revokeObjectURL(blobUrl);
            if (error instanceof DOMException && error.name === "SecurityError") return "worker_security_denied";
            throw error;
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          let initiated = false;
          try {
            await new Promise<void>((resolve, reject) => {
              worker.onmessage = (event) => {
                if (event.data === "worker_fetch_initiated" && !initiated) initiated = true;
                else if (event.data === "worker_fetch_settled" && initiated) resolve();
                else reject(new Error("unexpected_worker_acknowledgement"));
              };
              worker.onerror = () => reject(new Error("worker_script_failed"));
              timer = setTimeout(() => reject(new Error("missing_worker_acknowledgement")), 1200);
            });
          } finally {
            clearTimeout(timer);
            worker.terminate();
            URL.revokeObjectURL(blobUrl);
          }
        }
        return "vector_initiated";
      }, { vector, url }));
      check(mode === "restricted" || outcome === "vector_initiated", "baseline_worker_constructor_denied");
    }
    await delay(700);
    return outcome;
  } finally {
    await context.close();
  }
}

function fixture(marker: string): string {
  return `<!doctype html><html data-probe="${marker}"><head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${marker}'; style-src 'nonce-${marker}'; connect-src 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'">
    <title>Synthetic control fixture</title><style nonce="${marker}">
    body{height:1800px;margin:0;background:#fafafa;font:16px sans-serif}input{position:absolute;left:40px;top:40px;width:300px;height:40px}
    button{position:absolute;left:40px;top:110px;width:200px;height:40px}output{position:absolute;left:40px;top:180px}
    </style></head><body><input id="synthetic" aria-label="Synthetic text" autocomplete="off"><button type="button">Apply synthetic text</button><output data-count="0"></output>
    <script nonce="${marker}">document.querySelector('button').addEventListener('click',()=>{const out=document.querySelector('output');out.textContent=document.querySelector('input').value;out.dataset.count=String(Number(out.dataset.count)+1)})</script></body></html>`;
}

async function exerciseFixture(browser: Browser): Promise<Record<string, unknown>> {
  phase = "restricted_fixture";
  const context = await browser.createBrowserContext({ downloadBehavior: { policy: "deny" } });
  const page = await context.newPage();
  const target = page.target();
  const marker = randomUUID();
  let unexpectedTarget = false;
  let unexpectedNavigation = false;
  let interceptedRequests = 0;
  const onTarget = (created: ReturnType<Page["target"]>) => { if (created !== target && created.browserContext() === context) unexpectedTarget = true; };
  browser.on("targetcreated", onTarget);
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame() && frame.url() !== "about:blank") unexpectedNavigation = true; });
  page.on("popup", () => { unexpectedTarget = true; });
  try {
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
    await page.setCacheEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (request) => { interceptedRequests++; void request.abort().catch(() => undefined); });
    await page.setContent(fixture(marker), { waitUntil: "domcontentloaded" });
    const assertTarget = async () => {
      check(page.browser() === browser && page.browserContext() === context && page.target() === target
        && !page.isClosed() && page.url() === "about:blank" && !unexpectedTarget && !unexpectedNavigation
        && page.frames().length === 1, "fixture_target_changed");
      check(await page.evaluate((expected) => document.documentElement.dataset.probe === expected, marker), "fixture_document_changed");
    };
    await assertTarget();
    await page.mouse.click(80, 60);
    await page.keyboard.sendCharacter("fixture-你好");
    await page.keyboard.press("Backspace");
    await page.mouse.click(80, 130);
    const applied = await page.evaluate(() => ({ value: document.querySelector("output")?.textContent, count: document.querySelector("output")?.dataset.count }));
    check(applied.value === "fixture-你" && applied.count === "1", "fixture_input_or_click_failed");
    await page.mouse.wheel({ deltaY: 420 });
    await delay(200);
    check(await page.evaluate(() => window.scrollY) > 0, "fixture_scroll_failed");
    await assertTarget();
    const screenshot = await page.screenshot({ type: "png", fullPage: false });
    try {
      const bytes = Buffer.from(screenshot.buffer, screenshot.byteOffset, screenshot.byteLength);
      check(bytes.length > 100 && bytes.length < 1_000_000
        && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        && bytes.readUInt32BE(16) === 800 && bytes.readUInt32BE(20) === 600, "fixture_screenshot_failed");
      await assertTarget();
      check(interceptedRequests === 0, "fixture_attempted_network");
      return { inputAndClick: true, scrolled: true, targetValidated: true, screenshot: { format: "png", width: 800, height: 600, bytes: bytes.length, stored: false }, interceptedRequests };
    } finally {
      screenshot.fill(0);
    }
  } finally {
    browser.off("targetcreated", onTarget);
    await context.close();
  }
}

async function main(): Promise<void> {
  await selfCheck();
  check(process.platform === "darwin" && process.arch === "arm64", "unsupported_probe_host");
  const require = createRequire(import.meta.url);
  const packageInfo = JSON.parse(await readFile(require.resolve("puppeteer-core/package.json"), "utf8")) as { version: string };
  const { stdout: chromeVersion } = await runFile("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", "/Applications/Google Chrome.app/Contents/Info.plist"], { timeout: 2000 });
  report.versions = { node: process.version, platform: process.platform, architecture: process.arch, puppeteerCore: packageInfo.version, chrome: chromeVersion.trim() };
  const attempts = { baseline: Object.fromEntries(vectors.map((vector) => [vector, 0])) as Record<Vector, number>, restricted: Object.fromEntries(vectors.map((vector) => [vector, 0])) as Record<Vector, number> };
  report.canaryRequests = attempts;
  const outcomes: { baseline: Partial<Record<Vector, VectorOutcome>>; restricted: Partial<Record<Vector, VectorOutcome>> } = { baseline: {}, restricted: {} };
  report.vectorOutcomes = outcomes;
  const nonce = randomUUID();
  const server = createServer((request, response) => {
    const match = new RegExp(`^/${nonce}/(baseline|restricted)/(${vectors.join("|")})$`).exec(request.url ?? "");
    if (!match) { response.writeHead(404).end(); return; }
    attempts[match[1] as "baseline" | "restricted"][match[2] as Vector]++;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    response.end("<!doctype html><title>Local synthetic canary</title><body>fixture only</body>");
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  check(address && typeof address !== "string", "canary_not_loopback");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await withBrowser("baseline", async (browser) => {
      for (const vector of vectors) { phase = `baseline_${vector}`; outcomes.baseline[vector] = await exerciseVector(browser, vector, `${origin}/${nonce}/baseline/${vector}`, "baseline"); }
      check(vectors.every((vector) => attempts.baseline[vector] > 0), "canary_baseline_not_observable");
    });
    await withBrowser("restricted", async (browser) => {
      for (const vector of vectors) { phase = `restricted_${vector}`; outcomes.restricted[vector] = await exerciseVector(browser, vector, `${origin}/${nonce}/restricted/${vector}`, "restricted"); }
      check(vectors.every((vector) => attempts.restricted[vector] === 0), "restriction_canary_observed");
      report.fixture = await exerciseFixture(browser);
    });
    let failureObserved = false;
    try {
      await withBrowser("cleanup_failure", async () => { phase = "injected_failure"; throw new ProbeFailure("expected_injected_failure"); });
    } catch (error) {
      check(error instanceof ProbeFailure && error.message === "expected_injected_failure", "failure_cleanup_not_verified");
      failureObserved = true;
    }
    check(failureObserved && cleanup.length === 3 && cleanup.every((item) => item.processExited && item.profileRemoved && item.gracefulClose), "incomplete_cleanup_evidence");
    report.injectedFailureCleanup = true;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  check(vectors.every((vector) => attempts.restricted[vector] === 0), "late_restriction_canary_observed");
}

try {
  check(process.argv.length === 3 && ["--self-check", "--run"].includes(process.argv[2]!), "use_self_check_or_run");
  if (process.argv[2] === "--self-check") {
    await selfCheck();
    process.stdout.write('{"selfCheck":true}\n');
  } else {
    await main();
    process.stdout.write(`${JSON.stringify({ ...report, ok: true })}\n`);
  }
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ...report, ok: false, failure: { phase, reason: error instanceof ProbeFailure ? error.message : "probe_operation_failed", kind: error instanceof Error ? error.name : "Error" } })}\n`);
  process.exitCode = 1;
}
