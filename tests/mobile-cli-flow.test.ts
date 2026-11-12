import assert from "node:assert/strict";
import test from "node:test";
import { createCliFlowFixtureBase, context, expected, fixtureKey, nativeValue, supportedHost } from "./cli-flow-fixture.ts";
import { ownedCliServiceFixture } from "./owned-cli-service-fixture.ts";
import { startMobileBrowserFixture } from "./mobile-browser-fixture.ts";
import { assertMobileLayout, checkPairingPage, completeSyntheticCard, fillField, mobileBackend, tapButton, tapFrame, waitText } from "./mobile-flow-actions.ts";

// Real registered frontend, HTTP and owned CLI chain; BB shell and provider
// service remain fixtures. Mobile emulation does not establish iPhone support.
test("390px frontend owns pairing, synthetic acceptance and actual CLI callback through the original native result", {
  skip: !supportedHost, timeout: 120_000,
}, async (t) => {
  const service = await ownedCliServiceFixture(t);
  const s = await createCliFlowFixtureBase(t);
  assert.equal(s.worker.experimental_getRetainedWorkerLeaseCount(), 0);
  assert.equal(s.harness.inspection.pendingInteractions.length, 0);
  const bridge = mobileBackend(s.harness.behavior);
  const hostRefusals: Array<{ method: string; reason: string }> = [];
  s.faults.afterHostCall = async (method, response) => {
    if (response && typeof response === "object" && "ok" in response && response.ok === false && "reason" in response
      && typeof response.reason === "string" && /^[a-z_]{1,40}$/.test(response.reason)) hostRefusals.push({ method, reason: response.reason });
  };
  const replies: Array<{ action: string; status: number }> = [];
  const mobile = await startMobileBrowserFixture(t, { context, rpc: bridge.rpc, http: bridge.http,
    beforeSend(request, response) { replies.push({ action: new URL(request.url).pathname.split("/").at(-1)!, status: response.status }); },
  });
  await checkPairingPage(mobile.page, fixtureKey);
  await assertMobileLayout(mobile.page);
  assert.equal(service.state.documents, 0);

  const synthetic = await s.wait("synthetic");
  await mobile.show("login-control", bridge.interaction(synthetic));
  await completeSyntheticCard(mobile.page, fixtureKey);
  const paired = nativeValue(await synthetic.native);
  assert.equal(paired.mode, "synthetic"); assert.equal(paired.resume, "uncertain");
  assert.equal(bridge.submissions.get(synthetic.attemptId), 1);
  assert.equal(s.worker.experimental_getRetainedWorkerLeaseCount(), 0);

  const cli = await s.wait("oci_cli");
  await mobile.show("login-control", bridge.interaction(cli));
  await fillField(mobile.page, "控制密钥", fixtureKey);
  await tapButton(mobile.page, "验证 OCI 控制密钥");
  await fillField(mobile.page, "目标 Tenancy OCID", expected.tenancyOcid);
  await fillField(mobile.page, "目标 User OCID", expected.userOcid);
  await fillField(mobile.page, "目标 Region", expected.region);
  await assertMobileLayout(mobile.page);
  await tapButton(mobile.page, "确认私有 OCI CLI 目标");
  await waitText(mobile.page, "已绑定私有 OCI CLI 目标");
  await tapButton(mobile.page, "开始 OCI CLI 登录");
  try {
    await tapFrame(mobile.page, "OCI 私有登录画面", 100, 130);
    await tapButton(mobile.page, "交还并授权只读");
  } catch (error) {
    const status = await cli.status();
    t.diagnostic(JSON.stringify({ phase: status.phase, failure: status.failure, calls: [...bridge.calls], replies: replies.slice(-10), hostRefusals,
      stages: service.state.stages, childEvents: service.state.events.map(({ stage, value }) => ({ stage, outcome: value.outcome, reason: value.reason })) }));
    throw error;
  }
  await waitText(mobile.page, "登录结果已核验");
  const result = nativeValue(await cli.native);
  assert.equal(result.phase, "verified"); assert.equal(result.mode, "oci_cli"); assert.equal(result.resume, "uncertain");
  assert.equal(typeof result.accountRef, "string");
  assert.equal(bridge.submissions.get(cli.attemptId), 1);
  assert.equal((await cli.status()).resume.state, "uncertain");
  assert.equal(service.state.documents, 1);
  assert.deepEqual(service.state.stages, ["authentication", "diagnostic", "verifier"]);
  const task = nativeValue(await s.harness.behavior.callAgentTool("remote_login_oci_read", {
    attemptId: cli.attemptId, accountRef: result.accountRef, request: { operation: "list_compartments" },
  }, context));
  assert.equal(task.operation, "list_compartments");
  assert.deepEqual((task.rows as Array<{ name: string }>).map(({ name }) => name), ["Composed fixture compartment"]);
  assert.deepEqual(service.state.stages, ["authentication", "diagnostic", "verifier", "task"]);
  const storage = await mobile.page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  await s.assertPrivate([service.token, service.state.authorizationUrl, fixtureKey, service.root], [storage]);
  for (const value of [fixtureKey, expected.tenancyOcid, expected.userOcid, service.token, String(result.accountRef)]) {
    assert.equal(storage.includes(value), false, "private state must not persist in frontend storage");
  }
  await assertMobileLayout(mobile.page);
  await mobile.page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const rotated = await mobile.page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
  assert.equal(rotated.viewport, 844); assert.ok(rotated.width <= 845);
  await mobile.page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await assertMobileLayout(mobile.page);
  assert.equal(bridge.calls.get("/login/start"), 2);
  assert.equal(bridge.calls.get("/login/input"), 4, "touch and text inputs must be dispatched exactly once");
  const metrics = await mobile.metrics(); assert.equal(metrics.errors, 0);
  t.diagnostic(JSON.stringify({ method: "oci_cli", metrics, nativeSubmissions: 2,
    starts: bridge.calls.get("/login/start"), inputs: bridge.calls.get("/login/input"),
    serviceStages: service.state.stages, guardedChromeProcesses: service.state.browserTransports.length,
    privateStateAbsentFromPublicRecordsAndFrontendStorage: true }));
  // The frontend is itself confined by the shared spawn guard, in addition to
  // the synthetic and provider Chrome processes. Actual closure is observed.
  await mobile.close();
  assert.equal(service.state.browserTransports.length, 3);
  t.after(() => assert.ok(service.state.browserTransports.every(({ closed }) => closed)));
});
