import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { fixtureFrameSchema } from "../fixture-wire.ts";
import { context, deferred, eventually, expectedConsole, fixtureKey, nativeValue, ownedConsoleFlow, supportedConsoleFixture } from "./owned-console-flow-fixture.ts";

const options = { skip: !supportedConsoleFixture, timeout: 40000, concurrency: false };

// Removing the private gate, service self-read, retained browser or original-call proof must break this chain.
test("paired phone control completes the original Console native call and reads from its exact retained browser", options, async t => {
  const s = await ownedConsoleFlow(t);
  const client = await s.waitConsole(); await client.authenticate();
  assert.equal((await client.post("console-target", { expected: expectedConsole })).status, 403);
  assert.equal((await client.post("start")).status, 403);
  assert.equal(s.browsers.length, 0, "key possession alone cannot launch Console before paired control acceptance");
  await s.pair(); await s.start(client);
  const page = s.pages[0]!, browser = s.browsers[0]!, browserContext = page.browserContext(), target = page.target();
  const privateInput = "fabricated Console secret input 你好";
  for (const event of [{ type: "click", x: 80, y: 60 }, { type: "text", text: privateInput }] as const) {
    assert.equal((await client.freshInput(event)).status, 200);
  }
  assert.equal(await page.$eval("input", input => input.value), privateInput, "protected input must reach the actual owned page");
  const frameResponse = await client.post("frame"); assert.equal(frameResponse.status, 200);
  const frame = fixtureFrameSchema.parse(await frameResponse.json());
  assert.equal(Buffer.from(frame.png, "base64").readUInt32BE(16), 800);
  assert.equal(s.state.reads, 0);
  assert.equal((await client.post("handback")).status, 202);
  await s.finishHandback(client);
  const verified = await client.status();
  assert.equal(verified.verification?.kind, "oci_web"); assert.equal(verified.resume.state, "pending");
  await setImmediate(); assert.equal(client.settled(), false);
  assert.equal(s.retained(), 1); assert.equal(browser.connected, true);
  assert.equal((await client.post("input", { event: { type: "key", key: "Enter" }, frameRef: frame.frameRef })).status, 409);

  s.harness.behavior.submitInteraction(client.interaction.id, { attemptId: client.attemptId });
  const completed = nativeValue(await client.result), browserRef = completed.browserRef;
  assert.equal(completed.mode, "oci_web"); assert.equal(completed.phase, "verified"); assert.equal(completed.resume, "uncertain");
  assert.equal(typeof browserRef, "string"); assert.match(browserRef as string, /^[a-f0-9-]{36}$/);
  const identity = nativeValue(await s.harness.behavior.callAgentTool("remote_login_console_read", {
    attemptId: client.attemptId, browserRef, request: { operation: "read_identity" },
  }, context));
  assert.equal(identity.operation, "read_identity"); assert.equal(identity.matched, true);
  const outline = nativeValue(await s.harness.behavior.callAgentTool("remote_login_console_read", {
    attemptId: client.attemptId, browserRef, request: { operation: "read_page" },
  }, context));
  assert.equal(outline.operation, "read_page"); assert.equal(outline.title, "Owned Console fixture");
  assert.deepEqual(outline.headings, ["Owned Console overview"]);
  assert.ok(s.state.reads >= 7, "handback, native completion and both reads must independently prove the actual service identity");
  assert.equal(s.browsers.length, 1); assert.equal(page.browserContext(), browserContext); assert.equal(page.target(), target);
  assert.equal((await client.status()).resume.state, "uncertain");
  assert.equal(s.harness.inspection.sdk.calls.some(call => call.path === "threads.send"), false);
  const durable = s.bb.storage.database().prepare("SELECT record FROM remote_login_attempts_v1").all();
  const visible = JSON.stringify([await client.status(), durable, await s.bb.storage.kv.list(), s.harness.inspection.pendingInteractions,
    s.harness.logEntries, s.harness.inspection.realtimeSignals]);
  for (const secret of [fixtureKey, ...s.capabilities, browserRef as string, frame.png, frame.frameRef, privateInput, s.root,
    expectedConsole.userOcid, expectedConsole.tenancyOcid, expectedConsole.domainOcid, expectedConsole.domainOrigin]) {
    assert.equal(visible.includes(secret), false, "private material must stay out of public/durable state");
  }
  const resultText = JSON.stringify([completed, identity, outline]);
  for (const secret of [fixtureKey, ...s.capabilities, frame.png, frame.frameRef, privateInput, s.root, "ST$fixture-private", expectedConsole.userOcid,
    expectedConsole.tenancyOcid, expectedConsole.domainOcid, expectedConsole.domainOrigin]) assert.equal(resultText.includes(secret), false);
  assert.equal((await client.post("close")).status, 200); assert.equal(s.retained(), 0); assert.equal(browser.connected, false);
  assert.equal((await readdir(s.dataDir)).some(name => name.startsWith("oci-browser-")), false);
});

// Trusting the page's expected token hints instead of the actual protected Me response must fail here.
test("a wrong actual Console service principal closes the owned browser and cannot resume its waiting call", options, async t => {
  const s = await ownedConsoleFlow(t); await s.pair();
  const client = await s.waitConsole(); await s.start(client);
  s.state.profile.ocid = "ocid1.user.oc1..differentactualserviceuser";
  assert.equal((await client.post("handback")).status, 202);
  await eventually(async () => {
    const response = await client.post("console-status"); assert.equal(response.status, 200);
    return (await client.status()).phase === "failed";
  });
  await eventually(() => s.retained() === 0);
  assert.equal(s.state.reads, 1); assert.equal(s.browsers[0]!.connected, false);
  const failed = await client.status(); assert.equal(failed.verification, null); assert.equal(failed.resume.state, "none");
  assert.equal((await client.post("handback")).status, 409);
  s.harness.behavior.submitInteraction(client.interaction.id, { attemptId: client.attemptId });
  assert.deepEqual(nativeValue(await client.result), { error: "unavailable" });
  assert.equal((await readdir(s.dataDir)).some(name => name.startsWith("oci-browser-")), false);
});

// Letting a stopped, in-flight self-read commit late would expose a verified result after cancellation.
test("private cancellation aborts a held Console self-read and excludes late verification and native success", options, async t => {
  const s = await ownedConsoleFlow(t); await s.pair();
  const client = await s.waitConsole(); await s.start(client);
  const entered = deferred(), held = deferred();
  s.state.beforeRead = async () => { entered.resolve(); await held.promise; };
  try {
    assert.equal((await client.post("handback")).status, 202); await entered.promise;
    assert.equal((await client.status()).phase, "verifying");
    assert.equal((await client.post("frame")).status, 409);
    const close = await client.post("close"); assert.equal(close.status, 200); assert.deepEqual(await close.json(), { closed: true });
    assert.equal(s.retained(), 0); assert.equal(s.browsers[0]!.connected, false);
    await eventually(() => s.state.readAborted === 1);
    held.resolve(); await setImmediate();
    const cancelled = await client.status(); assert.equal(cancelled.phase, "cancelled");
    assert.equal(cancelled.verification, null); assert.equal(cancelled.resume.state, "none");
    assert.equal((await client.post("handback")).status, 409);
    s.harness.behavior.submitInteraction(client.interaction.id, { attemptId: client.attemptId });
    assert.deepEqual(nativeValue(await client.result), { error: "unavailable" });
    assert.equal((await readdir(s.dataDir)).some(name => name.startsWith("oci-browser-")), false);
  } finally { held.resolve(); }
});

// A rejoined verifier must replace its old proof without reopening browser input or losing the retained context.
test("a lost pending handback response permits verification-only key rejoin with a changed proof", options, async t => {
  const s = await ownedConsoleFlow(t); await s.pair();
  const client = await s.waitConsole(); await s.start(client);
  const page = s.pages[0]!, browserContext = page.browserContext(), entered = deferred(), held = deferred();
  s.state.beforeRead = async () => { entered.resolve(); await held.promise; };
  try {
    const humanFrameResponse = await client.post("frame"); assert.equal(humanFrameResponse.status, 200);
    const humanFrame = fixtureFrameSchema.parse(await humanFrameResponse.json());
    // The phone loses this response; the registered gateway and host continue the real handback.
    await client.post("handback"); await entered.promise;
    assert.equal((await client.status()).phase, "verifying");
    const oldProof = client.capability(), replacement = await client.authenticate();
    assert.notEqual(replacement.capability, oldProof);
    assert.equal((await client.post("console-status", {}, oldProof)).status, 403);
    for (const action of ["start", "frame", "input"]) {
      // A genuine prior observation keeps the input payload valid; the
      // verification-only phase must refuse it before examining its reference.
      assert.equal((await client.post(action, action === "input" ? { event: { type: "key", key: "Enter" }, frameRef: humanFrame.frameRef } : {})).status, 409);
    }
    assert.equal((await client.post("console-status")).status, 200);
    assert.equal(client.settled(), false); assert.equal(s.browsers.length, 1);
    held.resolve(); await s.finishHandback(client);
    assert.equal((await client.status()).verification?.kind, "oci_web");
    s.harness.behavior.submitInteraction(client.interaction.id, { attemptId: client.attemptId });
    const completed = nativeValue(await client.result); assert.equal(typeof completed.browserRef, "string");
    assert.equal(completed.resume, "uncertain"); assert.equal(page.browserContext(), browserContext); assert.equal(s.browsers.length, 1);
    const identity = nativeValue(await s.harness.behavior.callAgentTool("remote_login_console_read", {
      attemptId: client.attemptId, browserRef: completed.browserRef, request: { operation: "read_identity" },
    }, context));
    assert.equal(identity.matched, true); assert.ok(s.state.reads >= 5);
    assert.equal((await client.post("close")).status, 200); assert.equal(s.retained(), 0);
  } finally { held.resolve(); }
});
