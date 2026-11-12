import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { context, eventually, expectedConsole, fixtureKey, nativeValue, ownedConsoleFlow, supportedConsoleFixture } from "./owned-console-flow-fixture.ts";

const options = { skip: !supportedConsoleFixture, timeout: 40000, concurrency: false };

// This chain must break if presentation selection, local control isolation, private
// fixture acceptance, signed identity verification or original-call proof is lost.
test("visible host login closes its matching fixture and returns the exact verified Console to the original native call", options, async t => {
  const s = await ownedConsoleFlow(t), pairing = await s.createPairingAttempt(), pairedWait = await s.startNativeWait(pairing.attemptId);
  await pairedWait.authenticate();
  assert.equal((await pairedWait.post("start", { controlMode: "host" })).status, 200);
  assert.equal(s.fixtureBrowsers.length, 1); assert.equal(s.fixturePages.length, 1);
  const fixtureBrowser = s.fixtureBrowsers[0]!, fixturePage = s.fixturePages[0]!;
  assert.equal(fixtureBrowser.process()!.spawnargs.some(arg => arg.startsWith("--headless")), false);
  await fixturePage.click("input"); await fixturePage.keyboard.type("fabricated visible host acceptance"); await fixturePage.click("button");
  assert.equal((await pairedWait.post("frame")).status, 409);
  assert.equal((await pairedWait.post("input", { event: { type: "text", text: "must not execute" }, frameRef: randomUUID() })).status, 409);
  assert.equal((await pairedWait.post("handback")).status, 200);
  assert.equal(await s.gate.accepted("host"), true); assert.equal(await s.gate.accepted("remote"), false);
  assert.equal(fixtureBrowser.connected, false); assert.equal(s.retained(), 0);
  s.harness.behavior.submitInteraction(pairedWait.interaction.id, { attemptId: pairedWait.attemptId });
  const pairedResult = nativeValue(await pairedWait.result); assert.equal(pairedResult.phase, "verified");

  const client = await s.waitConsole(); await client.authenticate();
  const remoteStatus = await client.post("console-status", { controlMode: "remote" });
  assert.equal(remoteStatus.status, 200); assert.equal((await remoteStatus.json() as { phoneControlAccepted: boolean }).phoneControlAccepted, false);
  assert.equal(s.browsers.length, 0);
  assert.equal((await client.post("console-target", { expected: expectedConsole, controlMode: "host" })).status, 200);
  assert.equal((await client.post("console-target", { expected: expectedConsole, controlMode: "remote" })).status, 409);
  assert.equal((await client.post("start", { controlMode: "host" })).status, 202);
  await eventually(async () => {
    assert.equal((await client.post("console-status", { controlMode: "host" })).status, 200);
    return (await client.status()).phase === "user_control";
  });
  assert.equal((await client.status()).controlMode, "host");
  const browser = s.browsers[0]!, page = s.pages[0]!, target = page.target(), browserContext = page.browserContext();
  assert.equal(browser.process()!.spawnargs.some(arg => arg.startsWith("--headless")), false);
  const privateInput = "fabricated local Console input";
  await page.click("input"); await page.keyboard.type(privateInput);
  assert.equal(await page.$eval("input", input => input.value), privateInput);
  assert.equal((await client.post("frame")).status, 409);
  assert.equal((await client.post("input", { event: { type: "text", text: "must not execute" }, frameRef: randomUUID() })).status, 409);
  assert.equal(s.state.inputs, 0); assert.equal(s.state.reads, 0);
  assert.equal((await client.post("handback")).status, 202);
  await s.finishHandback(client); await setImmediate();
  assert.equal(client.settled(), false); assert.equal(browser.connected, true); assert.equal(s.retained(), 1);
  await page.keyboard.type(" blocked after handback");
  assert.equal(await page.$eval("input", input => input.value), privateInput);
  s.harness.behavior.submitInteraction(client.interaction.id, { attemptId: client.attemptId });
  const completed = nativeValue(await client.result), browserRef = completed.browserRef;
  assert.equal(completed.phase, "verified"); assert.equal(completed.resume, "uncertain"); assert.equal(typeof browserRef, "string");
  const identity = nativeValue(await s.harness.behavior.callAgentTool("remote_login_console_read", {
    attemptId: client.attemptId, browserRef, request: { operation: "read_identity" },
  }, context));
  const outline = nativeValue(await s.harness.behavior.callAgentTool("remote_login_console_read", {
    attemptId: client.attemptId, browserRef, request: { operation: "read_page" },
  }, context));
  assert.equal(identity.matched, true); assert.equal(outline.title, "Owned Console fixture"); assert.deepEqual(outline.headings, ["Owned Console overview"]);
  assert.equal(page.target(), target); assert.equal(page.browserContext(), browserContext); assert.equal(s.browsers.length, 1);
  const durable = s.bb.storage.database().prepare("SELECT record FROM remote_login_attempts_v1").all();
  const visible = JSON.stringify([durable, await s.bb.storage.kv.list(), s.harness.inspection.pendingInteractions, s.harness.logEntries,
    s.harness.inspection.realtimeSignals, await client.status()]);
  const resultText = JSON.stringify([pairedResult, completed, identity, outline]);
  for (const secret of [fixtureKey, ...s.capabilities, privateInput, s.root, "ST$fixture-private", expectedConsole.userOcid,
    expectedConsole.tenancyOcid, expectedConsole.domainOcid, expectedConsole.domainOrigin]) {
    assert.equal(visible.includes(secret), false); assert.equal(resultText.includes(secret), false);
  }
  assert.equal(visible.includes(browserRef as string), false);
  assert.equal(s.harness.inspection.sdk.calls.some(call => call.path === "threads.send"), false);
  assert.equal((await client.post("close")).status, 200); assert.equal(browser.connected, false); assert.equal(s.retained(), 0);
  assert.equal((await readdir(s.dataDir)).some(name => name.startsWith("oci-browser-") || name.startsWith("fixture-browser-")), false);
});
