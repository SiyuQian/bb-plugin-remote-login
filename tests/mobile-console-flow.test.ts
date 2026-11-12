import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startMobileBrowserFixture } from "./mobile-browser-fixture.ts";
import { assertMobileLayout, checkPairingPage, completeSyntheticCard, fillField, mobileBackend, tapButton, tapFrame, waitText } from "./mobile-flow-actions.ts";
import { context, deferred, eventually, expectedConsole, fixtureKey, nativeValue, ownedConsoleFlow, supportedConsoleFixture } from "./owned-console-flow-fixture.ts";

const options = { skip: !supportedConsoleFixture, timeout: 90000, concurrency: false };
type Flow = Awaited<ReturnType<typeof ownedConsoleFlow>>;
type Mobile = Awaited<ReturnType<typeof startMobileBrowserFixture>>;
type Bridge = ReturnType<typeof mobileBackend>;

async function openConsole(s: Flow, mobile: Mobile, bridge: Bridge) {
  const attempt = await s.createConsoleAttempt(), waiting = await s.startNativeWait(attempt.attemptId);
  await mobile.show("login-control", bridge.interaction(waiting));
  await fillField(mobile.page, "控制密钥", fixtureKey); await tapButton(mobile.page, "验证 OCI 控制密钥");
  for (const [label, value] of [["目标 Tenancy OCID", expectedConsole.tenancyOcid], ["目标 User OCID", expectedConsole.userOcid],
    ["目标 Domain OCID", expectedConsole.domainOcid], ["目标 Domain Origin", expectedConsole.domainOrigin]]) {
    await fillField(mobile.page, label!, value!);
    assert.equal(await mobile.page.evaluate((name, expected) => {
      const input = [...document.querySelectorAll("label")].find(node => node.textContent?.trim() === name)?.querySelector("input");
      return input instanceof HTMLInputElement && document.activeElement === input && input.value === expected;
    }, label!, value!), true, `Keyboard input must reach the focused ${label} field`);
  }
  await tapButton(mobile.page, "确认私有 OCI Console 目标"); await tapButton(mobile.page, "开始 OCI Console 登录");
  await mobile.page.waitForSelector('img[alt="OCI 私有登录画面"][aria-disabled="false"]');
  assert.equal((await waiting.status()).phase, "user_control");
  assert.equal(s.browsers.length, 1); assert.equal(s.retained(), 1);
  return waiting;
}

async function confirmCleanup(s: Flow, attemptId: string) {
  const service = s.harness.behavior.runService("login-coordinator");
  try {
    const cancelled = nativeValue(await s.harness.behavior.callAgentTool("remote_login_cancel", { attemptId }, context));
    assert.equal(cancelled.phase, "cancelled");
    await eventually(() => s.retained() === 0 && !s.browsers[0]!.connected);
    assert.equal((await readdir(s.dataDir)).some(name => name.startsWith("oci-browser-")), false);
    await eventually(() => (s.bb.storage.database().prepare("SELECT status FROM remote_login_cleanup_v1 WHERE attempt_id=?")
      .get(attemptId) as { status: string } | undefined)?.status === "acknowledged");
  } finally { service.controller.abort(); await service.done; }
}

async function assertPrivacy(s: Flow, mobile: Mobile, results: unknown[], frame: string, input: string, browserRef?: string, frameRefs: string[] = []) {
  const privateValues = [fixtureKey, ...s.capabilities, expectedConsole.userOcid, expectedConsole.tenancyOcid, expectedConsole.domainOcid,
    expectedConsole.domainOrigin, s.root, frame, input, ...frameRefs];
  const publicState = JSON.stringify([s.bb.storage.database().prepare("SELECT record FROM remote_login_attempts_v1").all(),
    await s.bb.storage.kv.list(), s.harness.inspection.pendingInteractions, s.harness.logEntries, s.harness.inspection.realtimeSignals]);
  const nativeResults = JSON.stringify(results);
  for (const value of privateValues) {
    assert.equal(publicState.includes(value), false, "Private fixture material must stay out of public and durable state");
    assert.equal(nativeResults.includes(value), false, "Native results must contain only the bounded task projection");
  }
  if (browserRef) assert.equal(publicState.includes(browserRef), false);
  const storage = await mobile.page.evaluate(() => JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));
  for (const value of [...privateValues, ...(browserRef ? [browserRef] : [])]) assert.equal(storage.includes(value), false, "Private control and browser references must stay out of frontend storage");
}

test("a real stale Console input preserves the original mobile wait and requires a fresh displayed observation before re-operation", options, async t => {
  const s = await ownedConsoleFlow(t); await s.pair();
  const bridge = mobileBackend(s.harness.behavior), fetchHttp = s.harness.behavior.fetchHttp.bind(s.harness.behavior);
  const sent: Array<{ frameRef: string; inputId: string; type: string }> = [], frameRefs: string[] = [], replies: number[] = [];
  let capture = false, reloadNext = false, selected = false, reloaded = false;
  t.mock.method(s.harness.behavior, "fetchHttp", (...args: Parameters<typeof fetchHttp>) => {
    if (capture && args[1] === "/login/input") {
      let body: { frameRef?: unknown; inputId?: unknown; event?: { type?: unknown } };
      try { body = JSON.parse(String(args[2]?.body)); } catch { throw new Error("Private input fixture body is invalid."); }
      assert.equal(typeof body.frameRef, "string"); assert.equal(typeof body.inputId, "string");
      assert.equal(typeof body.event?.type, "string");
      sent.push({ frameRef: body.frameRef as string, inputId: body.inputId as string, type: body.event!.type as string });
      if (reloadNext && body.event?.type === "text") { reloadNext = false; selected = true; }
    }
    return fetchHttp(...args);
  });
  const mobile = await startMobileBrowserFixture(t, { context, rpc: bridge.rpc, http: bridge.http,
    async beforeSend(request, response) {
      const path = new URL(request.url).pathname;
      if (capture && path.endsWith("/login/input")) replies.push(response.status);
      if (path.endsWith("/login/frame") && response.status === 200) {
        const frame = await response.clone().json().catch(() => { throw new Error("Private frame fixture response is invalid."); }) as { frameRef?: unknown };
        assert.equal(typeof frame.frameRef, "string"); frameRefs.push(frame.frameRef as string);
      }
    },
  });
  const waiting = await openConsole(s, mobile, bridge), page = s.pages[0]!, browser = s.browsers[0]!;
  const target = page.target(), browserContext = page.browserContext(), child = browser.process();
  assert.ok(child); let hostClosed = child.exitCode !== null || child.signalCode !== null;
  child.once("close", () => { hostClosed = true; });
  let keyboardEffects = 0;
  const send = page.keyboard.sendCharacter.bind(page.keyboard);
  t.mock.method(page.keyboard, "sendCharacter", async (value: string) => { keyboardEffects++; await send(value); });
  const draft = "旧画面拒绝后由用户重新发送";
  try {
    await tapFrame(mobile.page, "OCI 私有登录画面", 80, 60);
    await fillField(mobile.page, "OCI 登录文字（仅发送到私有浏览器）", draft);
    const privateFrame = await mobile.page.$eval('img[alt="OCI 私有登录画面"]', image => image.src.slice("data:image/png;base64,".length));
    const before = await waiting.status();
    capture = true; reloadNext = true;
    s.state.afterHostCall = async (method, response) => {
      if (method !== "authorizeControl" || !selected || reloaded) return;
      assert.equal((response as { ok?: boolean }).ok, true);
      reloaded = true;
      await page.reload({ waitUntil: "domcontentloaded", timeout: 6000 });
    };
    await tapButton(mobile.page, "发送到 OCI 私有浏览器");
    await waitText(mobile.page, "本次输入未发送");
    assert.equal(reloaded, true); assert.deepEqual(replies, [409]);
    assert.equal(keyboardEffects, 0); assert.equal(sent.length, 1); assert.equal(sent[0]!.type, "text");
    assert.equal(page.target() === target && page.browserContext() === browserContext, true);
    assert.equal(bridge.calls.get("/login/start"), 1); assert.equal(bridge.calls.get("/login/session"), 1);
    assert.equal(bridge.calls.get("/login/close") ?? 0, 0); assert.equal(bridge.submissions.get(waiting.attemptId) ?? 0, 0);
    assert.equal(waiting.settled(), false); assert.equal(s.retained(), 1);
    const current = await waiting.status();
    assert.equal(current.phase, "user_control"); assert.equal(current.verification, null); assert.equal(current.resume.state, "none");
    assert.equal(current.attemptId === before.attemptId && current.generation === before.generation && current.expiresAt === before.expiresAt, true);
    assert.equal(await mobile.page.evaluate(value => [...document.querySelectorAll("label")]
      .find(label => label.textContent?.trim() === "OCI 登录文字（仅发送到私有浏览器）")?.querySelector("input")?.value === value, draft), true);
    await mobile.page.waitForSelector('img[alt="OCI 私有登录画面"][aria-disabled="false"]');
    assert.equal(keyboardEffects, 0, "Read-only refresh must never replay the rejected text.");
    await tapFrame(mobile.page, "OCI 私有登录画面", 80, 60);
    await tapButton(mobile.page, "发送到 OCI 私有浏览器");
    const applied = await page.waitForFunction(value => document.querySelector("input")?.value === value, { timeout: 8000 }, draft);
    await applied.dispose();
    await eventually(() => replies.length >= 3);
    assert.equal(keyboardEffects, 1); assert.deepEqual(replies, [409, 200, 200]);
    assert.equal(sent.length, 3); assert.equal(new Set(sent.map(input => input.inputId)).size, 3);
    assert.equal(sent.slice(1).every(input => input.frameRef !== sent[0]!.frameRef), true);
    await tapButton(mobile.page, "交还并授权只读"); await waitText(mobile.page, "登录结果已核验");
    const completed = nativeValue(await waiting.result);
    assert.equal(completed.phase, "verified"); assert.equal(completed.mode, "oci_web"); assert.equal(completed.resume, "uncertain");
    assert.equal(bridge.submissions.get(waiting.attemptId), 1);
    const read = nativeValue(await s.harness.behavior.callAgentTool("remote_login_console_read", {
      attemptId: waiting.attemptId, browserRef: completed.browserRef, request: { operation: "read_identity" },
    }, context));
    assert.equal(read.matched, true); assert.equal(read.operation, "read_identity");
    assert.equal(page.target() === target && page.browserContext() === browserContext, true);
    assert.equal(s.harness.inspection.sdk.calls.some(call => call.path === "threads.send"), false);
    await assertPrivacy(s, mobile, [completed, read], privateFrame, draft, completed.browserRef as string,
      [...frameRefs, ...sent.map(input => input.frameRef)]);
    await assertMobileLayout(mobile.page); assert.equal((await mobile.metrics()).errors, 0);
    await confirmCleanup(s, waiting.attemptId);
    await eventually(() => hostClosed); assert.equal(browser.connected, false);
    await mobile.close(); assert.equal(mobile.browser.connected, false);
    t.diagnostic(JSON.stringify({ classification: "actual_390px_console_stale_input_before_effect",
      staleStatus: 409, rejectedKeyboardEffects: 0, explicitFreshKeyboardEffects: 1, inputReplies: replies,
      uniqueInputIds: 3, freshReferences: true, originalWaitPreserved: true, nativeSubmissions: 1,
      resume: "uncertain", sameOwnedContext: true, exactCleanupAcknowledged: true, hostClosed: true,
      privateValuesAbsent: true, actualPhoneOrOracleAcceptance: false }));
  } finally { s.state.afterHostCall = undefined; await mobile.close(); }
});

// Real frontend, HTTP, private classes and Chrome are joined. Oracle/source acceptance and mobile SDK transport remain fixtures.
test("390px Console UI pairs, preserves focused Chinese input, rejoins verification and resumes the original same-context reads", options, async t => {
  const s = await ownedConsoleFlow(t), bridge = mobileBackend(s.harness.behavior);
  const mobile = await startMobileBrowserFixture(t, { context, rpc: bridge.rpc, http: bridge.http });
  await mobile.show("pairing"); await checkPairingPage(mobile.page, fixtureKey);
  assert.equal(s.retained(), 0, "pairing diagnostics must not start a browser");
  assert.equal(bridge.calls.get("/fixture/start") ?? 0, 0);
  await assertMobileLayout(mobile.page);

  const pairing = await s.createPairingAttempt(), pairedWait = await s.startNativeWait(pairing.attemptId);
  await mobile.show("login-control", bridge.interaction(pairedWait));
  await completeSyntheticCard(mobile.page, fixtureKey);
  const paired = nativeValue(await pairedWait.result);
  assert.equal(paired.mode, "synthetic"); assert.equal(paired.phase, "verified"); assert.equal(paired.resume, "uncertain");
  assert.equal(bridge.submissions.get(pairing.attemptId), 1); assert.equal(s.retained(), 0);

  const waiting = await openConsole(s, mobile, bridge), page = s.pages[0]!, browserContext = page.browserContext(), target = page.target();
  const privateFrame = await mobile.page.$eval('img[alt="OCI 私有登录画面"]', image => image.src.slice("data:image/png;base64,".length));
  await assertMobileLayout(mobile.page);
  await tapFrame(mobile.page, "OCI 私有登录画面", 80, 60);
  const draft = "手机中文草稿保持焦点";
  const frameCalls = bridge.calls.get("/login/frame") ?? 0;
  await fillField(mobile.page, "OCI 登录文字（仅发送到私有浏览器）", draft);
  await eventually(() => (bridge.calls.get("/login/frame") ?? 0) > frameCalls);
  const focused = () => mobile.page.evaluate(value => {
    const input = [...document.querySelectorAll("label")].find(label => label.textContent?.trim() === "OCI 登录文字（仅发送到私有浏览器）")?.querySelector("input");
    return input instanceof HTMLInputElement && document.activeElement === input && input.value === value;
  }, draft);
  assert.equal(await focused(), true, "read-only polling must preserve the phone draft and focus");
  await mobile.page.setViewport({ width: 844, height: 390, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  assert.ok((await mobile.metrics()).page.scrollWidth <= 845, "rotated layout must remain inside its viewport");
  await mobile.page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await assertMobileLayout(mobile.page); assert.equal(await focused(), true);
  await tapButton(mobile.page, "发送到 OCI 私有浏览器");
  // Touch dispatch can finish before the protected host input executes.
  const applied = await page.waitForFunction(value => document.querySelector("input")?.value === value, { timeout: 8000 }, draft);
  await applied.dispose();

  const entered = deferred(), held = deferred();
  s.state.beforeRead = async () => { entered.resolve(); await held.promise; };
  try {
    await tapButton(mobile.page, "交还并授权只读"); await entered.promise;
    await mobile.page.waitForFunction(() => [...document.querySelectorAll('img[alt="OCI 私有登录画面"]')].every(image => image.getAttribute("aria-disabled") === "true"));
    assert.equal((await waiting.status()).phase, "verifying"); assert.equal(waiting.settled(), false);
    const io = ["/login/start", "/login/frame", "/login/input"].map(route => bridge.calls.get(route) ?? 0);
    await mobile.show("pairing"); await mobile.show("login-control", bridge.interaction(waiting));
    await fillField(mobile.page, "控制密钥", fixtureKey); await tapButton(mobile.page, "验证 OCI 控制密钥");
    await mobile.page.waitForSelector('section[aria-label="OCI 私有登录控制"]');
    assert.equal(await mobile.page.$('img[alt="OCI 私有登录画面"]'), null);
    assert.equal(await mobile.page.evaluate(() => [...document.querySelectorAll("button")].filter(button => ["开始 OCI Console 登录", "发送到 OCI 私有浏览器"].includes(button.textContent?.trim() ?? "")).every(button => button.disabled)), true);
    await delay(1100);
    assert.deepEqual(["/login/start", "/login/frame", "/login/input"].map(route => bridge.calls.get(route) ?? 0), io);
    assert.equal(s.browsers.length, 1); assert.equal(page.browserContext(), browserContext); assert.equal(page.target(), target);
    held.resolve(); await waitText(mobile.page, "登录结果已核验");
    const completed = nativeValue(await waiting.result);
    assert.equal(completed.mode, "oci_web"); assert.equal(completed.phase, "verified"); assert.equal(completed.resume, "uncertain");
    assert.equal(typeof completed.browserRef, "string"); assert.equal(bridge.submissions.get(waiting.attemptId), 1);
    const reads: unknown[] = [];
    for (const operation of ["read_identity", "read_page"] as const) {
      const read = nativeValue(await s.harness.behavior.callAgentTool("remote_login_console_read", {
        attemptId: waiting.attemptId, browserRef: completed.browserRef, request: { operation },
      }, context));
      assert.equal(read.operation, operation);
      reads.push(read);
      if (operation === "read_identity") assert.equal(read.matched, true);
      else assert.deepEqual(read.headings, ["Owned Console overview"]);
    }
    assert.equal(s.browsers.length, 1); assert.equal(page.browserContext(), browserContext); assert.equal(page.target(), target);
    assert.equal((await mobile.metrics()).errors, 0); await assertMobileLayout(mobile.page);
    assert.equal(s.harness.inspection.sdk.calls.some(call => call.path === "threads.send"), false);
    await assertPrivacy(s, mobile, [paired, completed, ...reads], privateFrame, draft, completed.browserRef as string);
    await confirmCleanup(s, waiting.attemptId);
  } finally { held.resolve(); }
});

test("a dropped real Console input acknowledgement is not replayed and ends the original mobile wait without success", options, async t => {
  const s = await ownedConsoleFlow(t); await s.pair();
  const bridge = mobileBackend(s.harness.behavior); let dropInput = false, dropped = 0, observingInput = false, onceBeforeDrop = false;
  const inputReplies: number[] = [];
  let retryMisclassifiedAsUnsent = false;
  const privateInput = "手机断线输入不重放";
  const mobile = await startMobileBrowserFixture(t, { context, rpc: bridge.rpc, http: bridge.http, async beforeSend(request, response) {
    if (observingInput && new URL(request.url).pathname.endsWith("/login/input")) {
      inputReplies.push(response.status);
      if (response.status !== 200) {
        const body = await response.clone().json() as { error?: unknown };
        retryMisclassifiedAsUnsent ||= body.error === "stale_frame";
      }
    }
    if (dropInput && new URL(request.url).pathname.endsWith("/login/input")) {
      onceBeforeDrop = await s.pages[0]!.$eval("input", (input, expected) => input.value === expected, privateInput);
      assert.equal(response.status, 200); dropInput = false; dropped++; return "drop";
    }
  } });
  const waiting = await openConsole(s, mobile, bridge);
  const page = s.pages[0]!, send = page.keyboard.sendCharacter.bind(page.keyboard);
  let keyboardEffects = 0;
  t.mock.method(page.keyboard, "sendCharacter", async (value: string) => { keyboardEffects++; await send(value); });
  const privateFrame = await mobile.page.$eval('img[alt="OCI 私有登录画面"]', image => image.src.slice("data:image/png;base64,".length));
  await tapFrame(mobile.page, "OCI 私有登录画面", 80, 60);
  await fillField(mobile.page, "OCI 登录文字（仅发送到私有浏览器）", privateInput);
  const hostCalls = () => s.harness.inspection.experimental_hostRpcCalls.filter(call => call.method === "inputConsole");
  const rpcBefore = hostCalls().length;
  const before = bridge.calls.get("/login/input") ?? 0; dropInput = true; observingInput = true;
  await tapButton(mobile.page, "发送到 OCI 私有浏览器");
  // The visible operation has its own eight-second timer; observe its settled UI after that deadline.
  await mobile.page.waitForFunction(() => document.body.textContent?.includes("浏览器清理尚未确认"), { timeout: 12000 });
  assert.deepEqual(await mobile.page.evaluate(() => ({ uncertain: document.body.textContent?.includes("输入回执未确认") ?? false,
    noResend: document.body.textContent?.includes("请勿直接重发") ?? false })), { uncertain: true, noResend: true },
  "The phone must explain uncertain input delivery before a person can resend it");
  await eventually(() => s.retained() === 0 && !s.browsers[0]!.connected);
  await delay(1100);
  assert.equal(dropped, 1); assert.equal(onceBeforeDrop, true);
  assert.equal(bridge.calls.get("/login/input"), before + 2, "The browser's one real retry must reach the protected route");
  const inputs = hostCalls().slice(rpcBefore).map(call => call.input as { inputId: string; frameRef: string });
  const retried = inputs.map(input => input.inputId);
  assert.equal(retried.length, 2); assert.equal(new Set(retried).size, 1, "A transport retry must preserve its original input operation ID");
  assert.equal(new Set(inputs.map(input => input.frameRef)).size, 1, "A transport retry must preserve its original displayed observation");
  assert.equal(inputReplies[0], 200); assert.ok(inputReplies[1] === 403 || inputReplies[1] === 409);
  assert.equal(retryMisclassifiedAsUnsent, false, "A spent input ID must remain uncertain even after its displayed observation is consumed");
  assert.equal(keyboardEffects, 1, "A browser retry of an uncertain input must not dispatch the input to the owned browser twice");
  assert.equal(bridge.calls.get("/login/close"), 1); assert.equal(await mobile.page.$('img[alt="OCI 私有登录画面"]'), null);
  assert.equal((await waiting.status()).phase, "cancelled"); assert.equal(bridge.submissions.get(waiting.attemptId) ?? 0, 0);
  await tapButton(mobile.page, "取消等待（清理未确认）");
  const failed = await waiting.result;
  assert.equal(typeof failed === "object" && failed.isError, true); assert.deepEqual(nativeValue(failed), { error: "unavailable" });
  assert.equal((await waiting.status()).verification, null); assert.equal((await waiting.status()).resume.state, "none");
  assert.equal((await readdir(s.dataDir)).some(name => name.startsWith("oci-browser-")), false);
  assert.equal((await mobile.metrics()).errors, 0); await assertMobileLayout(mobile.page);
  await assertPrivacy(s, mobile, [nativeValue(failed)], privateFrame, privateInput);
});
