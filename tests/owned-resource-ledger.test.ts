import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ControlScope } from "../control-authority.ts";

const identity = (pid: number, started = "100:123") => ({ pid, uid: process.getuid!(), started, executableId: "a".repeat(64) });
async function system(t: TestContext) {
  const api = await import("../owned-resource-ledger.ts").catch(() => null);
  assert.ok(api, "durable exact-resource ownership must be implemented");
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "owned-ledger-")); await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scope: ControlScope = { threadId: "ledger-thread", attemptId: randomUUID(), browserContextId: randomUUID(), generation: 2 };
  const processes = new Map([[101, identity(101)], [201, identity(201)]]);
  const ledger = new api.OwnedResourceLedger(root, { self: async () => identity(101), inspect: async (pid: number) => processes.get(pid) ?? null });
  const restarted = () => new api.OwnedResourceLedger(root, { self: async () => identity(102), inspect: async (pid: number) => processes.get(pid) ?? null });
  return { api, root, scope, ledger, restarted, processes };
}
async function directory(s: Awaited<ReturnType<typeof system>>) {
  const owned = await s.ledger.prepare(s.scope, "oci_session");
  const path = s.ledger.path(owned);
  await fs.mkdir(path, { mode: 0o700 }); await s.ledger.recordEntry(owned, "", true);
  await fs.writeFile(join(path, "config"), "synthetic private bytes", { mode: 0o600 }); await s.ledger.recordEntry(owned, "config", false);
  return { owned, path };
}

test("resource journal is private and nonsecret, and restart removes only exact stopped resources", async (t) => {
  const s = await system(t), { owned, path } = await directory(s);
  assert.equal(JSON.stringify(owned), "{}");
  const journals = await fs.readdir(join(s.root, "owned-resources-v1"));
  assert.equal(journals.length, 1);
  const journal = join(s.root, "owned-resources-v1", journals[0]!);
  assert.equal((await fs.stat(journal)).mode & 0o777, 0o600);
  const text = await fs.readFile(journal, "utf8");
  assert.equal(text.includes("synthetic private bytes"), false); assert.equal(text.includes(s.root), false);
  assert.equal(await s.restarted().recover(s.scope, "oci_session"), "uncertain");
  s.processes.delete(101);
  assert.equal(await s.restarted().recover(s.scope, "oci_session"), "recovered");
  await assert.rejects(fs.stat(path), { code: "ENOENT" });
  assert.equal(await s.restarted().recover(s.scope, "oci_session"), "recovered");
});

test("unknown scopes, reused owner PIDs and creation gaps cannot acknowledge cleanup", async (t) => {
  const s = await system(t);
  assert.equal(await s.restarted().recover(s.scope, "oci_session"), "unknown");
  const owned = await s.ledger.prepare(s.scope, "oci_session");
  await fs.mkdir(s.ledger.path(owned), { mode: 0o700 });
  s.processes.set(101, identity(101, "200:999"));
  assert.equal(await s.restarted().recover(s.scope, "oci_session"), "uncertain");
  s.processes.delete(101);
  assert.equal(await s.restarted().recover(s.scope, "oci_session"), "uncertain");
  assert.equal((await fs.readdir(s.root)).includes(`oci-session-${s.scope.attemptId}`), true);
});

test("unknown files, symlinks, hardlinks and replaced original inodes are never deleted", async (t) => {
  for (const mutate of ["unknown", "replace", "symlink", "hardlink"] as const) {
    const s = await system(t), { path } = await directory(s);
    if (mutate === "unknown") await fs.writeFile(join(path, "unknown"), "keep unknown", { mode: 0o600 });
    else {
      await fs.unlink(join(path, "config"));
      if (mutate === "replace") await fs.writeFile(join(path, "config"), "replacement", { mode: 0o600 });
      if (mutate === "symlink") await fs.symlink("/dev/null", join(path, "config"));
      if (mutate === "hardlink") { await fs.writeFile(join(s.root, "sentinel"), "keep", { mode: 0o600 }); await fs.link(join(s.root, "sentinel"), join(path, "config")); }
    }
    s.processes.delete(101);
    assert.equal(await s.restarted().recover(s.scope, "oci_session"), "uncertain");
    assert.ok(await fs.lstat(join(path, mutate === "unknown" ? "unknown" : "config")));
  }
});

test("pending, live, reused and unknown writers preserve owned files after restart", async (t) => {
  for (const state of ["pending", "live", "reused", "unknown"] as const) {
    const s = await system(t), { owned, path } = await directory(s);
    const writer = await s.ledger.beginWriter(owned, "authentication");
    if (state !== "pending") await s.ledger.attachWriter(writer, identity(201));
    s.processes.delete(101);
    if (state === "reused") s.processes.set(201, identity(201, "200:123"));
    const restarted = state === "unknown" ? new s.api.OwnedResourceLedger(s.root, { self: async () => identity(102), inspect: async () => { throw new Error("not visible"); } }) : s.restarted();
    assert.equal(await restarted.recover(s.scope, "oci_session"), "uncertain");
    assert.ok(await fs.stat(join(path, "config")));
  }
});

test("a journaled writer proven absent permits exact restart cleanup without sending signals", async (t) => {
  const s = await system(t), { owned, path } = await directory(s);
  const writer = await s.ledger.beginWriter(owned, "authentication"); await s.ledger.attachWriter(writer, identity(201));
  s.processes.delete(101); s.processes.delete(201);
  assert.equal(await s.restarted().recover(s.scope, "oci_session"), "recovered");
  await assert.rejects(fs.stat(path), { code: "ENOENT" });
});

test("normal cleanup requires every writer closed and preserves an unrelated default profile", async (t) => {
  const s = await system(t), { owned, path } = await directory(s);
  await fs.mkdir(join(s.root, "default-profile"), { mode: 0o700 }); await fs.writeFile(join(s.root, "default-profile", "sentinel"), "keep");
  const writer = await s.ledger.beginWriter(owned, "authentication"); await s.ledger.attachWriter(writer, identity(201));
  await assert.rejects(s.ledger.release(owned));
  await s.ledger.confirmWriterClosed(writer); await s.ledger.release(owned);
  await assert.rejects(fs.stat(path), { code: "ENOENT" });
  assert.equal(await fs.readFile(join(s.root, "default-profile", "sentinel"), "utf8"), "keep");
});

test("foreign and forged handles, cross-scope records and unsafe journals fail closed", async (t) => {
  const s = await system(t), { owned, path } = await directory(s);
  await assert.rejects(s.ledger.recordEntry({} as never, "config", false));
  await assert.rejects(s.restarted().release(owned));
  assert.equal(await s.restarted().recover({ ...s.scope, generation: 3 }, "oci_session"), "unknown");
  const dir = join(s.root, "owned-resources-v1"), file = (await fs.readdir(dir))[0]!;
  await fs.chmod(join(dir, file), 0o644); s.processes.delete(101);
  assert.equal(await s.restarted().recover(s.scope, "oci_session"), "uncertain");
  assert.ok(await fs.stat(join(path, "config")));
});

test("interruption after an owned unlink resumes from its durable removal intent", async (t) => {
  const s = await system(t), { owned, path } = await directory(s);
  const unlink = fs.unlink; let crashed = false;
  t.mock.method(fs, "unlink", async (target: Parameters<typeof fs.unlink>[0]) => {
    await unlink(target);
    if (!crashed && target === join(path, "config")) { crashed = true; throw new Error("synthetic interruption after unlink"); }
  });
  await assert.rejects(s.ledger.release(owned));
  assert.equal(crashed, true); s.processes.delete(101);
  assert.equal(await s.restarted().recover(s.scope, "oci_session"), "recovered");
  await assert.rejects(fs.stat(path), { code: "ENOENT" });
});

test("a browser writer remains uncertain after its PID disappears until its exact profile was removed", async (t) => {
  const s = await system(t), { owned, path } = await directory(s);
  const profile = join(s.root, `oci-browser-${randomUUID()}`); await fs.mkdir(profile, { mode: 0o700 });
  const writer = await s.ledger.beginWriter(owned, "browser"); await s.ledger.recordWriterDirectory(writer, profile);
  await s.ledger.attachWriter(writer, identity(201)); s.processes.delete(101); s.processes.delete(201);
  assert.equal(await s.restarted().recover(s.scope, "oci_session"), "uncertain");
  await assert.rejects(s.ledger.confirmWriterClosed(writer));
  await fs.rmdir(profile); await s.ledger.confirmWriterClosed(writer);
  assert.equal(await s.restarted().recover(s.scope, "oci_session"), "recovered");
  await assert.rejects(fs.stat(path), { code: "ENOENT" });
});

test("closed task history cannot exhaust a retained session after sixteen reads", async (t) => {
  const s = await system(t), { owned } = await directory(s);
  for (let index = 0; index < 24; index++) {
    const writer = await s.ledger.beginWriter(owned, "task"); await s.ledger.attachWriter(writer, identity(201)); await s.ledger.confirmWriterClosed(writer);
  }
  await s.ledger.release(owned);
});

test("a real exited worker's precreated OCI artifacts reconcile without account access or signalling", { timeout: 10000 }, async (t) => {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "owned-real-recovery-")); await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scope = { threadId: "real-recovery-fixture", attemptId: randomUUID(), browserContextId: randomUUID(), generation: 1 };
  const target = { mode: "oci_cli", tenancyOcid: "ocid1.tenancy.oc1..fixture", userOcid: "ocid1.user.oc1..fixture", region: "ap-sydney-1", realm: "oc1" };
  const source = `const {createOwnedOciSession}=await import('./oci-owned-session.ts');await createOwnedOciSession(${JSON.stringify(root)},${JSON.stringify(scope.attemptId)},${JSON.stringify(target)},${JSON.stringify(scope)});`;
  await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], { cwd: new URL("..", import.meta.url), timeout: 7000, maxBuffer: 2048, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
  const { recoverOwnedOciSession } = await import("../oci-owned-session.ts");
  assert.equal(await recoverOwnedOciSession(root, scope), "recovered");
  assert.deepEqual(await fs.readdir(root), ["owned-resources-v1"]);
});
