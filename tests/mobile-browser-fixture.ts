import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { build } from "esbuild";
import puppeteer, { type Browser } from "puppeteer-core";
import { withAbort } from "../private-response.ts";

export type MobileSlot = "pairing" | "login-attempts" | "login-control";
export type MobileInteraction = {
  id: string; payload: { attemptId: string }; title?: string; createdAt?: number; expiresAt?: number | null;
  submit(value: unknown): void | Promise<void>; cancel(): void | Promise<void>;
};
export type MobileBrowserOptions = {
  context: { projectId: string; threadId: string };
  rpc?(method: string, input: unknown): unknown | Promise<unknown>;
  http?(request: Request): Response | Promise<Response>;
  interaction?: MobileInteraction;
  beforeSend?(request: Request, response: Response): void | "drop" | Promise<void | "drop">;
};
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const supportedMobileBrowserFixture = process.platform === "darwin" && process.arch === "arm64" && existsSync(chrome);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value ?? null), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
// BB 0.49.0's public base CSS supplies this reset; typography comes from the real built stylesheet.
export const mobileFixtureHostStyle = `
@layer properties,theme,base,components,utilities;
@layer base {
  :where([data-bb-plugin=remote-login]), :where([data-bb-plugin=remote-login]) *,
  :where([data-bb-plugin=remote-login])::before, :where([data-bb-plugin=remote-login])::after,
  :where([data-bb-plugin=remote-login]) *::before, :where([data-bb-plugin=remote-login]) *::after,
  :where([data-bb-plugin=remote-login])::backdrop, :where([data-bb-plugin=remote-login]) *::backdrop,
  :where([data-bb-plugin=remote-login]) ::file-selector-button { box-sizing:border-box; border:0 solid; margin:0; padding:0; }
}
:root{--radius:.5rem;--background:#fff;--foreground:#111;--muted-foreground:#666;--border:#ddd;--input:#ccc;--ring:#333;--primary:#111;--primary-foreground:#fff;--secondary:#eee;--secondary-foreground:#111;--state-hover:#eee;--state-active:#ddd;--destructive:#a00;--destructive-foreground:#fff}
html,body{margin:0;min-height:100%;font-family:system-ui;background:white;color:black}body>div{min-height:100dvh}
`;

/** Local browser frontend only. App hooks use the public SDK testing runtime. */
export async function startMobileBrowserFixture(t: TestContext, options: MobileBrowserOptions) {
  const root = await mkdtemp(join(tmpdir(), "mobile-browser-fixture-"));
  let browser: Browser | undefined, server: Server | undefined, closing: Promise<void> | undefined;
  let origin = "", slot: MobileSlot = "pairing", interaction = options.interaction, revision = 0, errors = 0;
  const requests = new Set<AbortController>();
  const close = () => closing ??= (async () => {
    for (const request of requests) request.abort();
    try { if (browser) await withAbort(browser.close(), AbortSignal.timeout(8000)); }
    finally {
      server?.closeAllConnections();
      if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  })();
  t.after(close);
  await chmod(root, 0o700);
  const interactions = new Map<string, MobileInteraction>();
  if (interaction) interactions.set(interaction.id, interaction);
  const built = await build({ entryPoints: [new URL("./mobile-flow-page.tsx", import.meta.url).pathname], bundle: true, write: false,
    platform: "browser", format: "iife", target: "chrome157", define: { "process.env.NODE_ENV": '"development"' },
    tsconfig: new URL("../tsconfig.json", import.meta.url).pathname, logLevel: "silent" });
  const script = new Uint8Array(built.outputFiles[0]!.contents), css = await readFile(new URL("../dist/app.css", import.meta.url));
  const publicMount = () => ({ slot, revision, context: options.context, interaction: interaction ? {
    id: interaction.id, threadId: options.context.threadId, title: interaction.title ?? "Account-free mobile fixture",
    payload: interaction.payload, createdAt: interaction.createdAt ?? 1, expiresAt: interaction.expiresAt ?? null,
  } satisfies PluginPendingInteractionProps["interaction"] : null });
  server = createServer((incoming, outgoing) => { void (async () => {
    const controller = new AbortController(); requests.add(controller); incoming.once("aborted", () => controller.abort());
    outgoing.once("close", () => { if (!outgoing.writableEnded) controller.abort(); });
    let response: Response | undefined;
    try {
      const path = new URL(incoming.url ?? "/", origin).pathname;
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of incoming) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 4096) throw new Error(); chunks.push(bytes); }
      const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const request = new Request(new URL(incoming.url ?? "/", origin), { method: incoming.method, headers, signal: controller.signal,
        ...(chunks.length ? { body: Buffer.concat(chunks).toString("utf8") } : {}) });
      if (incoming.method === "GET" && path === "/") response = new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${mobileFixtureHostStyle}</style><link rel="stylesheet" href="/__test/app.css"></head><body><button hidden id="mobile-fixture-mount" type="button">Mount selected fixture view</button><script src="/__test/app.js"></script></body></html>`, { headers: { "content-type": "text/html" } });
      else if (incoming.method === "GET" && path === "/__test/app.js") response = new Response(script, { headers: { "content-type": "text/javascript" } });
      else if (incoming.method === "GET" && path === "/__test/app.css") response = new Response(css, { headers: { "content-type": "text/css" } });
      else if (incoming.method === "GET" && path === "/__test/mount") response = json(publicMount());
      else if (incoming.method === "POST" && path === "/__test/rpc") {
        const body = await request.json() as { method: string; input: unknown };
        if (!["hostChoices", "controlStatus", "loginAttempts"].includes(body.method) || !options.rpc) response = json({ error: "unavailable" }, 400);
        else response = json(await options.rpc(body.method, body.input));
      } else if (incoming.method === "POST" && ["/__test/interaction/submit", "/__test/interaction/cancel"].includes(path)) {
        const body = await request.json() as { interactionId: string; value?: unknown }, selected = interactions.get(body.interactionId);
        if (!selected) response = json({ error: "unavailable" }, 400);
        else { if (path.endsWith("/submit")) await selected.submit(body.value); else await selected.cancel(); response = json({ accepted: true }); }
      } else if (path.startsWith("/api/v1/plugins/remote-login/http/") && options.http) response = await options.http(request);
      else response = json({ error: "unavailable" }, 404);
      if (options.beforeSend && (path.startsWith("/api/") || path === "/__test/rpc")) {
        if (await withAbort(Promise.resolve(options.beforeSend(request, response)), controller.signal) === "drop") { void response.body?.cancel().catch(() => {}); outgoing.destroy(); return; }
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        try { for (;;) { const result = await withAbort(reader.read(), controller.signal); if (result.done) break; if (!outgoing.write(result.value)) await withAbort(new Promise<void>(resolve => outgoing.once("drain", resolve)), controller.signal); } }
        finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
      outgoing.end();
    } catch { void response?.body?.cancel().catch(() => {}); if (outgoing.headersSent || outgoing.destroyed || controller.signal.aborted) outgoing.destroy(); else { outgoing.writeHead(503, { "content-type": "application/json" }); outgoing.end('{"error":"unavailable"}'); } }
    finally { requests.delete(controller); }
  })(); });
  server.requestTimeout = 8000;
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string"); origin = `http://127.0.0.1:${address.port}`;
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, pipe: true, userDataDir: join(root, "profile"),
    args: ["--no-proxy-server", "--disable-quic", "--host-resolver-rules=MAP 127.0.0.1 127.0.0.1, MAP localhost 127.0.0.1, MAP * ~NOTFOUND"],
    allowlist: ["about\\:blank", `${origin}/*`], logger: () => undefined });
  const page = await browser.newPage();
  page.on("pageerror", () => { errors++; });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(8000);
  await page.goto(origin, { waitUntil: "load", timeout: 8000 });
  await page.waitForFunction(() => document.documentElement.dataset.mobileFixtureRevision === "0");
  return { page, browser, origin, close,
    async show(next: MobileSlot, selected?: MobileInteraction) {
      slot = next; if (selected) { interaction = selected; interactions.set(selected.id, selected); }
      if (slot === "login-control" && !interaction) throw new Error("A fixed original interaction is required.");
      revision++;
      await page.$eval("#mobile-fixture-mount", node => (node as HTMLButtonElement).click());
      await page.waitForFunction(value => document.documentElement.dataset.mobileFixtureRevision === String(value), {}, revision);
    },
    async metrics() {
      const layout = await page.evaluate(() => {
        const main = document.querySelector("main,section"), style = main ? getComputedStyle(main) : null;
        return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, pointerCoarse: matchMedia("(pointer: coarse)").matches,
          page: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
          main: { width: main?.getBoundingClientRect().width ?? 0, paddingTop: style?.paddingTop ?? "" } };
      });
      return { ...layout, errors, browserVersion: await browser!.version(), sourceSha256: createHash("sha256").update(script).digest("hex"), cssSha256: createHash("sha256").update(css).digest("hex") };
    },
  };
}
