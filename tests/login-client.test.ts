import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { postLogin } from "../login-client.ts";
import { FrameChangedError, StaleFrameError } from "../frame-error.ts";
import type { LoginAttempt } from "../login-protocol.ts";

const capability = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
const frameRef = "11111111-1111-4111-8111-111111111111";
const attempt: LoginAttempt = {
  version: 1, attemptId: "attempt-a", projectId: "project-a", threadId: "thread-a", environmentId: "environment-a",
  hostId: "host-a", browserContextId: "browser-a", generation: 1, principalId: "principal-a", mode: "synthetic",
  phase: "awaiting_control", revision: 1, createdAt: 100, updatedAt: 101, expiresAt: 1000,
  verification: null, resume: { state: "none", deliveryId: null }, failure: null,
};
const response = (value: unknown, cache = "no-store") => new Response(JSON.stringify(value), { headers: { "cache-control": cache } });

test("job input carries the displayed frame and generates only its own operation identity", async t => {
  let ids = 0, requests = 0;
  const inputId = "22222222-2222-4222-8222-222222222222";
  t.mock.method(globalThis.crypto, "randomUUID", () => { ids++; return inputId; });
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    assert.deepEqual(JSON.parse(String(init?.body)), { attemptId: "attempt-a", frameRef, event: { type: "key", key: "Enter" }, inputId });
    return response({ accepted: true });
  });
  await postLogin("https://bb.invalid", "input", { attemptId: "attempt-a", frameRef, event: { type: "key", key: "Enter" } }, capability);
  assert.equal(ids, 1); assert.equal(requests, 1);
  for (const metadata of [{}, { frameRef: "unissued-format" }, { frameRef, inputId }]) {
    await assert.rejects(postLogin("https://bb.invalid", "input", { attemptId: "attempt-a", event: { type: "key", key: "Enter" }, ...metadata }, capability));
  }
  assert.equal(ids, 1); assert.equal(requests, 1);
});

test("a transport exception cannot impersonate a decoded job stale response", async t => {
  let failure: Error = new StaleFrameError();
  t.mock.method(globalThis, "fetch", async () => { throw failure; });
  for (const ErrorType of [StaleFrameError, FrameChangedError]) for (const action of ["input", "frame"] as const) {
    failure = new ErrorType();
    await assert.rejects(postLogin("https://bb.invalid", action, action === "input" ? { attemptId: "attempt-a", frameRef, event: { type: "key", key: "Enter" } } : { attemptId: "attempt-a" }, capability),
      { name: "Error", message: "Login control failed." });
  }
});

test("an exact changed job frame read is distinguished from an unsent input", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response('{"error":"stale_frame"}', { status: 409, headers: { "cache-control": "no-store" } });
  });
  await assert.rejects(postLogin("https://bb.invalid", "frame", { attemptId: "attempt-a" }, capability), error => error instanceof Error && error.name === "FrameChangedError");
  assert.equal(requests, 1, "a changed read must not automatically fetch again");
});

test("a changed job frame reply arriving after abort stays a generic failure", async t => {
  const controller = new AbortController(); let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++; controller.abort();
    return new Response('{"error":"stale_frame"}', { status: 409, headers: { "cache-control": "no-store" } });
  });
  await assert.rejects(postLogin("https://bb.invalid", "frame", { attemptId: "attempt-a" }, capability, controller.signal), { name: "Error", message: "Login control failed." });
  assert.equal(requests, 1);
});

test("only an exact private job input stale refusal preserves recoverable semantics", async t => {
  let requests = 0;
  const reply = { status: 409, cache: "no-store", value: { error: "stale_frame" } as object };
  t.mock.method(globalThis, "fetch", async () => {
    requests++; return new Response(JSON.stringify(reply.value), { status: reply.status, headers: { "cache-control": reply.cache } });
  });
  const send = () => postLogin("https://bb.invalid", "input", { attemptId: "attempt-a", frameRef, event: { type: "key", key: "Enter" } }, capability);
  await assert.rejects(send(), error => error instanceof Error && error.name === "StaleFrameError");
  for (const changed of [{ status: 503 }, { cache: "public" }, { value: { error: "stale_frame", accepted: true } }, { value: { error: "login_control_failed" } }]) {
    Object.assign(reply, { status: 409, cache: "no-store", value: { error: "stale_frame" } }, changed);
    await assert.rejects(send(), { name: "Error", message: "Login control failed." });
  }
  Object.assign(reply, { status: 409, cache: "no-store", value: { error: "stale_frame" } });
  await assert.rejects(postLogin("https://bb.invalid", "frame", { attemptId: "attempt-a" }, capability), { name: "FrameChangedError" });
  await assert.rejects(postLogin("https://bb.invalid", "start", { attemptId: "attempt-a" }, capability), { name: "Error", message: "Login control failed." });
  assert.equal(requests, 7, "a stale refusal must not create a new input or read");
});

test("job requests bind only the attempt and keep grants in private POST headers", async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const inputId = "01234567-89ab-4cde-8f01-23456789abcd";
  t.mock.method(globalThis.crypto, "randomUUID", () => inputId);
  const results = { status: attempt, session: { grant: { capability, expiresAt: 1000 }, attempt }, renew: { capability: "B".repeat(43), expiresAt: 1100 }, start: { width: 800, height: 600 }, input: { accepted: true }, handback: { verified: true }, close: { closed: true } };
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return response(results[String(url).split("/").at(-1)! as keyof typeof results]);
  });
  for (const action of ["status", "session", "renew", "start", "input", "handback", "close"] as const) {
    const body = { attemptId: "attempt-a", ...(action === "session" ? { key: capability } : {}), ...(action === "input" ? { frameRef, event: { type: "key", key: "Enter" } } : {}) };
    assert.deepEqual(await postLogin("https://active.fixture.invalid", action, body, action === "status" || action === "session" ? undefined : capability), results[action]);
    const call = calls.at(-1)!;
    assert.equal(call.url, `https://active.fixture.invalid/api/v1/plugins/remote-login/http/login/${action}`);
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.credentials, "include");
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.init.referrerPolicy, "no-referrer");
    assert.deepEqual(JSON.parse(String(call.init.body)), action === "input" ? { ...body, inputId } : body);
    assert.equal(new Headers(call.init.headers).get("authorization"), action === "status" || action === "session" ? null : `Bearer ${capability}`);
  }
});

test("ordinary job requests settle after abort even when fetch or its body ignores cancellation", async (t) => {
  for (const stage of ["fetch", "body"] as const) await t.test(stage, async (t) => {
    const controller = new AbortController();
    let release!: () => void;
    let cancelled = false;
    t.mock.method(globalThis, "fetch", async () => stage === "fetch"
      ? new Promise<Response>((resolve) => { release = () => resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "cache-control": "no-store" } })); })
      : new Response(new ReadableStream({ start(stream) { release = () => { stream.enqueue(new TextEncoder().encode('{"accepted":true}')); stream.close(); }; }, cancel() { cancelled = true; } }), { headers: { "cache-control": "no-store" } }));
    let rejected = false;
    const pending = postLogin("https://bb.invalid", "input", { attemptId: "attempt-a", frameRef, event: { type: "key", key: "Enter" } }, capability, controller.signal)
      .catch((error: unknown) => { assert.equal((error as Error).message, "Login control failed."); rejected = true; });
    await setImmediate(); controller.abort(); await setImmediate();
    try { assert.equal(rejected, true, "the caller must settle while transport is still held"); }
    finally { try { release(); } catch { /* Aborted body readers may already be cancelled. */ } await pending; }
    await setImmediate(); assert.equal(cancelled, true, "late private responses must not retain unread streams");
  });
});

test("job client rejects unsafe endpoints, alternate scope, invalid keys and unsigned control before HTTP", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; throw new Error("must not request"); });
  for (const [origin, action, body, proof] of [
    ["http://remote.invalid", "status", { attemptId: "attempt-a" }, undefined],
    ["https://user:pass@bb.invalid", "status", { attemptId: "attempt-a" }, undefined],
    ["https://bb.invalid/path", "status", { attemptId: "attempt-a" }, undefined],
    ["https://bb.invalid", "status", { attemptId: "attempt-a", hostId: "other-host" }, undefined],
    ["https://bb.invalid", "session", { attemptId: "attempt-a", key: "bad" }, undefined],
    ["https://bb.invalid", "start", { attemptId: "attempt-a" }, undefined],
    ["https://bb.invalid", "input", { attemptId: "attempt-a", frameRef, event: { type: "text", text: "x".repeat(257) } }, capability],
  ] as const) await assert.rejects(postLogin(origin, action, body, proof), { message: "Login control failed." });
  assert.equal(calls, 0);
});

test("job responses reject false verification, unbounded frames and cacheable grants without exposing server text", async (t) => {
  for (const [action, value, cache] of [
    ["handback", { verified: false, error: capability }, "no-store"],
    ["session", { grant: { capability, expiresAt: 1000 }, attempt }, "public"],
    ["frame", { frameRef, png: "A".repeat(1_700_000), width: 800, height: 600 }, "no-store"],
  ] as const) {
    t.mock.method(globalThis, "fetch", async () => response(value, cache));
    await assert.rejects(postLogin("https://bb.invalid", action, { attemptId: "attempt-a", ...(action === "session" ? { key: capability } : {}) }, action === "session" ? undefined : capability), { message: "Login control failed." });
  }
});


test("renew rejects alternate targets, malformed grants and cacheable responses without retries", async (t) => {
  let calls = 0;
  let value: unknown = { capability: "B".repeat(43), expiresAt: 1100 };
  let cache = "no-store";
  t.mock.method(globalThis, "fetch", async () => { calls += 1; return response(value, cache); });
  for (const body of [{ attemptId: "attempt-a", hostId: "host-b" }, { attemptId: "attempt-a", scope: {} }]) {
    await assert.rejects(postLogin("https://bb.invalid", "renew", body, capability));
  }
  assert.equal(calls, 0);
  for (const invalid of [{ capability: "bad", expiresAt: 1100 }, { capability: "B".repeat(43), expiresAt: 1100, hostId: "host-b" }]) {
    value = invalid;
    await assert.rejects(postLogin("https://bb.invalid", "renew", { attemptId: "attempt-a" }, capability), { message: "Login control failed." });
  }
  value = { capability: "B".repeat(43), expiresAt: 1100 }; cache = "public";
  await assert.rejects(postLogin("https://bb.invalid", "renew", { attemptId: "attempt-a" }, capability));
  assert.equal(calls, 3);
});

test("renew preserves a strict late grant for caller cleanup after abort", async (t) => {
  const controller = new AbortController();
  const grant = { capability: "B".repeat(43), expiresAt: 1100 };
  t.mock.method(globalThis, "fetch", async () => { controller.abort(); return response(grant); });
  assert.deepEqual(await postLogin("https://bb.invalid", "renew", { attemptId: "attempt-a" }, capability, controller.signal), grant);
  await assert.rejects(postLogin("https://bb.invalid", "renew", { attemptId: "attempt-a" }, capability, controller.signal));
});

const expectedOci = { mode: "oci_cli", tenancyOcid: "ocid1.tenancy.oc1..targettenancy", userOcid: "ocid1.user.oc1..targetuser", region: "ap-sydney-1", realm: "oc1" } as const;

test("OCI target selection uses only the private attempt capability and strict expected identity", async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return response({ configured: true });
  });
  assert.deepEqual(await postLogin("https://bb.invalid", "oci-target", { attemptId: "attempt-a", expected: expectedOci }, capability), { configured: true });
  assert.equal(new Headers(calls[0]!.init.headers).get("authorization"), `Bearer ${capability}`);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { attemptId: "attempt-a", expected: expectedOci });
  assert.equal(calls[0]!.url.includes(expectedOci.userOcid), false);
  for (const body of [
    { attemptId: "attempt-a", expected: { ...expectedOci, region: "not-a-region" } },
    { attemptId: "attempt-a", expected: { ...expectedOci, realm: "oc2" } },
    { attemptId: "attempt-a", expected: expectedOci, hostId: "other-host" },
  ]) await assert.rejects(postLogin("https://bb.invalid", "oci-target", body, capability), { message: "Login control failed." });
  await assert.rejects(postLogin("https://bb.invalid", "oci-target", { attemptId: "attempt-a", expected: expectedOci }));
  assert.equal(calls.length, 1);
});

test("OCI status admits only bounded gate state and cannot carry provider data", async (t) => {
  let value: unknown = { configured: false, phoneControlAccepted: false, phase: "unconfigured", failure: null };
  t.mock.method(globalThis, "fetch", async () => response(value));
  assert.deepEqual(await postLogin("https://bb.invalid", "oci-status", { attemptId: "attempt-a" }, capability), value);
  for (const extra of [{ account: expectedOci.userOcid }, { failure: "private provider failure" }, { phase: "authenticated" }]) {
    value = { configured: true, phoneControlAccepted: true, phase: "ready", failure: null, ...extra };
    await assert.rejects(postLogin("https://bb.invalid", "oci-status", { attemptId: "attempt-a" }, capability), { message: "Login control failed." });
  }
});

test("OCI startup accepts a bounded pending acknowledgement without a viewport or provider detail", async (t) => {
  let value: unknown = { pending: true };
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(value), { status: 202, headers: { "cache-control": "no-store" } }));
  assert.deepEqual(await postLogin("https://bb.invalid", "start", { attemptId: "attempt-a" }, capability), { pending: true });
  for (const invalid of [{ pending: false }, { pending: true, url: "https://private.invalid" }, { width: 800, height: 600, pending: true }]) {
    value = invalid;
    await assert.rejects(postLogin("https://bb.invalid", "start", { attemptId: "attempt-a" }, capability), { message: "Login control failed." });
  }
});

const expectedConsole = { mode: "oci_web", userOcid: "ocid1.user.oc1..selecteduser", tenancyOcid: "ocid1.tenancy.oc1..selectedtenancy",
  domainOcid: "ocid1.domain.oc1..selecteddomain", domainOrigin: "https://selected.identity.oraclecloud.com", region: "ap-sydney-1", realm: "oc1" } as const;

test("Console target and status stay on strict capability-protected private routes", async (t) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const status = { configured: false, phoneControlAccepted: false, phase: "unconfigured", failure: null };
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return response(String(url).endsWith("/console-target") ? { configured: true } : status);
  });
  assert.deepEqual(await postLogin("https://bb.invalid", "console-target", { attemptId: "attempt-a", expected: expectedConsole }, capability), { configured: true });
  assert.deepEqual(await postLogin("https://bb.invalid", "console-status", { attemptId: "attempt-a" }, capability), status);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { attemptId: "attempt-a", expected: expectedConsole });
  assert.ok(calls.every((call) => new Headers(call.init.headers).get("authorization") === `Bearer ${capability}`));
  assert.ok(calls.every((call) => call.init.cache === "no-store" && !call.url.includes(expectedConsole.userOcid)));
  for (const expected of [{ ...expectedConsole, domainOrigin: "https://foreign.invalid" }, { ...expectedConsole, region: "us-phoenix-1" }, { ...expectedConsole, verified: true }]) {
    await assert.rejects(postLogin("https://bb.invalid", "console-target", { attemptId: "attempt-a", expected }, capability));
  }
  await assert.rejects(postLogin("https://bb.invalid", "console-target", { attemptId: "attempt-a", expected: expectedConsole }));
  assert.equal(calls.length, 2);
});

test("Console private status refuses account, browser-reference and writer metadata", async (t) => {
  let value: unknown;
  t.mock.method(globalThis, "fetch", async () => response(value));
  for (const extra of [{ userOcid: expectedConsole.userOcid }, { browserRef: "private-browser-reference" }, { writer: { pid: 1 } }, { verified: true }]) {
    value = { configured: true, phoneControlAccepted: true, phase: "ready", failure: null, ...extra };
    await assert.rejects(postLogin("https://bb.invalid", "console-status", { attemptId: "attempt-a" }, capability));
  }
});

test("a strict late protected handback acknowledgement remains available only for caller ownership cleanup", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => { controller.abort(); return response({ verified: true }); });
  assert.deepEqual(await postLogin("https://bb.invalid", "handback", { attemptId: "attempt-a" }, capability, controller.signal), { verified: true });
  await assert.rejects(postLogin("https://bb.invalid", "handback", { attemptId: "attempt-a" }, capability, controller.signal));
});

test("job client gives each input one fresh identity while other job actions remain identity-free", async (t) => {
  const ids = ["01234567-89ab-4cde-8f01-23456789abcd", "11234567-89ab-4cde-8f01-23456789abcd"] as const;
  let generated = 0;
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis.crypto, "randomUUID", () => ids[generated++]!);
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return response(String(url).endsWith("/input") ? { accepted: true } : { width: 800, height: 600 });
  });
  await postLogin("https://bb.invalid", "start", { attemptId: "attempt-a" }, capability);
  const payload = { attemptId: "attempt-a", frameRef, event: { type: "key", key: "Enter" } };
  await postLogin("https://bb.invalid", "input", payload, capability);
  await postLogin("https://bb.invalid", "input", payload, capability);
  assert.equal(generated, 2);
  assert.deepEqual(bodies, [{ attemptId: "attempt-a" }, { ...payload, inputId: ids[0] }, { ...payload, inputId: ids[1] }]);
  assert.equal(Object.hasOwn(payload, "inputId"), false);
});

test("job client rejects caller-selected and malformed generated input identities before fetch", async (t) => {
  let generated = 0, requests = 0;
  t.mock.method(globalThis.crypto, "randomUUID", () => { generated++; return "not-a-valid-input-id" as ReturnType<Crypto["randomUUID"]>; });
  t.mock.method(globalThis, "fetch", async () => { requests++; return response({ accepted: true }); });
  const payload = { attemptId: "attempt-a", frameRef, event: { type: "key", key: "Enter" } };
  for (const extra of [{ inputId: "01234567-89ab-4cde-8f01-23456789abcd" }, { inputId: "bad" }, { replay: true }]) {
    await assert.rejects(postLogin("https://bb.invalid", "input", { ...payload, ...extra }, capability), { message: "Login control failed." });
  }
  assert.equal(generated, 0);
  await assert.rejects(postLogin("https://bb.invalid", "input", payload, capability), { message: "Login control failed." });
  assert.equal(generated, 1);
  assert.equal(requests, 0);
});
