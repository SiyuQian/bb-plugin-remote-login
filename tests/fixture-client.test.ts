import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { boundedJson, postFixture } from "../fixture-client.ts";
import { FrameChangedError, StaleFrameError } from "../frame-error.ts";

const scope = { threadId: "fixture-thread", attemptId: "fixture-attempt", browserContextId: "fixture-browser", generation: 1 };
const target = { hostId: "fixture-host", scope };
const frameRef = "11111111-1111-4111-8111-111111111111";
const capability = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKD8AAAAASUVORK5CYII=";

test("fixture input carries its displayed frame and mints exactly one operation identity", async t => {
  let ids = 0, requests = 0;
  const inputId = "22222222-2222-4222-8222-222222222222";
  t.mock.method(globalThis.crypto, "randomUUID", () => { ids++; return inputId; });
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    assert.deepEqual(JSON.parse(String(init?.body)), { ...target, frameRef, event: { type: "key", key: "Enter" }, inputId });
    return new Response('{"accepted":true}', { headers: { "cache-control": "no-store" } });
  });
  await postFixture("https://bb.invalid", "input", { ...target, frameRef, event: { type: "key", key: "Enter" } }, capability);
  assert.equal(ids, 1); assert.equal(requests, 1);
  for (const metadata of [{}, { frameRef: "unissued-format" }, { frameRef, inputId }]) {
    await assert.rejects(postFixture("https://bb.invalid", "input", { ...target, event: { type: "key", key: "Enter" }, ...metadata }, capability));
  }
  assert.equal(ids, 1); assert.equal(requests, 1);
});

test("a transport exception cannot impersonate a decoded fixture stale response", async t => {
  let failure: Error = new StaleFrameError();
  t.mock.method(globalThis, "fetch", async () => { throw failure; });
  for (const ErrorType of [StaleFrameError, FrameChangedError]) for (const action of ["input", "frame"] as const) {
    failure = new ErrorType();
    await assert.rejects(postFixture("https://bb.invalid", action, action === "input" ? { ...target, frameRef, event: { type: "key", key: "Enter" } } : target, capability),
      { name: "Error", message: "Fixture control failed." });
  }
});

test("an exact changed frame read is distinguished from an unsent input", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response('{"error":"stale_frame"}', { status: 409, headers: { "cache-control": "no-store" } });
  });
  await assert.rejects(postFixture("https://bb.invalid", "frame", target, capability), error => error instanceof Error && error.name === "FrameChangedError");
  assert.equal(requests, 1, "a changed read must not automatically fetch again");
});

test("a changed fixture frame reply arriving after abort stays a generic failure", async t => {
  const controller = new AbortController(); let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++; controller.abort();
    return new Response('{"error":"stale_frame"}', { status: 409, headers: { "cache-control": "no-store" } });
  });
  await assert.rejects(postFixture("https://bb.invalid", "frame", target, capability, controller.signal), { name: "Error", message: "Fixture control failed." });
  assert.equal(requests, 1);
});

test("only an exact private input stale refusal has recoverable client semantics", async t => {
  let requests = 0;
  const reply = { status: 409, cache: "no-store", value: { error: "stale_frame" } as object };
  t.mock.method(globalThis, "fetch", async () => {
    requests++; return new Response(JSON.stringify(reply.value), { status: reply.status, headers: { "cache-control": reply.cache } });
  });
  const send = () => postFixture("https://bb.invalid", "input", { ...target, frameRef, event: { type: "key", key: "Enter" } }, capability);
  await assert.rejects(send(), error => error instanceof Error && error.name === "StaleFrameError");
  for (const changed of [{ status: 503 }, { cache: "public" }, { value: { error: "stale_frame", accepted: true } }, { value: { error: "fixture_control_failed" } }]) {
    Object.assign(reply, { status: 409, cache: "no-store", value: { error: "stale_frame" } }, changed);
    await assert.rejects(send(), { name: "Error", message: "Fixture control failed." });
  }
  Object.assign(reply, { status: 409, cache: "no-store", value: { error: "stale_frame" } });
  await assert.rejects(postFixture("https://bb.invalid", "frame", target, capability), { name: "FrameChangedError" });
  await assert.rejects(postFixture("https://bb.invalid", "start", target, capability), { name: "Error", message: "Fixture control failed." });
  assert.equal(requests, 7, "refusals must never replay input or fetch another frame");
});

test("an oversized declared private response cancels its unread body before refusal", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-length": "1600001" } });
  await assert.rejects(boundedJson(response));
  assert.equal(cancelled, true);
});

test("fixture input abort settles before an unresponsive fetch or body returns", async (t) => {
  for (const stage of ["fetch", "body"] as const) await t.test(stage, async (t) => {
    const controller = new AbortController(); let release!: () => void, cancelled = false;
    t.mock.method(globalThis, "fetch", async () => stage === "fetch"
      ? new Promise<Response>((resolve) => { release = () => resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "cache-control": "no-store" } })); })
      : new Response(new ReadableStream({ start(stream) { release = () => { stream.enqueue(new TextEncoder().encode('{"accepted":true}')); stream.close(); }; }, cancel() { cancelled = true; } }), { headers: { "cache-control": "no-store" } }));
    let rejected = false;
    const pending = postFixture("https://bb.invalid", "input", { ...target, frameRef, event: { type: "key", key: "Enter" } }, capability, controller.signal)
      .catch((error: unknown) => { assert.equal((error as Error).message, "Fixture control failed."); rejected = true; });
    await setImmediate(); controller.abort(); await setImmediate();
    try { assert.equal(rejected, true, "input must settle without retrying or waiting for transport"); }
    finally { try { release(); } catch { /* An aborted reader can already be cancelled. */ } await pending; }
    await setImmediate(); assert.equal(cancelled, true, "late private responses must be cancelled without consuming their data");
  });
});

async function serve(t: TestContext, listener: RequestListener) {
  const server = createServer(listener);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("fixture requests use fixed private POST routes and keep proof out of URLs and JSON", async (t) => {
  const calls: { path: string; method: string; authorization?: string; body: unknown }[] = [];
  const inputId = "01234567-89ab-4cde-8f01-23456789abcd";
  t.mock.method(globalThis.crypto, "randomUUID", () => inputId);
  const responses = { start: { width: 800, height: 600 }, frame: { frameRef, png, width: 800, height: 600 }, input: { accepted: true }, close: { closed: true } };
  const origin = await serve(t, async (request, response) => {
    let body = ""; for await (const chunk of request) body += String(chunk);
    calls.push({ path: request.url!, method: request.method!, authorization: request.headers.authorization, body: JSON.parse(body) });
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    const action = request.url!.split("/").at(-1) as keyof typeof responses;
    response.end(JSON.stringify(responses[action]));
  });
  for (const action of ["start", "frame", "input", "close"] as const) {
    const body = { ...target, ...(action === "input" ? { frameRef, event: { type: "text", text: "synthetic only" } } : {}) };
    assert.deepEqual(await postFixture(origin, action, body, capability), responses[action]);
    assert.deepEqual(calls.at(-1), { path: `/api/v1/plugins/remote-login/http/fixture/${action}`, method: "POST", authorization: `Bearer ${capability}`, body: action === "input" ? { ...body, inputId } : body });
  }
  assert.equal(JSON.stringify(calls.map(({ path, body }) => ({ path, body }))).includes(capability), false);
});

test("fixture client rejects unsafe origins, proof, scope and unbounded input before HTTP", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests += 1; throw new Error("Must not request"); });
  for (const origin of ["http://remote.invalid", "https://user:pass@bb.invalid", "https://bb.invalid/path", "https://bb.invalid?secret=x"]) {
    await assert.rejects(postFixture(origin, "frame", target, capability), { message: "Fixture control failed." });
  }
  for (const [action, body, proof] of [
    ["frame", target, "invalid"],
    ["frame", { ...target, scope: { ...scope, generation: -1 } }, capability],
    ["start", { ...target, url: "https://unapproved.invalid" }, capability],
    ["input", { ...target, frameRef, event: { type: "text", text: "x".repeat(257) } }, capability],
    ["input", { ...target, frameRef, event: { type: "key", key: "Control+L" } }, capability],
    ["unknown", target, capability],
  ] as const) {
    await assert.rejects(postFixture("https://bb.invalid", action as "frame", body, proof), { message: "Fixture control failed." });
  }
  assert.equal(requests, 0);
});

test("fixture input is never retried and denial text never reaches its error", async (t) => {
  let requests = 0;
  const origin = await serve(t, (_request, response) => {
    requests += 1;
    response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ private: `${capability} synthetic input fixture` }));
  });
  await assert.rejects(postFixture(origin, "input", { ...target, frameRef, event: { type: "key", key: "Enter" } }, capability), {
    message: "Fixture control failed.",
  });
  assert.equal(requests, 1);
});

test("fixture responses are bounded and must match the action and private cache policy", async (t) => {
  for (const item of [
    { name: "wrong dimensions", value: { frameRef, png, width: 1, height: 1 }, cache: "no-store" },
    { name: "non-PNG", value: { frameRef, png: "private invalid frame", width: 800, height: 600 }, cache: "no-store" },
    { name: "oversized response", value: { frameRef, png: "private" + "A".repeat(2_000_000), width: 800, height: 600 }, cache: "no-store" },
    { name: "cacheable response", value: { frameRef, png, width: 800, height: 600 }, cache: "public" },
    { name: "extra fields", value: { frameRef, png, width: 800, height: 600, token: capability }, cache: "no-store" },
  ]) {
    await t.test(item.name, async (t) => {
      const origin = await serve(t, (_request, response) => {
        response.writeHead(200, { "content-type": "application/json", "cache-control": item.cache });
        response.end(JSON.stringify(item.value));
      });
      await assert.rejects(postFixture(origin, "frame", target, capability), { message: "Fixture control failed." });
    });
  }
});

test("fixture fetch uses private browser options and honors cancellation", async (t) => {
  const controller = new AbortController();
  let captured: RequestInit | undefined;
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured = init;
    throw new Error("private transport failure fixture");
  });
  await assert.rejects(postFixture("https://bb.fixture.invalid", "start", target, capability, controller.signal), { message: "Fixture control failed." });
  assert.equal(captured!.cache, "no-store");
  assert.equal(captured!.credentials, "include");
  assert.equal(captured!.referrerPolicy, "no-referrer");
  assert.equal(captured!.signal, controller.signal);
  controller.abort();
  await assert.rejects(postFixture("https://bb.fixture.invalid", "frame", target, capability, controller.signal), { message: "Fixture control failed." });
});

test("fixture client assigns one fresh input identity per call and none to frame requests", async (t) => {
  const ids = ["01234567-89ab-4cde-8f01-23456789abcd", "11234567-89ab-4cde-8f01-23456789abcd"] as const;
  let generated = 0;
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis.crypto, "randomUUID", () => ids[generated++]!);
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(String(url).endsWith("/input") ? { accepted: true } : { frameRef, png, width: 800, height: 600 }), { headers: { "cache-control": "no-store" } });
  });
  await postFixture("https://bb.invalid", "frame", target, capability);
  const payload = { ...target, frameRef, event: { type: "key", key: "Enter" } };
  await postFixture("https://bb.invalid", "input", payload, capability);
  await postFixture("https://bb.invalid", "input", payload, capability);
  assert.equal(generated, 2);
  assert.deepEqual(bodies, [target, { ...payload, inputId: ids[0] }, { ...payload, inputId: ids[1] }]);
  assert.equal(Object.hasOwn(payload, "inputId"), false, "client input must not mutate the caller's event envelope");
});

test("fixture caller metadata and malformed generated input identities are refused before fetch", async (t) => {
  let generated = 0, requests = 0;
  t.mock.method(globalThis.crypto, "randomUUID", () => { generated++; return "not-a-valid-input-id" as ReturnType<Crypto["randomUUID"]>; });
  t.mock.method(globalThis, "fetch", async () => { requests++; return new Response('{"accepted":true}', { headers: { "cache-control": "no-store" } }); });
  const payload = { ...target, frameRef, event: { type: "key", key: "Enter" } };
  for (const extra of [{ inputId: "01234567-89ab-4cde-8f01-23456789abcd" }, { inputId: "bad" }, { replay: true }]) {
    await assert.rejects(postFixture("https://bb.invalid", "input", { ...payload, ...extra }, capability), { message: "Fixture control failed." });
  }
  assert.equal(generated, 0);
  await assert.rejects(postFixture("https://bb.invalid", "input", payload, capability), { message: "Fixture control failed." });
  assert.equal(generated, 1);
  assert.equal(requests, 0);
});
