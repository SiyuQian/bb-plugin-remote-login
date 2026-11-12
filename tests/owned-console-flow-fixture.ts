import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { TestContext } from "node:test";
import type { BrowserControlMode } from "../browser-control.ts";
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeHostResponse, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ControlAuthority, controlKeyFingerprint, inspectControlRoot, provisionControlRoot, type ControlScope } from "../control-authority.ts";
import { controlGrantSchema } from "../control-wire.ts";
import { openFixtureBrowser } from "../fixture-browser.ts";
import { FixtureLease } from "../fixture-lease.ts";
import { fixtureFrameSchema, type FixtureInput } from "../fixture-wire.ts";
import { inspectLoginRuntimeCapabilities } from "../login-runtime-capabilities.ts";
import { loginAttemptSchema } from "../login-protocol.ts";
import { openOciConsoleBrowser } from "../oci-console-browser.ts";
import { ConsoleHostJobs } from "../oci-console-host-job.ts";
import type { ConsoleExpectedIdentity } from "../oci-console-protocol.ts";
import type { ConsoleReadRequest } from "../oci-console-wire.ts";
import type { ConsoleSourceBoundary, ConsoleSourceProof } from "../oci-console-source.ts";
import { PairedControlGate } from "../paired-control-gate.ts";
import { assessLoginCapabilities } from "../provider-registry.ts";
import plugin from "../server.ts";
import { expectedConsole } from "./oci-console-fixture.ts";

export { expectedConsole, supportedConsoleFixture } from "./oci-console-fixture.ts";
export const context = { projectId: "project-owned-console-flow", threadId: "thread-owned-console-flow" };
export const fixtureKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const hostId = "host-owned-console-flow";
export const hostChoice = { id: hostId, name: "Owned Console fixture host" };

export function nativeValue(result: PluginAgentToolResult): Record<string, unknown> {
  assert.equal(typeof result, "object");
  if (typeof result === "string") throw new Error("Bounded native result required");
  assert.equal(result.content.length, 1);
  const part = result.content[0]!;
  assert.equal(part.type, "text");
  if (part.type !== "text") throw new Error("Bounded native text required");
  assert.ok(Buffer.byteLength(part.text) <= 16384);
  return JSON.parse(part.text) as Record<string, unknown>;
}

export async function eventually(predicate: () => boolean | Promise<boolean>, message = "Composed flow did not settle"): Promise<void> {
  for (let retry = 0; retry < 400; retry++) { if (await predicate()) return; await delay(10); }
  assert.fail(message);
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Real registered server/classes/browser. Only SDK transport, Console TLS routing and source attestation are fixtures. */
export async function ownedConsoleFlow(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "owned-console-flow-"));
  await chmod(root, 0o700);
  const dataDir = join(root, "private"), lifecycle = new AbortController();
  await provisionControlRoot(dataDir, fixtureKey, controlKeyFingerprint(fixtureKey));
  const authority = new ControlAuthority(dataDir), gate = new PairedControlGate(dataDir, authority);
  let retained = 0;
  const retain = () => { retained++; return { dispose: async () => { retained--; } }; };
  const fixtureBrowsers: Browser[] = [], fixturePages: Page[] = [];
  const fixture = new FixtureLease({ lifecycle: lifecycle.signal,
    authorize: (capability, scope) => authority.authorize(capability, scope), open: async (signal, controlMode) => {
      const launch = puppeteer.launch.bind(puppeteer), opened: Browser[] = [];
      const capture = t.mock.method(puppeteer, "launch", async (options: Parameters<typeof puppeteer.launch>[0]) => {
        const browser = await launch(options); opened.push(browser); return browser;
      });
      try {
        const driver = await openFixtureBrowser(dataDir, signal, controlMode);
        fixtureBrowsers.push(...opened);
        for (const browser of opened) fixturePages.push(...await browser.pages());
        return driver;
      } finally { capture.mock.restore(); }
    } });
  const state = {
    profile: { active: true, ocid: expectedConsole.userOcid, tenancyOcid: expectedConsole.tenancyOcid, domainOcid: expectedConsole.domainOcid } as Record<string, unknown>,
    reads: 0, readAborted: 0, inputs: 0, beforeRead: async () => {},
    afterHostCall: undefined as ((method: string, response: unknown) => void | Promise<void>) | undefined,
  };
  const browsers: Browser[] = [], pages: Page[] = [], capabilities: string[] = [];
  const waits: Array<{ controller: AbortController; result: Promise<PluginAgentToolResult> }> = [];
  const cleanup: { server?: https.Server; jobs?: ConsoleHostJobs; harness?: ReturnType<typeof createFakePluginHost>["harness"] } = {};
  t.after(async () => {
    for (const wait of waits) wait.controller.abort();
    await Promise.allSettled(waits.map(wait => wait.result));
    await cleanup.harness?.lifecycle.dispose(); lifecycle.abort();
    await Promise.allSettled([fixture.dispose(), cleanup.jobs?.dispose()]);
    await Promise.allSettled([...browsers, ...fixtureBrowsers].map(browser => browser.close()));
    if (cleanup.server) {
      cleanup.server.closeAllConnections();
      await new Promise<void>(resolve => cleanup.server!.close(() => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  });
  await promisify(execFile)("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=owned-console-loopback", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem")]);
  const html = `<!doctype html><title>Owned Console fixture</title><style>input{position:absolute;left:40px;top:40px;width:300px;height:40px}h1{margin-top:120px}</style><input autocomplete="off"><h1>Owned Console overview</h1><script>
    const identity={sub:${JSON.stringify(expectedConsole.userOcid)},tenant:${JSON.stringify(expectedConsole.tenancyOcid)},domain_ocid:${JSON.stringify(expectedConsole.domainOcid)},domain_stripe_url:${JSON.stringify(expectedConsole.domainOrigin)},nonce:"owned-generation-1"};
    const authenticator={getIdentityToken:async()=>({...identity}),getOverrideTenant:async()=>undefined};
    const signed=async resource=>{const request=new Request(resource);request.headers.set("Authorization",'Signature keyId="ST$fixture-private",version="1",algorithm="rsa-sha256",signature="fabricated"');return fetch(request);};
    class SelfServiceMeApi{constructor(fetch,origin){this.fetch=fetch;this.origin=origin;}async getMe(input,options){const url=new URL("/admin/v1/Me",this.origin);url.searchParams.set("attributes",input.attributes);const response=await this.fetch(new Request(url,{...options,method:"GET",headers:{...options.headers,"Content-Type":input.contentType}}));if(!response.ok)throw Error("fixture refusal");return{data:await response.json()};}}
    const Auth={getAuthenticator:()=>authenticator,getFetchApi:()=>signed};globalThis.webpackChunkoci_console={push:([ids,values,callback])=>callback(id=>({30045:{g:Auth},80002:{SelfServiceMeApi}})[id])};
    </script>`;
  const server = https.createServer({ key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) }, async (request, response) => {
    assert.equal(request.socket.remoteAddress, "127.0.0.1");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Access-Control-Allow-Origin", "https://cloud.oracle.com");
    response.setHeader("Access-Control-Allow-Headers", "authorization,content-type,opc-request-id,x-date");
    response.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    const hostname = request.headers.host?.split(":")[0];
    if (hostname === "cloud.oracle.com" && request.url === "/?region=ap-sydney-1") {
      response.writeHead(200, { "content-type": "text/html" }); response.end(html); return;
    }
    if (hostname === new URL(expectedConsole.domainOrigin).hostname && request.url?.startsWith("/admin/v1/Me?")) {
      if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
      assert.equal(request.method, "GET");
      assert.match(request.headers.authorization ?? "", /^Signature /);
      state.reads++; response.on("close", () => { if (!response.writableEnded) state.readAborted++; });
      await state.beforeRead();
      if (!response.destroyed) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(state.profile)); }
      return;
    }
    response.writeHead(404); response.end();
  });
  cleanup.server = server;
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Loopback fixture unavailable");
  const jobs = new ConsoleHostJobs({ dataDir, lifecycle: lifecycle.signal,
    authorize: (capability, scope) => authority.authorize(capability, scope), requirePhoneGate: mode => gate.require(mode),
    dependencies: { openBrowser: async input => {
      const driver = await openOciConsoleBrowser({ ...input, dependencies: {
      launch: async options => {
        // MAP * denies real DNS/provider traffic, including browser background requests.
        const browser = await puppeteer.launch({ ...options, acceptInsecureCerts: true,
          args: [...options?.args ?? [], `--host-resolver-rules=MAP * 127.0.0.1:${address.port}`] });
        browsers.push(browser); return browser;
      },
      sources: (page): ConsoleSourceBoundary => {
        pages.push(page);
        const proofs = new WeakSet<ConsoleSourceProof>(), target = page.target(), browserContext = page.browserContext();
        let disposed = false;
        return { async capture(signal) { signal.throwIfAborted(); const proof = Object.freeze({}) as ConsoleSourceProof; proofs.add(proof); return proof; },
          assert(proof) { if (disposed || !proofs.has(proof) || page.target() !== target || page.browserContext() !== browserContext) throw Error("Fixture source changed"); },
          dispose() { disposed = true; } };
      },
      } });
      // Count wrapper invocations, including refusals; the real driver alone
      // owns its input effect and synchronous replay-claim callback.
      return { ...driver, input: async (...args: Parameters<typeof driver.input>) => { state.inputs++; await driver.input(...args); } };
    } },
  });
  cleanup.jobs = jobs;
  const environment: Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["get"]>> = {
    baseBranch: null, branchName: null, createdAt: 1, defaultBranch: null, environmentProviderId: null, environmentProviderInstanceKey: null,
    environmentProviderSelection: null, hostId, hostLifecycle: "active", id: "environment-owned-console-flow", isGitRepo: false, isWorktree: false,
    lifecycle: { phase: "active", retireAt: null, teardown: null }, managed: false, mergeBaseBranch: null, name: "Owned Console fixture",
    path: "/private/owned-console-flow-environment", projectId: context.projectId, status: "ready", updatedAt: 1, workspaceProvisionType: "personal",
  };
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login", sdk: {
    hosts: { list: () => [makeHostResponse(hostChoice)] },
    threads: { get: () => makeThreadResponse({ ...context, id: context.threadId, environmentId: environment.id, deletedAt: null, archivedAt: null }) },
    environments: { get: () => environment },
  }, experimental_callHostRpc: async ({ hostId: target, method, input, signal }) => {
    assert.equal(target, hostId);
    const stopped = signal ?? lifecycle.signal;
    const p = input as { controlMode?: BrowserControlMode; capability: string; scope: ControlScope; deadline?: number; key: string; expected: ConsoleExpectedIdentity;
      event: FixtureInput; inputId: string; frameRef: string; receipt: string; browserRef: string; request: ConsoleReadRequest };
    try {
      stopped.throwIfAborted();
      const result = await (async () => { switch (method) {
        case "inspectLoginCapabilities": return assessLoginCapabilities(await inspectLoginRuntimeCapabilities(stopped));
        case "controlInfo": return { ...await inspectControlRoot(dataDir), provisioningDirectory: dataDir };
        case "authenticateControl": {
          const grant = await authority.authenticate(p.key, p.scope, p.deadline, grant => jobs.observeAuthenticatedGrant(p.scope, grant));
          capabilities.push(grant.capability);
          await fixture.refreshProof(grant.capability, p.scope);
          return { ok: true, grant };
        }
        case "authorizeControl": await authority.authorize(p.capability, p.scope); return { ok: true };
        case "revokeControl": await authority.revoke(p.capability, p.scope); await fixture.stopForScope(p.scope); if (jobs.hasScope(p.scope)) await jobs.stopForScope(p.scope); return { ok: true };
        case "startFixture": return { ok: true, viewport: await fixture.start(p.capability, p.scope, stopped, retain, p.controlMode) };
        case "frameFixture": return { ok: true, frame: await fixture.frame(p.capability, p.scope, stopped) };
        case "inputFixture": await fixture.input(p.capability, p.scope, p.event, stopped, p.inputId, p.frameRef); return { ok: true };
        case "completePhoneFixture": {
          const controlMode = await fixture.controlMode(p.capability, p.scope, stopped);
          return { ok: true, verified: await gate.acceptClosedFixture(p.capability, p.scope, stopped, async () => {
            if (!await fixture.verify(p.capability, p.scope, stopped)) return false;
            await fixture.close(p.capability, p.scope, stopped); return true;
          }, controlMode) };
        }
        case "closeFixture": await fixture.close(p.capability, p.scope, stopped); return { ok: true };
        case "consoleStatus": return { ok: true, status: await jobs.status(p.capability, p.scope, stopped, p.controlMode) };
        case "configureConsole": await jobs.configure(p.capability, p.scope, p.expected, stopped, p.controlMode); return { ok: true };
        case "startConsole": return { ok: true, viewport: await jobs.start(p.capability, p.scope, stopped, retain, p.controlMode) };
        case "frameConsole": return { ok: true, frame: await jobs.frame(p.capability, p.scope, stopped) };
        case "inputConsole": await jobs.input(p.capability, p.scope, p.event, stopped, p.inputId, p.frameRef); return { ok: true };
        case "handbackConsole": return { ok: true, result: await jobs.handback(p.capability, p.scope, stopped) };
        case "closeConsole": await jobs.close(p.capability, p.scope, stopped); return { ok: true };
        case "consoleResumeProof": return { ok: true, ...await jobs.resumeProof(p.scope, p.receipt) };
        case "readConsoleTask": return { ok: true, ...await jobs.readTask(p, p.request, stopped) };
        case "stopAttempt": return { ok: Boolean(await fixture.stopForScope(p.scope) || await jobs.stopForScope(p.scope)) };
        default: assert.fail(`Unexpected composed host method: ${method}`);
      } })();
      stopped.throwIfAborted();
      // Test-only late-delivery seam. The real operation and host signal check
      // precede it; without a hook, existing fixtures gain no extra await.
      if (state.afterHostCall) await state.afterHostCall(method, result);
      return result;
    } catch (error) { return { ok: false, reason: (error as { code?: string }).code ?? "control_unavailable" }; }
  } });
  cleanup.harness = harness;
  await plugin(bb);
  function select(attemptId: string) {
    let capability: string | undefined;
    const post = (action: string, extra: Record<string, unknown> = {}, proof = capability) => harness.behavior.fetchHttp("POST", `/login/${action}`, {
      headers: { "content-type": "application/json", ...(proof ? { authorization: `Bearer ${proof}` } : {}) },
      body: JSON.stringify({ attemptId, ...(action === "input" && !Object.hasOwn(extra, "inputId") ? { inputId: randomUUID() } : {}), ...extra }),
    });
    const status = async () => { const response = await post("status"); assert.equal(response.status, 200); return loginAttemptSchema.parse(await response.json()); };
    const authenticate = async () => {
      const response = await post("session", { key: fixtureKey }); assert.equal(response.status, 200);
      const result = await response.json() as { grant: unknown };
      const grant = controlGrantSchema.parse(result.grant); capability = grant.capability; return grant;
    };
    // Explicit manual setup only. post() never replaces a supplied or missing
    // observation, so stale/replay and malformed-input cases remain meaningful.
    const freshInput = async (event: FixtureInput, proof = capability) => {
      const response = await post("frame", {}, proof); assert.equal(response.status, 200);
      const frame = fixtureFrameSchema.parse(await response.json());
      return post("input", { event, frameRef: frame.frameRef }, proof);
    };
    return { attemptId, post, freshInput, status, authenticate, capability: () => { assert.ok(capability); return capability; } };
  }
  async function createAttempt(mode: "synthetic" | "oci_web") {
    const result = await harness.behavior.callAgentTool("remote_login_request", { mode }, context);
    assert.equal(typeof result === "object" && result.isError, undefined);
    const requested = nativeValue(result); assert.equal(requested.mode, mode); assert.equal(typeof requested.attemptId, "string");
    return select(requested.attemptId as string);
  }
  const createPairingAttempt = () => createAttempt("synthetic");
  const createConsoleAttempt = () => createAttempt("oci_web");
  async function pair() {
    assert.equal(await gate.accepted(), false);
    const client = await createPairingAttempt(); await client.authenticate();
    assert.equal((await client.post("start")).status, 200);
    for (const event of [{ type: "click", x: 80, y: 60 }, { type: "text", text: "fabricated paired control acceptance" }, { type: "click", x: 80, y: 130 }] as const) {
      assert.equal((await client.freshInput(event)).status, 200);
    }
    assert.equal((await client.post("handback")).status, 200);
    assert.equal(await gate.accepted(), true);
    assert.equal(retained, 0, "the synthetic browser must close before pairing acceptance");
    assert.equal((await readdir(dataDir)).some(name => name.startsWith("fixture-browser-")), false);
  }
  async function nativeWait(mode: "synthetic" | "oci_web", expectedAttemptId?: string) {
    const existing = new Set(harness.inspection.pendingInteractions.map(interaction => interaction.id));
    const controller = new AbortController(); let settled = false;
    const result = harness.behavior.callAgentTool("remote_login_request", { mode, wait: true }, { ...context, signal: controller.signal }).finally(() => { settled = true; });
    void result.catch(() => {}); waits.push({ controller, result });
    const opened = () => harness.inspection.pendingInteractions.find(interaction => !existing.has(interaction.id));
    await eventually(() => Boolean(opened()) || settled);
    const interaction = opened(); assert.ok(interaction, "The original native call must remain waiting");
    const { attemptId } = interaction.payload as { attemptId: string };
    assert.deepEqual(interaction.payload, { attemptId });
    assert.equal(interaction.rendererId, "login-control"); assert.equal(interaction.threadId, context.threadId);
    if (expectedAttemptId !== undefined) assert.equal(attemptId, expectedAttemptId, "Native waiting must rejoin the exact requested attempt");
    return { ...select(attemptId), result, interaction, settled: () => settled };
  }
  const waitConsole = () => nativeWait("oci_web");
  async function startNativeWait(attemptId: string) {
    const attempt = await select(attemptId).status();
    assert.ok(attempt.mode === "synthetic" || attempt.mode === "oci_web");
    return nativeWait(attempt.mode, attemptId);
  }
  async function start(client: ReturnType<typeof select>) {
    await client.authenticate();
    assert.equal((await client.post("console-target", { expected: expectedConsole })).status, 200);
    assert.equal((await client.post("start")).status, 202);
    await eventually(async () => {
      const response = await client.post("console-status"); assert.equal(response.status, 200);
      return (await client.status()).phase === "user_control";
    });
    assert.equal(browsers.length, 1); assert.equal(pages.length, 1); assert.equal(retained, 1);
  }
  async function finishHandback(client: ReturnType<typeof select>) {
    let completed = false;
    await eventually(async () => {
      const response = await client.post("handback");
      assert.ok(response.status === 200 || response.status === 202, `Unexpected Console handback status: ${response.status}`);
      if (response.status === 200) { assert.deepEqual(await response.json(), { verified: true }); completed = true; }
      return completed;
    });
  }
  return { bb, harness, root, dataDir, state, browsers, pages, fixtureBrowsers, fixturePages, gate, capabilities, hostChoice, createPairingAttempt, createConsoleAttempt, startNativeWait, pair, waitConsole, start, finishHandback,
    retained: () => retained };
}
