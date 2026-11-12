import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test, { after, before } from "node:test";
import http from "node:http";
import https, { type RequestOptions } from "node:https";
import dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { OfficialDeviceFlowInput } from "../official-device-flow.ts";

const originals = { httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get, fetch: globalThis.fetch };
before(() => {
  const forbidden = (): never => { throw new Error("Actual HTTP is forbidden in device-flow fixtures."); };
  http.request = forbidden; http.get = forbidden; https.request = forbidden; https.get = forbidden;
  globalThis.fetch = forbidden; syncBuiltinESMExports();
});
after(() => {
  http.request = originals.httpRequest; http.get = originals.httpGet; https.request = originals.httpsRequest; https.get = originals.httpsGet;
  globalThis.fetch = originals.fetch; syncBuiltinESMExports();
});

// Invented values only. Every execution supplies a fixture HTTP dependency; no network is used.
const origin = "https://idcs-device-fixture.identity.oraclecloud.com";
const config = { issuerOrigin: origin, clientId: "reviewed-fixture-client", scopes: ["fixture.read"], clientAuthentication: "none" as const };
const device = { device_code: "host-only-device-code", user_code: "ABCD-EFGH", verification_uri: `${origin}/ui/v1/device`, expires_in: 300, interval: 2 };
const token = { access_token: "host-only-access-token", token_type: "Bearer", expires_in: 300, scope: "fixture.read", refresh_token: "discard-refresh-token" };
type Reply = { status?: number; contentType?: string; value?: unknown; raw?: string; elapsed?: number; timeout?: boolean };

let executorModule: Promise<typeof import("../official-device-flow.ts") | undefined> | undefined;
async function run(input: OfficialDeviceFlowInput) {
  const module = await (executorModule ??= import("../official-device-flow.ts").catch(() => undefined));
  assert.ok(module?.runOfficialDeviceFlow, "the internal official device executor must exist");
  return module.runOfficialDeviceFlow(input);
}
function fixture(replies: Reply[] = [{ value: device }, { value: token }]) {
  let now = 1000;
  const controller = new AbortController();
  const calls: { url: string; fields: Record<string, string>; at: number; timeoutMs: number; body: Buffer }[] = [];
  const responses: Buffer[] = [], waits: number[] = [], presented: unknown[] = [], received: string[] = [], tokenBuffers: Uint8Array[] = [];
  let ownershipChecks = 0;
  const input: OfficialDeviceFlowInput = {
    trustedConfig: config, signal: controller.signal,
    assertOwned: async () => { ownershipChecks++; },
    present: async human => { presented.push(human); },
    consumeToken: async value => { tokenBuffers.push(value); received.push(Buffer.from(value).toString()); },
    dependencies: {
      now: () => now,
      wait: async (ms, signal) => { signal.throwIfAborted(); waits.push(ms); now += ms; },
      post: async request => {
        request.signal.throwIfAborted();
        calls.push({ url: request.url, fields: Object.fromEntries(new URLSearchParams(request.body.toString())), at: now, timeoutMs: request.timeoutMs, body: request.body });
        const reply = replies.shift();
        assert.ok(reply, "unexpected HTTP request: the fixture must forbid extra polling");
        now += reply.elapsed ?? 0;
        if (reply.timeout) throw Object.assign(new Error("fixture timeout"), { code: "ETIMEDOUT" });
        const body = Buffer.from(reply.raw ?? JSON.stringify(reply.value)); responses.push(body);
        return { status: reply.status ?? 200, contentType: reply.contentType ?? "application/json", body };
      },
    },
  };
  return { input, controller, calls, responses, waits, presented, received, tokenBuffers, ownershipChecks: () => ownershipChecks };
}

// Catches token leakage through a returned/native/UI value and premature polling.
test("only the official URI and user code reach the human while the private consumer gets a short-lived token buffer", async () => {
  const f = fixture([{ value: { ...device, verification_uri_complete: `${origin}/ui/v1/device?user_code=ABCD-EFGH` } }, { value: token }]);
  assert.deepEqual(await run(f.input), { status: "consumed" });
  assert.deepEqual(f.presented, [{ verificationUri: `${origin}/ui/v1/device`, userCode: "ABCD-EFGH" }]);
  assert.deepEqual(f.received, ["host-only-access-token"]);
  assert.deepEqual(f.calls.map(c => ({ url: c.url, fields: c.fields, at: c.at })), [
    { url: `${origin}/oauth2/v1/device`, fields: { response_type: "device_code", client_id: "reviewed-fixture-client", scope: "fixture.read" }, at: 1000 },
    { url: `${origin}/oauth2/v1/token`, fields: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "reviewed-fixture-client", device_code: "host-only-device-code" }, at: 3000 },
  ]);
  assert.ok(f.calls.every(c => c.body.every(byte => byte === 0)));
  assert.ok(f.responses.every(body => body.every(byte => byte === 0)));
  assert.ok(f.tokenBuffers.every(body => body.every(byte => byte === 0)));
  assert.equal(f.ownershipChecks(), 8);
});

// Catches immediate retries, resetting slow_down, and missing timeout backoff.
test("pending retains the interval, every slow_down adds five seconds, and each timeout doubles it", async () => {
  const f = fixture([
    { value: device }, { status: 400, value: { error: "authorization_pending" } },
    { status: 400, value: { error: "slow_down" } }, { status: 400, value: { error: "slow_down" } },
    { timeout: true }, { timeout: true }, { value: token },
  ]);
  assert.deepEqual(await run(f.input), { status: "consumed" });
  assert.deepEqual(f.waits, [2000, 2000, 7000, 12000, 24000, 48000]);
  assert.deepEqual(f.calls.map(c => c.at), [1000, 3000, 5000, 12000, 24000, 48000, 96000]);
});

test("an omitted interval uses five seconds", async () => {
  const { interval: _, ...withoutInterval } = device;
  const f = fixture([{ value: withoutInterval }, { value: token }]);
  assert.deepEqual(await run(f.input), { status: "consumed" });
  assert.deepEqual(f.waits, [5000]);
});

test("response time counts against a monotonic expiry and no poll starts at the deadline", async () => {
  const f = fixture([{ value: { ...device, expires_in: 5 }, elapsed: 1500 }, { status: 400, value: { error: "authorization_pending" }, elapsed: 1500 }]);
  assert.deepEqual(await run(f.input), { status: "expired" });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]!.timeoutMs, 1500);
  assert.deepEqual(f.received, []);
});

test("a short device lifetime expires before its first allowed poll", async () => {
  const f = fixture([{ value: { ...device, expires_in: 1 } }]);
  assert.deepEqual(await run(f.input), { status: "expired" });
  assert.equal(f.calls.length, 1);
});

for (const [error, status] of [["access_denied", "denied"], ["expired_token", "expired"], ["invalid_grant", "failed"], ["temporarily_unavailable", "failed"]] as const) {
  test(`the ${error} token response stops polling with a sanitized ${status} result`, async () => {
    const f = fixture([{ value: device }, { status: 400, value: { error, error_description: "not exposed to callers" } }]);
    assert.deepEqual(await run(f.input), { status });
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.received, []);
  });
}

test("cancellation before starting performs no HTTP or presentation", async () => {
  const f = fixture(); f.controller.abort(new Error("do not expose cancellation reason"));
  assert.deepEqual(await run(f.input), { status: "cancelled" });
  assert.deepEqual(f.calls, []); assert.deepEqual(f.presented, []);
});

test("cancellation during presentation prevents token polling", async () => {
  const f = fixture(); f.input.present = async () => { f.controller.abort(); };
  assert.deepEqual(await run(f.input), { status: "cancelled" });
  assert.equal(f.calls.length, 1); assert.deepEqual(f.received, []);
});

test("ownership loss after a token response prevents private consumption and clears the response", async () => {
  const f = fixture(); let check = 0;
  f.input.assertOwned = async () => { if (++check === 6) throw new Error("private lease failure"); };
  assert.deepEqual(await run(f.input), { status: "failed" });
  assert.equal(f.calls.length, 2); assert.deepEqual(f.received, []);
  assert.ok(f.responses.every(body => body.every(byte => byte === 0)));
});

test("an exception in the private consumer is sanitized and the borrowed token is erased", async () => {
  const f = fixture(); let retained: Uint8Array | undefined;
  f.input.consumeToken = async value => { retained = value; throw new Error("host-only-access-token"); };
  assert.deepEqual(await run(f.input), { status: "failed" });
  assert.ok(retained?.every(byte => byte === 0));
});

// Catches endpoint/secret injection before the transport, including URL normalization tricks.
for (const changed of [
  { issuerOrigin: "http://idcs-device-fixture.identity.oraclecloud.com" },
  { issuerOrigin: "https://localhost" }, { issuerOrigin: "https://127.0.0.1" }, { issuerOrigin: "https://[::1]" },
  { issuerOrigin: "https://evil.identity.oraclecloud.com.attacker.example" },
  { issuerOrigin: `${origin}:443` }, { issuerOrigin: `${origin}/` }, { issuerOrigin: `${origin}?a=b` },
  { issuerOrigin: origin.toUpperCase() }, { issuerOrigin: "https://user@idcs-device-fixture.identity.oraclecloud.com" },
  { tokenEndpoint: "https://attacker.example/token" }, { clientSecret: "never-supported" },
  { clientAuthentication: "client_secret_post" }, { clientId: "" }, { scopes: [] }, { scopes: ["fixture.read fixture.write"] }, { scopes: ["fixture.read", "fixture.read"] }, { scopes: ['fixture."read'] }, { scopes: ["fixture.\\read"] },
]) {
  test(`unreviewed host configuration is refused before HTTP: ${Object.keys(changed).join(",")}:${JSON.stringify(changed).slice(0, 90)}`, async () => {
    const f = fixture(); f.input.trustedConfig = { ...config, ...changed };
    assert.deepEqual(await run(f.input), { status: "failed" });
    assert.deepEqual(f.calls, []);
  });
}

for (const changed of [
  { verification_uri: "https://attacker.example/activate" }, { verification_uri: "http://idcs-device-fixture.identity.oraclecloud.com/ui/v1/device" },
  { verification_uri: `${origin}/ui/v1/device?user_code=ABCD-EFGH` }, { verification_uri: `${origin}/ui/v1/device#fragment` },
  { verification_uri: `${origin}/ui/v1/%64evice` }, { verification_uri: `${origin}:443/ui/v1/device` },
  { device_code: "" }, { device_code: "x".repeat(4097) }, { user_code: "unsafe\ncode" },
  { expires_in: 0 }, { expires_in: 901 }, { expires_in: 3.5 }, { interval: 0 }, { interval: 301 },
  { interval: "2" }, { injected: "ignored-data-is-not-accepted" },
]) {
  test(`malformed device authorization is refused before presentation: ${Object.keys(changed).join(",")}:${JSON.stringify(changed).slice(0, 90)}`, async () => {
    const f = fixture([{ value: { ...device, ...changed } }]);
    assert.deepEqual(await run(f.input), { status: "failed" });
    assert.deepEqual(f.presented, []); assert.equal(f.calls.length, 1);
    assert.ok(f.responses.every(body => body.every(byte => byte === 0)));
  });
}

for (const reply of [
  { status: 302, value: device }, { contentType: "text/html", value: device },
  { raw: JSON.stringify(device).replace('"expires_in":300', '"expires_in":300,"expires_in":300') },
  { raw: JSON.stringify(device).replace('"expires_in":300', '"expires_in":300,"expires_\\u0069n":300') },
  { raw: `{"nested":${JSON.stringify(device)}}` }, { raw: "[1,2]" }, { raw: "{" },
  { raw: " ".repeat(16385) }, { timeout: true },
]) {
  test(`invalid, duplicate, oversized, redirected or timed-out start response cannot begin a flow: ${JSON.stringify(reply).slice(0, 70)}`, async () => {
    const f = fixture([reply]);
    assert.deepEqual(await run(f.input), { status: "failed" });
    assert.deepEqual(f.presented, []); assert.equal(f.calls.length, 1);
  });
}

for (const reply of [
  { value: { ...token, token_type: "mac" } }, { value: { ...token, access_token: "" } },
  { value: { ...token, scope: "fixture.write" } }, { value: { ...token, scope: "fixture.read fixture.write" } },
  { value: { ...token, extra: "unsupported" } }, { value: { ...token, scope: "fixture.read fixture.read" } }, { status: 200, value: { error: "authorization_pending" } },
  { status: 503, value: { error: "authorization_pending" } }, { status: 302, value: token },
]) {
  test(`an invalid token response is terminal and never reaches the consumer: ${JSON.stringify(reply).slice(0, 85)}`, async () => {
    const f = fixture([{ value: device }, reply]);
    assert.deepEqual(await run(f.input), { status: "failed" });
    assert.equal(f.calls.length, 2); assert.deepEqual(f.received, []);
    assert.ok(f.responses.every(body => body.every(byte => byte === 0)));
  });
}


test("ownership is rechecked immediately after a timed-out poll before another wait", async () => {
  const f = fixture([{ value: device }, { timeout: true }, { value: token }]); let check = 0;
  f.input.assertOwned = async () => { if (++check === 6) throw new Error("lease revoked during timeout"); };
  assert.deepEqual(await run(f.input), { status: "failed" });
  assert.deepEqual(f.waits, [2000]); assert.equal(f.calls.length, 2);
});

test("cancellation while the private consumer is pending clears its borrowed token", async () => {
  const f = fixture(); let borrowed: Uint8Array | undefined;
  f.input.consumeToken = value => { borrowed = value; f.controller.abort(); return new Promise<void>(() => {}); };
  assert.deepEqual(await run(f.input), { status: "cancelled" });
  assert.ok(borrowed?.every(byte => byte === 0));
});

test("an encoded device code cannot produce an oversized token request", async () => {
  const f = fixture([{ value: { ...device, device_code: "%".repeat(4096) } }]);
  assert.deepEqual(await run(f.input), { status: "failed" });
  assert.equal(f.calls.length, 1);
});

test("cancellation settles even when HTTP ignores its signal and a late token response is erased", { timeout: 1000 }, async () => {
  const f = fixture(), originalPost = f.input.dependencies!.post;
  let finish!: (response: { status: number; contentType: string; body: Buffer }) => void, count = 0, requestSignal: AbortSignal | undefined;
  f.input.dependencies!.post = request => {
    if (++count === 1) return originalPost(request);
    requestSignal = request.signal;
    queueMicrotask(() => f.controller.abort());
    return new Promise(resolve => { finish = resolve; });
  };
  assert.deepEqual(await run(f.input), { status: "cancelled" });
  assert.equal(requestSignal?.aborted, true);
  const late = Buffer.from(JSON.stringify(token)); finish({ status: 200, contentType: "application/json", body: late });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(late.every(byte => byte === 0)); assert.deepEqual(f.received, []);
});

test("cancellation settles even when the polling wait ignores its signal", { timeout: 1000 }, async () => {
  const f = fixture();
  f.input.dependencies!.wait = () => { queueMicrotask(() => f.controller.abort()); return new Promise(() => {}); };
  assert.deepEqual(await run(f.input), { status: "cancelled" });
  assert.equal(f.calls.length, 1); assert.deepEqual(f.received, []);
});

for (const clock of [() => Number.NaN, () => Number.POSITIVE_INFINITY, () => -1, (() => { let value = 1000; return () => value--; })()]) {
  test("an invalid or backwards monotonic clock fails closed before any HTTP", async () => {
    const f = fixture(); f.input.dependencies!.now = clock;
    assert.deepEqual(await run(f.input), { status: "failed" }); assert.deepEqual(f.calls, []);
  });
}

test("an early-resolving polling wait cannot trigger an immediate token request", async () => {
  const f = fixture(); f.input.dependencies!.wait = async () => {};
  assert.deepEqual(await run(f.input), { status: "failed" });
  assert.equal(f.calls.length, 1); assert.deepEqual(f.received, []);
});


test("a token that expires during ownership checks never reaches the private consumer", async () => {
  const f = fixture([{ value: device }, { value: { ...token, expires_in: 1 } }]);
  const originalNow = f.input.dependencies!.now; let offset = 0, check = 0;
  f.input.dependencies!.now = () => originalNow() + offset;
  f.input.assertOwned = async () => { if (++check === 6) offset = 2000; };
  assert.deepEqual(await run(f.input), { status: "expired" }); assert.deepEqual(f.received, []);
});

// Exercise the default HTTPS/DNS adapter with in-memory Node request events; sockets remain forbidden.
type AdapterCall = { url: string; options: RequestOptions; fields: Record<string, string>; destroyed: boolean; dnsRejected?: boolean };
async function withHttps(replies: (Reply & { hold?: boolean })[], addresses: string[], operation: (calls: AdapterCall[]) => Promise<void>) {
  const originalRequest = https.request, originalLookup = dns.lookup;
  const calls: AdapterCall[] = [];
  dns.lookup = (async () => addresses.map(address => ({ address, family: address.includes(":") ? 6 : 4 }))) as unknown as typeof dns.lookup;
  https.request = ((url: string, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const req = new EventEmitter(), call: AdapterCall = { url, options, fields: {}, destroyed: false }; calls.push(call); let finished = false;
    const destroy = () => { call.destroyed = true; if (finished) return req; finished = true; queueMicrotask(() => req.emit("error", new Error("fixture request closed"))); return req; };
    Object.assign(req, { destroy, end(body: Buffer) {
      call.fields = Object.fromEntries(new URLSearchParams(body.toString()));
      options.signal?.addEventListener("abort", destroy, { once: true });
      options.lookup!(new URL(url).hostname, { all: true }, error => {
        call.dnsRejected = Boolean(error);
        if (error) { finished = true; options.signal?.removeEventListener("abort", destroy); queueMicrotask(() => req.emit("error", error)); return; }
        const reply = replies.shift(); assert.ok(reply, "unexpected default-adapter request");
        if (reply.hold) return;
        queueMicrotask(() => {
          const response = Object.assign(new EventEmitter(), { statusCode: reply.status ?? 200, headers: { "content-type": reply.contentType ?? "application/json" }, destroy() {} });
          callback(response as unknown as IncomingMessage);
          if (!call.destroyed) { response.emit("data", Buffer.from(reply.raw ?? JSON.stringify(reply.value))); response.emit("end"); }
          finished = true; options.signal?.removeEventListener("abort", destroy);
        });
      });
    } });
    return req;
  }) as typeof https.request;
  syncBuiltinESMExports();
  try { await operation(calls); }
  finally { https.request = originalRequest; dns.lookup = originalLookup; syncBuiltinESMExports(); }
}

test("default HTTP uses exact reviewed URLs, direct normal TLS and form requests", { timeout: 3000 }, async () => {
  await withHttps([{ value: { ...device, interval: 1 } }, { value: token }], ["129.146.1.1"], async calls => {
    const f = fixture(); delete f.input.dependencies;
    assert.deepEqual(await run(f.input), { status: "consumed" });
    assert.deepEqual(calls.map(call => call.url), [`${origin}/oauth2/v1/device`, `${origin}/oauth2/v1/token`]);
    assert.deepEqual(calls[0]!.fields, { response_type: "device_code", client_id: "reviewed-fixture-client", scope: "fixture.read" });
    assert.deepEqual(calls[1]!.fields, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "reviewed-fixture-client", device_code: "host-only-device-code" });
    for (const call of calls) {
      assert.equal(call.options.agent, false); assert.equal(call.options.rejectUnauthorized, true); assert.equal(call.options.minVersion, "TLSv1.2");
      assert.equal(call.options.method, "POST"); assert.equal(call.options.maxHeaderSize, 8192); assert.equal(call.options.signal?.aborted, true);
    }
  });
});

test("default HTTP refuses redirects, malformed JSON, wrong content type and an oversized stream", async () => {
  for (const reply of [{ status: 302, value: device }, { raw: "{" }, { contentType: "text/html", value: device }, { raw: "x".repeat(16385) }]) {
    await withHttps([reply], ["129.146.1.1"], async calls => {
      const f = fixture(); delete f.input.dependencies;
      assert.deepEqual(await run(f.input), { status: "failed" });
      assert.equal(calls.length, 1); assert.deepEqual(f.presented, []);
      if (reply.raw !== "{") assert.equal(calls[0]!.destroyed, true);
    });
  }
});

test("default HTTP never selects local, mapped, mixed, reserved or non-global DNS answers", async () => {
  for (const addresses of [["127.0.0.1"], ["10.0.0.1"], ["169.254.1.1"], ["172.16.1.1"], ["192.168.1.1"], ["100.64.0.1"], ["0.0.0.0"], ["224.0.0.1"], ["198.51.100.1"], ["::1"], ["::ffff:127.0.0.1"], ["fc00::1"], ["fe80::1"], ["2001:db8::1"], ["3fff::1"], ["3ffe::1"], ["129.146.1.1", "127.0.0.1"]]) {
    await withHttps([{ status: 302, value: device }], addresses, async calls => {
      const f = fixture(); delete f.input.dependencies;
      assert.deepEqual(await run(f.input), { status: "failed" }); assert.equal(calls.length, 1); assert.deepEqual(f.presented, []); assert.equal(calls[0]!.dnsRejected, true);
    });
  }
});

test("default HTTP cancellation destroys the exact pending request", { timeout: 3000 }, async () => {
  await withHttps([{ hold: true }], ["129.146.1.1"], async calls => {
    const f = fixture(); delete f.input.dependencies;
    const pending = run(f.input); await new Promise(resolve => setImmediate(resolve)); f.controller.abort();
    assert.deepEqual(await pending, { status: "cancelled" }); assert.equal(calls.length, 1); assert.equal(calls[0]!.destroyed, true);
  });
});

test("default HTTP deadline destroys the exact pending request", { timeout: 3000 }, async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  await withHttps([{ hold: true }], ["129.146.1.1"], async calls => {
    const f = fixture(); delete f.input.dependencies;
    const pending = run(f.input); await new Promise(resolve => setImmediate(resolve)); context.mock.timers.tick(10001);
    assert.deepEqual(await pending, { status: "expired" }); assert.equal(calls.length, 1); assert.equal(calls[0]!.destroyed, true);
  });
});
