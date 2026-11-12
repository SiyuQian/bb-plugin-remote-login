import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import type { LoginAttempt } from "../login-protocol.ts";
import plugin from "../server.ts";
import { assertMobileLayout, fillField, tapButton, waitText } from "./mobile-flow-actions.ts";
import { createRecoveryFixture, eventually, fixtureKey, nativeValue } from "./mobile-recovery-fixture.ts";
import { deferred, supportedConsoleFixture } from "./owned-console-flow-fixture.ts";

function binding(a: LoginAttempt) {
  return { attemptId: a.attemptId, projectId: a.projectId, threadId: a.threadId, environmentId: a.environmentId,
    hostId: a.hostId, browserContextId: a.browserContextId, generation: a.generation, principalId: a.principalId,
    createdAt: a.createdAt, expiresAt: a.expiresAt };
}

// A committed public SDK test-server replacement; the owned host stays live.
// Removing the gateway lifecycle fence would lose prompt live-transport refusal
// while the real reply remains held; the ordinary deadline is excluded below.
test("390px committed test-server reload fences a real late frame and successor cleanup closes its owned synthetic host", {
  skip: !supportedConsoleFixture, timeout: 90_000, concurrency: false,
}, async (t) => {
  const recovery = await createRecoveryFixture(t), { flow, guard } = recovery;
  const behavior = flow.harness.behavior;
  const original = { fetchHttp: behavior.fetchHttp.bind(behavior), callRpc: behavior.callRpc.bind(behavior) };
  let backend: Pick<typeof behavior, "fetchHttp" | "callRpc"> = original;
  let successor: Awaited<ReturnType<typeof flow.harness.lifecycle.reload>> | undefined;
  let holdNextFrame = false, selectedFrameRequest = false, heldFrame = "", released = false, lateReplyReturned = false;
  const release = deferred();
  let heldHttp: Promise<{ status: number; body: string }> | undefined;
  let heldTransport: { started: number; signal: AbortSignal | null | undefined } | undefined;
  t.mock.method(behavior, "fetchHttp", (...args: Parameters<typeof behavior.fetchHttp>) => {
    const [, path] = args;
    const selected = holdNextFrame && path === "/login/frame" && !selectedFrameRequest;
    if (selected) {
      selectedFrameRequest = true;
      heldTransport = { started: performance.now(), signal: args[2]?.signal };
    }
    const operation = backend.fetchHttp(...args);
    if (selected) {
      heldHttp = operation.then(async response => ({ status: response.status, body: await response.clone().text() }));
      void heldHttp.catch(() => {});
    }
    return operation;
  });
  t.mock.method(behavior, "callRpc", (...args: Parameters<typeof behavior.callRpc>) => backend.callRpc(...args));
  // This hook cannot substitute a result. It delays one successful real host
  // frame after its final signal check, before registered gateway postchecks.
  flow.state.afterHostCall = async (method, response) => {
    if (!selectedFrameRequest || method !== "frameFixture" || heldFrame) return;
    const actual = response as { ok?: boolean; frame?: { png?: string } };
    assert.equal(actual.ok, true); assert.equal(typeof actual.frame?.png, "string");
    heldFrame = actual.frame!.png!;
    assert.ok(heldFrame.length > 0, "The held reply must contain a real private frame.");
    await release.promise;
    lateReplyReturned = true;
  };
  try {
    const attempt = await flow.createPairingAttempt(), waiting = await flow.startNativeWait(attempt.attemptId);
    const view = await recovery.controller(waiting), { mobile, bridge, replies } = view;
    await fillField(mobile.page, "控制密钥", fixtureKey);
    await tapButton(mobile.page, "验证并接管测试");
    await tapButton(mobile.page, "开始假页面测试");
    await mobile.page.waitForSelector('img[alt="假页面测试画面"][aria-disabled="false"]');
    const displayedFrame = await mobile.page.$eval('img[alt="假页面测试画面"]', image => image.src.slice("data:image/png;base64,".length));
    const draft = "服务替换前的未发送草稿";
    await fillField(mobile.page, "测试文字", draft);
    const initial = await waiting.status();
    assert.equal(initial.phase, "user_control"); assert.equal(flow.retained(), 1);
    assert.equal(waiting.settled(), false); assert.equal(flow.harness.inspection.pendingInteractions.length, 1);
    assert.equal(bridge.submissions.get(waiting.attemptId) ?? 0, 0);
    await assertMobileLayout(mobile.page);

    const oldPublic = JSON.stringify([flow.bb.storage.database().prepare("SELECT record FROM remote_login_attempts_v1").all(),
      await flow.bb.storage.kv.list()]);
    holdNextFrame = true;
    await eventually(() => Boolean(heldFrame) && Boolean(heldHttp));
    assert.equal(released, false); assert.equal(lateReplyReturned, false);
    assert.equal(flow.retained(), 1); assert.equal(await guard.profilesRemoved("host"), false);
    successor = await flow.harness.lifecycle.reload(plugin);
    backend = successor.harness.behavior;

    const oldResponse = await heldHttp!;
    assert.equal(oldResponse.status, 503);
    assert.equal(oldResponse.body === '{"error":"login_control_failed"}', true, "Refusal must contain only the fixed public error.");
    assert.ok(heldTransport?.signal, "The actual frontend request signal must be retained.");
    assert.equal(heldTransport.signal.aborted, false, "The transport must still be live when the gateway refuses the old read.");
    assert.ok(performance.now() - heldTransport.started < 8000, "Reload must refuse before the ordinary operation deadline.");
    assert.equal(oldResponse.body.includes(heldFrame), false);
    assert.equal(lateReplyReturned, false, "Old HTTP must refuse before the delayed host reply is released.");
    const result = await waiting.result;
    assert.equal(typeof result === "object" && result.isError, true);
    assert.equal(JSON.stringify(nativeValue(result)) === '{"error":"unavailable"}', true);
    assert.equal(flow.harness.inspection.pendingInteractions.length, 0);
    assert.equal(successor.harness.inspection.pendingInteractions.length, 0);
    const ended = await waiting.status();
    // SDK disposal cancels the original interaction while its old coordinator
    // is still live; successor activation preserves that terminal cancellation.
    assert.equal(ended.phase, "cancelled"); assert.equal(ended.failure, "cancelled");
    assert.equal(ended.verification, null); assert.equal(ended.resume.state, "none");
    assert.equal(isDeepStrictEqual(binding(ended), binding(initial)), true);
    const cleanupStatus = () => (successor!.bb.storage.database().prepare(
      "SELECT status FROM remote_login_cleanup_v1 WHERE attempt_id=?").get(waiting.attemptId) as { status: string }).status;
    assert.equal(cleanupStatus(), "pending");
    assert.equal(flow.retained(), 1); assert.equal(await guard.profilesRemoved("host"), false);
    await waitText(mobile.page, "浏览器清理尚未确认");
    assert.equal(await mobile.page.$('img[alt="假页面测试画面"]'), null);

    const service = successor.harness.behavior.runService("login-coordinator");
    try {
      await eventually(async () => flow.retained() === 0 && await guard.profilesRemoved("host") && cleanupStatus() === "acknowledged");
    } finally { service.controller.abort(); await service.done; }
    const stops = successor.harness.inspection.experimental_hostRpcCalls.filter(call => call.method === "stopAttempt");
    assert.equal(stops.length, 1);
    assert.equal(stops[0]!.hostId === initial.hostId, true);
    assert.equal(isDeepStrictEqual(stops[0]!.input, { scope: { threadId: initial.threadId, attemptId: initial.attemptId,
      browserContextId: initial.browserContextId, generation: initial.generation } }), true);
    const stoppedRequests = ["session", "start", "frame", "input", "handback", "renew"].map(action => bridge.calls.get(`/login/${action}`) ?? 0);
    release.resolve(); released = true;
    await eventually(() => lateReplyReturned);
    await delay(2200);
    assert.deepEqual(["session", "start", "frame", "input", "handback", "renew"].map(action => bridge.calls.get(`/login/${action}`) ?? 0), stoppedRequests);
    assert.deepEqual(stoppedRequests.slice(0, 2), [1, 1]); assert.deepEqual(stoppedRequests.slice(3), [0, 0, 0]);
    assert.equal(isDeepStrictEqual(await waiting.status(), ended), true);
    assert.equal(await mobile.page.$('img[alt="假页面测试画面"]'), null);
    assert.equal(await mobile.page.$('section[aria-label="假页面测试控制"]'), null);
    assert.equal(bridge.submissions.get(waiting.attemptId) ?? 0, 0);
    assert.ok(replies.some(reply => reply.action === "frame" && reply.status === 503));
    const calls = [...flow.harness.inspection.experimental_hostRpcCalls, ...successor.harness.inspection.experimental_hostRpcCalls];
    assert.equal(calls.filter(call => call.method === "startFixture").length, 1);
    assert.equal(calls.some(call => ["inputFixture", "completePhoneFixture"].includes(call.method)), false);
    assert.equal(flow.browsers.length, 0); assert.equal(flow.pages.length, 0);
    assert.equal(flow.state.reads, 0); assert.equal(flow.state.inputs, 0);
    assert.equal([...flow.harness.inspection.sdk.calls, ...successor.harness.inspection.sdk.calls].some(call => call.path === "threads.send"), false);

    // The original bb storage handle is stale after replacement. Scan both
    // generations' public observations and the successor's actual stores.
    const surfaces = [oldPublic, JSON.stringify([result, ended,
      successor.bb.storage.database().prepare("SELECT record FROM remote_login_attempts_v1").all(), await successor.bb.storage.kv.list(),
      flow.harness.logEntries, flow.harness.inspection.realtimeSignals, flow.harness.inspection.pendingInteractions,
      successor.harness.logEntries, successor.harness.inspection.realtimeSignals, successor.harness.inspection.pendingInteractions]),
      await mobile.page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))];
    for (const value of [fixtureKey, flow.root, ...flow.capabilities, draft, displayedFrame, heldFrame]) {
      assert.ok(value.length > 0);
      for (const surface of surfaces) assert.equal(surface.includes(value), false, "Private reload material must remain absent from public state, native results and frontend storage.");
    }
    await assertMobileLayout(mobile.page); assert.equal((await mobile.metrics()).errors, 0);
    await recovery.closeControllers();
    await eventually(() => guard.counts().closed === guard.counts().total);
    guard.assertClosed(); assert.equal(await guard.profilesRemoved("all"), true);
    assert.deepEqual(guard.counts(), { frontend: 1, host: 1, closed: 2, total: 2 });
    t.diagnostic(JSON.stringify({ classification: "committed_public_sdk_test_server_reload_live_synthetic_host",
      realHostFrameHeldBeforeGatewayReturn: true, oldFrameStatus: oldResponse.status, refusedBeforeRelease: true,
      refusedBeforeOperationDeadline: true, originalTransportUnabortedAtRefusal: true,
      originalNativeUnavailable: true, successorPhase: ended.phase, cleanup: cleanupStatus(),
      sameBindingAndDeadline: true, lateReplyRevived: false, hostInputs: 0, nativeSubmissions: 0,
      providerUnused: true, guardedChrome: guard.counts(), profilesRemoved: true, privateValuesAbsent: true }));
  } finally {
    release.resolve(); flow.state.afterHostCall = undefined;
    await recovery.closeControllers();
    await successor?.harness.lifecycle.dispose();
  }
});
