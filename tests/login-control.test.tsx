import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import type { ExperimentalServers, PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import type { LoginAttempt } from "../login-protocol.ts";
import { installUiEnvironment } from "./ui-environment.ts";

const environment = installUiEnvironment();
after(() => environment.window.close());
const { act, fireEvent } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { LoginControls, LoginControlInteraction } = await import("../login-control.tsx");
const key = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
const capability = "A".repeat(43);
const frameRef = "11111111-1111-4111-8111-111111111111";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKD8AAAAASUVORK5CYII=";
const attempt = (attemptId = "attempt-a"): LoginAttempt => ({
  version: 1, attemptId, projectId: "project-a", threadId: "thread-a", environmentId: "environment-a", hostId: "host-a",
  browserContextId: `browser-${attemptId}`, generation: 1, principalId: null, mode: "synthetic", phase: "awaiting_pairing",
  revision: 0, createdAt: Date.now() - 1000, updatedAt: Date.now() - 1000, expiresAt: Date.now() + 600_000,
  verification: null, resume: { state: "none", deliveryId: null }, failure: null,
});
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "cache-control": "no-store" } });
type Call = { action: string; body: Record<string, unknown>; init: RequestInit; url: string };
function loginHttp(t: TestContext, intercept?: (call: Call) => Response | Promise<Response> | undefined) {
  const calls: Call[] = [];
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { action: String(url).split("/").at(-1)!, body: JSON.parse(String(init.body)) as Record<string, unknown>, init, url: String(url) };
    calls.push(call);
    const intercepted = intercept?.(call);
    if (intercepted) return intercepted;
    const record = attempt(String(call.body.attemptId));
    if (call.action === "status") return response(record);
    if (call.action === "session") return response({ grant: { capability, expiresAt: Date.now() + 300_000 }, attempt: { ...record, phase: "awaiting_control", principalId: "principal-a", revision: 1 } });
    if (call.action === "start") return response({ width: 800, height: 600 });
    if (call.action === "frame") return response({ width: 800, height: 600, png,
      frameRef: "11111111-1111-4111-8111-" + (0x111111111110 + calls.filter(item => item.action === "frame").length).toString(16) });
    if (call.action === "input") return response({ accepted: true });
    if (call.action === "handback") return response({ verified: true });
    if (call.action === "close") return response({ closed: true });
    throw new Error("unexpected route");
  });
  return calls;
}
function renderControl(t: TestContext, props: { attemptId: string; onComplete?: () => Promise<void> } = { attemptId: "attempt-a" }, servers: ExperimentalServers | null = null) {
  const view = renderSlot({ component: LoginControls }, props, { pluginId: "remote-login", context: { threadId: "thread-a" }, servers });
  t.after(() => view.unmount());
  return view;
}
async function click(view: ReturnType<typeof renderControl>, name: string) {
  await act(async () => { fireEvent.click(view.getByRole("button", { name })); });
}
async function authenticate(view: ReturnType<typeof renderControl>) {
  const field = view.queryByLabelText("控制密钥") ?? await view.findByLabelText("控制密钥");
  fireEvent.change(field, { target: { value: key } });
  await click(view, "验证并接管测试");
}

test("a private stale-frame refusal preserves the login proof without completion, cancellation or automatic resend", async t => {
  let completions = 0;
  const calls = loginHttp(t, call => call.action === "input" ? response({ error: "stale_frame" }, 409) : undefined);
  const view = renderControl(t, { attemptId: "attempt-a", onComplete: async () => { completions++; } });
  await authenticate(view); await click(view, "开始假页面测试");
  fireEvent.change(view.getByLabelText("测试文字"), { target: { value: "unsent draft" } });
  await click(view, "发送测试文字");
  const sent = calls.find(call => call.action === "input");
  assert.ok(sent, "the viewer must dispatch its displayed frame reference to the private input client");
  assert.equal(sent.body.frameRef, frameRef);
  assert.equal(calls.filter(call => call.action === "input").length, 1);
  assert.equal(calls.filter(call => call.action === "close").length, 0);
  assert.equal(completions, 0);
  assert.equal((view.getByLabelText("控制密钥") as HTMLInputElement).disabled, true, "trusted stale must not revoke the in-memory control proof");
  assert.equal(view.queryByText(/输入回执未确认/), null);
  assert.ok(view.getByText(/本次输入未发送/));
  assert.equal((view.getByLabelText("测试文字") as HTMLInputElement).value, "unsent draft");
});

test("acknowledged job input then a changed frame retains proof while keeping its sent draft empty", async t => {
  let frames = 0, completions = 0;
  const calls = loginHttp(t, call => call.action === "frame" && ++frames === 2 ? response({ error: "stale_frame" }, 409) : undefined);
  const view = renderControl(t, { attemptId: "attempt-a", onComplete: async () => { completions++; } });
  await authenticate(view); await click(view, "开始假页面测试");
  fireEvent.change(view.getByLabelText("测试文字"), { target: { value: "already acknowledged draft" } });
  await click(view, "发送测试文字");
  assert.equal(calls.filter(call => call.action === "input").length, 1);
  assert.equal(calls.filter(call => call.action === "close").length, 0);
  assert.equal(calls.filter(call => call.action === "start").length, 1); assert.equal(completions, 0);
  assert.equal((view.getByLabelText("测试文字") as HTMLInputElement).value, "");
  assert.equal((view.getByLabelText("控制密钥") as HTMLInputElement).disabled, true);
  assert.equal(view.queryByText(/本次输入未发送/) === null, true);
  assert.equal(view.queryByText(/输入回执未确认/) === null, true);
  assert.ok(view.getByText(/画面读取时发生变化/));
});

test("native interaction exposes the job controller and submits only attemptId after protected handback", async (t) => {
  const plugin = await loadPluginApp(() => import("../app.tsx"));
  assert.ok(plugin.pendingInteractions.find((item) => item.id === "login-control"));
  const calls = loginHttp(t);
  const submissions: unknown[] = [];
  const props: PluginPendingInteractionProps = {
    interaction: { id: "interaction-a", threadId: "thread-a", title: "fixture", payload: { attemptId: "attempt-a" }, createdAt: Date.now(), expiresAt: null },
    submit: async (value) => { assert.equal(calls.at(-1)!.action, "handback"); submissions.push(value); }, cancel: async () => undefined,
  };
  const view = renderSlot({ component: LoginControlInteraction }, props, { pluginId: "remote-login", context: { threadId: "thread-a" } });
  t.after(() => view.unmount());
  await authenticate(view);
  assert.equal((view.getByLabelText("控制密钥") as HTMLInputElement).value, "");
  await click(view, "开始假页面测试");
  assert.deepEqual(submissions, []);
  await click(view, "交还并核验测试结果");
  assert.deepEqual(submissions, [{ attemptId: "attempt-a" }]);
  assert.equal(view.container.innerHTML.includes(key), false);
  assert.equal(view.container.innerHTML.includes(capability), false);
  assert.equal(view.queryByAltText("假页面测试画面"), null);
  assert.ok(calls.every((call) => call.url.includes("/login/") && !call.url.includes(key) && !call.url.includes(capability)));
  assert.deepEqual(view.inspection.rpcCalls, []);
});

test("failed handback preserves phone control and does not submit or close", async (t) => {
  const calls = loginHttp(t, (call) => call.action === "handback" ? response({ error: "private verifier" }, 409) : undefined);
  let completions = 0;
  const view = renderControl(t, { attemptId: "attempt-a", onComplete: async () => { completions += 1; } });
  await authenticate(view);
  await click(view, "开始假页面测试");
  await click(view, "交还并核验测试结果");
  assert.ok(view.getByAltText("假页面测试画面"));
  assert.equal((view.getByRole("button", { name: "Enter" }) as HTMLButtonElement).disabled, false);
  assert.equal(completions, 0);
  assert.equal(calls.filter((call) => call.action === "close").length, 0);
  assert.equal(view.container.textContent!.includes("private verifier"), false);
});

test("failed public completion can retry without replaying protected handback", async (t) => {
  const calls = loginHttp(t);
  let submissions = 0;
  const view = renderControl(t, { attemptId: "attempt-a", onComplete: async () => { if (++submissions === 1) throw new Error("private delivery"); } });
  await authenticate(view);
  await click(view, "开始假页面测试");
  await click(view, "交还并核验测试结果");
  await click(view, "重试提交测试完成");
  assert.equal(submissions, 2);
  assert.equal(calls.filter((call) => call.action === "handback").length, 1);
  assert.equal(view.queryByAltText("假页面测试画面"), null);
  assert.equal(view.container.textContent!.includes("private delivery"), false);
});

test("native clients use only the active server and never fall back when none is selected", async (t) => {
  const calls = loginHttp(t);
  const servers: ExperimentalServers = { status: "ready", servers: [{ id: "active", name: "active", origin: "https://active.fixture.invalid", kind: "account", active: true }], switchTo: () => {} };
  const view = renderControl(t, { attemptId: "attempt-a" }, servers);
  await authenticate(view);
  assert.ok(calls.every((call) => call.url.startsWith("https://active.fixture.invalid/")));
  view.unmount();
  const without = renderControl(t, { attemptId: "attempt-a" }, { ...servers, servers: servers.servers.map((server) => ({ ...server, active: false })) });
  assert.equal(without.queryByLabelText("控制密钥"), null);
  assert.equal(calls.length, 2);
});

test("proof expiry hides the frame and clears drafts before closing only the original attempt", async (t) => {
  const now = Date.now();
  const calls = loginHttp(t);
  const view = renderControl(t);
  await view.findByLabelText("控制密钥");
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now });
  await authenticate(view);
  await click(view, "开始假页面测试");
  fireEvent.change(view.getByLabelText("测试文字"), { target: { value: "private draft" } });
  await act(async () => { t.mock.timers.tick(300_000); });
  assert.equal(view.queryByAltText("假页面测试画面"), null);
  assert.equal(view.queryByLabelText("测试文字"), null);
  assert.equal(view.container.innerHTML.includes("private draft"), false);
  assert.deepEqual(calls.find((call) => call.action === "close")!.body, { attemptId: "attempt-a" });
});

test("scope changes discard late frames and clear the key before rendering the next attempt", async (t) => {
  let release!: (value: Response) => void;
  const held = new Promise<Response>((resolve) => { release = resolve; });
  let hold = false;
  const calls = loginHttp(t, (call) => call.action === "frame" && hold ? held : undefined);
  const view = renderControl(t);
  await authenticate(view);
  hold = true;
  await click(view, "开始假页面测试");
  const frame = calls.find((call) => call.action === "frame")!;
  await act(async () => { view.rerender(<LoginControls attemptId="attempt-b" />); });
  assert.equal(frame.init.signal!.aborted, true);
  assert.equal(view.queryByAltText("假页面测试画面"), null);
  await act(async () => { release(response({ width: 800, height: 600, png, frameRef })); });
  assert.equal(view.queryByAltText("假页面测试画面"), null);
  assert.equal((view.getByLabelText("控制密钥") as HTMLInputElement).value, "");
  assert.deepEqual(calls.find((call) => call.action === "close")!.body, { attemptId: "attempt-a" });
});

test("unsupported and terminal attempts never render a control-key form", async (t) => {
  loginHttp(t, (call) => call.action === "status" ? response({ ...attempt(), mode: "oci_web", phase: "unsupported", failure: "unsupported" }) : undefined);
  const view = renderControl(t);
  await view.findByText(/此请求当前不能接管/);
  assert.equal(view.queryByLabelText("控制密钥"), null);
  assert.equal(view.queryByRole("button", { name: "开始假页面测试" }), null);
});

test("already verified native cards offer explicit public completion without reopening control", async (t) => {
  const record = attempt();
  const verifiedAt = Date.now();
  const calls = loginHttp(t, (call) => call.action === "status" ? response({ ...record, principalId: "principal-a", phase: "verified",
    updatedAt: verifiedAt, verification: { id: "verification-a", kind: "synthetic", verifiedAt }, resume: { state: "pending", deliveryId: null } }) : undefined);
  const submissions: unknown[] = [];
  const view = renderSlot({ component: LoginControlInteraction }, {
    interaction: { id: "interaction-a", threadId: "thread-a", title: "fixture", payload: { attemptId: "attempt-a" }, createdAt: Date.now(), expiresAt: null },
    submit: async (value: unknown) => { submissions.push(value); }, cancel: async () => undefined,
  }, { pluginId: "remote-login", context: { threadId: "thread-a" } });
  t.after(() => view.unmount());
  await view.findByRole("button", { name: "提交已核验测试完成" });
  assert.deepEqual(submissions, []);
  assert.equal(view.queryByLabelText("控制密钥"), null);
  await click(view, "提交已核验测试完成");
  assert.deepEqual(submissions, [{ attemptId: "attempt-a" }]);
  assert.deepEqual(calls.map((call) => call.action), ["status"]);
});

test("an existing browser cannot mint another grant and shows its bound target", async (t) => {
  loginHttp(t, (call) => call.action === "status" ? response({ ...attempt(), phase: "user_control", principalId: "principal-a" }) : undefined);
  const view = renderControl(t);
  await view.findByText("host-a");
  assert.ok(view.getByText("environment-a"));
  assert.ok(view.getByText("thread-a"));
  assert.ok(view.getByText("用户控制中"));
  assert.equal(view.queryByLabelText("控制密钥"), null);
});

test("repeated authentication taps cannot issue concurrent control grants", async (t) => {
  let complete!: (response: Response) => void;
  const calls = loginHttp(t, (call) => call.action === "session" ? new Promise<Response>((resolve) => { complete = resolve; }) : undefined);
  const view = renderControl(t);
  await view.findByLabelText("控制密钥");
  fireEvent.change(view.getByLabelText("控制密钥"), { target: { value: key } });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "验证并接管测试" }));
    fireEvent.click(view.getByRole("button", { name: "验证并接管测试" }));
  });
  assert.equal(calls.filter((call) => call.action === "session").length, 1);
  await act(async () => { complete(response({ error: "refused" }, 409)); });
});

test("leaving during handback discards its late completion and closes only its original attempt", async (t) => {
  let complete!: (response: Response) => void;
  let completions = 0;
  const calls = loginHttp(t, (call) => call.action === "handback" ? new Promise<Response>((resolve) => { complete = resolve; }) : undefined);
  const view = renderControl(t, { attemptId: "attempt-a", onComplete: async () => { completions += 1; } });
  await authenticate(view);
  await click(view, "开始假页面测试");
  await click(view, "交还并核验测试结果");
  await act(async () => { view.rerender(<LoginControls attemptId="attempt-b" />); });
  assert.equal(calls.find((call) => call.action === "handback")!.init.signal!.aborted, true);
  await act(async () => { complete(response({ verified: true })); });
  assert.equal(completions, 0);
  assert.deepEqual(calls.find((call) => call.action === "close")!.body, { attemptId: "attempt-a" });
  assert.equal(view.queryByAltText("假页面测试画面"), null);
});

test("explicit native stop cancels the waiting interaction only after confirmed protected close", async (t) => {
  const calls = loginHttp(t);
  let cancellations = 0;
  const view = renderSlot({ component: LoginControlInteraction }, {
    interaction: { id: "interaction-a", threadId: "thread-a", title: "fixture", payload: { attemptId: "attempt-a" }, createdAt: Date.now(), expiresAt: null },
    submit: async () => assert.fail("stop is not verification"), cancel: async () => { assert.equal(calls.at(-1)!.action, "close"); cancellations += 1; },
  }, { pluginId: "remote-login", context: { threadId: "thread-a" } });
  t.after(() => view.unmount());
  await authenticate(view);
  await click(view, "开始假页面测试");
  await click(view, "停止假页面测试");
  assert.equal(cancellations, 1);
  assert.equal(view.queryByAltText("假页面测试画面"), null);
  view.unmount();
  assert.equal(calls.filter((call) => call.action === "close").length, 1);
  assert.equal(cancellations, 1);
});

test("a failed close offers explicit cancellation without claiming confirmed cleanup", async (t) => {
  loginHttp(t, (call) => call.action === "close" ? response({ error: "private close" }, 503) : undefined);
  let cancellations = 0;
  const view = renderSlot({ component: LoginControlInteraction }, {
    interaction: { id: "interaction-a", threadId: "thread-a", title: "fixture", payload: { attemptId: "attempt-a" }, createdAt: Date.now(), expiresAt: null },
    submit: async () => assert.fail("close is not verification"), cancel: async () => { cancellations += 1; },
  }, { pluginId: "remote-login", context: { threadId: "thread-a" } });
  t.after(() => view.unmount());
  await authenticate(view);
  await click(view, "开始假页面测试");
  await click(view, "停止假页面测试");
  assert.equal(cancellations, 0);
  assert.match(view.container.textContent!, /清理尚未确认/);
  assert.equal(view.container.textContent!.includes("private close"), false);
  await click(view, "取消等待（清理未确认）");
  assert.equal(cancellations, 1);
  assert.equal(view.container.textContent!.includes("清理已完成"), false);
});

test("unmount cleanup never cancels the native interaction automatically", async (t) => {
  const calls = loginHttp(t);
  let cancellations = 0;
  const view = renderSlot({ component: LoginControlInteraction }, {
    interaction: { id: "interaction-a", threadId: "thread-a", title: "fixture", payload: { attemptId: "attempt-a" }, createdAt: Date.now(), expiresAt: null },
    submit: async () => assert.fail("unmount is not verification"), cancel: async () => { cancellations += 1; },
  }, { pluginId: "remote-login", context: { threadId: "thread-a" } });
  await authenticate(view);
  await click(view, "开始假页面测试");
  await act(async () => { view.unmount(); });
  assert.equal(calls.filter((call) => call.action === "close").length, 1);
  assert.equal(cancellations, 0);
});

test("an open native card can refresh authoritative status after history completed verification", async (t) => {
  let verified = false;
  const calls = loginHttp(t, (call) => {
    if (call.action !== "status" || !verified) return;
    const record = attempt();
    const verifiedAt = Date.now();
    return response({ ...record, principalId: "principal-a", phase: "verified", updatedAt: verifiedAt,
      verification: { id: "verification-a", kind: "synthetic", verifiedAt }, resume: { state: "pending", deliveryId: null } });
  });
  const submissions: unknown[] = [];
  const view = renderSlot({ component: LoginControlInteraction }, {
    interaction: { id: "interaction-a", threadId: "thread-a", title: "fixture", payload: { attemptId: "attempt-a" }, createdAt: Date.now(), expiresAt: null },
    submit: async (value: unknown) => { submissions.push(value); }, cancel: async () => undefined,
  }, { pluginId: "remote-login", context: { threadId: "thread-a" } });
  t.after(() => view.unmount());
  await view.findByLabelText("控制密钥");
  fireEvent.change(view.getByLabelText("控制密钥"), { target: { value: key } });
  verified = true;
  await click(view, "刷新测试状态");
  assert.equal(view.queryByLabelText("控制密钥"), null);
  await click(view, "提交已核验测试完成");
  assert.deepEqual(submissions, [{ attemptId: "attempt-a" }]);
  assert.deepEqual(calls.map((call) => call.action), ["status", "status"]);
  assert.equal(view.container.innerHTML.includes(key), false);
});

test("status refresh cannot tear down an actively controlled browser", async (t) => {
  const calls = loginHttp(t);
  const view = renderControl(t);
  await authenticate(view);
  await click(view, "开始假页面测试");
  const refresh = view.getByRole("button", { name: "刷新测试状态" }) as HTMLButtonElement;
  assert.equal(refresh.disabled, true);
  fireEvent.click(refresh);
  assert.ok(view.getByAltText("假页面测试画面"));
  assert.equal(calls.filter((call) => call.action === "status").length, 1);
  assert.equal(calls.filter((call) => call.action === "close").length, 0);
});

test("an explicit native stop settles its original waiting card after unmount", async (t) => {
  let acknowledge!: (response: Response) => void;
  const calls = loginHttp(t, (call) => call.action === "close" ? new Promise<Response>((resolve) => { acknowledge = resolve; }) : undefined);
  let cancellations = 0;
  const view = renderSlot({ component: LoginControlInteraction }, {
    interaction: { id: "interaction-a", threadId: "thread-a", title: "fixture", payload: { attemptId: "attempt-a" }, createdAt: Date.now(), expiresAt: null },
    submit: async () => assert.fail("stop is not verification"), cancel: async () => { cancellations += 1; },
  }, { pluginId: "remote-login", context: { threadId: "thread-a" } });
  await authenticate(view);
  await click(view, "开始假页面测试");
  await click(view, "停止假页面测试");
  await act(async () => { view.unmount(); });
  assert.equal(calls.find((call) => call.action === "close")!.init.signal!.aborted, false);
  assert.equal(cancellations, 0);
  await act(async () => { acknowledge(response({ closed: true })); });
  assert.equal(cancellations, 1);
  assert.equal(calls.filter((call) => call.action === "close").length, 1);
});

test("an explicit stop cannot cancel a replacement native interaction", async (t) => {
  let acknowledge!: (response: Response) => void;
  const calls = loginHttp(t, (call) => call.action === "close" ? new Promise<Response>((resolve) => { acknowledge = resolve; }) : undefined);
  let original = 0, replacement = 0;
  const props: PluginPendingInteractionProps = {
    interaction: { id: "interaction-a", threadId: "thread-a", title: "fixture", payload: { attemptId: "attempt-a" }, createdAt: Date.now(), expiresAt: null },
    submit: async () => assert.fail("stop is not verification"), cancel: async () => { original += 1; },
  };
  const view = renderSlot({ component: LoginControlInteraction }, props, { pluginId: "remote-login", context: { threadId: "thread-a" } });
  t.after(() => view.unmount());
  await authenticate(view);
  await click(view, "开始假页面测试");
  await click(view, "停止假页面测试");
  await act(async () => { view.rerender(<LoginControlInteraction {...props} interaction={{ ...props.interaction, id: "interaction-b", payload: { attemptId: "attempt-b" } }} cancel={async () => { replacement += 1; }} />); });
  await act(async () => { acknowledge(response({ closed: true })); });
  assert.equal(original, 1);
  assert.equal(replacement, 0);
  assert.deepEqual(calls.find((call) => call.action === "close")!.body, { attemptId: "attempt-a" });
  assert.equal(view.queryByAltText("假页面测试画面"), null);
});


test("manual renewal preserves the draft and lease but requires a fresh image for the replacement proof", async (t) => {
  const renewed = "B".repeat(43);
  const calls = loginHttp(t, (call) => call.action === "renew" ? response({ capability: renewed, expiresAt: Date.now() + 300_000 }) : undefined);
  const view = renderControl(t);
  await authenticate(view);
  await click(view, "开始假页面测试");
  const text = view.getByLabelText("测试文字") as HTMLInputElement;
  text.focus(); fireEvent.change(text, { target: { value: "draft through renewal" } });
  await click(view, "延长测试控制授权");
  assert.equal(view.queryByAltText("假页面测试画面") === null, true);
  assert.equal(view.getByLabelText("测试文字") === text, true);
  assert.equal(text.value, "draft through renewal");
  assert.equal(text.disabled, true);
  assert.deepEqual(calls.map((call) => call.action), ["status", "session", "start", "frame", "renew"]);
  assert.deepEqual(calls.at(-1)!.body, { attemptId: "attempt-a" });
  assert.equal(new Headers(calls.at(-1)!.init.headers).get("authorization"), `Bearer ${capability}`);
  await click(view, "刷新私有浏览器画面");
  assert.equal(text.disabled, false);
  await click(view, "Enter");
  assert.equal(calls.find(call => call.action === "input")!.body.frameRef, "11111111-1111-4111-8111-111111111112");
  assert.ok(calls.slice(5).every((call) => new Headers(call.init.headers).get("authorization") === `Bearer ${renewed}`));
  await click(view, "停止假页面测试");
  assert.equal(new Headers(calls.at(-1)!.init.headers).get("authorization"), `Bearer ${renewed}`);
  assert.equal(calls.filter((call) => call.action === "start").length, 1);
  assert.equal(calls.filter((call) => call.action === "close").length, 1);
  assert.equal(view.container.innerHTML.includes(renewed), false);
});

test("renewal shares the viewer operation slot and refreshes its expiry timer", async (t) => {
  const now = Date.now();
  let release!: (value: Response) => void;
  const calls = loginHttp(t, (call) => call.action === "renew" ? new Promise<Response>((resolve) => { release = resolve; }) : undefined);
  const view = renderControl(t);
  await view.findByLabelText("控制密钥");
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now });
  await authenticate(view);
  await click(view, "开始假页面测试");
  await act(async () => { t.mock.timers.tick(290_000); });
  const frames = calls.filter((call) => call.action === "frame").length;
  const text = view.getByLabelText("测试文字") as HTMLInputElement;
  text.focus(); fireEvent.change(text, { target: { value: "keep typing locally" } });
  await click(view, "延长测试控制授权");
  assert.equal(text.disabled, true, "a proof rotation has invalidated its displayed frame");
  await click(view, "Enter"); await click(view, "交还并核验测试结果"); await click(view, "停止假页面测试"); await click(view, "延长测试控制授权");
  await act(async () => { t.mock.timers.tick(1000); });
  assert.equal(calls.filter((call) => call.action === "renew").length, 1);
  assert.equal(calls.filter((call) => call.action === "input" || call.action === "handback" || call.action === "close").length, 0);
  assert.equal(calls.filter((call) => call.action === "frame").length, frames);
  await act(async () => { release(response({ capability: "B".repeat(43), expiresAt: now + 590_000 })); });
  await act(async () => { t.mock.timers.tick(9000); });
  assert.ok(view.getByAltText("假页面测试画面"));
  assert.equal(text.value, "keep typing locally");
  await act(async () => { t.mock.timers.tick(290_000); });
  assert.equal(view.queryByAltText("假页面测试画面"), null);
  assert.equal(calls.filter((call) => call.action === "renew").length, 1);
  assert.equal(new Headers(calls.find((call) => call.action === "close")!.init.headers).get("authorization"), `Bearer ${"B".repeat(43)}`);
});

test("uncertain renewal terminates control without retrying renewal or allowing later input", async (t) => {
  const calls = loginHttp(t, (call) => call.action === "renew" ? Promise.reject(new Error("private renewal uncertainty")) : undefined);
  const view = renderControl(t);
  await authenticate(view); await click(view, "开始假页面测试");
  await click(view, "延长测试控制授权");
  assert.equal(view.queryByAltText("假页面测试画面"), null);
  assert.equal(view.queryByRole("button", { name: "Enter" }), null);
  assert.match(view.container.textContent!, /清理尚未确认/);
  assert.equal(view.container.innerHTML.includes("private renewal uncertainty"), false);
  assert.equal(calls.filter((call) => call.action === "renew").length, 1);
  assert.equal(calls.filter((call) => call.action === "input").length, 0);
});

test("late renewed grants cannot attach to a changed scope or an expired or unmounted controller", async (t) => {
  for (const transition of ["scope", "unmount", "expiry"] as const) await t.test(transition, async (t) => {
    let release!: (value: Response) => void;
    const calls = loginHttp(t, (call) => call.action === "renew" ? new Promise<Response>((resolve) => { release = resolve; }) : undefined);
    const view = renderControl(t);
    await view.findByLabelText("控制密钥");
    const now = Date.now();
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now });
    await authenticate(view); await click(view, "开始假页面测试"); await click(view, "延长测试控制授权");
    await act(async () => {
      if (transition === "scope") view.rerender(<LoginControls attemptId="attempt-b" />);
      else if (transition === "unmount") view.unmount();
      else t.mock.timers.tick(300_000);
    });
    await act(async () => { release(response({ capability: "B".repeat(43), expiresAt: now + 500_000 })); });
    assert.equal(view.queryByAltText("假页面测试画面"), null);
    const cleanup = calls.find((call) => call.action === "close" && new Headers(call.init.headers).get("authorization") === `Bearer ${"B".repeat(43)}`);
    assert.ok(cleanup, "late replacement proof must be used only for original-attempt cleanup");
    assert.deepEqual(cleanup.body, { attemptId: "attempt-a" });
    assert.equal(calls.filter((call) => call.action === "renew").length, 1);
    assert.equal(calls.filter((call) => call.action === "start").length, 1);
  });
});

test("renewed grants beyond the attempt deadline or original authority ceiling are refused", async (t) => {
  for (const invalid of ["attempt", "authority", "lifetime", "same-proof", "expired"] as const) await t.test(invalid, async (t) => {
    const now = Date.now();
    const record = { ...attempt(), expiresAt: now + (invalid === "authority" ? 1_200_000 : 600_000) };
    const calls = loginHttp(t, (call) => {
      if (call.action === "status") return response(record);
      if (call.action === "session") return response({ attempt: { ...record, phase: "awaiting_control", principalId: "principal-a" }, grant: { capability, expiresAt: now + 300_000 } });
      if (call.action === "renew") return response({ capability: invalid === "same-proof" ? capability : "B".repeat(43), expiresAt: invalid === "expired" ? now : now + (invalid === "authority" ? 900_001 : invalid === "attempt" ? 600_001 : invalid === "lifetime" ? 310_000 : 300_000) });
    });
    const view = renderControl(t);
    await authenticate(view); await click(view, "开始假页面测试"); await click(view, "延长测试控制授权");
    assert.equal(view.queryByAltText("假页面测试画面"), null);
    assert.equal(calls.filter((call) => call.action === "start").length, 1);
    assert.equal(calls.filter((call) => call.action === "renew").length, 1);
  });
});


test("renewal timeout ends local control even if the transport ignores abort, and later cleans only its replacement", async (t) => {
  let release!: (value: Response) => void;
  const calls = loginHttp(t, (call) => call.action === "renew" ? new Promise<Response>((resolve) => { release = resolve; }) : undefined);
  const view = renderControl(t);
  await view.findByLabelText("控制密钥");
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now });
  await authenticate(view); await click(view, "开始假页面测试"); await click(view, "延长测试控制授权");
  await act(async () => { t.mock.timers.tick(8000); });
  assert.ok(view.queryByAltText("假页面测试画面") === null, "renewal timeout must end the controller");
  assert.match(view.container.textContent!, /清理尚未确认/);
  assert.equal(calls.find((call) => call.action === "renew")!.init.signal!.aborted, true);
  await act(async () => { release(response({ capability: "B".repeat(43), expiresAt: now + 300_000 })); });
  assert.ok(view.queryByAltText("假页面测试画面") === null, "renewal timeout must end the controller");
  assert.equal(calls.filter((call) => call.action === "renew").length, 1);
  const cleanup = calls.find((call) => call.action === "close" && new Headers(call.init.headers).get("authorization") === `Bearer ${"B".repeat(43)}`);
  assert.deepEqual(cleanup?.body, { attemptId: "attempt-a" });
});


test("an expiry callback already queued for the consumed grant cannot expire its replacement", async (t) => {
  const now = Date.now();
  loginHttp(t, (call) => call.action === "renew" ? response({ capability: "B".repeat(43), expiresAt: now + 300_000 }) : undefined);
  const view = renderControl(t);
  await view.findByLabelText("控制密钥");
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now });
  const schedule = globalThis.setTimeout;
  const expirations: (() => void)[] = [];
  t.mock.method(globalThis, "setTimeout", ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 300_000) expirations.push(() => callback(...args));
    return schedule(callback, delay, ...args);
  }) as typeof setTimeout);
  await authenticate(view); await click(view, "开始假页面测试");
  const expiredOldGrant = expirations[0]!;
  assert.ok(expiredOldGrant);
  await click(view, "延长测试控制授权");
  await act(async () => { expiredOldGrant(); });
  assert.equal(view.queryByAltText("假页面测试画面") === null, true);
  await click(view, "刷新私有浏览器画面");
  assert.ok(view.queryByAltText("假页面测试画面"), "a queued old expiry must ignore the refreshed proof");
  await click(view, "Enter");
});

test("unmount between renewal transport completion and viewer continuation closes the replacement proof", async (t) => {
  const calls = loginHttp(t, (call) => call.action === "renew" ? response({ capability: "B".repeat(43), expiresAt: Date.now() + 300_000 }) : undefined);
  const view = renderControl(t);
  await authenticate(view); await click(view, "开始假页面测试");
  const parse = JSON.parse;
  t.mock.method(JSON, "parse", (text: string) => {
    const value: unknown = parse(text);
    if (value && typeof value === "object" && "capability" in value && value.capability === "B".repeat(43)) {
      // Enter the gap after the transport accepts the response, before the viewer resumes.
      queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => view.unmount())));
    }
    return value;
  });
  await click(view, "延长测试控制授权");
  assert.ok(view.queryByAltText("假页面测试画面") === null);
  const close = calls.find((call) => call.action === "close");
  assert.ok(close);
  assert.equal(new Headers(close.init.headers).get("authorization"), `Bearer ${"B".repeat(43)}`);
  assert.deepEqual(close.body, { attemptId: "attempt-a" });
});


test("manual renewal before browser start replaces proof without opening a lease", async (t) => {
  const calls = loginHttp(t, (call) => call.action === "renew" ? response({ capability: "B".repeat(43), expiresAt: Date.now() + 300_000 }) : undefined);
  const view = renderControl(t);
  await authenticate(view);
  const text = view.getByLabelText("测试文字");
  await click(view, "延长测试控制授权");
  assert.equal(view.getByLabelText("测试文字"), text);
  assert.deepEqual(calls.map((call) => call.action), ["status", "session", "renew"]);
  await click(view, "开始假页面测试");
  assert.equal(new Headers(calls.find((call) => call.action === "start")!.init.headers).get("authorization"), `Bearer ${"B".repeat(43)}`);
});

test("repeated renewal keeps the original fifteen-minute ceiling instead of extending it", async (t) => {
  const now = Date.now();
  const record = { ...attempt(), expiresAt: now + 1_200_000 };
  let renewals = 0;
  const calls = loginHttp(t, (call) => {
    if (call.action === "status") return response(record);
    if (call.action === "session") return response({ attempt: { ...record, phase: "awaiting_control", principalId: "principal-a" }, grant: { capability, expiresAt: now + 300_000 } });
    if (call.action === "renew") return response({ capability: ["B", "C", "D"][renewals++]!.repeat(43), expiresAt: Date.now() + 300_000 });
  });
  const view = renderControl(t);
  await view.findByLabelText("控制密钥");
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now });
  await authenticate(view); await click(view, "开始假页面测试");
  for (let index = 0; index < 2; index++) {
    await act(async () => { t.mock.timers.tick(240_000); });
    await click(view, "延长测试控制授权");
    assert.equal(view.queryByAltText("假页面测试画面") === null, true);
    await click(view, "刷新私有浏览器画面");
    assert.ok(view.getByAltText("假页面测试画面"));
  }
  await act(async () => { t.mock.timers.tick(240_000); });
  await click(view, "延长测试控制授权");
  assert.ok(view.queryByAltText("假页面测试画面") === null, "a five-minute replacement after twelve minutes exceeds original authority");
  assert.equal(calls.filter((call) => call.action === "renew").length, 3);
  assert.equal(calls.filter((call) => call.action === "start").length, 1);
  const cleanup = calls.find((call) => call.action === "close");
  assert.equal(new Headers(cleanup!.init.headers).get("authorization"), `Bearer ${"D".repeat(43)}`);
});

const expectedOci = { mode: "oci_cli", tenancyOcid: "ocid1.tenancy.oc1..selectedtenancy", userOcid: "ocid1.user.oc1..selecteduser", region: "ap-sydney-1", realm: "oc1" } as const;
function ociHttp(t: TestContext, options: { mode?: "oci_cli" | "oci_web"; accepted?: boolean; intercept?: (call: Call) => Response | Promise<Response> | undefined } = {}) {
  let configured = false;
  return loginHttp(t, (call) => {
    const intercepted = options.intercept?.(call);
    if (intercepted) return intercepted;
    const record = { ...attempt(String(call.body.attemptId)), mode: options.mode ?? "oci_cli" };
    if (call.action === "status") return response(record);
    if (call.action === "session") return response({ grant: { capability, expiresAt: Date.now() + 300_000 }, attempt: { ...record, phase: "awaiting_control", principalId: "principal-a", revision: 1 } });
    if (call.action === (options.mode === "oci_web" ? "console-status" : "oci-status")) return response({ configured, phoneControlAccepted: options.accepted ?? true, phase: configured ? "ready" : "unconfigured", failure: null });
    if (call.action === (options.mode === "oci_web" ? "console-target" : "oci-target")) { configured = true; return response({ configured: true }); }
  });
}
async function authenticateOci(view: ReturnType<typeof renderControl>) {
  const field = view.queryByLabelText("控制密钥") ?? await view.findByLabelText("控制密钥");
  fireEvent.change(field, { target: { value: key } });
  await click(view, "验证 OCI 控制密钥");
}
async function selectOciTarget(view: ReturnType<typeof renderControl>) {
  for (const [label, value] of [["目标 Tenancy OCID", expectedOci.tenancyOcid], ["目标 User OCID", expectedOci.userOcid], ["目标 Region", expectedOci.region]]) {
    fireEvent.change(view.getByLabelText(label), { target: { value } });
  }
  await click(view, "确认私有 OCI CLI 目标");
}

test("OCI requires accepted phone control before sending a private target or starting a browser", async (t) => {
  let accepted = false;
  const calls = ociHttp(t, { accepted: false, intercept: (call) => call.action === "oci-status" ? response({ configured: false, phoneControlAccepted: accepted, phase: "unconfigured", failure: null }) : undefined });
  const view = renderControl(t);
  await authenticateOci(view);
  for (const [label, value] of [["目标 Tenancy OCID", expectedOci.tenancyOcid], ["目标 User OCID", expectedOci.userOcid], ["目标 Region", expectedOci.region]]) fireEvent.change(view.getByLabelText(label), { target: { value } });
  const select = view.getByRole("button", { name: "确认私有 OCI CLI 目标" }) as HTMLButtonElement;
  assert.equal(select.disabled, true);
  fireEvent.click(select);
  assert.equal(calls.filter((call) => call.action === "oci-target").length, 0);
  assert.equal(calls.filter((call) => call.action === "start").length, 0);
  assert.equal(view.queryByRole("button", { name: "开始 OCI CLI 登录" }), null);
  assert.match(view.container.textContent!, /手机控制验收/);
  assert.deepEqual(view.inspection.rpcCalls, []);
  accepted = true;
  await click(view, "检查 OCI 启动条件");
  assert.equal((view.getByRole("button", { name: "确认私有 OCI CLI 目标" }) as HTMLButtonElement).disabled, false);
});

test("OCI target values are cleared before private selection returns and never enter public interaction state", async (t) => {
  let complete!: (value: Response) => void;
  const calls = ociHttp(t, { intercept: (call) => call.action === "oci-target" ? new Promise<Response>((resolve) => { complete = resolve; }) : undefined });
  const view = renderControl(t);
  await authenticateOci(view);
  await selectOciTarget(view);
  assert.equal((view.getByLabelText("目标 User OCID") as HTMLInputElement).value, "");
  assert.equal(view.container.innerHTML.includes(expectedOci.userOcid), false);
  assert.equal(view.container.innerHTML.includes(expectedOci.tenancyOcid), false);
  const selection = calls.find((call) => call.action === "oci-target")!;
  assert.deepEqual(selection.body, { attemptId: "attempt-a", expected: expectedOci });
  assert.equal(new Headers(selection.init.headers).get("authorization"), `Bearer ${capability}`);
  assert.deepEqual(view.inspection.rpcCalls, []);
  await act(async () => { complete(response({ error: "refused" }, 409)); });
});


test("OCI protected provider handback alone completes the original card and pending verification preserves control", async (t) => {
  let pending = true;
  const calls = ociHttp(t, { intercept: (call) => call.action === "handback" && pending ? response({ error: "still waiting" }, 409) : undefined });
  const submissions: unknown[] = [];
  const view = renderSlot({ component: LoginControlInteraction }, {
    interaction: { id: "oci-interaction", threadId: "thread-a", title: "OCI", payload: { attemptId: "attempt-a" }, createdAt: Date.now(), expiresAt: null },
    submit: async (value: unknown) => { submissions.push(value); }, cancel: async () => undefined,
  }, { pluginId: "remote-login", context: { threadId: "thread-a" } });
  t.after(() => view.unmount());
  await authenticateOci(view); await selectOciTarget(view);
  await click(view, "开始 OCI CLI 登录");
  assert.ok(view.getByAltText("OCI 私有登录画面"));
  await click(view, "交还并授权只读");
  assert.ok(view.getByAltText("OCI 私有登录画面"));
  assert.deepEqual(submissions, []);
  assert.equal(calls.filter((call) => call.action === "close").length, 0);
  pending = false;
  await click(view, "交还并授权只读");
  assert.deepEqual(submissions, [{ attemptId: "attempt-a" }]);
  assert.equal(view.queryByAltText("OCI 私有登录画面"), null);
  assert.equal(view.container.innerHTML.includes(expectedOci.userOcid), false);
});

test("pending OCI verification pauses browser I/O, permits manual renewal and polls only handback until verified", async (t) => {
  let verified = false;
  const calls = ociHttp(t, { intercept: (call) => {
    if (call.action === "handback") return response(verified ? { verified: true } : { pending: true }, verified ? 200 : 202);
    if (call.action === "renew") return response({ capability: "B".repeat(43), expiresAt: Date.now() + 300_000 });
  } });
  let completions = 0;
  const view = renderControl(t, { attemptId: "attempt-a", onComplete: async () => { completions += 1; } });
  await view.findByLabelText("控制密钥");
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  await authenticateOci(view); await selectOciTarget(view); await click(view, "开始 OCI CLI 登录");
  fireEvent.change(view.getByLabelText("OCI 登录文字（仅发送到私有浏览器）"), { target: { value: "private draft" } });
  await click(view, "交还并授权只读");
  assert.equal((view.getByLabelText("OCI 登录文字（仅发送到私有浏览器）") as HTMLInputElement).value, "");
  assert.equal((view.getByRole("button", { name: "Enter" }) as HTMLButtonElement).disabled, true);
  assert.equal(completions, 0);
  assert.equal((view.getByRole("button", { name: "延长 OCI 控制授权" }) as HTMLButtonElement).disabled, false);
  await click(view, "延长 OCI 控制授权");
  await act(async () => { t.mock.timers.tick(1000); });
  assert.equal(calls.filter((call) => call.action === "frame").length, 1);
  assert.equal(calls.filter((call) => call.action === "input").length, 0);
  assert.equal(calls.filter((call) => call.action === "handback").length, 2);
  verified = true;
  await act(async () => { t.mock.timers.tick(1000); });
  assert.equal(completions, 1);
  assert.equal(view.queryByAltText("OCI 私有登录画面"), null);
  assert.equal(calls.filter((call) => call.action === "close").length, 0);
  assert.equal(new Headers(calls.filter((call) => call.action === "handback").at(-1)!.init.headers).get("authorization"), `Bearer ${"B".repeat(43)}`);
});

test("OCI can stop its protected session before a private target is selected", async (t) => {
  const calls = ociHttp(t, { accepted: false });
  let cancelled = 0;
  const view = renderSlot({ component: LoginControlInteraction }, {
    interaction: { id: "oci-interaction", threadId: "thread-a", title: "OCI", payload: { attemptId: "attempt-a" }, createdAt: Date.now(), expiresAt: null },
    submit: async () => assert.fail("cancel is not verification"), cancel: async () => { assert.equal(calls.at(-1)!.action, "close"); cancelled += 1; },
  }, { pluginId: "remote-login", context: { threadId: "thread-a" } });
  t.after(() => view.unmount());
  await authenticateOci(view);
  fireEvent.change(view.getByLabelText("目标 User OCID"), { target: { value: expectedOci.userOcid } });
  await click(view, "停止 OCI CLI 登录");
  assert.equal(cancelled, 1);
  assert.equal(calls.filter((call) => call.action === "start").length, 0);
  assert.equal(view.container.innerHTML.includes(expectedOci.userOcid), false);
});

test("OCI status refresh cannot overlap browser startup", async (t) => {
  let complete!: (value: Response) => void;
  const calls = ociHttp(t, { intercept: (call) => call.action === "start" ? new Promise<Response>((resolve) => { complete = resolve; }) : undefined });
  const view = renderControl(t);
  await authenticateOci(view); await selectOciTarget(view); await click(view, "开始 OCI CLI 登录");
  const count = calls.filter((call) => call.action === "oci-status").length;
  const refresh = view.getByRole("button", { name: "检查 OCI 启动条件" }) as HTMLButtonElement;
  assert.equal(refresh.disabled, true);
  fireEvent.click(refresh);
  assert.equal(calls.filter((call) => call.action === "oci-status").length, count);
  await act(async () => { complete(response({ width: 800, height: 600 })); });
});

test("stopping OCI before target selection retains its close request and original cancellation after leaving", async (t) => {
  let complete!: (value: Response) => void;
  const calls = ociHttp(t, { accepted: false, intercept: (call) => call.action === "close" ? new Promise<Response>((resolve) => { complete = resolve; }) : undefined });
  let cancelled = 0;
  const view = renderSlot({ component: LoginControlInteraction }, {
    interaction: { id: "oci-interaction", threadId: "thread-a", title: "OCI", payload: { attemptId: "attempt-a" }, createdAt: Date.now(), expiresAt: null },
    submit: async () => assert.fail("cancel is not verification"), cancel: async () => { cancelled += 1; },
  }, { pluginId: "remote-login", context: { threadId: "thread-a" } });
  t.after(() => view.unmount());
  await authenticateOci(view); await click(view, "停止 OCI CLI 登录");
  await act(async () => { view.unmount(); });
  try { assert.equal(calls.find((call) => call.action === "close")!.init.signal!.aborted, false); }
  finally { await act(async () => { complete(response({ closed: true })); }); }
  assert.equal(cancelled, 1);
});

test("OCI startup polls readiness beyond eight seconds without starting again or requesting a premature frame", async (t) => {
  let starting = false;
  let ready = false;
  const calls = ociHttp(t, { intercept: (call) => {
    if (call.action === "start") { starting = true; return response({ pending: true }, 202); }
    if (call.action === "oci-status" && starting) return response({ configured: true, phoneControlAccepted: true, phase: ready ? "user_control" : "starting", failure: null });
    if (call.action === "renew") return response({ capability: "B".repeat(43), expiresAt: Date.now() + 300_000 });
  } });
  const view = renderControl(t);
  await view.findByLabelText("控制密钥");
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
  await authenticateOci(view); await selectOciTarget(view); await click(view, "开始 OCI CLI 登录");
  assert.equal(calls.filter((call) => call.action === "frame").length, 0);
  assert.equal((view.getByRole("button", { name: "Enter" }) as HTMLButtonElement).disabled, true);
  assert.equal((view.getByRole("button", { name: "开始 OCI CLI 登录" }) as HTMLButtonElement).disabled, true);
  assert.match(view.container.textContent!, /启动中/);
  for (let index = 0; index < 10; index++) await act(async () => { t.mock.timers.tick(1000); });
  assert.equal(calls.filter((call) => call.action === "start").length, 1);
  assert.equal(calls.filter((call) => call.action === "frame").length, 0);
  assert.equal(calls.filter((call) => call.action === "close").length, 0);
  assert.equal((view.getByRole("button", { name: "停止 OCI CLI 登录" }) as HTMLButtonElement).disabled, false);
  await click(view, "延长 OCI 控制授权");
  ready = true;
  await act(async () => { t.mock.timers.tick(1000); });
  assert.ok(view.getByAltText("OCI 私有登录画面"));
  assert.equal((view.getByRole("button", { name: "Enter" }) as HTMLButtonElement).disabled, false);
  assert.equal(calls.filter((call) => call.action === "frame").length, 1);
  assert.equal(new Headers(calls.filter((call) => call.action === "oci-status").at(-1)!.init.headers).get("authorization"), `Bearer ${"B".repeat(43)}`);
});

test("OCI startup can be stopped before browser readiness and cancels only after protected closure", async (t) => {
  const calls = ociHttp(t, { intercept: (call) => call.action === "start" ? response({ pending: true }, 202) : undefined });
  let cancelled = 0;
  const view = renderSlot({ component: LoginControlInteraction }, {
    interaction: { id: "oci-interaction", threadId: "thread-a", title: "OCI", payload: { attemptId: "attempt-a" }, createdAt: Date.now(), expiresAt: null },
    submit: async () => assert.fail("startup is not verification"), cancel: async () => { assert.equal(calls.at(-1)!.action, "close"); cancelled += 1; },
  }, { pluginId: "remote-login", context: { threadId: "thread-a" } });
  t.after(() => view.unmount());
  await authenticateOci(view); await selectOciTarget(view); await click(view, "开始 OCI CLI 登录");
  await click(view, "停止 OCI CLI 登录");
  assert.equal(cancelled, 1);
  assert.equal(calls.filter((call) => call.action === "start").length, 1);
  assert.equal(calls.filter((call) => call.action === "frame").length, 0);
  assert.equal(calls.filter((call) => call.action === "close").length, 1);
});

test("late OCI startup readiness cannot attach to a replacement attempt and closes only its original browser", async (t) => {
  let starting = false;
  let release!: (value: Response) => void;
  const calls = ociHttp(t, { intercept: (call) => {
    if (call.action === "start") { starting = true; return response({ pending: true }, 202); }
    if (call.action === "oci-status" && starting) return new Promise<Response>((resolve) => { release = resolve; });
  } });
  const view = renderControl(t);
  await view.findByLabelText("控制密钥");
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  await authenticateOci(view); await selectOciTarget(view); await click(view, "开始 OCI CLI 登录");
  await act(async () => { t.mock.timers.tick(1000); });
  const status = calls.filter((call) => call.action === "oci-status").at(-1)!;
  await act(async () => { view.rerender(<LoginControls attemptId="attempt-b" />); });
  assert.equal(status.init.signal!.aborted, true);
  await act(async () => { release(response({ configured: true, phoneControlAccepted: true, phase: "user_control", failure: null })); });
  assert.equal(view.queryByAltText("OCI 私有登录画面"), null);
  assert.equal(calls.filter((call) => call.action === "frame").length, 0);
  assert.deepEqual(calls.find((call) => call.action === "close")!.body, { attemptId: "attempt-a" });
});

test("OCI handback explicitly delegates only compartments and Sydney instance reads to the original task", async (t) => {
  const calls = ociHttp(t);
  let completed = 0;
  const view = renderControl(t, { attemptId: "attempt-a", onComplete: async () => { completed += 1; } });
  await authenticateOci(view); await selectOciTarget(view); await click(view, "开始 OCI CLI 登录");
  assert.ok(view.getByText(/原任务.*compartments.*ap-sydney-1.*实例/));
  await click(view, "交还并授权只读");
  assert.equal(completed, 1);
  assert.deepEqual(calls.find((call) => call.action === "handback")!.body, { attemptId: "attempt-a" });
  assert.equal(view.queryByAltText("OCI 私有登录画面"), null);
});

const expectedConsole = { mode: "oci_web", userOcid: "ocid1.user.oc1..selecteduser", tenancyOcid: "ocid1.tenancy.oc1..selectedtenancy",
  domainOcid: "ocid1.domain.oc1..selecteddomain", domainOrigin: "https://selected.identity.oraclecloud.com", region: "ap-sydney-1", realm: "oc1" } as const;
async function selectConsoleTarget(view: ReturnType<typeof renderControl>) {
  for (const [label, value] of [["目标 Tenancy OCID", expectedConsole.tenancyOcid], ["目标 User OCID", expectedConsole.userOcid],
    ["目标 Domain OCID", expectedConsole.domainOcid], ["目标 Domain Origin", expectedConsole.domainOrigin]]) fireEvent.change(view.getByLabelText(label), { target: { value } });
  await click(view, "确认私有 OCI Console 目标");
}

test("Console selects independent private identity behind the paired gate and clears drafts before the request settles", async (t) => {
  let complete!: (value: Response) => void;
  const calls = ociHttp(t, { mode: "oci_web", intercept: (call) => call.action === "console-target" ? new Promise<Response>((resolve) => { complete = resolve; }) : undefined });
  const view = renderControl(t);
  await authenticateOci(view);
  assert.equal((view.getByLabelText("目标 Region") as HTMLInputElement).value, "ap-sydney-1");
  assert.equal((view.getByLabelText("目标 Region") as HTMLInputElement).readOnly, true);
  await selectConsoleTarget(view);
  for (const label of ["目标 User OCID", "目标 Tenancy OCID", "目标 Domain OCID", "目标 Domain Origin"]) assert.equal((view.getByLabelText(label) as HTMLInputElement).value, "");
  const call = calls.find((call) => call.action === "console-target")!;
  assert.deepEqual(call.body, { attemptId: "attempt-a", expected: expectedConsole });
  assert.equal(new Headers(call.init.headers).get("authorization"), `Bearer ${capability}`);
  assert.deepEqual(view.inspection.rpcCalls, []);
  for (const secret of [expectedConsole.userOcid, expectedConsole.tenancyOcid, expectedConsole.domainOcid, expectedConsole.domainOrigin, capability]) assert.equal(view.container.innerHTML.includes(secret), false);
  await act(async () => { complete(response({ configured: true })); });
});

test("Console handback delegates only same-context identity and page outline reads, and submits only attemptId", async (t) => {
  const calls = ociHttp(t, { mode: "oci_web" });
  const submissions: unknown[] = [];
  const view = renderSlot({ component: LoginControlInteraction }, {
    interaction: { id: "console-interaction", threadId: "thread-a", title: "Console", payload: { attemptId: "attempt-a" }, createdAt: Date.now(), expiresAt: null },
    submit: async (value: unknown) => { submissions.push(value); }, cancel: async () => undefined,
  }, { pluginId: "remote-login", context: { threadId: "thread-a" } });
  t.after(() => view.unmount());
  await authenticateOci(view); await selectConsoleTarget(view); await click(view, "开始 OCI Console 登录");
  assert.ok(view.getByText(/原任务.*read_identity.*read_page/));
  assert.ok(view.getByText(/保留.*浏览器.*不.*表单.*输入.*Cookie.*截图/));
  await click(view, "交还并授权只读");
  assert.deepEqual(submissions, [{ attemptId: "attempt-a" }]);
  assert.deepEqual(calls.find((call) => call.action === "handback")!.body, { attemptId: "attempt-a" });
  assert.equal(view.queryByAltText("OCI 私有登录画面"), null);
  await act(async () => { view.unmount(); });
  assert.equal(calls.filter((call) => call.action === "close").length, 0);
});

test("Console readiness uses protected status polling and unmounted pending handback retains the exact host browser", async (t) => {
  let starting = false, ready = false;
  const calls = ociHttp(t, { mode: "oci_web", intercept: (call) => {
    if (call.action === "start") { starting = true; return response({ pending: true }, 202); }
    if (call.action === "console-status" && starting) return response({ configured: true, phoneControlAccepted: true, phase: ready ? "user_control" : "starting", failure: null });
    if (call.action === "handback") return response({ pending: true }, 202);
  } });
  let submitted = 0;
  const view = renderControl(t, { attemptId: "attempt-a", onComplete: async () => { submitted++; } });
  await view.findByLabelText("控制密钥");
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  await authenticateOci(view); await selectConsoleTarget(view);
  await click(view, "开始 OCI Console 登录");
  assert.equal(calls.filter((call) => call.action === "frame").length, 0);
  await act(async () => { t.mock.timers.tick(1000); });
  ready = true; await act(async () => { t.mock.timers.tick(1000); });
  assert.equal(calls.filter((call) => call.action === "start").length, 1);
  assert.ok(view.getByAltText("OCI 私有登录画面"));
  await click(view, "交还并授权只读");
  assert.equal((view.getByRole("button", { name: "Enter" }) as HTMLButtonElement).disabled, true);
  await act(async () => { view.unmount(); t.mock.timers.tick(2000); });
  assert.equal(submitted, 0);
  assert.equal(calls.filter((call) => call.action === "close").length, 0);
  assert.equal(calls.filter((call) => call.action === "input").length, 0);
});

test("a returning Console controller can reauthenticate only into verification polling without browser I/O or a new start", async (t) => {
  const calls = ociHttp(t, { mode: "oci_web", intercept: (call) => {
    const record = { ...attempt(String(call.body.attemptId)), mode: "oci_web", phase: "verifying", principalId: "principal-a" };
    if (call.action === "status") return response(record);
    if (call.action === "session") return response({ grant: { capability, expiresAt: Date.now() + 300_000 }, attempt: record });
    if (call.action === "console-status") return response({ configured: true, phoneControlAccepted: true, phase: "verifying", failure: null });
    if (call.action === "handback") return response({ verified: true });
  } });
  let completed = 0;
  const view = renderControl(t, { attemptId: "attempt-a", onComplete: async () => { completed++; } });
  await authenticateOci(view);
  assert.equal(view.queryByLabelText("目标 User OCID"), null);
  assert.equal((view.getByRole("button", { name: "开始 OCI Console 登录" }) as HTMLButtonElement).disabled, true);
  assert.equal((view.getByRole("button", { name: "Enter" }) as HTMLButtonElement).disabled, true);
  assert.equal(view.queryByAltText("OCI 私有登录画面"), null);
  await click(view, "交还并授权只读");
  assert.equal(completed, 1);
  assert.equal(calls.filter((call) => ["start", "frame", "input", "close", "console-target"].includes(call.action)).length, 0);
});

test("a late protected Console handback acknowledgement retains its browser without completing an aborted native card", async (t) => {
  let complete!: (value: Response) => void;
  const calls = ociHttp(t, { mode: "oci_web", intercept: (call) => call.action === "handback" ? new Promise<Response>((resolve) => { complete = resolve; }) : undefined });
  let submitted = 0;
  const view = renderControl(t, { attemptId: "attempt-a", onComplete: async () => { submitted++; } });
  await view.findByLabelText("控制密钥");
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  await authenticateOci(view); await selectConsoleTarget(view); await click(view, "开始 OCI Console 登录");
  await click(view, "交还并授权只读");
  await act(async () => { t.mock.timers.tick(8000); complete(response({ verified: true })); });
  assert.equal(submitted, 0);
  assert.equal(calls.filter((call) => call.action === "close").length, 0);
});

test("Console pairing rejection prevents private target submission and browser startup", async (t) => {
  const calls = ociHttp(t, { mode: "oci_web", accepted: false });
  const view = renderControl(t);
  await authenticateOci(view); await selectConsoleTarget(view);
  assert.equal((view.getByRole("button", { name: "确认私有 OCI Console 目标" }) as HTMLButtonElement).disabled, true);
  assert.equal(view.queryByRole("button", { name: "开始 OCI Console 登录" }), null);
  assert.equal(calls.filter((call) => call.action === "console-target" || call.action === "start").length, 0);
});

test("a late retained Console handback cannot complete or clean up a replacement attempt", async (t) => {
  let complete!: (value: Response) => void;
  const calls = ociHttp(t, { mode: "oci_web", intercept: (call) => call.action === "handback" ? new Promise<Response>((resolve) => { complete = resolve; }) : undefined });
  let submitted = 0;
  const view = renderControl(t, { attemptId: "attempt-a", onComplete: async () => { submitted++; } });
  await authenticateOci(view); await selectConsoleTarget(view); await click(view, "开始 OCI Console 登录"); await click(view, "交还并授权只读");
  const handback = calls.find((call) => call.action === "handback")!;
  await act(async () => { view.rerender(<LoginControls attemptId="attempt-b" onComplete={async () => { submitted++; }} />); });
  assert.equal(handback.init.signal!.aborted, false);
  await act(async () => { complete(response({ verified: true })); });
  assert.equal(submitted, 0);
  assert.equal(calls.filter((call) => call.action === "close").length, 0);
  assert.equal((view.getByLabelText("控制密钥") as HTMLInputElement).value, "");
  assert.equal(view.queryByAltText("OCI 私有登录画面"), null);
});

test("Console handback timeout settles the viewer while a strict late fetch or body acknowledgement retains only its original browser", async (t) => {
  for (const stage of ["fetch", "body"] as const) await t.test(stage, async (t) => {
    let release!: () => void;
    const calls = ociHttp(t, { mode: "oci_web", intercept: (call) => {
      if (call.action !== "handback") return;
      return stage === "fetch" ? new Promise<Response>((resolve) => { release = () => resolve(response({ verified: true })); })
        : new Response(new ReadableStream({ start(stream) { release = () => { stream.enqueue(new TextEncoder().encode('{"verified":true}')); stream.close(); }; } }), { headers: { "cache-control": "no-store" } });
    } });
    let submitted = 0;
    const view = renderControl(t, { attemptId: "attempt-a", onComplete: async () => { submitted++; } });
    await view.findByLabelText("控制密钥");
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    await authenticateOci(view); await selectConsoleTarget(view); await click(view, "开始 OCI Console 登录");
    await click(view, "交还并授权只读");
    await act(async () => { t.mock.timers.tick(8000); });
    try {
      assert.match(view.container.textContent!, /浏览器清理尚未确认/);
      assert.equal(view.queryByAltText("OCI 私有登录画面"), null);
      assert.equal(calls.filter(call => call.action === "close").length, 0, "an outstanding protected acknowledgement still owns the cleanup decision");
    } finally { await act(async () => { release(); }); }
    await act(async () => { view.unmount(); });
    assert.equal(submitted, 0);
    assert.equal(calls.filter(call => call.action === "close").length, 0);
    assert.equal(calls.filter(call => call.action === "handback").length, 1);
    assert.equal(calls.filter(call => call.action === "input").length, 0);
  });
});

test("control authentication timeout releases the key form while the fetch remains stalled", async (t) => {
  let release!: () => void;
  loginHttp(t, call => call.action === "session" ? new Promise<Response>((resolve) => { release = () => resolve(response({ grant: { capability, expiresAt: Date.now() + 300_000 }, attempt: { ...attempt(), phase: "awaiting_control", principalId: "principal-a" } })); }) : undefined);
  const view = renderControl(t); await view.findByLabelText("控制密钥");
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  await authenticate(view); await act(async () => { t.mock.timers.tick(8000); });
  try {
    assert.equal((view.getByLabelText("控制密钥") as HTMLInputElement).disabled, false);
    assert.match(view.container.textContent!, /测试控制鉴权未通过/);
  } finally { await act(async () => { release(); }); }
  assert.equal(view.queryByRole("button", { name: "开始假页面测试" }), null);
});
