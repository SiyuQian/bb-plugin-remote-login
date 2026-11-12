import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fixtureFrameSchema } from "../fixture-wire.ts";
import { cliFlowFixture, context, eventually, nativeValue, supportedHost } from "./cli-flow-fixture.ts";
import { ownedCliServiceFixture } from "./owned-cli-service-fixture.ts";

// Service acceptance is synthetic. Every plugin component and its native result
// consumer runs unchanged, including real pinned bootstrap, callback and signer.
test("registered CLI handback uses the actual owned callback, official diagnostic and SDK signer before native account use", {
  skip: !supportedHost, timeout: 45_000, concurrency: false,
}, async (t) => {
  const service = await ownedCliServiceFixture(t);
  const s = await cliFlowFixture(t);
  t.after(() => assert.equal(service.state.browserTransports.every(({ closed }) => closed), true));
  assert.equal((await s.send("start")).status, 202);
  await eventually(async () => {
    const response = await s.send("oci-status");
    assert.equal(response.status, 200);
    return (await response.json() as { phase: string }).phase === "user_control";
  });
  assert.equal(service.state.documents, 1);
  assert.equal(service.state.browserTransports.length, 2, "pairing and provider Chrome must both pass the shared pre-launch guard");
  assert.equal(service.state.browserTransports.every(({ guardedBeforeSpawn, loopbackDocument, otherDnsDenied, directConnections }) =>
    guardedBeforeSpawn && loopbackDocument && otherDnsDenied && directConnections), true);
  assert.deepEqual(service.state.stages, ["authentication"]);
  assert.equal(s.worker.experimental_getRetainedWorkerLeaseCount(), 1);
  const frame = await s.send("frame");
  assert.equal(frame.status, 200);
  const image = fixtureFrameSchema.parse(await frame.json());
  assert.equal(image.width, 800); assert.equal(image.height, 600);
  assert.equal((await s.send("input", { event: { type: "click", x: 100, y: 130 }, frameRef: image.frameRef })).status, 200);
  await eventually(async () => service.state.events.some(({ stage, value }) => stage === "authentication" && value.outcome === "bootstrap_complete"));
  const root = join(s.dataDir, `oci-session-${s.attemptId}`), profile = `BB_REMOTE_${s.attemptId.replaceAll("-", "")}`;
  assert.equal(await readFile(join(root, "tokens", profile, "token"), "utf8"), service.token);
  assert.match(await readFile(join(root, "config"), "utf8"), new RegExp(`\\[${profile}\\]`));
  assert.equal((await s.send("handback")).status, 202);
  let handback: Response | undefined;
  await eventually(async () => { handback = await s.send("handback"); return handback.status !== 202; });
  assert.equal(handback?.status, 200);
  assert.deepEqual(await handback!.json(), { verified: true });
  assert.deepEqual(service.state.stages, ["authentication", "diagnostic", "verifier"]);
  assert.equal(service.state.events.find(({ stage }) => stage === "diagnostic")?.value.reason, "complete");
  assert.equal(service.state.events.find(({ stage }) => stage === "verifier")?.value.reason, "matched");
  assert.equal((await s.status()).verification?.kind, "oci_cli");
  assert.equal((await s.status()).resume.state, "pending");
  assert.equal(s.settled(), false);
  const earlyRead = await s.harness.behavior.callAgentTool("remote_login_oci_read", { attemptId: s.attemptId,
    accountRef: "11111111-1111-4111-8111-111111111111", request: { operation: "list_compartments" } }, context);
  assert.deepEqual(nativeValue(earlyRead), { error: "unavailable" });
  s.harness.behavior.submitInteraction(s.interaction.id, { attemptId: s.attemptId });
  const result = await s.native;
  assert.equal(typeof result === "object" && result.isError, undefined);
  const metadata = nativeValue(result);
  assert.deepEqual(Object.keys(metadata).sort(), ["accountRef", "attemptId", "expiresAt", "hostId", "mode", "phase", "resume"]);
  assert.equal(metadata.mode, "oci_cli"); assert.equal(metadata.phase, "verified"); assert.equal(metadata.resume, "uncertain");
  assert.match(String(metadata.accountRef), /^[0-9a-f-]{36}$/);
  assert.equal((await s.status()).resume.state, "uncertain");
  const read = await s.harness.behavior.callAgentTool("remote_login_oci_read", { attemptId: s.attemptId,
    accountRef: metadata.accountRef, request: { operation: "list_compartments" } }, context);
  assert.equal(typeof read === "object" && read.isError, undefined);
  const task = nativeValue(read);
  assert.equal(task.operation, "list_compartments");
  assert.equal(task.truncated, false);
  assert.deepEqual((task.rows as Array<{ name: string }>).map(({ name }) => name), ["Composed fixture compartment"]);
  assert.equal(JSON.stringify(task).includes("ocid1.compartment"), false);
  assert.deepEqual(service.state.stages, ["authentication", "diagnostic", "verifier", "task"]);
  const replay = await s.harness.behavior.callAgentTool("remote_login_request", { mode: "oci_cli", wait: true }, context);
  assert.deepEqual(nativeValue(replay), { error: "unavailable" });
  await s.assertPrivate([service.token, service.state.authorizationUrl, image.png, image.frameRef, service.root]);
  const journalDir = join(s.dataDir, "owned-resources-v1");
  const [journalFile] = (await readdir(journalDir)).filter((name) => name.endsWith(".json"));
  const journal = JSON.parse(await readFile(join(journalDir, journalFile!), "utf8")) as { writers: Array<{ role: string; state: string }> };
  assert.deepEqual(journal.writers.map(({ role, state }) => ({ role, state })), [
    { role: "browser", state: "closed" }, { role: "task", state: "closed" },
  ]);
});
