import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import type { LoginAttempt } from "../login-protocol.ts";
import { installUiEnvironment } from "./ui-environment.ts";

const environment = installUiEnvironment();
after(() => environment.window.close());
const { act, fireEvent, waitFor } = await import("@testing-library/react");
const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { useBbContext } = await import("@get-bb/plugin-sdk/app");
const { LoginStatusPage } = await import("../login-status.tsx");

const ATTEMPT: LoginAttempt = {
  version: 1, attemptId: "fixture-attempt", projectId: "fixture-project", threadId: "thread-a",
  environmentId: "fixture-environment", hostId: "host-a", browserContextId: "fixture-browser", generation: 1,
  principalId: "principal-never-render", mode: "synthetic", phase: "verified", revision: 7,
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_001_000, expiresAt: 1_700_000_600_000,
  verification: { id: "verification-never-render", kind: "synthetic", verifiedAt: 1_700_000_000_900 },
  resume: { state: "uncertain", deliveryId: "delivery-never-render" }, failure: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function renderStatus(t: TestContext, handler: (input: unknown) => LoginAttempt[] | Promise<LoginAttempt[]>, threadId: string | null = "thread-a") {
  const view = renderSlot({ component: LoginStatusPage }, {}, {
    pluginId: "remote-login", context: { threadId }, rpc: { loginAttempts: handler },
  });
  t.after(() => view.unmount());
  return view;
}

test("no selected thread makes no RPC and offers only a selection hint", async (t) => {
  const view = await renderStatus(t, () => { assert.fail("no context must not request attempts"); }, null);
  assert.ok(view.getByText("请选择一个 thread 查看登录请求。"));
  assert.equal(view.rpcCalls.length, 0);
  assert.equal(view.queryByRole("button"), null);
});

test("persistent attempt metadata is readable without rendering proof, raw receipt identifiers or actions", async (t) => {
  const records = [
    { ...ATTEMPT, capability: "capability-never-render", url: "https://never-render.fixture.invalid" },
    { ...ATTEMPT, attemptId: "cli-attempt", mode: "oci_cli" as const, verification: { ...ATTEMPT.verification!, kind: "oci_cli" as const } },
    { ...ATTEMPT, attemptId: "web-attempt", mode: "oci_web" as const, principalId: null, phase: "awaiting_pairing" as const, verification: null, resume: { state: "none" as const, deliveryId: null } },
  ];
  const view = await renderStatus(t, () => records);
  await view.findByRole("list", { name: "登录请求" });
  assert.ok(view.getByRole("heading", { name: "测试" }));
  assert.ok(view.getByRole("heading", { name: "OCI 命令行授权" }));
  assert.ok(view.getByRole("heading", { name: "OCI 网页登录" }));
  assert.equal(view.getAllByText("恢复结果待确认").length, 2);
  assert.ok(view.getByText("尚未配对"));
  assert.equal(view.getAllByText("host-a").length, 3);
  assert.equal(view.container.querySelectorAll("time").length, 6);
  for (const forbidden of ["principal-never-render", "verification-never-render", "delivery-never-render", "capability-never-render", "never-render.fixture.invalid", "成功"]) {
    assert.equal(view.container.textContent?.includes(forbidden), false);
  }
  assert.equal(view.queryAllByRole("button").length, 1);
  assert.equal(view.container.querySelector("form,input,textarea,a,img"), null);
  assert.deepEqual(view.rpcCalls, [{ method: "loginAttempts", input: { threadId: "thread-a" } }]);
});

test("manual refresh replaces an empty result using only the read-only list RPC", async (t) => {
  let reads = 0;
  const view = await renderStatus(t, () => ++reads === 1 ? [] : [ATTEMPT]);
  await view.findByText("当前 thread 暂无登录请求。");
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "刷新" })); });
  await view.findByText("恢复结果待确认");
  assert.equal(view.rpcCalls.length, 2);
  assert.ok(view.rpcCalls.every((call) => call.method === "loginAttempts"));
});

test("pending requests disable refresh and reach a fixed timeout without accepting late results", async (t) => {
  const late = deferred<LoginAttempt[]>();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const view = await renderStatus(t, () => ++reads === 1 ? late.promise : []);
  const refresh = view.getByRole("button", { name: "刷新" }) as HTMLButtonElement;
  assert.equal(refresh.disabled, true);
  assert.ok(view.getByRole("status"));
  await act(async () => { t.mock.timers.tick(8_000); });
  assert.ok(view.getByRole("alert"));
  assert.equal(refresh.disabled, false);
  await act(async () => { late.resolve([ATTEMPT]); });
  assert.equal(view.queryByText("host-a"), null);
  t.mock.timers.reset();
  await act(async () => { fireEvent.click(refresh); });
  await view.findByText("当前 thread 暂无登录请求。");
});

test("RPC failures display a fixed message without backend errors or credential-like strings", async (t) => {
  const view = await renderStatus(t, async () => { throw new Error("private-backend-error secret-capability https://private.invalid"); });
  const alert = await view.findByRole("alert");
  assert.equal(alert.textContent, "暂时无法读取登录请求，请稍后刷新。");
  assert.equal(view.container.textContent?.includes("private"), false);
  assert.equal((view.getByRole("button", { name: "刷新" }) as HTMLButtonElement).disabled, false);
});

test("a thread switch hides old data and discards the old thread's late RPC result", async (t) => {
  const late = deferred<LoginAttempt[]>();
  let selection!: { threadId: string | null };
  function SelectedThread() { selection = useBbContext(); return <LoginStatusPage />; }
  const view = renderSlot({ component: SelectedThread }, {}, {
    pluginId: "remote-login", context: { threadId: "thread-a" },
    rpc: { loginAttempts: (input) => (input as { threadId: string }).threadId === "thread-a" ? late.promise : [{ ...ATTEMPT, attemptId: "thread-b-attempt", threadId: "thread-b", hostId: "host-b" }] },
  });
  t.after(() => view.unmount());
  await waitFor(() => assert.equal(view.rpcCalls.length, 1));
  // The public harness exposes context as a plain value, without a setter.
  // Mutating that test value and rerendering models a host selection update.
  await act(async () => { selection.threadId = "thread-b"; view.rerender(<SelectedThread />); });
  await view.findByText("host-b");
  await act(async () => { late.resolve([ATTEMPT]); });
  assert.equal(view.queryByText("host-a"), null);
  assert.ok(view.getByText("host-b"));
  assert.deepEqual(view.rpcCalls.map((call) => call.input), [{ threadId: "thread-a" }, { threadId: "thread-b" }]);
  await act(async () => { selection.threadId = null; view.rerender(<SelectedThread />); });
  assert.ok(view.getByText("请选择一个 thread 查看登录请求。"));
  assert.equal(view.queryByText("host-b"), null);
  assert.equal(view.rpcCalls.length, 2);
});

test("a verified or claimed record does not claim delivery; only delivered history shows its receipt", async (t) => {
  const view = await renderStatus(t, () => [
    { ...ATTEMPT, attemptId: "pending-attempt", resume: { state: "pending", deliveryId: null } },
    { ...ATTEMPT, attemptId: "claimed-attempt", resume: { state: "claimed", deliveryId: "delivery-never-render" } },
  ]);
  await view.findByRole("list", { name: "登录请求" });
  assert.equal(view.queryByText("恢复已确认送达"), null);
  assert.ok(view.getByText("恢复结果待确认"));
  view.unmount();
  const delivered = await renderStatus(t, () => [{ ...ATTEMPT, resume: { state: "delivered", deliveryId: "delivery-never-render" } }]);
  assert.ok(await delivered.findByText("恢复已确认送达"));
  assert.equal(delivered.container.textContent?.includes("delivery-never-render"), false);
});

test("a live synthetic history row opens the same private controller using only its attempt ID", async (t) => {
  const now = Date.now();
  const live: LoginAttempt = { ...ATTEMPT, phase: "awaiting_pairing", principalId: null, createdAt: now - 1000, updatedAt: now - 1000,
    expiresAt: now + 600_000, verification: null, resume: { state: "none", deliveryId: null } };
  const calls: { path: string; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ path: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(live), { headers: { "cache-control": "no-store" } });
  });
  const view = await renderStatus(t, () => [live, { ...live, attemptId: "unsupported-cli", mode: "oci_cli" }]);
  await view.findByRole("list", { name: "登录请求" });
  assert.equal(view.getAllByRole("button", { name: "接管测试" }).length, 1);
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "接管测试" })); });
  await view.findByLabelText("控制密钥");
  assert.deepEqual(calls, [{ path: "https://bb-web.fixture.invalid/api/v1/plugins/remote-login/http/login/status", body: { attemptId: "fixture-attempt" } }]);
  assert.ok(view.getByText(/授权最长五分钟/));
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "关闭登录控制" })); });
  assert.equal(view.queryByLabelText("控制密钥"), null);
});

test("a queued OCI CLI history row opens its private authorization controller with no account fields in RPC", async (t) => {
  const now = Date.now();
  const live: LoginAttempt = { ...ATTEMPT, attemptId: "oci-queued", mode: "oci_cli", phase: "awaiting_pairing", principalId: null,
    createdAt: now - 1000, updatedAt: now - 1000, expiresAt: now + 600_000, verification: null, resume: { state: "none", deliveryId: null } };
  const calls: { path: string; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ path: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(live), { headers: { "cache-control": "no-store" } });
  });
  const view = await renderStatus(t, () => [live]);
  await view.findByRole("list", { name: "登录请求" });
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "接管 OCI 授权" })); });
  await view.findByLabelText("控制密钥");
  assert.ok(view.getByRole("button", { name: "验证 OCI 控制密钥" }));
  assert.deepEqual(calls, [{ path: "https://bb-web.fixture.invalid/api/v1/plugins/remote-login/http/login/status", body: { attemptId: "oci-queued" } }]);
  assert.deepEqual(view.rpcCalls, [{ method: "loginAttempts", input: { threadId: "thread-a" } }]);
  assert.equal(view.queryByRole("button", { name: "开始 OCI CLI 登录" }), null);
});

test("a queued Console history row opens the same protected controller without account or browser reference RPC fields", async (t) => {
  const now = Date.now();
  const record: LoginAttempt = { ...ATTEMPT, attemptId: "console-queued", mode: "oci_web", phase: "awaiting_pairing", principalId: null,
    createdAt: now - 1000, updatedAt: now - 1000, expiresAt: now + 600_000, verification: null, resume: { state: "none", deliveryId: null } };
  const calls: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push(JSON.parse(String(init.body))); return new Response(JSON.stringify(record), { headers: { "cache-control": "no-store" } });
  });
  const view = await renderStatus(t, () => [record]);
  await view.findByRole("list", { name: "登录请求" });
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "接管 OCI Console 授权" })); });
  await view.findByLabelText("控制密钥");
  assert.deepEqual(calls, [{ attemptId: "console-queued" }]);
  assert.deepEqual(view.rpcCalls, [{ method: "loginAttempts", input: { threadId: "thread-a" } }]);
  assert.equal(view.queryByRole("button", { name: "开始 OCI Console 登录" }), null);
});

test("finished Console history remains read-only and never displays retained browser or writer metadata", async (t) => {
  const record = { ...ATTEMPT, mode: "oci_web" as const, verification: { ...ATTEMPT.verification!, kind: "oci_web" as const },
    browserRef: "browser-reference-never-render", expected: { userOcid: "account-never-render" }, writer: { pid: 773399 }, profile: "/private/profile-never-render" };
  const view = await renderStatus(t, () => [record]);
  await view.findByRole("list", { name: "登录请求" });
  assert.equal(view.queryAllByRole("button").length, 1);
  assert.equal(view.container.querySelector("form,input,textarea,a,img"), null);
  for (const value of [record.browserRef, record.expected.userOcid, String(record.writer.pid), record.profile]) assert.equal(view.container.textContent!.includes(value), false);
});
