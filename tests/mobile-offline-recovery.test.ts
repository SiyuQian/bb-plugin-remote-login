import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { assertMobileLayout, fillField, tapButton } from "./mobile-flow-actions.ts";
import { createRecoveryFixture, eventually, fixtureKey, nativeValue } from "./mobile-recovery-fixture.ts";
import { supportedConsoleFixture } from "./owned-console-flow-fixture.ts";

// Actual private-origin transport denial through a temporary tighter public
// browser allowlist; this does not emulate navigator.offline or a physical radio.
test("390px private-origin transport denial stops synthetic control without replay and explicitly cleans the original wait", {
  skip: !supportedConsoleFixture, timeout: 90_000, concurrency: false,
}, async (t) => {
  const fixture = await createRecoveryFixture(t), { flow, guard } = fixture;
  const attempt = await flow.createPairingAttempt(), waiting = await flow.startNativeWait(attempt.attemptId);
  const view = await fixture.controller(waiting), { mobile, bridge, replies } = view;
  await fillField(mobile.page, "控制密钥", fixtureKey);
  await tapButton(mobile.page, "验证并接管测试");
  await tapButton(mobile.page, "开始假页面测试");
  await mobile.page.waitForSelector('img[alt="假页面测试画面"][aria-disabled="false"]');
  const privateFrame = await mobile.page.$eval('img[alt="假页面测试画面"]', image => image.src.slice("data:image/png;base64,".length));
  const draft = "断网前的未发送中文草稿";
  await fillField(mobile.page, "测试文字", draft);
  const previousFrames = replies.filter(({ action, status }) => action === "frame" && status === 200).length;
  await eventually(() => replies.filter(({ action, status }) => action === "frame" && status === 200).length > previousFrames);
  await mobile.page.waitForSelector('img[alt="假页面测试画面"][aria-disabled="false"]');
  assert.ok(replies.some(({ action, status }) => action === "frame" && status === 200));
  assert.equal((await waiting.status()).phase, "user_control");
  assert.equal(guard.counts().frontend, 1); assert.equal(guard.counts().host, 1); assert.equal(flow.retained(), 1);
  await assertMobileLayout(mobile.page);

  const protectedActions = ["session", "start", "input", "handback", "renew"] as const;
  const actionCounts = () => protectedActions.map(action => bridge.calls.get(`/login/${action}`) ?? 0);
  const beforeDenial = actionCounts();
  assert.deepEqual(beforeDenial, [1, 1, 0, 0, 0]);
  const hostInputs = () => flow.harness.inspection.experimental_hostRpcCalls.filter(call => call.method === "inputFixture").length;
  assert.equal(hostInputs(), 0); assert.equal(waiting.settled(), false);
  const originalFrontendAllowlist = ["about\\:blank", `${mobile.origin}/*`];
  const target = mobile.page.target(), browserContext = mobile.page.browserContext();
  const frameDenials: string[] = [];
  mobile.page.on("requestfailed", request => {
    if (request.method() !== "POST" || !new URL(request.url()).pathname.endsWith("/login/frame")) return;
    const reason = request.failure()?.errorText ?? "";
    if (frameDenials.length < 4) frameDenials.push(["net::ERR_INTERNET_DISCONNECTED", "net::ERR_BLOCKED_BY_CLIENT", "net::ERR_FAILED", "net::ERR_NETWORK_CHANGED"].includes(reason) ? reason : "other");
  });
  const backendFramesBeforeDenial = bridge.calls.get("/login/frame") ?? 0;
  let denialSnapshot!: { retained: number; hostProfilesRemoved: boolean; guardedChildrenClosed: number };
  try {
    // Puppeteer's public offline API conflicts with the existing rule allowlist.
    // Restriction replacement keeps existing targets attached and never clears it.
    await mobile.browser.restrictNetwork({ allowlist: ["about\\:blank"] });
    await mobile.page.waitForFunction(() => document.body.textContent?.includes("浏览器清理尚未确认"), { timeout: 12_000 });
    assert.equal(await mobile.page.$('img[alt="假页面测试画面"]'), null);
    assert.equal(await mobile.page.$('section[aria-label="假页面测试控制"]'), null);
    assert.equal(await mobile.page.evaluate(() => document.body.textContent?.includes("输入回执未确认") ?? false), false);
    assert.deepEqual(actionCounts(), beforeDenial); assert.equal(hostInputs(), 0);
    assert.ok(frameDenials.length > 0, "an actual browser frame request must fail at the transport boundary");
    assert.equal(bridge.calls.get("/login/frame") ?? 0, backendFramesBeforeDenial, "denied frame requests must not reach the backend");
    assert.equal(mobile.page.isClosed(), false); assert.equal(mobile.page.target(), target); assert.equal(mobile.page.browserContext(), browserContext);
    assert.equal(bridge.submissions.get(waiting.attemptId) ?? 0, 0); assert.equal(waiting.settled(), false);
    const current = await waiting.status();
    assert.equal(current.verification, null); assert.equal(current.resume.state, "none");
    denialSnapshot = { retained: flow.retained(), hostProfilesRemoved: await guard.profilesRemoved("host"),
      guardedChildrenClosed: guard.counts().closed };
  } finally {
    if (!mobile.page.isClosed()) await mobile.browser.restrictNetwork({ allowlist: originalFrontendAllowlist });
  }

  // Observe more than two ordinary polling intervals after reconnecting.
  const frameCallsAfterFailure = bridge.calls.get("/login/frame") ?? 0;
  await delay(2200);
  assert.deepEqual(actionCounts(), beforeDenial); assert.equal(hostInputs(), 0);
  assert.equal(bridge.calls.get("/login/frame") ?? 0, frameCallsAfterFailure);
  assert.equal(bridge.submissions.get(waiting.attemptId) ?? 0, 0); assert.equal(waiting.settled(), false);
  assert.equal(await mobile.page.$('img[alt="假页面测试画面"]'), null);

  const cancelled = await fixture.cancelAttempt(waiting.attemptId);
  assert.equal(cancelled.phase, "cancelled"); assert.equal(flow.retained(), 0);
  assert.equal(await guard.profilesRemoved("host"), true);
  assert.equal((flow.bb.storage.database().prepare("SELECT status FROM remote_login_cleanup_v1 WHERE attempt_id=?")
    .get(waiting.attemptId) as { status: string }).status, "acknowledged");
  assert.equal(waiting.settled(), false, "durable cancellation must not substitute for the original UI interaction outcome");
  assert.ok(flow.harness.inspection.pendingInteractions.some(interaction => interaction.id === waiting.interaction.id));
  await tapButton(mobile.page, "取消等待（清理未确认）");
  const result = await waiting.result;
  assert.equal(typeof result === "object" && result.isError, true);
  assert.deepEqual(nativeValue(result), { error: "unavailable" });
  const ended = await waiting.status();
  assert.equal(ended.phase, "cancelled"); assert.equal(ended.verification, null); assert.equal(ended.resume.state, "none");
  assert.equal(bridge.submissions.get(waiting.attemptId) ?? 0, 0); assert.equal(hostInputs(), 0);
  assert.equal(flow.harness.inspection.sdk.calls.some(call => call.path === "threads.send"), false);
  assert.equal(flow.browsers.length, 0); assert.equal(flow.pages.length, 0);
  assert.equal(flow.state.reads, 0); assert.equal(flow.state.inputs, 0);
  await fixture.assertPrivate([view], [cancelled, result, ended], [draft, privateFrame]);
  await assertMobileLayout(mobile.page); assert.equal((await mobile.metrics()).errors, 0);
  await fixture.closeControllers();
  await eventually(() => guard.counts().closed === guard.counts().total);
  guard.assertClosed(); assert.equal(await guard.profilesRemoved("all"), true);
  assert.deepEqual(guard.counts(), { frontend: 1, host: 1, closed: 2, total: 2 });
  t.diagnostic(JSON.stringify({ classification: "local_frontend_private_origin_transport_denial", denialSnapshot,
    failedFrameTransportCategories: frameDenials, deniedFramesReachedBackend: 0, originalFrontendAllowlistRestored: true,
    protectedActionCountsUnchanged: true, hostInputs: 0, nativeSubmissions: 0, originalWaitUnavailable: true,
    explicitCleanupAcknowledged: true, guardedChrome: guard.counts(), profilesRemoved: true, privateValuesAbsent: true }));
});
