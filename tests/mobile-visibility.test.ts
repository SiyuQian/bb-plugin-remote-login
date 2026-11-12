import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { TimeoutError, type JSHandle, type Page } from "puppeteer-core";
import { supportedMobileBrowserFixture } from "./mobile-browser-fixture.ts";
import { assertMobileLayout, fillField, tapButton } from "./mobile-flow-actions.ts";
import { createRecoveryFixture } from "./mobile-recovery-fixture.ts";
import { eventually, fixtureKey, nativeValue } from "./owned-console-flow-fixture.ts";

async function visibility(page: Page, hidden: boolean) {
  const observed = await page.waitForFunction(expected => document.hidden === expected
    && document.visibilityState === (expected ? "hidden" : "visible"), { polling: 100, timeout: 3000 }, hidden);
  await observed.dispose();
}
async function idleFrame(page: Page) {
  const idle = await page.waitForFunction(() => document.querySelector('img[alt="假页面测试画面"]')
    ?.getAttribute("aria-disabled") === "false", { polling: 100, timeout: 8000 });
  await idle.dispose();
}
function operations(calls: Map<string, number>) {
  return Object.fromEntries(["start", "frame", "input", "renew", "handback", "session"].map(action => [action, calls.get(`/login/${action}`) ?? 0]));
}

// Removing the real document.hidden polling gate must fail the hidden counts;
// replaying a draft or restarting on visibility must fail the return checks.
test("an actually hidden 390px synthetic controller pauses polling and resumes its unchanged lease without replay", {
  skip: !supportedMobileBrowserFixture, timeout: 60_000,
}, async t => {
  const s = await createRecoveryFixture(t);
  const attempt = await s.flow.createPairingAttempt(), waiting = await s.flow.startNativeWait(attempt.attemptId);
  const controller = await s.controller(waiting), { mobile, bridge } = controller;
  const page = mobile.page;
  let cover: Page | undefined;
  let heartbeat: JSHandle<{ ticks: number; timer: number }> | undefined;
  let normalCleanup = false;
  try {
    await page.bringToFront(); await visibility(page, false);
    cover = await mobile.browser.newPage(); await cover.bringToFront();
    try { await visibility(page, true); }
    catch (error) {
      if (!(error instanceof TimeoutError)) throw error;
      t.diagnostic(JSON.stringify({ classification: "headless_tab_visibility_gap", hiddenTransitionObserved: false,
        hostBrowsers: s.guard.counts().host, inputRequests: bridge.calls.get("/login/input") ?? 0 }));
      normalCleanup = true;
      t.skip("Pinned headless Chrome did not expose an actual hidden-page transition; no background acceptance claimed.");
      return;
    }
    await page.bringToFront(); await visibility(page, false);
    assert.equal(s.guard.counts().host, 0, "visibility preflight must precede host-browser startup");
    assert.deepEqual(operations(bridge.calls), { start: 0, frame: 0, input: 0, renew: 0, handback: 0, session: 0 });

    await fillField(page, "控制密钥", fixtureKey); await tapButton(page, "验证并接管测试");
    await tapButton(page, "开始假页面测试"); await idleFrame(page);
    const draft = "保留未发送的可见性测试草稿";
    await fillField(page, "测试文字", draft); await idleFrame(page); await assertMobileLayout(page);
    const before = await waiting.status(); assert.equal(before.phase, "user_control");
    const privateFrame = await page.$eval('img[alt="假页面测试画面"]', image => image.src.slice("data:image/png;base64,".length));
    heartbeat = await page.evaluateHandle(() => {
      const counter = { ticks: 0, timer: 0 };
      counter.timer = window.setInterval(() => { counter.ticks++; }, 100);
      return counter;
    });

    await cover.bringToFront(); await visibility(page, true);
    // Drain a read that began immediately before hiding; measure only the
    // settled hidden interval, without overriding browser visibility or clocks.
    await idleFrame(page);
    const hidden = operations(bridge.calls), authorizations = s.flow.harness.inspection.experimental_hostRpcCalls
      .filter(call => call.method === "authorizeControl").length;
    const ticks = await heartbeat.evaluate(counter => counter.ticks);
    const started = performance.now(); await delay(2400);
    assert.ok(performance.now() - started >= 2200, "the page must remain hidden for more than two poll intervals");
    assert.equal(await page.evaluate(() => document.hidden && document.visibilityState === "hidden"), true);
    assert.ok(await heartbeat.evaluate(counter => counter.ticks) - ticks >= 2,
      "the hidden renderer must run timers, so zero polls is not evidence of timer suspension");
    assert.deepEqual(operations(bridge.calls), hidden, "a settled hidden page must issue no controller operations");
    assert.equal(waiting.settled(), false); assert.equal(bridge.submissions.get(waiting.attemptId) ?? 0, 0);
    assert.equal(await page.evaluate(expected => [...document.querySelectorAll("label")].find(label => label.textContent?.trim() === "测试文字")
      ?.querySelector("input")?.value === expected, draft), true, "the unsent draft must remain private and unchanged");

    await page.bringToFront(); await visibility(page, false);
    await eventually(() => (bridge.calls.get("/login/frame") ?? 0) > hidden.frame!); await idleFrame(page);
    const resumed = operations(bridge.calls), after = await waiting.status();
    assert.equal(resumed.start, 1); assert.equal(resumed.session, 1); assert.equal(resumed.input, 0);
    assert.equal(resumed.renew, 0); assert.equal(resumed.handback, 0);
    assert.ok(s.flow.harness.inspection.experimental_hostRpcCalls.filter(call => call.method === "authorizeControl").length > authorizations,
      "resumed private polling must pass the registered current-authority check");
    assert.equal(after.attemptId === before.attemptId && after.hostId === before.hostId && after.principalId === before.principalId
      && after.browserContextId === before.browserContextId && after.generation === before.generation && after.expiresAt === before.expiresAt, true,
    "visibility must preserve the original binding and deadline");
    assert.equal(after.phase, "user_control"); assert.equal(after.verification, null); assert.equal(after.resume.state, "none");
    assert.equal(await page.evaluate(expected => [...document.querySelectorAll("label")].find(label => label.textContent?.trim() === "测试文字")
      ?.querySelector("input")?.value === expected, draft), true);
    assert.equal(s.flow.retained(), 1); assert.equal(s.guard.counts().host, 1);

    await tapButton(page, "停止假页面测试");
    const stopped = await waiting.result;
    assert.equal(typeof stopped === "object" && stopped.isError, true); assert.deepEqual(nativeValue(stopped), { error: "unavailable" });
    await s.cancelAttempt(waiting.attemptId);
    const cancelled = await waiting.status(); assert.equal(cancelled.phase, "cancelled");
    assert.equal(cancelled.verification, null); assert.equal(cancelled.resume.state, "none");
    assert.equal(bridge.submissions.get(waiting.attemptId) ?? 0, 0); assert.equal(s.flow.retained(), 0);
    assert.equal(await s.guard.profilesRemoved("host"), true);
    await s.assertPrivate([controller], [nativeValue(stopped)], [draft, privateFrame]);
    assert.equal((await mobile.metrics()).errors, 0); await assertMobileLayout(page);
    t.diagnostic(JSON.stringify({ classification: "actual_headless_tab_visibility_only", hiddenTransitionObserved: true,
      hiddenTimerHeartbeatAdvanced: true, hiddenPollRequests: 0, resumedWithCurrentAuthority: true, inputRequests: resumed.input, starts: resumed.start,
      originalBindingAndDeadlinePreserved: true, unsentDraftPreserved: true, nativeResume: "none", ownedHostProfileRemoved: true }));
    normalCleanup = true;
  } finally {
    if (heartbeat) {
      await heartbeat.evaluate(counter => window.clearInterval(counter.timer)).catch(() => {});
      await heartbeat.dispose().catch(() => {});
    }
    await cover?.close().catch(() => {});
    await s.closeControllers();
    // Success and an honest unsupported-visibility skip must both prove normal
    // cleanup; unexpected failures retain their original cause for fallback.
    if (normalCleanup) {
      await eventually(() => s.guard.counts().closed === s.guard.counts().total);
      s.guard.assertClosed(); assert.equal(await s.guard.profilesRemoved("all"), true);
    }
  }
});
