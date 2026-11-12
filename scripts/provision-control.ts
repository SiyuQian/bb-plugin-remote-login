import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

// Offline owner tool: consumes the supplied safe staging file even on failure.
// Supply only this attempt's fresh file in a separate private staging directory, never an existing credential file.

type Arguments = { dataDir: string; secretFile: string; expectedFingerprint: string };

function parseArguments(args: string[]): Arguments {
  if (args.length !== 6) throw new Error("provision_failed");
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    const value = args[index + 1]!;
    if (!["--data-dir", "--secret-file", "--expected-fingerprint"].includes(name) || values.has(name)) {
      throw new Error("provision_failed");
    }
    values.set(name, value);
  }
  const dataDir = values.get("--data-dir") ?? "";
  const secretFile = values.get("--secret-file") ?? "";
  const expectedFingerprint = values.get("--expected-fingerprint") ?? "";
  if (!isAbsolute(dataDir) || !isAbsolute(secretFile) || !/^[0-9a-fA-F]{64}$/.test(expectedFingerprint)) {
    throw new Error("provision_failed");
  }
  return { dataDir, secretFile, expectedFingerprint: expectedFingerprint.toLowerCase() };
}

function safeMetadata(stats: Stats, uid: number): boolean {
  return stats.isFile() && stats.uid === uid && stats.nlink === 1
    && (stats.mode & 0o7777) === 0o600 && stats.size <= 4096;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function canonicalLocation(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return join(await canonicalLocation(dirname(path)), basename(path));
  }
}

async function assertOutsideDataDir(args: Arguments): Promise<void> {
  const dataDir = await canonicalLocation(args.dataDir);
  const staging = join(await realpath(dirname(args.secretFile)), basename(args.secretFile));
  const location = relative(dataDir, staging);
  if (!location || (!isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`))) {
    throw new Error("provision_failed");
  }
}

function parseKey(content: string): string {
  const match = /^REMOTE_LOGIN_CONTROL_KEY=([^\r\n]+)\r?\n$/.exec(content);
  if (!match || match[0] !== content) throw new Error("provision_failed");
  const encoded = match[1]!;
  const key: unknown = encoded.startsWith('"') ? JSON.parse(encoded)
    : encoded.startsWith("'") && encoded.endsWith("'") ? encoded.slice(1, -1) : encoded;
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("provision_failed");
  const decoded = Buffer.from(key, "base64url");
  try {
    if (decoded.length !== 32 || decoded.toString("base64url") !== key) throw new Error("provision_failed");
  } finally {
    decoded.fill(0);
  }
  return key;
}

async function removeOwnedStaging(path: string, identity: Stats, uid: number): Promise<void> {
  let current: Stats;
  try {
    current = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  // Once opened safely, invalid content must still be removed; never unlink a replacement inode.
  if (!sameFile(identity, current) || !current.isFile() || current.uid !== uid) throw new Error("provision_failed");
  await unlink(path);
}

async function main(): Promise<{ rootId: string }> {
  const args = parseArguments(process.argv.slice(2));
  const uid = process.getuid?.();
  if (uid === undefined || typeof constants.O_NOFOLLOW !== "number") throw new Error("provision_failed");
  await assertOutsideDataDir(args);
  const file = await open(args.secretFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let owned: Stats | undefined;
  const bytes = Buffer.alloc(4097);
  try {
    const metadata = await file.stat();
    const pathMetadata = await lstat(args.secretFile);
    if (!safeMetadata(metadata, uid) || !safeMetadata(pathMetadata, uid) || !sameFile(metadata, pathMetadata)) {
      throw new Error("provision_failed");
    }
    owned = metadata;
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const afterRead = await file.stat();
    if (bytesRead !== metadata.size || !safeMetadata(afterRead, uid) || !sameFile(metadata, afterRead)
      || afterRead.size !== metadata.size || afterRead.mtimeMs !== metadata.mtimeMs) {
      throw new Error("provision_failed");
    }
    const key = parseKey(bytes.subarray(0, bytesRead).toString("utf8"));
    const { provisionControlRoot } = await import("../control-authority.ts");
    return await provisionControlRoot(args.dataDir, key, args.expectedFingerprint);
  } finally {
    try {
      if (owned) await removeOwnedStaging(args.secretFile, owned, uid);
    } finally {
      bytes.fill(0);
      await file.close();
    }
  }
}

try {
  const { rootId } = await main();
  process.stdout.write(`${JSON.stringify({ provisioned: true, rootId })}\n`);
} catch {
  process.stdout.write(`${JSON.stringify({ provisioned: false, reason: "provision_failed" })}\n`);
  process.exitCode = 1;
}
