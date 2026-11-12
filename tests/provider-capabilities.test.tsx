import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { installUiEnvironment } from "./ui-environment.ts";

const environment = installUiEnvironment();
after(() => environment.window.close());
const { act, fireEvent } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const plugin = await loadPluginApp(() => import("../app.tsx"));
const capabilities = plugin.navPanels.find((panel) => panel.id === "capabilities");
assert.ok(capabilities);

const REPORT = {
  version: 1,
  providers: [
    { id: "oci_cli", method: "host_browser", availability: "candidate", reasons: [], acceptance: "not_accepted" },
    { id: "oci_web", method: "host_browser", availability: "candidate", reasons: [], acceptance: "not_accepted" },
    { id: "oci_identity_domain_device", method: "device_code", availability: "unavailable", reasons: ["provider_not_configured"], acceptance: "not_accepted" },
    { id: "oci_phone_callback", method: "phone_callback", availability: "unavailable", reasons: ["callback_not_supported"], acceptance: "not_accepted" },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function renderCapabilities(t: TestContext, handler: (input: unknown) => unknown = () => ({ hostId: "host-a", report: REPORT })) {
  const view = renderSlot(capabilities!, { subPath: "" }, {
    pluginId: "remote-login", rpc: { loginCapabilities: handler },
  });
  t.after(() => view.unmount());
  return view;
}
async function inspect(view: ReturnType<typeof renderCapabilities>, hostId = "host-a") {
  fireEvent.change(view.getByLabelText("目标 host ID"), { target: { value: hostId } });
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "检查登录方式" })); });
}

test("diagnostics require an explicit host and present only that host's method capabilities", async (t) => {
  const view = renderCapabilities(t);
  assert.equal(view.rpcCalls.length, 0);
  assert.equal((view.getByRole("button", { name: "检查登录方式" }) as HTMLButtonElement).disabled, true);
  await inspect(view, "  host-a  ");
  await view.findByRole("list", { name: "登录方式能力" });
  assert.deepEqual(view.rpcCalls, [{ method: "loginCapabilities", input: { hostId: "host-a" } }]);
  assert.deepEqual(view.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent), [
    "OCI CLI", "OCI Console", "OCI Identity Domains device flow", "手机回调转发",
  ]);
  assert.equal(view.getAllByText("环境检查通过").length, 2);
  assert.equal(view.getAllByText("暂不可用").length, 2);
  assert.equal(view.getAllByText("尚未验收").length, 4);
  assert.match(view.container.textContent!, /开始前还需完成手机配对，并确认预期账号。环境检查不代表已登录。/);
  assert.match(view.container.textContent!, /真实手机控制、账号登录和原任务恢复尚未验收/);
  assert.match(view.container.textContent!, /macOS arm64.*157\.0\.8103\.50.*25\.16\.0.*Sydney.*oc1/);
  assert.match(view.container.textContent!, /设备代码.*不能替代.*Console/);
  assert.match(view.container.textContent!, /插件管理的全新浏览器/);
  assert.equal(view.container.querySelector("pre,textarea,input[type=password],a,img"), null);
  assert.equal(view.queryAllByRole("button").length, 1);
});

test("unavailable methods explain each runtime gate in Chinese without exposing raw report fields", async (t) => {
  const report = structuredClone(REPORT);
  report.providers[0] = { ...report.providers[0]!, availability: "unavailable", reasons: ["platform_unsupported", "browser_pin_unmatched", "process_inspection_unavailable", "cli_source_unmatched"] };
  const view = renderCapabilities(t, () => ({ hostId: "host-a", report }));
  await inspect(view);
  await view.findByRole("list", { name: "登录方式能力" });
  for (const text of [/仅支持 macOS arm64/, /Chrome 版本.*不匹配/, /无法确认浏览器进程归属/, /OCI CLI 源码.*不匹配/, /尚未配置/, /未支持手机回调转发/]) {
    assert.match(view.container.textContent!, text);
  }
  for (const field of ["browser_pin_unmatched", "not_accepted", "oci_identity_domain_device"]) {
    assert.equal(view.container.textContent!.includes(field), false);
  }
});

test("malformed or wrong-host capabilities fail with one fixed message and no server payload", async (t) => {
  const cases: unknown[] = [
    null,
    { hostId: "host-other", report: REPORT },
    { hostId: "host-a", report: { ...REPORT, version: 2 } },
    { hostId: "host-a", report: { ...REPORT, secret: "secret-never-render" } },
    { hostId: "host-a", report: { ...REPORT, providers: [...REPORT.providers].reverse() } },
    { hostId: "host-a", report: { ...REPORT, providers: [{ ...REPORT.providers[0], acceptance: "accepted" }, ...REPORT.providers.slice(1)] } },
    { hostId: "host-a", report: { ...REPORT, providers: [{ ...REPORT.providers[0], reasons: ["secret-never-render"] }, ...REPORT.providers.slice(1)] } },
    { hostId: "host-a", report: REPORT, secret: "secret-never-render" },
  ];
  for (const value of cases) {
    const view = renderCapabilities(t, () => value);
    await inspect(view);
    assert.equal((await view.findByRole("alert")).textContent, "无法读取所选 host 的登录方式，请确认 host 在线后重试。");
    assert.equal(view.queryByRole("list", { name: "登录方式能力" }), null);
    assert.equal(view.container.textContent!.includes("secret-never-render"), false);
    view.unmount();
  }
});

test("a failed RPC shows a fixed error without rendering exception text", async (t) => {
  const view = renderCapabilities(t, () => { throw new Error("private-path secret-never-render https://private.invalid"); });
  await inspect(view);
  assert.equal((await view.findByRole("alert")).textContent, "无法读取所选 host 的登录方式，请确认 host 在线后重试。");
  assert.equal(view.container.textContent!.includes("private"), false);
  assert.equal((view.getByRole("button", { name: "检查登录方式" }) as HTMLButtonElement).disabled, false);
});

test("switching hosts clears the displayed report before another check", async (t) => {
  const view = renderCapabilities(t);
  await inspect(view);
  await view.findByRole("list", { name: "登录方式能力" });
  fireEvent.change(view.getByLabelText("目标 host ID"), { target: { value: "host-b" } });
  assert.equal(view.queryByRole("list", { name: "登录方式能力" }), null);
  assert.equal(view.rpcCalls.length, 1);
  assert.equal((view.getByRole("button", { name: "检查登录方式" }) as HTMLButtonElement).disabled, false);
});

test("an earlier host's late result cannot replace a newer host's result", async (t) => {
  const late = deferred<unknown>();
  const report = structuredClone(REPORT);
  report.providers[0] = { ...report.providers[0]!, availability: "unavailable", reasons: ["cli_source_unmatched"] };
  const view = renderCapabilities(t, (input) => (input as { hostId: string }).hostId === "host-a" ? late.promise : { hostId: "host-b", report });
  await inspect(view);
  assert.ok(view.getByRole("button", { name: "检查中…" }));
  await inspect(view, "host-b");
  await view.findByRole("list", { name: "登录方式能力" });
  assert.equal(view.getAllByText("环境检查通过").length, 1);
  await act(async () => { late.resolve({ hostId: "host-a", report: REPORT }); });
  assert.equal(view.getAllByText("环境检查通过").length, 1);
  assert.match(view.container.textContent!, /报告 host：host-b/);
  assert.deepEqual(view.rpcCalls.map((call) => call.input), [{ hostId: "host-a" }, { hostId: "host-b" }]);
});

test("an eight-second timeout releases retry and ignores late RPC results", async (t) => {
  const late = deferred<unknown>();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const view = renderCapabilities(t, () => ++reads === 1 ? late.promise : { hostId: "host-a", report: REPORT });
  await inspect(view);
  await act(async () => { t.mock.timers.tick(7_999); });
  assert.equal(view.queryByRole("alert"), null);
  await act(async () => { t.mock.timers.tick(1); });
  assert.ok(view.getByRole("alert"));
  assert.equal((view.getByRole("button", { name: "检查登录方式" }) as HTMLButtonElement).disabled, false);
  await act(async () => { late.resolve({ hostId: "host-a", report: REPORT }); });
  assert.equal(view.queryByRole("list", { name: "登录方式能力" }), null);
  t.mock.timers.reset();
  await inspect(view);
  await view.findByRole("list", { name: "登录方式能力" });
});

test("a host switch also discards the old request's rejection and timeout", async (t) => {
  const late = deferred<unknown>();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const view = renderCapabilities(t, () => late.promise);
  await inspect(view);
  fireEvent.change(view.getByLabelText("目标 host ID"), { target: { value: "host-b" } });
  await act(async () => { late.reject(new Error("secret-never-render")); t.mock.timers.tick(8_000); });
  assert.equal(view.queryByRole("alert"), null);
  assert.equal(view.queryByRole("list", { name: "登录方式能力" }), null);
  assert.equal((view.getByRole("button", { name: "检查登录方式" }) as HTMLButtonElement).disabled, false);
  t.mock.timers.reset();
});
