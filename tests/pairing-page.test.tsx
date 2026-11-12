import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import type { ExperimentalServers } from "@get-bb/plugin-sdk/app";
import { installUiEnvironment } from "./ui-environment.ts";

const environment = installUiEnvironment();
after(() => environment.window.close());
const { act, fireEvent, waitFor } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const plugin = await loadPluginApp(() => import("../app.tsx"));
const pairing = plugin.navPanels.find((panel) => panel.id === "pairing");
assert.ok(pairing);

const fixtureKey = Buffer.alloc(32, 0x37).toString("base64url");
const fixtureCapability = Buffer.alloc(32, 0x55).toString("base64url");
type FetchCall = { url: URL; headers: Headers; payload: Record<string, unknown>; init: RequestInit };

function jsonResponse(value: unknown, status = 200, cacheControl: string | null = "no-store") {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...(cacheControl ? { "cache-control": cacheControl } : {}) },
  });
}

function controlHttp(t: TestContext, options: { expiresAt?: number; probe?: () => Response; intercept?: (call: FetchCall) => Response | Promise<Response> | undefined } = {}) {
  const calls: FetchCall[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init.headers);
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    const call = { url, headers, payload, init }; calls.push(call);
    const intercepted = options.intercept?.(call); if (intercepted) return intercepted;
    if (url.pathname.endsWith("/check") && !headers.has("authorization")) {
      return options.probe?.() ?? jsonResponse({ error: "control_authorization_failed" }, 401);
    }
    if (url.pathname.endsWith("/session")) {
      return jsonResponse({ capability: fixtureCapability, expiresAt: options.expiresAt ?? Date.now() + 300_000 });
    }
    if (url.pathname.endsWith("/check")) return jsonResponse({ authorized: true });
    if (url.pathname.endsWith("/release")) return jsonResponse({ released: true });
    throw new Error("Unexpected fixture HTTP request");
  });
  return calls;
}

async function renderPairing(t: TestContext, options: {
  provisioned?: boolean;
  hosts?: { id: string; name: string }[];
  servers?: ExperimentalServers | null;
  controlStatus?: (input: unknown) => { hostId: string; provisioned: boolean; rootId: string | null } | Promise<{ hostId: string; provisioned: boolean; rootId: string | null }>;
} = {}) {
  const hosts = options.hosts ?? [{ id: "fixture-host-a", name: "Fixture host A" }];
  const view = renderSlot(pairing!, { subPath: "" }, {
    pluginId: "remote-login",
    context: { threadId: "fixture-thread" },
    servers: options.servers ?? null,
    rpc: {
      hostChoices: () => hosts,
      controlStatus: options.controlStatus ?? ((input: unknown) => ({
        hostId: (input as { hostId: string }).hostId,
        provisioned: options.provisioned ?? true,
        rootId: options.provisioned === false ? null : "fixture-root-id",
      })),
    },
  });
  t.after(async () => { await act(async () => { view.unmount(); }); });
  await view.findByRole("option", { name: hosts[0]!.name });
  return view;
}

async function checkConnection(view: Awaited<ReturnType<typeof renderPairing>>) {
  await waitFor(() => assert.equal((view.getByRole("button", { name: "检查连接与配对状态" }) as HTMLButtonElement).disabled, false));
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "检查连接与配对状态" })); });
}

test("an expired five-minute control grant releases the host and pairing controls", async (t) => {
  const now = Date.now();
  controlHttp(t, { expiresAt: now + 300_000 });
  const view = await renderPairing(t);
  await checkConnection(view);
  const input = view.getByLabelText("控制密钥") as HTMLInputElement;
  fireEvent.change(input, { target: { value: fixtureKey } });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "验证配对" })); });
  const host = view.getByRole("combobox") as HTMLSelectElement;
  const refresh = view.getByRole("button", { name: "检查连接与配对状态" }) as HTMLButtonElement;
  const release = view.getByRole("button", { name: "撤销本次授权" }) as HTMLButtonElement;
  assert.equal(release.disabled, false);
  assert.ok(view.getByRole("button", { name: "开始假页面测试" }));
  assert.equal(host.disabled, true);
  await act(async () => { t.mock.timers.tick(299_999); });
  assert.equal(release.disabled, false);
  await act(async () => { t.mock.timers.tick(1); });
  assert.equal(host.disabled, false, "expired grants must not leave the host selector locked");
  assert.equal(refresh.disabled, false);
  assert.equal(input.disabled, false);
  assert.equal(release.disabled, true);
  assert.equal(view.queryByRole("button", { name: "开始假页面测试" }), null);
});

test("ordinary web clients use their current HTTPS origin for a credential-free preflight", async (t) => {
  const calls = controlHttp(t);
  const view = await renderPairing(t, { servers: null });
  assert.ok(view.getByRole("heading", { name: "控制配对", level: 1 }));
  assert.equal(calls.length, 0);
  assert.equal(view.queryByLabelText("控制密钥"), null);
  await checkConnection(view);
  assert.equal(calls.length, 1);
  const probe = calls[0]!;
  assert.equal(probe.url.origin, "https://bb-web.fixture.invalid");
  assert.equal(probe.url.pathname, "/api/v1/plugins/remote-login/http/control/check");
  assert.equal(probe.init.method, "POST");
  assert.equal(probe.init.cache, "no-store");
  assert.equal(probe.init.credentials, "include");
  assert.equal(probe.headers.has("authorization"), false);
  assert.equal(Object.hasOwn(probe.payload, "key"), false);
  assert.equal(probe.payload.hostId, "fixture-host-a");
  assert.equal(view.getByRole("status", { name: "配对状态" }).textContent?.includes("控制通道可连接"), true);
});

test("host discovery and unprovisioned pairing never submit a control key", async (t) => {
  const calls = controlHttp(t);
  const view = await renderPairing(t, {
    provisioned: false,
    hosts: [{ id: "fixture-host-a", name: "Fixture host A" }, { id: "fixture-host-b", name: "Fixture host B" }],
  });
  const refresh = view.getByRole("button", { name: "检查连接与配对状态" }) as HTMLButtonElement;
  assert.equal((view.getByRole("combobox") as HTMLSelectElement).value, "");
  assert.equal(refresh.disabled, true);
  fireEvent.click(refresh);
  assert.equal(calls.length, 0);
  assert.equal(view.queryByRole("button", { name: "生成控制密钥" }), null);
  fireEvent.change(view.getByRole("combobox"), { target: { value: "fixture-host-b" } });
  await checkConnection(view);
  assert.ok(view.getByText("host 尚未配对"));
  assert.equal(view.queryByRole("button", { name: "验证配对" }), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.payload.hostId, "fixture-host-b");
  assert.equal(Object.hasOwn(calls[0]!.payload, "key"), false);
  assert.equal(calls[0]!.headers.has("authorization"), false);
});

test("gateway failures cannot enable sending a control key", async (t) => {
  const cases = [
    { name: "gateway HTML 401", probe: () => new Response("Gateway login required", { status: 401 }) },
    { name: "gateway JSON 401", probe: () => jsonResponse({ error: "gateway_login_required" }, 401) },
    { name: "route response without no-store", probe: () => jsonResponse({ error: "control_authorization_failed" }, 401, null) },
    { name: "unexpected fields in a 401", probe: () => jsonResponse({ error: "control_authorization_failed", gateway: true }, 401) },
  ];
  for (const item of cases) {
    await t.test(item.name, async (t) => {
      const calls = controlHttp(t, { probe: item.probe });
      const view = await renderPairing(t);
      await checkConnection(view);
      fireEvent.change(view.getByLabelText("控制密钥"), { target: { value: fixtureKey } });
      const authenticate = view.getByRole("button", { name: "验证配对" }) as HTMLButtonElement;
      assert.equal(authenticate.disabled, true);
      fireEvent.click(authenticate);
      assert.equal(view.getByRole("status", { name: "配对状态" }).textContent?.includes("尚未确认"), true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.headers.has("authorization"), false);
      assert.equal(Object.hasOwn(calls[0]!.payload, "key"), false);
    });
  }
});

test("mobile authentication uses the active server, clears the key and never renders its grant", async (t) => {
  const calls = controlHttp(t);
  const view = await renderPairing(t, {
    servers: {
      status: "ready",
      servers: [
        { id: "other", name: "Other server", origin: "https://other-server.fixture.invalid", kind: "account", active: false },
        { id: "active", name: "Active server", origin: "https://active-server.fixture.invalid", kind: "account", active: true },
      ],
      switchTo: () => { throw new Error("The pairing page must not switch servers"); },
    },
  });
  assert.equal(view.queryByRole("button", { name: "开始假页面测试" }), null);
  await checkConnection(view);
  const input = view.getByLabelText("控制密钥") as HTMLInputElement;
  fireEvent.change(input, { target: { value: fixtureKey } });
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "验证配对" })); });
  assert.equal(input.value, "");
  assert.equal(input.disabled, true);
  assert.equal(view.getByRole("status", { name: "配对状态" }).textContent?.includes("控制密钥验证通过"), true);
  assert.equal(view.container.innerHTML.includes(fixtureCapability), false);
  assert.equal(view.container.innerHTML.includes(fixtureKey), false);
  assert.ok(view.getByRole("button", { name: "开始假页面测试" }));
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.url.origin === "https://active-server.fixture.invalid"));
  assert.equal(calls[1]!.url.pathname.endsWith("/session"), true);
  assert.equal(calls[1]!.payload.key, fixtureKey);
  assert.equal(calls[1]!.headers.has("authorization"), false);
  assert.equal(calls[2]!.headers.get("authorization"), `Bearer ${fixtureCapability}`);
  assert.equal(Object.hasOwn(calls[2]!.payload, "key"), false);
});

test("a mobile server list without an active server does not fall back to another origin", async (t) => {
  const calls = controlHttp(t);
  const view = await renderPairing(t, {
    servers: {
      status: "ready",
      servers: [{ id: "other", name: "Other server", origin: "https://other-server.fixture.invalid", kind: "account", active: false }],
      switchTo: () => {},
    },
  });
  const refresh = view.getByRole("button", { name: "检查连接与配对状态" }) as HTMLButtonElement;
  assert.equal(refresh.disabled, true);
  fireEvent.click(refresh);
  assert.equal(calls.length, 0);
});

test("first pairing generates a local key and matching public fingerprint without transmitting the key", async (t) => {
  const calls = controlHttp(t);
  const view = await renderPairing(t, { provisioned: false });
  await checkConnection(view);
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "生成控制密钥" })); });
  const generated = await view.findByLabelText("控制密钥（请勿发送到聊天）") as HTMLInputElement;
  assert.match(generated.value, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(generated.type, "password");
  assert.equal(generated.readOnly, true);
  const expectedFingerprint = createHash("sha256")
    .update("bb-remote-login pairing root v1\0", "utf8")
    .update(Buffer.from(generated.value, "base64url")).digest("hex");
  assert.ok(view.getByText(expectedFingerprint));
  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0]!.payload, "key"), false);
});

test("first pairing host discovery reports timeout before a stalled SDK reply returns", async (t) => {
  let release!: () => void;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const view = renderSlot(pairing!, { subPath: "" }, { pluginId: "remote-login", rpc: {
    hostChoices: () => new Promise<{ id: string; name: string }[]>(resolve => { release = () => resolve([{ id: "late-host", name: "Late host" }]); }),
  } });
  t.after(async () => { await act(async () => { view.unmount(); }); });
  await act(async () => { t.mock.timers.tick(8000); });
  try { assert.match(view.container.textContent!, /无法读取 host 列表/); }
  finally { await act(async () => { release(); }); }
  assert.equal(view.queryByRole("option", { name: "Late host" }), null);
});

test("pairing refresh timeout releases pending UI and preserves a generated key across held SDK, fetch and body replies", async (t) => {
  for (const stage of ["rpc", "fetch", "body"] as const) await t.test(stage, async (t) => {
    let hold = false, release!: () => void;
    const calls = controlHttp(t, { intercept: call => {
      if (!hold || stage === "rpc" || call.headers.has("authorization")) return;
      if (stage === "fetch") return new Promise<Response>(resolve => { release = () => resolve(jsonResponse({ error: "control_authorization_failed" }, 401)); });
      return new Response(new ReadableStream({ start(stream) { release = () => { stream.enqueue(new TextEncoder().encode('{"error":"control_authorization_failed"}')); stream.close(); }; } }), { status: 401, headers: { "cache-control": "no-store" } });
    } });
    const view = await renderPairing(t, { provisioned: false, controlStatus: input => hold && stage === "rpc"
      ? new Promise(resolve => { release = () => resolve({ hostId: (input as { hostId: string }).hostId, provisioned: true, rootId: "late-root" }); })
      : { hostId: (input as { hostId: string }).hostId, provisioned: false, rootId: null } });
    await checkConnection(view);
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "生成控制密钥" })); });
    const generated = await view.findByLabelText("控制密钥（请勿发送到聊天）") as HTMLInputElement, saved = generated.value;
    hold = true; t.mock.timers.enable({ apis: ["setTimeout"] });
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "检查连接与配对状态" })); });
    await act(async () => { t.mock.timers.tick(8000); });
    try {
      assert.equal((view.getByRole("button", { name: "检查连接与配对状态" }) as HTMLButtonElement).disabled, false);
      assert.equal((view.getByLabelText("控制密钥（请勿发送到聊天）") as HTMLInputElement).value, saved);
      assert.ok(view.getByRole("button", { name: "复制密钥以安全保存" }));
    } finally { await act(async () => { try { release(); } catch { /* Aborted reader may already be cancelled. */ } }); }
    assert.equal(view.queryByRole("button", { name: "验证配对" }), null);
    assert.equal(calls.some(call => Object.hasOwn(call.payload, "key")), false);
  });
});

test("pairing authentication timeout clears pending before late fetch or body success and cannot authorize", async (t) => {
  for (const stage of ["fetch", "body"] as const) await t.test(stage, async (t) => {
    let release!: () => void;
    controlHttp(t, { intercept: call => {
      if (stage === "fetch" && call.url.pathname.endsWith("/session")) return new Promise<Response>(resolve => { release = () => resolve(jsonResponse({ capability: fixtureCapability, expiresAt: Date.now() + 300_000 })); });
      if (stage === "body" && call.headers.has("authorization")) return new Response(new ReadableStream({ start(stream) { release = () => { stream.enqueue(new TextEncoder().encode('{"authorized":true}')); stream.close(); }; } }), { headers: { "cache-control": "no-store" } });
    } });
    const view = await renderPairing(t); await checkConnection(view);
    fireEvent.change(view.getByLabelText("控制密钥"), { target: { value: fixtureKey } });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "验证配对" })); });
    await act(async () => { t.mock.timers.tick(8000); });
    try {
      assert.equal((view.getByLabelText("控制密钥") as HTMLInputElement).disabled, false);
      assert.equal((view.getByLabelText("控制密钥") as HTMLInputElement).value, "");
      assert.match(view.getByRole("status", { name: "配对状态" }).textContent!, /控制鉴权未通过/);
    } finally { await act(async () => { try { release(); } catch { /* The body may already be cancelled. */ } }); }
    assert.equal(view.queryByRole("button", { name: "开始假页面测试" }), null);
  });
});

test("pairing release timeout leaves revocation unconfirmed and ignores its late success", async (t) => {
  let release!: () => void;
  controlHttp(t, { intercept: call => call.url.pathname.endsWith("/release") ? new Promise<Response>(resolve => { release = () => resolve(jsonResponse({ released: true })); }) : undefined });
  const view = await renderPairing(t); await checkConnection(view);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  fireEvent.change(view.getByLabelText("控制密钥"), { target: { value: fixtureKey } });
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "验证配对" })); });
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "撤销本次授权" })); });
  await act(async () => { t.mock.timers.tick(8000); });
  try {
    assert.equal((view.getByRole("button", { name: "撤销本次授权" }) as HTMLButtonElement).disabled, false);
    assert.match(view.getByRole("status", { name: "配对状态" }).textContent!, /未确认授权已撤销/);
  } finally { await act(async () => { release(); }); }
  assert.ok(view.getByRole("button", { name: "开始假页面测试" }));
  assert.match(view.getByRole("status", { name: "配对状态" }).textContent!, /未确认授权已撤销/);
});

test("a pairing reply held through a target switch or unmount cannot authorize a replacement view", async (t) => {
  for (const transition of ["host", "unmount"] as const) await t.test(transition, async (t) => {
    let release!: () => void;
    controlHttp(t, { intercept: call => call.url.pathname.endsWith("/session") ? new Promise<Response>(resolve => { release = () => resolve(jsonResponse({ capability: fixtureCapability, expiresAt: Date.now() + 300_000 })); }) : undefined });
    const view = await renderPairing(t, { hosts: [{ id: "fixture-host-a", name: "Fixture host A" }, { id: "fixture-host-b", name: "Fixture host B" }] });
    await act(async () => { fireEvent.change(view.getByRole("combobox"), { target: { value: "fixture-host-a" } }); });
    await checkConnection(view); fireEvent.change(view.getByLabelText("控制密钥"), { target: { value: fixtureKey } });
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "验证配对" })); });
    await act(async () => { if (transition === "host") fireEvent.change(view.getByRole("combobox"), { target: { value: "fixture-host-b" } }); else view.unmount(); });
    await act(async () => { release(); });
    assert.equal(view.queryByRole("button", { name: "开始假页面测试" }), null);
    assert.equal(view.container.innerHTML.includes(fixtureCapability), false);
  });
});

test("key generation cannot stay pending after timeout or attach its late key to a different host", async (t) => {
  for (const transition of ["timeout", "host"] as const) await t.test(transition, async (t) => {
    controlHttp(t);
    const view = await renderPairing(t, { provisioned: false, hosts: [{ id: "fixture-host-a", name: "Fixture host A" }, { id: "fixture-host-b", name: "Fixture host B" }] });
    await act(async () => { fireEvent.change(view.getByRole("combobox"), { target: { value: "fixture-host-a" } }); });
    await checkConnection(view);
    let release!: () => void;
    t.mock.method(crypto.subtle, "digest", () => new Promise<ArrayBuffer>(resolve => { release = () => resolve(new ArrayBuffer(32)); }));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "生成控制密钥" })); });
    await act(async () => {
      if (transition === "timeout") t.mock.timers.tick(8000);
      else fireEvent.change(view.getByRole("combobox"), { target: { value: "fixture-host-b" } });
    });
    try {
      assert.equal((view.getByRole("button", { name: "检查连接与配对状态" }) as HTMLButtonElement).disabled, false);
      if (transition === "timeout") assert.match(view.getByRole("status", { name: "配对状态" }).textContent!, /不能安全生成密钥/);
    } finally { await act(async () => { release(); }); }
    if (transition === "host") {
      await act(async () => { fireEvent.click(view.getByRole("button", { name: "检查连接与配对状态" })); });
    }
    assert.equal(view.queryByLabelText("控制密钥（请勿发送到聊天）"), null);
  });
});
