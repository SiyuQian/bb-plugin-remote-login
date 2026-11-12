import assert from "node:assert/strict";
import test from "node:test";
import { startMobileBrowserFixture, supportedMobileBrowserFixture } from "./mobile-browser-fixture.ts";

const options = { skip: !supportedMobileBrowserFixture, timeout: 30000 };
test("the public app harness renders and remounts real registrations with built CSS at 390px", options, async t => {
  const calls: string[] = [];
  const s = await startMobileBrowserFixture(t, { context: { projectId: "mobile-smoke-project", threadId: "mobile-smoke-thread" },
    rpc(method) { calls.push(method); if (method === "hostChoices") return [{ id: "mobile-smoke-host", name: "Mobile smoke host" }]; if (method === "loginAttempts") return []; assert.fail("Unexpected fixture RPC"); },
  });
  await s.page.waitForSelector('option[value="mobile-smoke-host"]');
  assert.equal(await s.page.$eval("h1", node => node.textContent), "控制配对");
  const metrics = await s.metrics();
  assert.equal(metrics.viewport.width, 390); assert.equal(metrics.viewport.height, 844); assert.equal(metrics.pointerCoarse, true);
  assert.equal(metrics.main.paddingTop, "16px"); assert.equal(metrics.page.scrollWidth, 390); assert.equal(metrics.errors, 0);
  assert.deepEqual(calls, ["hostChoices"]);
  await s.show("login-attempts");
  await s.page.waitForFunction(() => document.querySelector("main")?.textContent?.includes("当前 thread 暂无登录请求"));
  assert.equal(await s.page.$eval("h1", node => node.textContent), "登录请求状态");
  assert.deepEqual(calls, ["hostChoices", "loginAttempts"]);
  console.log(JSON.stringify(metrics));
  await s.close(); await s.close(); assert.equal(s.browser.connected, false);
});

test("fixture closure cancels a held response hook without waiting for an ignored abort", options, async t => {
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let observed: AbortSignal | undefined, cancelled = false;
  const s = await startMobileBrowserFixture(t, { context: { projectId: "mobile-close-project", threadId: "mobile-close-thread" },
    rpc: () => [{ id: "mobile-close-host", name: "Mobile close host" }],
    http: () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 401 }),
    beforeSend(request) { if (!new URL(request.url).pathname.startsWith("/api/")) return; observed = request.signal; entered(); return new Promise<void>(() => {}); },
  });
  const request = s.page.evaluate(() => fetch("/api/v1/plugins/remote-login/http/control/check", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null));
  void request.catch(() => {});
  await waiting; const start = performance.now(); await s.close();
  await request.catch(() => {});
  assert.equal(observed?.aborted, true); assert.equal(s.browser.connected, false); assert.ok(performance.now() - start < 3000);
  assert.equal(cancelled, true, "the held hook must release its still-unread private response");
});

test("the observed host base contract keeps the actual pairing input inside the 390px page", options, async t => {
  const paths: string[] = [];
  const s = await startMobileBrowserFixture(t, { context: { projectId: "mobile-input-project", threadId: "mobile-input-thread" },
    rpc(method) { if (method === "hostChoices") return [{ id: "mobile-input-host", name: "Mobile input host" }];
      assert.equal(method, "controlStatus"); return { hostId: "mobile-input-host", provisioned: true, rootId: "fixture-root", lastCheck: null }; },
    async http(request) { const path = new URL(request.url).pathname; paths.push(path); assert.equal(request.headers.has("authorization"), false);
      assert.equal(Object.hasOwn(await request.json(), "key"), false);
      if (path.endsWith("/login/status")) return new Response(JSON.stringify({ version: 1, attemptId: "mobile-layout-attempt", projectId: "mobile-input-project", threadId: "mobile-input-thread",
        environmentId: "mobile-layout-environment", hostId: "mobile-input-host", browserContextId: "mobile-layout-browser", generation: 1, principalId: "fixture-root",
        mode: "oci_cli", phase: "awaiting_control", revision: 1, createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 600000,
        verification: null, resume: { state: "none", deliveryId: null }, failure: null }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      return new Response('{"error":"control_authorization_failed"}', { status: 401, headers: { "content-type": "application/json", "cache-control": "no-store" } }); },
  });
  await s.page.waitForSelector('option[value="mobile-input-host"]');
  await s.page.click("button:not([hidden])");
  await s.page.waitForSelector('input[type="password"]');
  const measure = () => s.page.evaluate(() => {
    const input = document.querySelector('input[type="password"]')!, style = getComputedStyle(input), box = input.getBoundingClientRect();
    return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, input: { width: box.width, left: box.left, right: box.right,
      parentWidth: input.parentElement!.getBoundingClientRect().width, boxSizing: style.boxSizing, paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight, borderLeft: style.borderLeftWidth, borderRight: style.borderRightWidth, fontSize: style.fontSize } };
  });
  const geometry = await measure();
  assert.equal(geometry.input.boxSizing, "border-box");
  assert.equal(geometry.viewport, 390); assert.equal(geometry.scrollWidth, 390);
  assert.ok(geometry.input.width <= geometry.input.parentWidth); assert.ok(geometry.input.right <= 390);
  assert.equal(geometry.input.paddingLeft, "12px"); assert.equal(geometry.input.fontSize, "15px");
  await s.show("login-control", { id: "mobile-layout-interaction", payload: { attemptId: "mobile-layout-attempt" }, submit() { assert.fail("Layout cannot complete authentication"); }, cancel() { assert.fail("Layout cannot cancel an original call"); } });
  await s.page.waitForSelector('input[type="password"]');
  const controller = await measure();
  assert.equal(controller.viewport, 390); assert.equal(controller.scrollWidth, 390);
  assert.equal(controller.input.boxSizing, "border-box"); assert.equal(controller.input.width, 358);
  assert.equal(controller.input.right, 374); assert.equal(controller.input.paddingLeft, "12px");
  assert.deepEqual(paths, ["/api/v1/plugins/remote-login/http/control/check", "/api/v1/plugins/remote-login/http/login/status"]);
  console.log(JSON.stringify({ inputLayout: geometry, controllerInputLayout: controller }));
});
