import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { installUiEnvironment } from "./ui-environment.ts";
import type { FixtureControlsProps } from "../fixture-controls.tsx";
import { FrameChangedError, StaleFrameError } from "../frame-error.ts";

const environment = installUiEnvironment();
after(() => environment.window.close());
const { act, fireEvent } = await import("@testing-library/react");
const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { FixtureControls } = await import("../fixture-controls.tsx");
const capability = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
const frameRef = "11111111-1111-4111-8111-111111111111";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKD8AAAAASUVORK5CYII=";
const props: FixtureControlsProps = {
  origin: "https://active-server.fixture.invalid", hostId: "fixture-host",
  scope: { threadId: "fixture-thread", attemptId: "fixture-attempt", browserContextId: "fixture-browser", generation: 1 },
  capability,
};
type Call = { action: string; payload: Record<string, unknown>; headers: Headers; signal?: AbortSignal | null; url: string };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function fixtureHttp(t: TestContext, intercept?: (call: Call) => Promise<Response> | Response | undefined) {
  const calls: Call[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const call = { action: new URL(url).pathname.split("/").at(-1)!, payload: JSON.parse(String(init.body)) as Record<string, unknown>, headers: new Headers(init.headers), signal: init.signal, url };
    calls.push(call);
    const intercepted = intercept?.(call);
    if (intercepted) return intercepted;
    if (call.action === "start") return response({ width: 800, height: 600 });
    if (call.action === "frame") return response({ png, width: 800, height: 600, frameRef });
    if (call.action === "input") return response({ accepted: true });
    if (call.action === "close") return response({ closed: true });
    throw new Error("Unexpected fixture route");
  });
  return calls;
}

function renderControls(t: TestContext, input = props) {
  const view = renderSlot({ component: FixtureControls }, input, { pluginId: "remote-login" });
  t.after(async () => { await act(async () => { view.unmount(); }); });
  return view;
}

async function click(view: ReturnType<typeof renderControls>, name: string) {
  await act(async () => { fireEvent.click(view.getByRole("button", { name })); });
}

test("a trusted stale input preserves the viewer and draft until a fresh frame and explicit re-operation", async t => {
  const refs = [frameRef, "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  const inputs: Array<{ event: unknown; frameRef: unknown }> = [];
  let reads = 0, closes = 0, failures = 0, effects = 0;
  const transport = {
    async start() { return { width: 800, height: 600 }; },
    async frame() { return { png, width: 800 as const, height: 600 as const, frameRef: refs[reads++]! }; },
    async input(event: unknown, _signal: AbortSignal, observed: string) {
      inputs.push({ event, frameRef: observed });
      if (inputs.length === 1) throw new StaleFrameError();
      effects++;
    },
    async close() { closes++; },
  };
  const view = renderControls(t, { ...props, transport, onFailure: () => { failures++; } });
  await click(view, "开始假页面测试");
  fireEvent.change(view.getByLabelText("测试文字"), { target: { value: "rejected private draft" } });
  await click(view, "发送测试文字");
  assert.deepEqual(inputs, [{ event: { type: "text", text: "rejected private draft" }, frameRef }]);
  assert.equal(closes, 0); assert.equal(failures, 0); assert.equal(effects, 0);
  assert.equal(view.queryByAltText("假页面测试画面"), null);
  assert.equal((view.getByLabelText("测试文字") as HTMLInputElement).value, "rejected private draft");
  assert.equal((view.getByRole("button", { name: "Enter" }) as HTMLButtonElement).disabled, true);
  assert.equal((view.getByRole("button", { name: "发送测试文字" }) as HTMLButtonElement).disabled, true);
  assert.match(view.getByRole("status").textContent!, /本次输入未发送.*重新操作/);
  await click(view, "刷新私有浏览器画面");
  assert.equal(inputs.length, 1, "a fresh read must never replay the rejected event");
  await click(view, "发送测试文字");
  assert.equal(inputs.length, 2); assert.equal(inputs[1]!.frameRef, refs[1]); assert.equal(effects, 1);
  assert.equal(closes, 0); assert.equal(failures, 0);
});

test("acknowledged input followed by a changed read keeps the sent draft empty and never replays it", async t => {
  let reads = 0, effects = 0, closes = 0, failures = 0, starts = 0;
  const transport = {
    async start() { starts++; },
    async frame() {
      if (++reads === 2) throw new FrameChangedError();
      return { png, width: 800 as const, height: 600 as const, frameRef: reads === 1 ? frameRef : "22222222-2222-4222-8222-222222222222" };
    },
    async input() { effects++; },
    async close() { closes++; },
  };
  const view = renderControls(t, { ...props, transport, onFailure: () => { failures++; } });
  await click(view, "开始假页面测试");
  fireEvent.change(view.getByLabelText("测试文字"), { target: { value: "already sent draft" } });
  await click(view, "发送测试文字");
  assert.equal(effects, 1); assert.equal(closes, 0); assert.equal(failures, 0); assert.equal(starts, 1);
  assert.equal((view.getByLabelText("测试文字") as HTMLInputElement).value, "");
  assert.equal(view.queryByAltText("假页面测试画面") === null, true);
  assert.equal(view.queryByText(/本次输入未发送/) === null, true);
  assert.ok(view.getByText(/画面读取时发生变化/));
  assert.equal((view.getByRole("button", { name: "Enter" }) as HTMLButtonElement).disabled, true);
  await click(view, "刷新私有浏览器画面");
  assert.equal(effects, 1, "fresh observation must not replay the acknowledged input");
  assert.equal(starts, 1); assert.equal(closes, 0); assert.equal(failures, 0);
  assert.equal((view.getByRole("button", { name: "Enter" }) as HTMLButtonElement).disabled, false);
});

test("a changed frame after start or ready retains the owned viewer for a fresh read", async t => {
  for (const pending of [false, true]) await t.test(pending ? "ready" : "start", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let reads = 0, starts = 0, closes = 0, failures = 0, effects = 0;
    const transport = {
      async start() { starts++; return pending ? { pending: true } : { width: 800, height: 600 }; },
      async readyStatus() { return true; },
      async frame() {
        if (++reads === 1) throw new FrameChangedError();
        return { png, width: 800 as const, height: 600 as const, frameRef };
      },
      async input() { effects++; }, async close() { closes++; },
    };
    const view = renderControls(t, { ...props, mode: "oci_cli", transport, onFailure: () => { failures++; } });
    await click(view, "开始 OCI CLI 登录");
    if (pending) await act(async () => { t.mock.timers.tick(1000); });
    assert.equal(closes, 0); assert.equal(failures, 0); assert.equal(effects, 0); assert.equal(starts, 1);
    assert.ok(view.getByText(/画面读取时发生变化/));
    await click(view, "刷新私有浏览器画面");
    assert.equal(reads, 2); assert.equal(starts, 1); assert.equal(effects, 0);
    assert.equal(view.queryByAltText("OCI 私有登录画面") !== null, true);
  });
});

test("typed refusals from the wrong operation stage keep conservative input cleanup", async t => {
  for (const misplaced of ["read-refusal-during-input", "input-refusal-during-read"]) await t.test(misplaced, async t => {
    let reads = 0, closes = 0, failures = 0;
    const transport = {
      async start() {},
      async frame() {
        if (++reads === 2) throw new StaleFrameError();
        return { png, width: 800 as const, height: 600 as const, frameRef };
      },
      async input() { if (misplaced === "read-refusal-during-input") throw new FrameChangedError(); },
      async close() { closes++; },
    };
    const view = renderControls(t, { ...props, transport, onFailure: () => { failures++; } });
    await click(view, "开始假页面测试");
    fireEvent.change(view.getByLabelText("测试文字"), { target: { value: "no automatic restoration" } });
    await click(view, "发送测试文字");
    assert.equal(closes, 1); assert.equal(failures, 1);
    assert.equal((view.getByLabelText("测试文字") as HTMLInputElement).value, "");
    assert.equal(view.queryByText(/本次输入未发送/) === null, true);
    assert.equal(view.queryByText(/画面读取时发生变化/) === null, true);
  });
});

test("fixture start and stop keep frames and proof in the private component channel", async (t) => {
  const calls = fixtureHttp(t);
  const view = renderControls(t);
  assert.ok(view.getByText("仅假页面测试，勿输入账号凭据"));
  assert.equal(calls.length, 0);
  await click(view, "开始假页面测试");
  assert.equal(view.getByAltText("假页面测试画面").getAttribute("src"), `data:image/png;base64,${png}`);
  assert.equal(view.container.innerHTML.includes(capability), false);
  assert.deepEqual(calls.map((call) => call.action), ["start", "frame"]);
  assert.ok(calls.every((call) => call.headers.get("authorization") === `Bearer ${capability}`));
  assert.ok(calls.every((call) => !call.url.includes(capability) && !JSON.stringify(call.payload).includes(capability)));
  assert.deepEqual(view.inspection.rpcCalls, []);
  assert.deepEqual(view.inspection.sdkCalls, []);
  await click(view, "停止假页面测试");
  assert.equal(view.queryByAltText("假页面测试画面"), null);
  assert.equal(calls.at(-1)!.action, "close");
  assert.ok(calls.every((call) => !call.url.includes("/control/release")));
});

test("a stopped scope cannot restart until its pairing proof changes", async (t) => {
  const calls = fixtureHttp(t);
  const view = renderControls(t);
  await click(view, "开始假页面测试");
  await click(view, "停止假页面测试");
  const start = view.getByRole("button", { name: "开始假页面测试" }) as HTMLButtonElement;
  assert.equal(start.disabled, true);
  fireEvent.click(start);
  assert.equal(calls.filter((call) => call.action === "start").length, 1);
  assert.match(view.getByRole("status").textContent!, /撤销本次授权.*重新验证/);
});

test("an explicit stop survives unmount or proof changes until the host acknowledges close", async (t) => {
  for (const transition of ["unmount", "proof-change"]) {
    await t.test(transition, async (t) => {
      let acknowledge!: () => void;
      let hostClosed = false;
      const calls = fixtureHttp(t, (call) => call.action === "close" ? new Promise<Response>((resolve, reject) => {
        acknowledge = () => {
          if (!call.signal!.aborted) {
            hostClosed = true;
            resolve(response({ closed: true }));
          }
        };
        call.signal!.addEventListener("abort", () => reject(new Error("close cancelled fixture")), { once: true });
      }) : undefined);
      const view = renderControls(t);
      await click(view, "开始假页面测试");
      await click(view, "停止假页面测试");
      const close = calls.find((call) => call.action === "close")!;
      assert.equal(close.signal!.aborted, false);
      await act(async () => {
        if (transition === "unmount") view.unmount();
        else view.rerender(<FixtureControls {...props} scope={{ ...props.scope, attemptId: "different-attempt" }} capability={"A".repeat(43)} />);
      });
      assert.equal(close.signal!.aborted, false, "teardown must not cancel the only close request");
      await act(async () => { acknowledge(); });
      assert.equal(hostClosed, true);
      assert.equal(calls.filter((call) => call.action === "close").length, 1);
      assert.equal(calls.filter((call) => call.action === "input").length, 0);
      assert.equal(view.queryByAltText("假页面测试画面"), null);
    });
  }
});

test("an explicit close retains its eight-second deadline after unmount", async (t) => {
  const calls = fixtureHttp(t, (call) => call.action === "close" ? new Promise<Response>((_resolve, reject) => {
    call.signal!.addEventListener("abort", () => reject(new Error("close timeout fixture")), { once: true });
  }) : undefined);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const view = renderControls(t);
  await click(view, "开始假页面测试");
  await click(view, "停止假页面测试");
  const close = calls.find((call) => call.action === "close")!;
  await act(async () => { view.unmount(); });
  assert.equal(close.signal!.aborted, false);
  await act(async () => { t.mock.timers.tick(7999); });
  assert.equal(close.signal!.aborted, false);
  await act(async () => { t.mock.timers.tick(1); });
  assert.equal(close.signal!.aborted, true);
  assert.equal(calls.filter((call) => call.action === "close").length, 1);
});

test("tap coordinates invert CSS scaling and each input is followed by a frame", async (t) => {
  const calls = fixtureHttp(t);
  const view = renderControls(t);
  await click(view, "开始假页面测试");
  const image = view.getByAltText("假页面测试画面");
  t.mock.method(image, "getBoundingClientRect", () => ({ x: 10, y: 20, left: 10, top: 20, right: 410, bottom: 320, width: 400, height: 300, toJSON: () => ({}) }));
  await act(async () => { fireEvent.click(image, { clientX: 110, clientY: 95 }); });
  assert.deepEqual(calls[2]!.payload.event, { type: "click", x: 200, y: 150 });
  assert.deepEqual(calls.slice(2).map((call) => call.action), ["input", "frame"]);
  await act(async () => { fireEvent.click(image, { clientX: 500, clientY: 95 }); });
  assert.equal(calls.filter((call) => call.action === "input").length, 1);
});

test("bounded text requires explicit send, clears on submit, and only five keys and fixed wheel controls are sent", async (t) => {
  const calls = fixtureHttp(t);
  const view = renderControls(t);
  await click(view, "开始假页面测试");
  const text = view.getByLabelText("测试文字") as HTMLInputElement;
  fireEvent.change(text, { target: { value: "仅测试文字" } });
  fireEvent.keyDown(text, { key: "Enter" });
  assert.equal(calls.filter((call) => call.action === "input").length, 0);
  await click(view, "发送测试文字");
  assert.equal(text.value, "");
  assert.deepEqual(calls.find((call) => call.action === "input")!.payload.event, { type: "text", text: "仅测试文字" });
  fireEvent.change(text, { target: { value: "x".repeat(257) } });
  assert.equal((view.getByRole("button", { name: "发送测试文字" }) as HTMLButtonElement).disabled, true);
  for (const key of ["Backspace", "Tab", "Enter", "ArrowLeft", "ArrowRight"]) await click(view, key);
  await click(view, "向上滚动");
  await click(view, "向下滚动");
  assert.deepEqual(calls.filter((call) => call.action === "input").slice(1).map((call) => call.payload.event), [
    ...["Backspace", "Tab", "Enter", "ArrowLeft", "ArrowRight"].map((key) => ({ type: "key", key })),
    { type: "wheel", deltaY: -300 }, { type: "wheel", deltaY: 300 },
  ]);
});

test("pending input drops extra taps and polling work without replaying input", async (t) => {
  let finish!: (value: Response) => void;
  const held = new Promise<Response>((resolve) => { finish = resolve; });
  const calls = fixtureHttp(t, (call) => call.action === "input" ? held : undefined);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const view = renderControls(t);
  await click(view, "开始假页面测试");
  await click(view, "Enter");
  await click(view, "Enter");
  await click(view, "Tab");
  await act(async () => { t.mock.timers.tick(5000); });
  assert.equal(calls.filter((call) => call.action === "input").length, 1);
  assert.equal(calls.filter((call) => call.action === "frame").length, 1);
  await act(async () => { finish(response({ accepted: true })); });
  assert.equal(calls.filter((call) => call.action === "input").length, 1);
  assert.equal(calls.filter((call) => call.action === "frame").length, 2);
});

test("a pending read-only poll preserves editable focused draft text without concurrent input", async (t) => {
  let hold = false;
  let finish!: (value: Response) => void;
  const held = new Promise<Response>((resolve) => { finish = resolve; });
  const calls = fixtureHttp(t, (call) => call.action === "frame" && hold ? held : undefined);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const view = renderControls(t);
  await click(view, "开始假页面测试");
  const text = view.getByLabelText("测试文字") as HTMLInputElement;
  text.focus();
  fireEvent.change(text, { target: { value: "draft before poll" } });
  hold = true;
  await act(async () => { t.mock.timers.tick(1000); });
  assert.equal(text.disabled, false, "read-only polling must not dismiss the phone keyboard");
  assert.equal(document.activeElement, text);
  fireEvent.change(text, { target: { value: "typed during poll" } });
  const send = view.getByRole("button", { name: "发送测试文字" }) as HTMLButtonElement;
  assert.equal(send.disabled, true);
  fireEvent.click(send);
  assert.equal(calls.filter((call) => call.action === "input").length, 0);
  hold = false;
  await act(async () => { finish(response({ png, width: 800, height: 600, frameRef })); });
  assert.equal(text.value, "typed during poll");
  assert.equal(document.activeElement, text);
  await click(view, "发送测试文字");
  assert.deepEqual(calls.find((call) => call.action === "input")!.payload.event, { type: "text", text: "typed during poll" });
});

test("failed input clears its frame and reports no private server error or automatic retry", async (t) => {
  const calls = fixtureHttp(t, (call) => call.action === "input" ? response({ error: `${capability} private fixture failure` }, 503) : undefined);
  let failures = 0;
  const view = renderControls(t, { ...props, onFailure: () => { failures += 1; } });
  await click(view, "开始假页面测试");
  await click(view, "Enter");
  assert.equal(view.queryByAltText("假页面测试画面"), null);
  assert.equal(view.container.textContent!.includes("private fixture failure"), false);
  assert.equal(view.container.innerHTML.includes(capability), false);
  assert.equal(calls.filter((call) => call.action === "input").length, 1);
  assert.equal(failures, 1);
});

test("proof changes and unmount abort late frames and close only their original fixture", async (t) => {
  let finish!: (value: Response) => void;
  const held = new Promise<Response>((resolve) => { finish = resolve; });
  let hold = false;
  const calls = fixtureHttp(t, (call) => call.action === "frame" && hold ? held : undefined);
  const view = renderControls(t);
  await click(view, "开始假页面测试");
  assert.ok(view.getByAltText("假页面测试画面"));
  fireEvent.change(view.getByLabelText("测试文字"), { target: { value: "pending fixture text" } });
  hold = true;
  await click(view, "Enter");
  const frame = calls.filter((call) => call.action === "frame").at(-1)!;
  await act(async () => { view.rerender(<FixtureControls {...props} hostId="different-host" capability={"A".repeat(43)} />); });
  assert.equal(frame.signal!.aborted, true);
  assert.equal(view.queryByAltText("假页面测试画面"), null);
  assert.equal((view.getByLabelText("测试文字") as HTMLInputElement).value, "");
  await act(async () => { finish(response({ png, width: 800, height: 600, frameRef })); });
  assert.equal(view.queryByAltText("假页面测试画面"), null);
  const close = calls.find((call) => call.action === "close")!;
  assert.equal(close.payload.hostId, "fixture-host");
  assert.deepEqual(close.payload.scope, props.scope);
  assert.equal(close.headers.get("authorization"), `Bearer ${capability}`);
  view.unmount();
  assert.ok(calls.every((call) => !call.url.includes("/control/release")));
});

test("frame polling skips busy or hidden periods and stops on unmount", async (t) => {
  const calls = fixtureHttp(t);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const view = renderControls(t);
  await click(view, "开始假页面测试");
  await act(async () => { t.mock.timers.tick(5000); });
  assert.equal(calls.filter((call) => call.action === "frame").length, 2);
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  t.after(() => { Reflect.deleteProperty(document, "hidden"); });
  await act(async () => { t.mock.timers.tick(5000); });
  assert.equal(calls.filter((call) => call.action === "frame").length, 2);
  await act(async () => { view.unmount(); });
  await act(async () => { t.mock.timers.tick(5000); });
  assert.equal(calls.filter((call) => call.action === "frame").length, 2);
  assert.equal(calls.filter((call) => call.action === "close").length, 1);
});

test("an unresponsive frame request times out and clears the fixture without retrying", async (t) => {
  let failures = 0;
  const calls = fixtureHttp(t, (call) => call.action === "frame" ? new Promise<Response>((_resolve, reject) => {
    call.signal!.addEventListener("abort", () => reject(new Error("private timeout fixture")), { once: true });
  }) : undefined);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const view = renderControls(t, { ...props, onFailure: () => { failures += 1; } });
  await click(view, "开始假页面测试");
  await act(async () => { t.mock.timers.tick(8000); });
  assert.equal(calls.filter((call) => call.action === "frame").length, 1);
  assert.equal(view.queryByAltText("假页面测试画面"), null);
  assert.equal(view.container.textContent!.includes("private timeout fixture"), false);
  assert.equal(failures, 1);
  assert.equal(calls.filter((call) => call.action === "close").length, 1);
});

test("fixture controls cannot accidentally submit an enclosing pairing form", async (t) => {
  fixtureHttp(t);
  let submissions = 0;
  const view = renderSlot({ component: () => <form onSubmit={(event) => { event.preventDefault(); submissions += 1; }}><FixtureControls {...props} /></form> }, {}, { pluginId: "remote-login" });
  t.after(() => view.unmount());
  await click(view, "开始假页面测试");
  assert.equal(submissions, 0);
  assert.equal(fireEvent.keyDown(view.getByLabelText("测试文字"), { key: "Enter" }), false);
});

test("protected handback shares the input mutex and failed verification keeps the viewer open", async (t) => {
  let finish!: () => void;
  let verified = 0;
  const actions: string[] = [];
  let reject = true;
  const transport = {
    start: async () => { actions.push("start"); },
    frame: async () => { actions.push("frame"); return { png, width: 800 as const, height: 600 as const, frameRef }; },
    input: async () => { actions.push("input"); },
    close: async () => { actions.push("close"); },
    handback: async () => {
      actions.push("handback");
      await new Promise<void>((resolve) => { finish = resolve; });
      if (reject) throw new Error("private verifier refused");
    },
  };
  const view = renderControls(t, { ...props, transport, onVerified: () => { verified += 1; } });
  await click(view, "开始假页面测试");
  await click(view, "交还并核验测试结果");
  assert.equal((view.getByRole("button", { name: "Enter" }) as HTMLButtonElement).disabled, true);
  fireEvent.click(view.getByRole("button", { name: "Enter" }));
  assert.equal(actions.includes("input"), false);
  await act(async () => { finish(); });
  assert.ok(view.getByAltText("假页面测试画面"));
  assert.equal(actions.includes("close"), false);
  assert.equal(verified, 0);
  assert.match(view.getByRole("status").textContent!, /核验未通过/);
  assert.equal(view.container.textContent!.includes("private verifier"), false);
  reject = false;
  await click(view, "交还并核验测试结果");
  await act(async () => { finish(); });
  assert.equal(view.queryByAltText("假页面测试画面"), null);
  assert.equal(verified, 1);
  view.unmount();
  assert.equal(actions.filter((action) => action === "close").length, 0, "verified handback already confirms server cleanup");
});

test("Console handback keeps its request alive through unmount and transfers automatic cleanup only after its protected acknowledgement", async (t) => {
  for (const result of [{ pending: true }, { verified: true }] as const) await t.test(JSON.stringify(result), async (t) => {
    let release!: (result: unknown) => void, handbackSignal: AbortSignal | undefined, closes = 0, completed = 0;
    const pending = new Promise<unknown>((resolve) => { release = resolve; });
    const transport = { start: async () => ({ width: 800, height: 600 }), frame: async () => ({ width: 800 as const, height: 600 as const, png, frameRef }),
      input: async () => {}, close: async () => { closes++; }, handback: async (signal: AbortSignal) => { handbackSignal = signal; return pending; } };
    const view = renderControls(t, { ...props, mode: "oci_web", handbackLabel: "交还测试", transport, onVerified: () => { completed++; } });
    await act(async () => { fireEvent.click(view.getByRole("button", { name: /^开始/ })); });
    await click(view, "交还测试");
    await act(async () => { view.unmount(); });
    try { assert.equal(handbackSignal?.aborted, false, "the protected handback owns its existing request deadline"); }
    finally { await act(async () => { release(result); }); }
    assert.equal(closes, 0, "an accepted Console handback is retained by the host");
    assert.equal(completed, 0, "an unmounted viewer cannot submit native completion");
  });
});

test("accepted Console handback still permits explicit Stop, while an unacknowledged handback keeps automatic cleanup", async (t) => {
  for (const accepted of [false, true]) await t.test(String(accepted), async (t) => {
    let closes = 0;
    const transport = { start: async () => ({}), frame: async () => ({ width: 800 as const, height: 600 as const, png, frameRef }), input: async () => {},
      handback: async () => { if (!accepted) throw new Error("private refusal"); return { pending: true }; }, close: async () => { closes++; } };
    const view = renderControls(t, { ...props, mode: "oci_web", handbackLabel: "交还测试", transport });
    await act(async () => { fireEvent.click(view.getByRole("button", { name: /^开始/ })); });
    await click(view, "交还测试");
    if (accepted) await click(view, "停止 OCI Console 登录");
    await act(async () => { view.unmount(); });
    assert.equal(closes, 1);
  });
});

test("a viewer startup timeout settles its operation even if a private transport ignores abort", async (t) => {
  let release!: () => void, closes = 0;
  const transport = { start: () => new Promise<void>((resolve) => { release = resolve; }),
    frame: async () => ({ width: 800 as const, height: 600 as const, png, frameRef }), input: async () => {}, close: async () => { closes++; } };
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const view = renderControls(t, { ...props, transport });
  await click(view, "开始假页面测试");
  await act(async () => { t.mock.timers.tick(8000); });
  try { assert.match(view.getByRole("status").textContent!, /假页面测试未完成/); }
  finally { await act(async () => { release(); }); }
  assert.equal(view.queryByAltText("假页面测试画面"), null);
  assert.equal(closes, 1);
});
