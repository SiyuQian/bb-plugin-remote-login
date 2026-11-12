import assert from "node:assert/strict";
import test from "node:test";
import { supportedMobileBrowserFixture } from "./mobile-browser-fixture.ts";
import { assertMobileLayout, fillField, tapButton, tapFrame, waitText } from "./mobile-flow-actions.ts";
import { createRecoveryFixture, eventually, fixtureKey, nativeValue } from "./mobile-recovery-fixture.ts";

function releaseGate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Two source frontends and real private synthetic control share one original
// native wait. This is neither a physical two-phone nor provider acceptance case.
test("two 390px controllers replace only their shared synthetic proof and stale cleanup preserves the current owner", {
  skip: !supportedMobileBrowserFixture, timeout: 90000,
}, async t => {
  const recovery = await createRecoveryFixture(t), flow = recovery.flow;
  const attempt = await flow.createPairingAttempt(), waiting = await flow.startNativeWait(attempt.attemptId);
  const initial = await waiting.status();
  const binding = (value: typeof initial) => JSON.stringify([value.hostId, value.environmentId, value.threadId,
    value.browserContextId, value.generation, value.expiresAt]);
  const session = releaseGate(), polling = releaseGate();
  let heldSession: { signal: AbortSignal; started: number } | undefined;
  let heldPoll: { signal: AbortSignal; started: number } | undefined, holdNextPoll = false;
  let nativeCompleted = false;
  const a = await recovery.controller(waiting, { beforeSend: async (request, response) => {
    if (!new URL(request.url).pathname.endsWith("/login/session") || heldSession) return;
    assert.equal(response.status, 200);
    heldSession = { signal: request.signal, started: performance.now() };
    await session.promise;
  } });
  const b = await recovery.controller(waiting, { beforeSend: async (request, response) => {
    if (!holdNextPoll || !new URL(request.url).pathname.endsWith("/login/frame")) return;
    holdNextPoll = false; assert.equal(response.status, 200);
    heldPoll = { signal: request.signal, started: performance.now() };
    await polling.promise;
  } });
  try {
    assert.equal(flow.harness.inspection.pendingInteractions.length, 1);
    assert.deepEqual(recovery.guard.counts(), { frontend: 2, host: 0, closed: 0, total: 2 });
    await assertMobileLayout(a.mobile.page); await assertMobileLayout(b.mobile.page);
    // Prepare both forms before A starts its existing eight-second operation.
    await fillField(a.mobile.page, "控制密钥", fixtureKey);
    await fillField(b.mobile.page, "控制密钥", fixtureKey);
    await tapButton(a.mobile.page, "验证并接管测试");
    await eventually(() => Boolean(heldSession));
    assert.equal((await waiting.status()).phase, "awaiting_control");
    await tapButton(b.mobile.page, "验证并接管测试");
    await tapButton(b.mobile.page, "开始假页面测试");
    await b.mobile.page.waitForSelector('img[alt="假页面测试画面"][aria-disabled="false"]');
    assert.equal((await waiting.status()).phase, "user_control");
    assert.equal(flow.retained(), 1);
    assert.deepEqual(recovery.guard.counts(), { frontend: 2, host: 1, closed: 0, total: 3 });
    assert.equal(flow.capabilities.length, 2); assert.equal(new Set(flow.capabilities).size, 2);

    // Hold only B's next prepared read response. Its viewer stays busy while
    // the registered backend slot is free for A's obsolete-proof close check.
    holdNextPoll = true; await eventually(() => Boolean(heldPoll));
    assert.equal(heldSession!.signal.aborted, false);
    assert.ok(performance.now() - heldSession!.started < 8000, "A's original authentication deadline must remain live");
    session.resolve();
    await tapButton(a.mobile.page, "开始假页面测试");
    await waitText(a.mobile.page, "浏览器清理尚未确认");
    await eventually(() => a.replies.some(reply => reply.action === "close"));
    assert.deepEqual(a.replies.filter(reply => ["start", "close"].includes(reply.action)), [
      { action: "start", status: 409 }, { action: "close", status: 403 },
    ]);
    assert.equal(a.bridge.calls.get("/login/start"), 1); assert.equal(a.bridge.calls.get("/login/close"), 1);
    assert.equal(a.bridge.calls.get("/login/input") ?? 0, 0); assert.equal(a.bridge.calls.get("/login/frame") ?? 0, 0);
    assert.equal(a.bridge.submissions.get(waiting.attemptId) ?? 0, 0);
    assert.equal(waiting.settled(), false);
    const current = await waiting.status();
    assert.equal(binding(current) === binding(initial), true);
    assert.equal(current.phase, "user_control"); assert.equal(current.verification, null); assert.equal(current.resume.state, "none");
    assert.equal(flow.retained(), 1); assert.equal(await recovery.guard.profilesRemoved("host"), false);
    assert.deepEqual(recovery.guard.counts(), { frontend: 2, host: 1, closed: 0, total: 3 });
    assert.equal(heldPoll!.signal.aborted, false);
    assert.ok(performance.now() - heldPoll!.started < 8000, "B's held read must retain its original deadline");
    polling.resolve();

    const draft = "双控制器隔离后的真实输入";
    await tapFrame(b.mobile.page, "假页面测试画面", 80, 60);
    await fillField(b.mobile.page, "测试文字", draft); await tapButton(b.mobile.page, "发送测试文字");
    await tapFrame(b.mobile.page, "假页面测试画面", 80, 130);
    const observed = await b.mobile.page.waitForSelector('img[alt="假页面测试画面"][aria-disabled="false"]');
    assert.ok(observed);
    const frame = await observed.evaluate(image => image.src.slice("data:image/png;base64,".length));
    await observed.dispose();
    assert.equal(frame.length > 0, true);
    await tapButton(b.mobile.page, "交还并核验测试结果"); await waitText(b.mobile.page, "登录结果已核验");
    const result = nativeValue(await waiting.result); nativeCompleted = true;
    assert.equal(result.phase, "verified"); assert.equal(result.mode, "synthetic"); assert.equal(result.resume, "uncertain");
    assert.equal(a.bridge.submissions.get(waiting.attemptId) ?? 0, 0); assert.equal(b.bridge.submissions.get(waiting.attemptId), 1);
    assert.equal(b.bridge.calls.get("/login/start"), 1); assert.equal(b.bridge.calls.get("/login/input"), 3);
    const calls = flow.harness.inspection.experimental_hostRpcCalls;
    assert.equal(calls.filter(call => call.method === "startFixture").length, 1);
    const inputs = calls.filter(call => call.method === "inputFixture");
    assert.equal(inputs.length, 3);
    assert.equal(new Set(inputs.map(call => (call.input as { inputId: string }).inputId)).size, 3);
    assert.equal((await waiting.status()).resume.state, "uncertain");
    assert.equal(flow.retained(), 0); assert.equal(await recovery.guard.profilesRemoved("host"), true);
    assert.equal(flow.browsers.length, 0); assert.equal(flow.state.reads, 0, "the provider boundary must remain unused");
    await recovery.assertPrivate([a, b], [result], [fixtureKey, draft, frame]);
    await assertMobileLayout(a.mobile.page); await assertMobileLayout(b.mobile.page);
    await recovery.closeControllers();
    await eventually(() => recovery.guard.counts().closed === recovery.guard.counts().total);
    assert.equal(await recovery.guard.profilesRemoved("all"), true); recovery.guard.assertClosed();
    t.diagnostic(JSON.stringify({ classification: "local_two_frontend_same_synthetic_interaction", controllers: 2,
      starts: { stale: 409, currentHostStarts: 1 }, staleClose: 403, hostInputs: inputs.length,
      originalNativeSubmissions: { stale: 0, current: 1 }, resume: "uncertain", privacyChecked: true,
      chrome: recovery.guard.counts(), profilesRemoved: true, providerUnused: true }));
  } finally {
    session.resolve(); polling.resolve();
    try { if (!nativeCompleted && !waiting.settled()) await recovery.cancelAttempt(waiting.attemptId); }
    finally { await recovery.closeControllers(); }
  }
});
