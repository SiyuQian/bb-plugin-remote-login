import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { controlEndpoint, postControl, probeControlChannel } from "../control-client.ts";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { postFixture } from "../fixture-client.ts";
import { postLogin } from "../login-client.ts";

test("private client refusals cancel an unread streaming response body", async (t) => {
  const capability = "A".repeat(43), target = { hostId: "fixture-host", scope: { threadId: "fixture-thread", attemptId: "fixture-attempt", browserContextId: "fixture-browser", generation: 1 } };
  for (const client of ["control", "login", "fixture"] as const) for (const policy of ["denied", "cacheable"] as const) {
    if (client === "control" && policy === "cacheable") continue;
    await t.test(`${client} ${policy}`, async (t) => {
      let cancelled = false;
      t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: policy === "denied" ? 403 : 200, headers: { "cache-control": policy === "cacheable" ? "public" : "no-store" } }));
      const pending = client === "control" ? postControl("https://bb.invalid", "session", {}) : client === "login"
        ? postLogin("https://bb.invalid", "start", { attemptId: "fixture-attempt" }, capability)
        : postFixture("https://bb.invalid", "start", target, capability);
      await assert.rejects(pending);
      assert.equal(cancelled, true, "refused response must not leave its private stream alive");
    });
  }
});

test("pairing HTTP abort settles held fetch and response bodies without accepting late control", async (t) => {
  for (const action of ["session", "probe"] as const) for (const stage of ["fetch", "body"] as const) await t.test(`${action} ${stage}`, async (t) => {
    const controller = new AbortController(); let release!: () => void, cancelled = false;
    const result = action === "session" ? { capability: "A".repeat(43), expiresAt: Date.now() + 300_000 } : { error: "control_authorization_failed" };
    const response = () => new Response(JSON.stringify(result), { status: action === "probe" ? 401 : 200, headers: { "cache-control": "no-store" } });
    t.mock.method(globalThis, "fetch", async () => stage === "fetch" ? new Promise<Response>(resolve => { release = () => resolve(response()); })
      : new Response(new ReadableStream({ start(stream) { release = () => { stream.enqueue(new TextEncoder().encode(JSON.stringify(result))); stream.close(); }; }, cancel() { cancelled = true; } }), { status: action === "probe" ? 401 : 200, headers: { "cache-control": "no-store" } }));
    let settled = false, accepted = false;
    const pending = (action === "probe" ? probeControlChannel("https://bb.invalid", {}, controller.signal)
      : postControl("https://bb.invalid", "session", {}, undefined, controller.signal)).then(value => { settled = true; accepted = Boolean(value); }, () => { settled = true; });
    await setImmediate(); controller.abort(); await setImmediate();
    try { assert.equal(settled, true, "pairing must settle before the ignored transport is released"); assert.equal(accepted, false); }
    finally { try { release(); } catch { /* Aborted body may already be cancelled. */ } await pending; }
    await setImmediate(); if (stage === "body") assert.equal(cancelled, true);
  });
});

test("control endpoint allows HTTPS or loopback and never accepts URL credentials", () => {
  assert.equal(controlEndpoint("https://bb.example", "check"), "https://bb.example/api/v1/plugins/remote-login/http/control/check");
  assert.equal(controlEndpoint("http://127.0.0.1:3456", "session"), "http://127.0.0.1:3456/api/v1/plugins/remote-login/http/control/session");
  for (const origin of ["http://remote.example", "https://user:password@bb.example", "https://bb.example/path", "https://bb.example?token=secret", "https://bb.example#fragment", "file:///tmp/example"]) {
    assert.throws(() => controlEndpoint(origin, "check"), /Unsafe control endpoint/);
  }
});

test("phone sends the control key in a bounded private POST, not a URL", async (t) => {
  const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const capability = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
  const requests: { url: string; method: string; authorization?: string; data: unknown }[] = [];
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += String(chunk);
    requests.push({ url: request.url ?? "", method: request.method ?? "", authorization: request.headers.authorization, data: JSON.parse(text) });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url?.endsWith("/session") ? { capability, expiresAt: 1_000_000 } : { authorized: true }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const grant = await postControl(origin, "session", { key });
  assert.deepEqual(grant, { capability, expiresAt: 1_000_000 });
  assert.equal(await postControl(origin, "check", { hostId: "host-test" }, capability), null);
  assert.deepEqual(requests, [
    { url: "/api/v1/plugins/remote-login/http/control/session", method: "POST", authorization: undefined, data: { key } },
    { url: "/api/v1/plugins/remote-login/http/control/check", method: "POST", authorization: `Bearer ${capability}`, data: { hostId: "host-test" } },
  ]);
});

test("phone does not echo a denied server response", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ secret: "untrusted response fixture" }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await assert.rejects(postControl(`http://127.0.0.1:${address.port}`, "session", {}), { message: "Control request refused." });
});

test("phone confirms the control route without sending any credential", async (t) => {
  let approved = false;
  const scope = { threadId: "probe", attemptId: "probe", browserContextId: "unopened", generation: 0 };
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += String(chunk);
    assert.equal(request.headers.authorization, undefined);
    assert.deepEqual(JSON.parse(text), { hostId: "host-test", scope });
    response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: approved ? "control_authorization_failed" : "some_other_login_gate" }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  assert.equal(await probeControlChannel(origin, { hostId: "host-test", scope }), false);
  approved = true;
  assert.equal(await probeControlChannel(origin, { hostId: "host-test", scope }), true);
});

test("operator can test the installed control channel without supplying a credential", async (t) => {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/v1/plugins/remote-login/http/control/check");
    assert.equal(request.headers.authorization, undefined);
    response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: "control_authorization_failed" }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const { bb, harness } = createFakePluginHost({ pluginId: "remote-login", loopbackBaseUrl: `http://127.0.0.1:${address.port}` });
  t.after(() => harness.lifecycle.dispose()); await plugin(bb);
  const result = await harness.behavior.runCli(["check-channel", "host-selected", "--json"]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { hostId: "host-selected", reachable: true, authenticated: false });
  assert.equal(harness.inspection.experimental_hostRpcCalls.length, 0);
});
