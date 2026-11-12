import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { startMobileBrowserFixture, supportedMobileBrowserFixture } from "./mobile-browser-fixture.ts";
import { assertMobileLayout, mobileBackend, tapButton, waitText } from "./mobile-flow-actions.ts";

const hostA = "mobile-first-key-host-a", hostB = "mobile-first-key-host-b";
const context = { projectId: "mobile-first-key-project", threadId: "mobile-first-key-thread" };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Only inventory is simulated. The registered unauthenticated check route must
// return its real 401; no fixture can authenticate, start control or verify.
async function pairingSystem(t: TestContext, boundary: "rpc" | "http") {
  const held = deferred(), entered = deferred(), completed = deferred();
  const inventory = new Map([[hostA, 0], [hostB, 0]]);
  let hold = false, probes = 0, heldCalls = 0, abortedHttp = 0;
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login", sdk: {
    hosts: { list: () => [makeHostResponse({ id: hostA, name: "First key host A" }), makeHostResponse({ id: hostB, name: "First key host B" })] },
  }, experimental_callHostRpc: async ({ hostId, method }) => {
    assert.equal(method, "controlInfo", "this inventory fixture must never grant control or start a browser");
    assert.ok(hostId === hostA || hostId === hostB);
    inventory.set(hostId, inventory.get(hostId)! + 1);
    if (hold && hostId === hostA) {
      if (boundary === "rpc") { heldCalls++; entered.resolve(); await held.promise; completed.resolve(); }
      // This late invented inventory fact is not a grant or verification proof.
      return { provisioned: true, rootId: "late-inventory-only-root", provisioningDirectory: "/unused-inventory-fixture" };
    }
    return { provisioned: false, rootId: null, provisioningDirectory: "/unused-inventory-fixture" };
  } });
  t.after(async () => { held.resolve(); await harness.lifecycle.dispose(); });
  await plugin(bb);
  const bridge = mobileBackend(harness.behavior);
  const mobile = await startMobileBrowserFixture(t, { context, rpc: bridge.rpc,
    http: async (request) => {
      assert.equal(new URL(request.url).pathname, "/api/v1/plugins/remote-login/http/control/check");
      assert.equal(request.headers.has("authorization"), false);
      const payload = await request.clone().json() as Record<string, unknown>;
      assert.equal(Object.keys(payload).sort().join(","), "hostId,scope", "generated key must never be transmitted during discovery");
      probes++;
      const response = await bridge.http(request);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.clone().json() as Record<string, unknown>;
      assert.equal(body.error === "control_authorization_failed" && Object.keys(body).length === 1, true);
      return response;
    },
    beforeSend: async (request) => {
      if (boundary !== "http" || !hold || !new URL(request.url).pathname.endsWith("/control/check")) return;
      heldCalls++; entered.resolve();
      request.signal.addEventListener("abort", () => { abortedHttp++; }, { once: true });
      try { await held.promise; } finally { completed.resolve(); }
    },
  });
  return { mobile, bridge, inventory, entered: entered.promise, completed: completed.promise,
    beginHold: () => { hold = true; }, release: () => { hold = false; held.resolve(); },
    counts: () => ({ probes, heldCalls, abortedHttp }) };
}

for (const boundary of ["rpc", "http"] as const) {
  test(`390px first pairing preserves its generated key through a real eight-second held ${boundary} refresh`, {
    skip: !supportedMobileBrowserFixture, timeout: 30_000,
  }, async (t) => {
    const s = await pairingSystem(t, boundary), page = s.mobile.page;
    let proof: Awaited<ReturnType<typeof page.evaluateHandle>> | undefined;
    try {
      await page.waitForSelector(`select option[value="${hostA}"]`);
      await page.select("select", hostA);
      await tapButton(page, "检查连接与配对状态");
      await waitText(page, "host 尚未配对");
      await tapButton(page, "生成手机控制密钥");
      await page.waitForSelector('input[type="password"][readonly]');
      proof = await page.evaluateHandle(async () => {
        const input = document.querySelector<HTMLInputElement>('input[type="password"][readonly]');
        if (!input || !/^[A-Za-z0-9_-]{43}$/.test(input.value)) throw new Error("Expected generated password field");
        return { digest: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.value)))) };
      });
      await assertMobileLayout(page);
      assert.equal(s.bridge.calls.get("/control/session"), undefined);
      s.beginHold();
      const started = performance.now();
      await tapButton(page, "检查连接与配对状态");
      await s.entered;
      assert.equal(await page.evaluate(() => [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.trim() === "检查连接与配对状态")?.disabled), true);
      await page.waitForFunction(() => document.body.textContent?.includes("无法检查该 host 的配对状态。"), { timeout: 12_000 });
      assert.ok(performance.now() - started >= 7_500, "the real eight-second deadline must elapse");
      assert.equal(await page.evaluate(async (saved) => {
        const input = document.querySelector<HTMLInputElement>('input[type="password"][readonly]');
        if (!input || !input.readOnly || input.type !== "password") return false;
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.value)));
        return digest.every((byte, index) => byte === (saved as { digest: number[] }).digest[index]);
      }, proof), true, "a timed-out refresh must preserve the generated key");
      assert.equal(await page.evaluate(() => [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.trim() === "检查连接与配对状态")?.disabled), false);
      assert.equal(await page.evaluate(() => [...document.querySelectorAll("button")].some((button) =>
        button.textContent?.trim() === "验证配对" || button.textContent?.trim() === "开始假页面测试")), false);
      assert.deepEqual(s.counts(), { probes: 2, heldCalls: 1, abortedHttp: boundary === "http" ? 1 : 0 });
      assert.equal(s.inventory.get(hostA), 2);

      await page.select("select", hostB);
      await page.waitForFunction(() => !document.querySelector('input[type="password"][readonly]'));
      s.release(); await s.completed;
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      assert.equal(await page.$eval("select", (select) => select.value), hostB);
      assert.equal(await page.evaluate(() => document.body.textContent?.includes("host 已配对")), false);
      assert.equal(await page.evaluate(() => [...document.querySelectorAll("button")].some((button) =>
        button.textContent?.trim() === "验证配对" || button.textContent?.trim() === "开始假页面测试")), false);
      await tapButton(page, "检查连接与配对状态"); await waitText(page, "host 尚未配对");
      assert.equal(s.inventory.get(hostB), 1);
      assert.deepEqual(s.counts(), { probes: 3, heldCalls: 1, abortedHttp: boundary === "http" ? 1 : 0 });
      assert.equal(s.bridge.calls.get("rpc/controlStatus"), 3);
      assert.equal(s.bridge.calls.get("/control/session"), undefined);
      const metrics = await s.mobile.metrics(); assert.equal(metrics.errors, 0);
    } finally { s.release(); await proof?.dispose(); }
  });
}
