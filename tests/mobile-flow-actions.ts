import assert from "node:assert/strict";
import type { ElementHandle, Page } from "puppeteer-core";

type Backend = {
  fetchHttp(method: string, path: string, init?: RequestInit): Promise<Response>;
  callRpc(method: string, input?: unknown): Promise<unknown>;
  submitInteraction(id: string, value: { attemptId: string }): void;
  cancelInteraction(id: string): void;
};

async function touchPoint(page: Page, element: ElementHandle<Element>, fraction = { x: 0.5, y: 0.5 }) {
  await element.evaluate(node => node.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }));
  const result = await element.evaluate(async (node, point) => {
    let previous = "", stable = 0;
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const box = node.getBoundingClientRect(), viewport = visualViewport;
      const signature = JSON.stringify([box.x, box.y, box.width, box.height, scrollX, scrollY,
        viewport?.offsetLeft, viewport?.offsetTop, viewport?.scale]);
      stable = signature === previous ? stable + 1 : 0; previous = signature;
      const x = box.x + point.x * box.width, y = box.y + point.y * box.height;
      const hit = document.elementFromPoint(x, y);
      const disabled = ((node instanceof HTMLButtonElement || node instanceof HTMLInputElement) && node.disabled)
        || node.getAttribute("aria-disabled") === "true";
      if (stable >= 6 && !disabled && box.width > 0 && box.height > 0 && (hit === node || (hit && node.contains(hit)))) {
        // DOM rectangles/hit testing use layout coordinates; CDP touch points
        // use the visual viewport, which can pan when a mobile input is focused.
        const visualX = x - (viewport?.offsetLeft ?? 0), visualY = y - (viewport?.offsetTop ?? 0);
        if (visualX >= 0 && visualY >= 0 && visualX < (viewport?.width ?? innerWidth) && visualY < (viewport?.height ?? innerHeight)) {
          return { x: visualX, y: visualY };
        }
      }
    }
    throw new Error("Mobile touch target did not settle.");
  }, fraction);
  await page.touchscreen.tap(result.x, result.y);
}

/** Only fixed test transport adapters; authority stays in the registered routes. */
export function mobileBackend(backend: Backend) {
  const calls = new Map<string, number>(), submissions = new Map<string, number>();
  const count = (name: string) => calls.set(name, (calls.get(name) ?? 0) + 1);
  return {
    calls, submissions,
    rpc: async (method: string, input?: unknown) => {
      assert.ok(["hostChoices", "controlStatus", "loginAttempts"].includes(method));
      count(`rpc/${method}`); return backend.callRpc(method, input);
    },
    http: async (request: Request) => {
      const prefix = "/api/v1/plugins/remote-login/http";
      const pathname = new URL(request.url).pathname;
      assert.ok(pathname.startsWith(prefix));
      const path = pathname.slice(prefix.length);
      assert.match(path, /^\/(control|fixture|login)\/[a-z-]+$/);
      assert.equal(request.method, "POST"); count(path);
      return backend.fetchHttp(request.method, path, {
        headers: request.headers, body: await request.text(), signal: request.signal,
      });
    },
    interaction: (client: { attemptId: string; interaction: { id: string } }) => ({
      id: client.interaction.id, payload: { attemptId: client.attemptId }, title: "Account-free mobile interaction",
      submit: (value: unknown) => {
        assert.deepEqual(value, { attemptId: client.attemptId });
        submissions.set(client.attemptId, (submissions.get(client.attemptId) ?? 0) + 1);
        backend.submitInteraction(client.interaction.id, { attemptId: client.attemptId });
      },
      cancel: () => backend.cancelInteraction(client.interaction.id),
    }),
  };
}

export async function tapButton(page: Page, name: string) {
  await page.waitForFunction((text) => [...document.querySelectorAll("button")].some((button) =>
    button.textContent?.trim() === text && !button.disabled && button.getBoundingClientRect().width > 0), {}, name);
  const handle = await page.evaluateHandle((text) => [...document.querySelectorAll("button")].find((button) =>
    button.textContent?.trim() === text && !button.disabled && button.getBoundingClientRect().width > 0)!, name);
  try { await touchPoint(page, handle.asElement() as ElementHandle<HTMLButtonElement>); } finally { await handle.dispose(); }
}

export async function fillField(page: Page, name: string, value: string) {
  await page.waitForFunction((text) => [...document.querySelectorAll("label")].some((label) =>
    label.textContent?.trim() === text && label.querySelector("input:not(:disabled)")), {}, name);
  const handle = await page.evaluateHandle((text) => [...document.querySelectorAll("label")].find((label) =>
    label.textContent?.trim() === text && label.querySelector("input:not(:disabled)"))!.querySelector("input")!, name);
  try {
    await touchPoint(page, handle.asElement() as ElementHandle<HTMLInputElement>);
    await page.waitForFunction(input => document.activeElement === input, {}, handle);
    await page.keyboard.type(value);
    await page.waitForFunction((input, expected) => input.value === expected, {}, handle, value);
  } finally { await handle.dispose(); }
}

export async function waitText(page: Page, text: string) {
  await page.waitForFunction((value) => document.body.textContent?.includes(value), {}, text);
}

export async function tapFrame(page: Page, alt: string, x: number, y: number) {
  const image = await page.waitForSelector(`img[alt="${alt}"][aria-disabled="false"]`);
  assert.ok(image);
  try { await touchPoint(page, image, { x: x / 800, y: y / 600 }); } finally { await image.dispose(); }
}

export async function checkPairingPage(page: Page, key: string) {
  await tapButton(page, "检查连接与配对状态"); await waitText(page, "host 已配对");
  await fillField(page, "控制密钥", key); await tapButton(page, "验证配对");
  await waitText(page, "控制密钥验证通过"); await tapButton(page, "撤销本次授权");
  await waitText(page, "本次控制授权已撤销");
}

export async function completeSyntheticCard(page: Page, key: string, text = "手机端中文输入验证") {
  await fillField(page, "控制密钥", key); await tapButton(page, "验证并接管测试");
  await tapButton(page, "开始假页面测试");
  await tapFrame(page, "假页面测试画面", 80, 60);
  await fillField(page, "测试文字", text); await tapButton(page, "发送测试文字");
  await tapFrame(page, "假页面测试画面", 80, 130);
  await tapButton(page, "交还并核验测试结果");
  await waitText(page, "登录结果已核验");
}

/** Inspect actual layout; never repair it with fixture CSS. */
export async function assertMobileLayout(page: Page) {
  const geometry = await page.evaluate(() => ({
    viewport: innerWidth, width: document.documentElement.scrollWidth,
    touch: matchMedia("(pointer: coarse)").matches,
    input: document.querySelector("input")?.getBoundingClientRect().width ?? null,
    overflow: [...document.querySelectorAll("main,section,div,button,input,dl,dt,dd,p")].filter(node => {
      const box = node.getBoundingClientRect(); return box.width > 0 && (box.right > 391 || box.left < -1);
    }).slice(0, 8).map(node => ({ tag: node.tagName, className: node.className,
      left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
      minWidth: getComputedStyle(node).minWidth, whiteSpace: getComputedStyle(node).whiteSpace })),
  }));
  assert.equal(geometry.viewport, 390, JSON.stringify(geometry)); assert.ok(geometry.width <= 391, "plugin layout overflows the mobile viewport");
  assert.equal(geometry.touch, true);
  if (geometry.input !== null) assert.ok(geometry.input > 0 && geometry.input <= 390);
  return geometry;
}
