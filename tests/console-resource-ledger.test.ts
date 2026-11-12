import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { OwnedResourceLedger } from "../owned-resource-ledger.ts";

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "console-ledger-")); await fs.chmod(directory, 0o700);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const scope = { threadId: "console-ledger", attemptId: randomUUID(), browserContextId: randomUUID(), generation: 1 };
  const identity = { pid: 101, uid: process.getuid!(), started: "100:100", executableId: "a".repeat(64) };
  const ledger = new OwnedResourceLedger(directory, { self: async () => identity, inspect: async () => null });
  const resource = await ledger.prepare(scope, "browser_profile"), path = ledger.path(resource);
  await fs.mkdir(path, { mode: 0o700 }); await ledger.recordEntry(resource, "", true);
  const writer = await ledger.beginWriter(resource, "browser"); await ledger.recordWriterDirectory(writer, path);
  await ledger.attachWriter(writer, { ...identity, pid: 102 });
  return { ledger, resource, writer, path, scope, directory };
}

test("a genuine Console profile removal intent permits known closure without inventing CLI credentials", async (t) => {
  const s = await fixture(t);
  await fs.mkdir(join(s.path, "Default"), { mode: 0o700 }); await fs.writeFile(join(s.path, "Default", "Cookies"), "synthetic browser fixture");
  await assert.rejects(s.ledger.release(s.resource));
  await s.ledger.prepareBrowserRemoval(s.resource, s.writer);
  await fs.rm(s.path, { recursive: true });
  await s.ledger.confirmWriterClosed(s.writer); await s.ledger.release(s.resource);
  assert.equal(await s.ledger.recover(s.scope, "browser_profile"), "recovered");
  assert.deepEqual(await fs.readdir(s.directory), ["owned-resources-v1"]);
});

test("browser removal intent refuses replacement roots, foreign writers and non-browser resources", async (t) => {
  const s = await fixture(t), other = await fixture(t);
  await assert.rejects(s.ledger.prepareBrowserRemoval(s.resource, other.writer));
  await fs.rename(s.path, join(s.directory, "original-moved-profile")); await fs.mkdir(s.path, { mode: 0o700 });
  await fs.writeFile(join(s.path, "unknown"), "keep this replacement");
  await assert.rejects(s.ledger.prepareBrowserRemoval(s.resource, s.writer));
  assert.equal(await fs.readFile(join(s.path, "unknown"), "utf8"), "keep this replacement");
  const cli = await other.ledger.prepare({ ...other.scope, attemptId: randomUUID() }, "oci_session");
  await fs.mkdir(other.ledger.path(cli), { mode: 0o700 }); await other.ledger.recordEntry(cli, "", true);
  const cliWriter = await other.ledger.beginWriter(cli, "browser");
  await assert.rejects(other.ledger.prepareBrowserRemoval(cli, cliWriter));
});

test("profile deletion without a durable browser-close marker remains uncertain after restart", async (t) => {
  const s = await fixture(t);
  await s.ledger.prepareBrowserRemoval(s.resource, s.writer); await fs.rmdir(s.path);
  assert.equal(await s.ledger.recover(s.scope, "browser_profile"), "uncertain");
});
