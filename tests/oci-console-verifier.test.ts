import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleIdentityVerifier } from "../oci-console-verifier.ts";
import { consoleFixture, consoleScope, expectedConsole, supportedConsoleFixture } from "./oci-console-fixture.ts";

const options = { skip: !supportedConsoleFixture, timeout: 20000, concurrency: false };
function verifier(fixture: Awaited<ReturnType<typeof consoleFixture>>, extra: Partial<Parameters<typeof createConsoleIdentityVerifier>[0]> = {}) {
  return createConsoleIdentityVerifier({ page: fixture.page, scope: consoleScope, expected: expectedConsole,
    expiresAt: Date.now() + 60000, lifecycle: fixture.lifecycle.signal, assertOwned: fixture.assertOwned,
    dependencies: { sources: fixture.sources }, ...extra });
}

test("owned Console verifier requires a real correlated signed self-read and returns only bounded matches", options, async (t) => {
  const f = await consoleFixture(t), v = verifier(f); t.after(() => v.dispose());
  const result = await v.verify(new AbortController().signal);
  assert.deepEqual(result, { matched: true, userMatched: true, tenancyMatched: true, domainMatched: true, sourceBuild: "4.26.2hotfix.2" });
  assert.equal(f.state.reads, 1); assert.ok(f.state.ownerChecks >= 3);
  for (const privateValue of [expectedConsole.userOcid, expectedConsole.tenancyOcid, expectedConsole.domainOcid, f.signature, f.root]) assert.equal(JSON.stringify(result).includes(privateValue), false);
});

test("cancellation drains a late private network allowance without dispatching a self-read", options, async t => {
  const f=await consoleFixture(t);let entered!:()=>void,release!:()=>void,revoked=0,active=false;
  const waiting=new Promise<void>(r=>{entered=r;}),held=new Promise<void>(r=>{release=r;});
  const v=verifier(f,{allowRead:async()=>{entered();await held;active=true;return async()=>{active=false;revoked++;};}});t.after(()=>v.dispose());
  const controller=new AbortController(),pending=v.verify(controller.signal);void pending.catch(()=>{});
  await waiting;controller.abort();release();await assert.rejects(pending);
  assert.equal(revoked,1);assert.equal(active,false);assert.equal(f.state.reads,0);
});

test("a page evaluation reporting success without network evidence cannot verify Console identity", options, async (t) => {
  const f = await consoleFixture(t), v = verifier(f, { timeoutMs: 150 }); t.after(() => v.dispose());
  t.mock.method(f.page, "evaluate", async () => true);
  await assert.rejects(v.verify(new AbortController().signal), { message: "Console verification unavailable." });
  assert.equal(f.state.reads, 0);
});

test("Console service rejection, missing identity and any wrong exact principal field fail closed", options, async (t) => {
  const f = await consoleFixture(t), v = verifier(f); t.after(() => v.dispose());
  for (const patch of [{ ocid: "ocid1.user.oc1..wronguser" }, { tenancyOcid: "ocid1.tenancy.oc1..wrongtenancy" }, { domainOcid: "ocid1.domain.oc1..wrongdomain" }, { active: false }]) {
    const original = f.state.profile; f.state.profile = { ...original, ...patch };
    await assert.rejects(v.verify(new AbortController().signal), { message: "Console verification unavailable." });
    f.state.profile = original;
  }
  delete f.state.profile.domainOcid;
  await assert.rejects(v.verify(new AbortController().signal), { message: "Console verification unavailable." });
  f.state.status = 401;
  await assert.rejects(v.verify(new AbortController().signal), { message: "Console verification unavailable." });
});

test("wire authorization substitution is refused even if the service returns the expected identity", options, async (t) => {
  const f = await consoleFixture(t), v = verifier(f); t.after(() => v.dispose());
  await f.page.setRequestInterception(true);
  f.page.on("request", (request) => {
    if (request.url().startsWith(expectedConsole.domainOrigin + "/admin/v1/Me?")) void request.continue({ headers: { ...request.headers(), authorization: f.signature.replace("fixture-private-token", "substituted-private-token") } });
    else void request.continue();
  });
  await assert.rejects(v.verify(new AbortController().signal), { message: "Console verification unavailable." });
  assert.equal(f.state.reads, 1);
});

test("Console credential-generation change and final owner revocation defeat matching late evidence", options, async (t) => {
  const f = await consoleFixture(t), v = verifier(f); t.after(() => v.dispose());
  f.state.beforeRead = async () => { await f.page.evaluate(() => { (globalThis as any).consoleFixture.identity.nonce = "replacement-generation"; }); };
  await assert.rejects(v.verify(new AbortController().signal), { message: "Console verification unavailable." });
  f.state.beforeRead = async () => { f.state.owned = false; };
  await assert.rejects(v.verify(new AbortController().signal), { message: "Console verification unavailable." });
});

test("default Console attestor refuses a page lacking actual pinned source deliveries before any identity read", options, async (t) => {
  const f = await consoleFixture(t), v = verifier(f, { dependencies: undefined }); t.after(() => v.dispose());
  await assert.rejects(v.verify(new AbortController().signal), { message: "Console verification unavailable.", code: "source" });
  assert.equal(f.state.reads, 0);
});

test("cached or service-worker identity responses cannot authorize even when the profile matches", options, async (t) => {
  const f = await consoleFixture(t), v = verifier(f); t.after(() => v.dispose());
  const createSession = f.page.createCDPSession.bind(f.page);
  let fromServiceWorker = false;
  t.mock.method(f.page, "createCDPSession", async () => {
    const session = await createSession();
    session.on("Network.responseReceived", (event) => { if (fromServiceWorker) event.response.fromServiceWorker = true; else event.response.fromDiskCache = true; });
    return session;
  });
  await assert.rejects(v.verify(new AbortController().signal), { code: "network" });
  fromServiceWorker = true;
  await assert.rejects(v.verify(new AbortController().signal), { code: "network" });
  assert.equal(f.state.reads, 2);
});

test("navigation while a signed self-read is pending invalidates matching late Console evidence", options, async (t) => {
  const f = await consoleFixture(t), v = verifier(f); t.after(() => v.dispose());
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  f.state.beforeRead = async () => { entered(); await held; };
  const pending = v.verify(new AbortController().signal);
  void pending.catch(() => {});
  await waiting;
  await f.page.goto("https://cloud.oracle.com/#replacement", { waitUntil: "load" });
  release();
  await assert.rejects(pending, { message: "Console verification unavailable." });
});

test("a final owner change during CDP cleanup prevents a previously matching result from escaping", options, async (t) => {
  const f = await consoleFixture(t), v = verifier(f); t.after(() => v.dispose());
  const createSession = f.page.createCDPSession.bind(f.page);
  t.mock.method(f.page, "createCDPSession", async () => {
    const session = await createSession(), detach = session.detach.bind(session);
    t.mock.method(session, "detach", async () => { await detach(); f.state.owned = false; });
    return session;
  });
  await assert.rejects(v.verify(new AbortController().signal), { code: "ownership" });
  assert.equal(f.state.reads, 1);
});

test("cancelling a held Console self-read restores fetch and aborts only its owned request before returning", options, async (t) => {
  const f = await consoleFixture(t), v = verifier(f); t.after(() => v.dispose());
  const before = await f.page.evaluateHandle(() => globalThis.fetch);
  t.after(() => before.dispose());
  let entered!: () => void, release!: () => void, otherEntered!: () => void, otherRelease!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
  const otherWaiting = new Promise<void>((resolve) => { otherEntered = resolve; }), otherHeld = new Promise<void>((resolve) => { otherRelease = resolve; });
  f.state.beforeRead = async () => { entered(); await held; };
  f.state.beforeOtherRead = async () => { otherEntered(); await otherHeld; };
  let otherSettled = false;
  const unrelated = f.page.evaluate((origin) => fetch(origin + "/unrelated").then((response) => response.text()), expectedConsole.domainOrigin).finally(() => { otherSettled = true; });
  await otherWaiting;
  const controller = new AbortController(), pending = v.verify(controller.signal);
  void pending.catch(() => {});
  try {
    await waiting; controller.abort();
    await assert.rejects(pending, { message: "Console verification unavailable." });
    assert.equal(await f.page.evaluate((fetch) => globalThis.fetch === fetch, before), true);
    assert.equal(otherSettled, false); assert.equal(f.state.otherAborted, 0);
  } finally { release(); otherRelease(); }
  assert.equal(await unrelated, "unrelated fixture read");
  assert.equal(f.state.readAborted, 1);
  f.state.beforeRead = async () => {};
  assert.equal((await v.verify(new AbortController().signal)).matched, true);
  assert.equal(await f.page.evaluate((fetch) => globalThis.fetch === fetch, before), true);
});

test("memory-cache evidence is rejected before correlation and after response completion", options, async (t) => {
  const f = await consoleFixture(t), v = verifier(f); t.after(() => v.dispose());
  const createSession = f.page.createCDPSession.bind(f.page);
  let late = false;
  t.mock.method(f.page, "createCDPSession", async () => {
    const session = await createSession();
    session.on("Network.requestWillBeSent", (event) => {
      if (!late && event.request.url.startsWith(expectedConsole.domainOrigin + "/admin/v1/Me?")) session.emit("Network.requestServedFromCache", { requestId: event.requestId });
    });
    const send = session.send.bind(session);
    t.mock.method(session, "send", (async (method, params) => {
      const result = await send(method, params);
      if (late && method === "Network.getResponseBody") session.emit("Network.requestServedFromCache", { requestId: (params as { requestId: string }).requestId });
      return result;
    }) as typeof session.send);
    return session;
  });
  await assert.rejects(v.verify(new AbortController().signal), { code: "network" });
  late = true;
  await assert.rejects(v.verify(new AbortController().signal), { code: "network" });
});

test("a correlated redirect chain cannot evade refusal by removing its request marker", options, async (t) => {
  const f = await consoleFixture(t), v = verifier(f); t.after(() => v.dispose());
  const createSession = f.page.createCDPSession.bind(f.page);
  t.mock.method(f.page, "createCDPSession", async () => {
    const session = await createSession();
    let request: import("puppeteer-core").Protocol.Network.RequestWillBeSentEvent | undefined;
    session.on("Network.requestWillBeSent", (event) => { if (event.type === "Fetch" && event.request.url.startsWith(expectedConsole.domainOrigin + "/admin/v1/Me?")) request = event; });
    const send = session.send.bind(session);
    t.mock.method(session, "send", (async (method, params) => {
      const result = await send(method, params);
      if (method === "Network.getResponseBody" && request) session.emit("Network.requestWillBeSent", { ...request, request: { ...request.request, headers: {}, url: expectedConsole.domainOrigin + "/redirected" }, redirectResponse: {} as import("puppeteer-core").Protocol.Network.Response });
      return result;
    }) as typeof session.send);
    return session;
  });
  await assert.rejects(v.verify(new AbortController().signal), { code: "network" });
});

test("cancelled late acquisition disposes only its owned CDP session or bridge handle", options, async (t) => {
  for (const kind of ["session", "bridge"] as const) await t.test(kind, async (t) => {
    const f = await consoleFixture(t), v = verifier(f); t.after(() => v.dispose());
    let entered!: () => void, release!: () => void, disposed = 0;
    const waiting = new Promise<void>((resolve) => { entered = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
    if (kind === "session") {
      const createSession = f.page.createCDPSession.bind(f.page);
      t.mock.method(f.page, "createCDPSession", async () => {
        const session = await createSession(), detach = session.detach.bind(session);
        t.mock.method(session, "detach", async () => { disposed++; await detach(); });
        entered(); await held; return session;
      });
    } else {
      const evaluateHandle = f.page.evaluateHandle.bind(f.page);
      t.mock.method(f.page, "evaluateHandle", (async (...args) => {
        const handle = await evaluateHandle(...args) as import("puppeteer-core").JSHandle, dispose = handle.dispose.bind(handle);
        t.mock.method(handle, "dispose", async () => { disposed++; await dispose(); });
        entered(); await held; return handle;
      }) as typeof f.page.evaluateHandle);
    }
    const controller = new AbortController(), pending = v.verify(controller.signal);
    void pending.catch(() => {});
    await waiting; controller.abort(); release();
    await assert.rejects(pending, { message: "Console verification unavailable." });
    assert.equal(disposed, 1);
  });
});

test("unconfirmed page cancellation poisons the verifier until its owner closes the context", options, async (t) => {
  const f = await consoleFixture(t), v = verifier(f); t.after(() => v.dispose());
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
  f.state.beforeRead = async () => { entered(); await held; };
  const evaluate = f.page.evaluate.bind(f.page);
  t.mock.method(f.page, "evaluate", (async (...args) => {
    if (typeof args[0] === "function" && String(args[0]).includes(".dispose(")) return new Promise(() => {});
    return evaluate(...args);
  }) as typeof f.page.evaluate);
  const controller = new AbortController(), pending = v.verify(controller.signal);
  void pending.catch(() => {});
  try {
    await waiting; controller.abort();
    await assert.rejects(pending, { code: "cleanup_uncertain", message: "Console verification unavailable." });
    await assert.rejects(v.verify(new AbortController().signal), { code: "cleanup_uncertain" });
    assert.equal(f.state.reads, 1);
  } finally { release(); }
});
