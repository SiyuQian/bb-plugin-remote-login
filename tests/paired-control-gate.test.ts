import assert from "node:assert/strict";
import type { PathLike } from "node:fs";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { ControlAuthority, controlKeyFingerprint, provisionControlRoot } from "../control-authority.ts";
import { PairedControlGate, PairedControlGateError } from "../paired-control-gate.ts";

const key = Buffer.alloc(32, 19).toString("base64url");
const scope = { threadId: "gate-thread", attemptId: "gate-attempt", browserContextId: "gate-browser", generation: 1 };
async function system(t: TestContext) {
  const parent = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "paired-gate-")), dir = join(parent, "private");
  await provisionControlRoot(dir, key, controlKeyFingerprint(key));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const authority = new ControlAuthority(dir); const grant = await authority.authenticate(key, scope);
  let now = 2000;
  const gate = new PairedControlGate(dir, authority, () => now);
  return { dir, authority, grant, gate, now: (value: number) => { now = value; } };
}

test("only the trusted verify-and-close producer persists paired control acceptance", async (t) => {
  const s = await system(t); assert.equal(await s.gate.accepted(), false);
  assert.equal(await s.gate.acceptClosedFixture(s.grant.capability, scope, new AbortController().signal, async () => false), false);
  await assert.rejects(fs.stat(join(s.dir, "paired-control-acceptance.json")), { code: "ENOENT" });
  await assert.rejects(s.gate.acceptClosedFixture(s.grant.capability, scope, new AbortController().signal, async () => { throw new Error("private-marker"); }), PairedControlGateError);
  assert.equal(await s.gate.accepted(), false);
  assert.equal(await s.gate.acceptClosedFixture(s.grant.capability, scope, new AbortController().signal, async () => true), true);
  assert.equal(await s.gate.accepted(), true);
  const stat = await fs.lstat(join(s.dir, "paired-control-acceptance.json")); assert.equal(stat.mode & 0o777, 0o600);
  const saved = await fs.readFile(join(s.dir, "paired-control-acceptance.json"), "utf8");
  for (const secret of [key, s.grant.capability, scope.threadId]) assert.equal(saved.includes(secret), false);
  assert.equal(await new PairedControlGate(s.dir, new ControlAuthority(s.dir), () => 2001).accepted(), true);
});

test("wrong proof cannot invoke a producer or create an acceptance receipt", async (t) => {
  const s = await system(t); let called = false;
  await assert.rejects(s.gate.acceptClosedFixture("invalid", scope, new AbortController().signal, async () => { called = true; return true; }), PairedControlGateError);
  assert.equal(called, false); assert.equal(await s.gate.accepted(), false);
});

test("replacing a root with identical public ID and contents invalidates its receipt", async (t) => {
  const s = await system(t); await s.gate.acceptClosedFixture(s.grant.capability, scope, new AbortController().signal, async () => true);
  const path = join(s.dir, "control-root.json"), bytes = await fs.readFile(path);
  await fs.writeFile(join(s.dir, "replacement"), bytes, { mode: 0o600 }); await fs.rename(join(s.dir, "replacement"), path);
  assert.equal(await s.gate.accepted(), false);
  await assert.rejects(s.gate.require(), PairedControlGateError);
});

test("future time, expiry, corrupt fields and unsafe storage fail closed", async (t) => {
  const s = await system(t); await s.gate.acceptClosedFixture(s.grant.capability, scope, new AbortController().signal, async () => true);
  s.now(1999); assert.equal(await s.gate.accepted(), false);
  s.now(86_402_000); assert.equal(await s.gate.accepted(), false);
  s.now(2001); const path = join(s.dir, "paired-control-acceptance.json");
  const saved = JSON.parse(await fs.readFile(path, "utf8")); await fs.writeFile(path, JSON.stringify({ ...saved, accepted: true }));
  assert.equal(await s.gate.accepted(), false);
  await assert.rejects(s.gate.acceptClosedFixture(s.grant.capability, scope, new AbortController().signal, async () => true), PairedControlGateError);
  await fs.chmod(s.dir, 0o755); assert.equal(await s.gate.accepted(), false); assert.equal((await fs.stat(s.dir)).mode & 0o777, 0o755);
});

test("root change or cancellation during the owned fixture cannot save acceptance", async (t) => {
  const s = await system(t), controller = new AbortController();
  await assert.rejects(s.gate.acceptClosedFixture(s.grant.capability, scope, controller.signal, async () => { controller.abort(); return true; }), PairedControlGateError);
  assert.equal(await s.gate.accepted(), false);
  assert.deepEqual((await fs.readdir(s.dir)).sort(), ["control-budget.json", "control-root.json"]);
});

test("cancellation while committing a receipt removes only that newly written receipt", async (t) => {
  const s = await system(t), controller = new AbortController();
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, "rename", async (from: PathLike, to: PathLike) => {
    await rename(from, to);
    if (to === join(s.dir, "paired-control-acceptance.json")) controller.abort();
  });
  await assert.rejects(s.gate.acceptClosedFixture(s.grant.capability, scope, controller.signal, async () => true), PairedControlGateError);
  assert.equal(await s.gate.accepted(), false);
  await assert.rejects(fs.stat(join(s.dir, "paired-control-acceptance.json")), { code: "ENOENT" });
  assert.deepEqual((await fs.readdir(s.dir)).sort(), ["control-budget.json", "control-root.json"]);
});

test("a capability revoked during receipt commit cannot leave acceptance behind", async (t) => {
  const s = await system(t), rename = fs.rename.bind(fs);
  t.mock.method(fs, "rename", async (from: PathLike, to: PathLike) => {
    await rename(from, to);
    if (to === join(s.dir, "paired-control-acceptance.json")) await s.authority.revoke(s.grant.capability, scope);
  });
  await assert.rejects(s.gate.acceptClosedFixture(s.grant.capability, scope, new AbortController().signal, async () => true), PairedControlGateError);
  assert.equal(await s.gate.accepted(), false);
  await assert.rejects(fs.stat(join(s.dir, "paired-control-acceptance.json")), { code: "ENOENT" });
});

test("failed acceptance never removes an unrecognized replacement receipt", async (t) => {
  const s = await system(t), controller = new AbortController(), rename = fs.rename.bind(fs);
  const path = join(s.dir, "paired-control-acceptance.json"), replacement = join(s.dir, "replacement");
  await fs.writeFile(replacement, "unrecognized replacement", { mode: 0o600 });
  t.mock.method(fs, "rename", async (from: PathLike, to: PathLike) => {
    await rename(from, to);
    if (to === path) { await rename(replacement, path); controller.abort(); }
  });
  await assert.rejects(s.gate.acceptClosedFixture(s.grant.capability, scope, controller.signal, async () => true), PairedControlGateError);
  assert.equal(await fs.readFile(path, "utf8"), "unrecognized replacement");
  assert.equal(await s.gate.accepted(), false);
});


test("a host control receipt cannot satisfy the remote path and vice versa", async t => {
  const s = await system(t), signal = new AbortController().signal;
  assert.equal(await s.gate.acceptClosedFixture(s.grant.capability, scope, signal, async () => true, "host"), true);
  assert.equal(await s.gate.accepted("host"), true);
  assert.equal(await s.gate.accepted(), false);
  await assert.rejects(s.gate.require("remote"), PairedControlGateError);
  await s.gate.require("host");
  assert.equal(await new PairedControlGate(s.dir, s.authority, () => 2001).accepted("host"), true);
  assert.equal(await s.gate.acceptClosedFixture(s.grant.capability, scope, signal, async () => true), true);
  assert.equal(await s.gate.accepted("remote"), true);
  assert.equal(await s.gate.accepted("host"), false);
});


test("a known old browser pin remains unusable until a new authorized fixture closes", async t => {
  const s = await system(t), signal = new AbortController().signal;
  await s.gate.acceptClosedFixture(s.grant.capability, scope, signal, async () => true);
  const path = join(s.dir, "paired-control-acceptance.json"), saved = JSON.parse(await fs.readFile(path, "utf8"));
  delete saved.controlMode;
  await fs.writeFile(path, JSON.stringify(saved));
  assert.equal(await s.gate.accepted(), true, "missing presentation mode is the legacy remote receipt");
  assert.equal(await s.gate.accepted("host"), false);
  saved.pin = "private-fixture/Chrome-157.0.8103.50/v1";
  await fs.writeFile(path, JSON.stringify(saved));
  assert.equal(await s.gate.accepted("remote"), false);
  assert.equal(await s.gate.accepted("host"), false);
  let producerRan = false;
  assert.equal(await s.gate.acceptClosedFixture(s.grant.capability, scope, signal, async () => { producerRan = true; return false; }, "host"), false);
  assert.equal(producerRan, true);
  assert.equal(await s.gate.accepted("host"), false);
  assert.equal(await s.gate.acceptClosedFixture(s.grant.capability, scope, signal, async () => true, "host"), true);
  assert.equal(await s.gate.accepted("host"), true);
  assert.equal(await s.gate.accepted("remote"), false);
});
