import assert from "node:assert/strict";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, rmdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { inspectOwnedProcess, nativeOwnedProcesses, ownedProcessIdentitySchema } from "../owned-process-identity.ts";

const ownerSchema = z.object({ version: z.literal(1), leaseId: z.string().uuid(), owner: ownedProcessIdentitySchema }).strict();
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a: BigIntStats, b: BigIntStats) => same(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Cross-process test scheduling only. Never signals or adopts any process. */
export async function acquireCliFixtureLease(testDirectory?: string): Promise<() => Promise<void>> {
  const uid = process.getuid?.(); assert.equal(typeof uid, "number");
  const directory = testDirectory ?? join(await realpath(tmpdir()), `bb-remote-login-cli-tests-${uid}.lock`), path = join(directory, "owner.json");
  const refusal = () => new Error(`CLI test lease requires manual inspection: ${directory}`);
  const privateDirectory = async () => {
    const metadata = await lstat(directory, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== BigInt(uid!) || (metadata.mode & 0o7777n) !== 0o700n
      || await realpath(directory) !== directory) throw refusal();
    return metadata;
  };
  const privateFile = (metadata: BigIntStats) => {
    if (!metadata.isFile() || metadata.uid !== BigInt(uid!) || metadata.nlink !== 1n || (metadata.mode & 0o7777n) !== 0o600n || metadata.size > 2048n) throw refusal();
  };
  const read = async () => {
    const beforeDirectory = await privateDirectory();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true }); privateFile(before);
      const record = ownerSchema.parse(JSON.parse(await handle.readFile("utf8")));
      const after = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true });
      privateFile(after); privateFile(named);
      if (!unchanged(before, after) || !unchanged(before, named) || !same(beforeDirectory, await privateDirectory())) throw refusal();
      return { record, directory: beforeDirectory, file: before };
    } finally { await handle.close(); }
  };
  const owner = await nativeOwnedProcesses.self();
  const mine = ownerSchema.parse({ version: 1, leaseId: randomUUID(), owner });
  const deadline = performance.now() + 40_000;
  let missingSince = 0;
  while (performance.now() < deadline) {
    let created = false;
    try { await mkdir(directory, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (created) {
      let createdDirectory: BigIntStats, createdFile: BigIntStats;
      try {
        createdDirectory = await privateDirectory();
        const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try {
          await handle.writeFile(JSON.stringify(mine)); await handle.sync();
          createdFile = await handle.stat({ bigint: true }); privateFile(createdFile);
        } finally { await handle.close(); }
        if (!same(createdDirectory, await privateDirectory()) || !same(createdFile, await lstat(path, { bigint: true }))) throw refusal();
      } catch { throw refusal(); }
      let released = false;
      return async () => {
        if (released) return;
        try {
          const current = await read();
          if (JSON.stringify(current.record) !== JSON.stringify(mine) || !same(current.directory, createdDirectory) || !same(current.file, createdFile)) throw refusal();
          const named = await lstat(path, { bigint: true }); privateFile(named);
          if (!same(createdFile, named) || !same(createdDirectory, await privateDirectory())) throw refusal();
          await unlink(path);
          if (!same(createdDirectory, await privateDirectory())) throw refusal();
          await rmdir(directory); released = true;
        } catch { throw refusal(); }
      };
    }
    try {
      const current = await read(); missingSince = 0;
      const live = await inspectOwnedProcess(current.record.owner.pid);
      if (!live || JSON.stringify(live) !== JSON.stringify(current.record.owner) || live.uid !== uid) {
        // The legitimate owner may have released and exited during inspection.
        // Reobserve only: a successor must pass the next strict read/inspection.
        const observed = await read();
        if (same(current.directory, observed.directory) && same(current.file, observed.file)) throw refusal();
      }
    } catch (error) {
      // A live owner may still be committing its file or removing its directory.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw refusal();
      missingSince ||= performance.now();
      if (performance.now() - missingSince > 1000) throw refusal();
    }
    await delay(100);
  }
  throw new Error(`CLI test lease wait exceeded its bound: ${directory}`);
}
