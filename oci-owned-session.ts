import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { cliExpectedIdentitySchema, type CliExpectedIdentity } from "./oci-cli-protocol.ts";
import type { ControlScope } from "./control-authority.ts";
import { OwnedResourceLedger, type OwnedResource, type OwnedRecovery } from "./owned-resource-ledger.ts";

/** Worker-only paths. Never serialize this lease into status, a tool result, or durable metadata. */
export type OwnedOciPaths = Readonly<{
  root: string; configFile: string; rcFile: string; tokenLocation: string; profileName: string;
  profileDir: string; privateKeyFile: string; publicKeyFile: string; tokenFile: string;
}>;
export type OwnedOciSession = Readonly<{ paths: OwnedOciPaths; expectedIdentity: Readonly<CliExpectedIdentity> }>;
type Entry = { path: string; stat: BigIntStats; directory: boolean };
type Session = {
  paths: OwnedOciPaths; expectedIdentity: Readonly<CliExpectedIdentity>; parent: Entry;
  entries: Map<string, Entry>; activeSnapshot?: OwnedOciSnapshot; capturing: boolean; releasing: boolean; released: boolean;
  ledger: OwnedResourceLedger; resource: OwnedResource;
};
const sessions = new WeakMap<OwnedOciSession, Session>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class OwnedOciSessionError extends Error {
  constructor(readonly code: string) { super("Owned OCI session refused."); this.name = "OwnedOciSessionError"; }
}
function fail(code: string): never { throw new OwnedOciSessionError(code); }
function fsCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException | null)?.code; }
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof OwnedOciSessionError) throw error;
    if (["ELOOP", "ENOTDIR"].includes(fsCode(error) ?? "")) fail("unsafe_storage");
    fail("storage_unavailable");
  }
}
function owned(stat: BigIntStats): boolean {
  return typeof process.getuid === "function" && stat.uid === BigInt(process.getuid());
}
function privateEntry(stat: BigIntStats, directory: boolean): void {
  if (!owned(stat) || (stat.mode & 0o7777n) !== (directory ? 0o700n : 0o600n) ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) fail("unsafe_storage");
}
function sameInode(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
async function entry(path: string, directory: boolean): Promise<Entry> {
  const stat = await fs.lstat(path, { bigint: true });
  privateEntry(stat, directory);
  return { path, stat, directory };
}
async function recheckEntry(original: Entry): Promise<void> {
  const current = await entry(original.path, original.directory);
  if (!sameInode(current.stat, original.stat)) fail("artifact_changed");
}
function session(lease: OwnedOciSession): Session {
  const value = sessions.get(lease);
  if (!value || value.released || value.releasing) fail("invalid_lease");
  return value;
}
async function checkDirectories(state: Session): Promise<void> {
  if (await fs.realpath(state.parent.path) !== state.parent.path) fail("unsafe_storage");
  await recheckEntry(state.parent);
  for (const value of state.entries.values()) if (value.directory) await recheckEntry(value);
}
async function makeDirectory(path: string): Promise<Entry> {
  await fs.mkdir(path, { mode: 0o700 });
  return entry(path, true);
}
async function makeEmptyFile(path: string): Promise<Entry> {
  const handle = await fs.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { privateEntry(await handle.stat({ bigint: true }), false); }
  finally { await handle.close(); }
  return entry(path, false);
}

/** Creates only a fresh root under an existing trusted private directory; never consults ~/.oci. */
export async function createOwnedOciSession(
  trustedDataDir: string, attemptUUID: string, expectedCliIdentity: CliExpectedIdentity, scope?: ControlScope,
): Promise<OwnedOciSession> {
  return safe(async () => {
    if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY || !UUID.test(attemptUUID)) fail("invalid_session");
    const target = cliExpectedIdentitySchema.safeParse(expectedCliIdentity);
    if (!target.success) fail("invalid_identity");
    if (typeof trustedDataDir !== "string" || !isAbsolute(trustedDataDir) || resolve(trustedDataDir) !== trustedDataDir ||
      trustedDataDir.length > 4096 || /[\x00-\x1f\x7f]/.test(trustedDataDir) ||
      await fs.realpath(trustedDataDir) !== trustedDataDir) fail("unsafe_storage");
    if (scope && scope.attemptId !== attemptUUID) fail("invalid_session");
    const parent = await entry(trustedDataDir, true);
    const ledger = new OwnedResourceLedger(trustedDataDir);
    let resource: OwnedResource;
    try { resource = await ledger.prepare(scope ?? { threadId: "owned-oci-internal", attemptId: attemptUUID, browserContextId: attemptUUID, generation: 0 }, "oci_session"); }
    catch (error) { if ((error as { code?: string }).code === "busy") fail("session_exists"); throw error; }
    const root = ledger.path(resource);
    const profileName = `BB_REMOTE_${attemptUUID.replaceAll("-", "")}`;
    const tokenLocation = join(root, "tokens");
    const profileDir = join(tokenLocation, profileName);
    const paths = Object.freeze({ root, configFile: join(root, "config"), rcFile: join(root, "oci_cli_rc"), tokenLocation,
      profileName, profileDir, privateKeyFile: join(profileDir, "oci_api_key.pem"),
      publicKeyFile: join(profileDir, "oci_api_key_public.pem"), tokenFile: join(profileDir, "token") });
    const state: Session = { paths, expectedIdentity: Object.freeze(target.data), parent, entries: new Map(), capturing: false, releasing: false, released: false, ledger, resource };
    try { state.entries.set(root, await makeDirectory(root)); }
    catch (error) { if (fsCode(error) === "EEXIST") fail("session_exists"); throw error; }
    await ledger.recordEntry(resource, "", true);
    // Every fixed artifact exists and is journaled before a writer can receive private configuration.
    for (const path of [tokenLocation, profileDir]) {
      await checkDirectories(state);
      state.entries.set(path, await makeDirectory(path));
      await ledger.recordEntry(resource, path.slice(root.length + 1), true);
    }
    for (const path of [paths.configFile, paths.rcFile, paths.privateKeyFile, paths.publicKeyFile, paths.tokenFile]) {
      await checkDirectories(state);
      state.entries.set(path, await makeEmptyFile(path));
      await ledger.recordEntry(resource, path.slice(root.length + 1), false);
    }
    await checkDirectories(state);
    const lease = Object.freeze(Object.defineProperties({}, {
      paths: { value: paths }, expectedIdentity: { value: state.expectedIdentity },
    })) as OwnedOciSession;
    sessions.set(lease, state);
    return lease;
  });
}

/** Explicit owned release; successful authentication does not automatically erase retained credentials. */
export async function releaseOwnedOciSession(lease: OwnedOciSession): Promise<void> {
  await safe(async () => {
    const state = session(lease);
    if (state.capturing) fail("snapshot_active");
    state.releasing = true;
    try {
      await checkDirectories(state);
      for (const original of state.entries.values()) await recheckEntry(original);
      for (const original of state.entries.values()) {
        if (!original.directory) continue;
        const actual = (await fs.readdir(original.path)).sort();
        const expected = [...state.entries.values()].filter((item) => dirname(item.path) === original.path).map((item) => basename(item.path)).sort();
        if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) fail("cleanup_refused");
      }
      await state.ledger.release(state.resource);
      state.entries.clear();
      state.released = true;
      if (state.activeSnapshot) disposeOwnedOciSnapshot(state.activeSnapshot);
    } finally { state.releasing = false; }
  });
}

/** Worker-only resource hook. Opaque handles cannot be reconstructed from durable metadata. */
export function ownedOciResourceContext(lease: OwnedOciSession): { ledger: OwnedResourceLedger; resource: OwnedResource } {
  const state = session(lease); return { ledger: state.ledger, resource: state.resource };
}
/** Cleanup only; a replacement worker cannot turn journaled artifacts into an authenticated session. */
export async function recoverOwnedOciSession(dataDir: string, scope: ControlScope): Promise<OwnedRecovery> {
  return new OwnedResourceLedger(dataDir).recover(scope, "oci_session");
}

export type OwnedOciConfig = Readonly<{ tenancyOcid: string; userOcid?: string; region: string; fingerprint: string }>;
/** Worker-only immutable bytes. Getters copy; JSON serialization exposes no account data. */
export type OwnedOciSnapshot = Readonly<{ tokenBytes: Buffer; privateKeyBytes: Buffer; config: OwnedOciConfig }>;
type CapturedFile = Entry & { bytes: Buffer };
type Snapshot = { session: Session; files: Map<string, CapturedFile>; directories: Map<string, BigIntStats>; config: OwnedOciConfig };
const snapshots = new WeakMap<OwnedOciSnapshot, Snapshot>();
declare const generationSealBrand: unique symbol;
/** Opaque worker-only generation binding. It contains no inspectable or serializable evidence. */
export type OwnedOciGenerationSeal = Readonly<{ [generationSealBrand]: true }>;
type GenerationSeal = {
  session: Session;
  files: Map<string, { stat: BigIntStats; digest: string }>;
  directories: Map<string, BigIntStats>;
};
const generationSeals = new WeakMap<OwnedOciGenerationSeal, GenerationSeal>();
const CONFIG_LIMIT = 16_384;
const KEY_LIMIT = 32_768;
const TOKEN_LIMIT = 65_536;

function sameGeneration(a: BigIntStats, b: BigIntStats): boolean {
  return sameInode(a, b) && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink &&
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function directoryGenerations(state: Session): Promise<Map<string, BigIntStats>> {
  const generations = new Map<string, BigIntStats>();
  await checkDirectories(state);
  for (const original of state.entries.values()) {
    if (original.directory) generations.set(original.path, (await entry(original.path, true)).stat);
  }
  return generations;
}
async function recheckDirectories(state: Session, generations: Map<string, BigIntStats>): Promise<void> {
  const current = await directoryGenerations(state);
  for (const [path, before] of generations) if (!sameGeneration(before, current.get(path)!)) fail("artifact_changed");
}
function sameFile(a: CapturedFile, b: CapturedFile): boolean {
  return sameGeneration(a.stat, b.stat) && a.bytes.equals(b.bytes);
}
async function readPrivate(state: Session, path: string, limit: number, allowEmpty = false): Promise<CapturedFile> {
  await checkDirectories(state);
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const buffer = Buffer.alloc(limit + 1);
  try {
    const before = await handle.stat({ bigint: true });
    privateEntry(before, false);
    const original = state.entries.get(path);
    if (original && !sameInode(original.stat, before)) fail("artifact_changed");
    if (before.size > BigInt(limit)) fail("artifact_too_large");
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) fail("artifact_too_large");
    if (!length && !allowEmpty) fail("invalid_artifact");
    const after = await handle.stat({ bigint: true });
    privateEntry(after, false);
    const current = await entry(path, false);
    if (!sameGeneration(before, after) || !sameGeneration(before, current.stat) || before.size !== BigInt(length)) fail("artifact_changed");
    return { path, stat: before, directory: false, bytes: Buffer.from(buffer.subarray(0, length)) };
  } finally { buffer.fill(0); await handle.close(); }
}
async function checkLayout(state: Session): Promise<void> {
  await checkDirectories(state);
  for (const [path, names] of [
    [state.paths.root, ["config", "oci_cli_rc", "tokens"]],
    [state.paths.tokenLocation, [state.paths.profileName]],
    [state.paths.profileDir, ["oci_api_key.pem", "oci_api_key_public.pem", "token"]],
  ] as const) {
    const actual = (await fs.readdir(path)).sort();
    const expected = [...names].sort();
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) fail("unexpected_artifact");
  }
}
function parseConfig(bytes: Buffer, state: Session): OwnedOciConfig {
  let config: string;
  try { config = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail("invalid_config"); }
  const values = new Map<string, string>();
  let sectionSeen = false;
  for (const line of config.split("\n")) {
    if (!line) continue;
    if (!sectionSeen) {
      if (line !== `[${state.paths.profileName}]`) fail("invalid_config");
      sectionSeen = true;
      continue;
    }
    const match = /^(fingerprint|key_file|tenancy|region|security_token_file|user)(?:=| = )([^\x00-\x1f\x7f]+)$/.exec(line);
    if (!match || values.has(match[1]) || match[2].trim() !== match[2]) fail("invalid_config");
    values.set(match[1], match[2]);
  }
  const expected = state.expectedIdentity;
  const fingerprint = values.get("fingerprint");
  if (!sectionSeen || !fingerprint || !/^(?:[0-9a-f]{2}:){15}[0-9a-f]{2}$/.test(fingerprint) ||
    values.get("key_file") !== state.paths.privateKeyFile || values.get("security_token_file") !== state.paths.tokenFile ||
    values.get("tenancy") !== expected.tenancyOcid || values.get("region") !== expected.region ||
    (values.has("user") && values.get("user") !== expected.userOcid)) fail("invalid_config");
  return Object.freeze({ tenancyOcid: expected.tenancyOcid, region: expected.region, fingerprint,
    ...(values.has("user") ? { userOcid: values.get("user")! } : {}) });
}
function clearFiles(files: Map<string, CapturedFile>): void {
  for (const file of files.values()) file.bytes.fill(0);
  files.clear();
}
async function readFiles(state: Session): Promise<Map<string, CapturedFile>> {
  const files = new Map<string, CapturedFile>();
  try {
    for (const [path, limit, allowEmpty] of [
      [state.paths.configFile, CONFIG_LIMIT, false], [state.paths.rcFile, 0, true],
      [state.paths.privateKeyFile, KEY_LIMIT, false], [state.paths.publicKeyFile, KEY_LIMIT, false],
      [state.paths.tokenFile, TOKEN_LIMIT, false],
    ] as const) files.set(path, await readPrivate(state, path, limit, allowEmpty));
    return files;
  } catch (error) { clearFiles(files); throw error; }
}

/** Call only after the owned authentication child exits and all owned writers stop. This is not verification. */
export async function captureOwnedOciSnapshot(lease: OwnedOciSession): Promise<OwnedOciSnapshot> {
  return safe(async () => {
    const state = session(lease);
    if (state.capturing || state.activeSnapshot) fail("snapshot_active");
    state.capturing = true;
    let files: Map<string, CapturedFile> | undefined;
    let retained = false;
    try {
      await checkLayout(state);
      const directories = await directoryGenerations(state);
      files = await readFiles(state);
      const config = parseConfig(files.get(state.paths.configFile)!.bytes, state);
      const second = await readFiles(state);
      try {
        for (const [path, first] of files) if (!sameFile(first, second.get(path)!)) fail("artifact_changed");
        await checkLayout(state);
        await recheckDirectories(state, directories);
      } finally { clearFiles(second); }
      for (const [path, file] of files) if (!state.entries.has(path)) state.entries.set(path, { path, stat: file.stat, directory: false });
      const snapshot = Object.freeze(Object.defineProperties({}, {
        tokenBytes: { get: () => Buffer.from(snapshotRecord(snapshot).files.get(state.paths.tokenFile)!.bytes) },
        privateKeyBytes: { get: () => Buffer.from(snapshotRecord(snapshot).files.get(state.paths.privateKeyFile)!.bytes) },
        config: { get: () => snapshotRecord(snapshot).config },
      })) as OwnedOciSnapshot;
      snapshots.set(snapshot, { session: state, files, directories, config });
      state.activeSnapshot = snapshot;
      retained = true;
      return snapshot;
    } finally {
      state.capturing = false;
      if (!retained && files) clearFiles(files);
    }
  });
}

function snapshotRecord(snapshot: OwnedOciSnapshot): Snapshot {
  const original = snapshots.get(snapshot);
  if (!original || original.session.released || original.session.releasing || original.session.activeSnapshot !== snapshot) fail("invalid_snapshot");
  return original;
}

/** Idempotently zeroes and revokes one private snapshot; retained credential files remain owned by the lease. */
export function disposeOwnedOciSnapshot(snapshot: OwnedOciSnapshot): void {
  const original = snapshots.get(snapshot);
  if (!original) return;
  clearFiles(original.files);
  original.directories.clear();
  if (original.session.activeSnapshot === snapshot) original.session.activeSnapshot = undefined;
  snapshots.delete(snapshot);
}

/** Anchors a whole verification chain without retaining credential bytes or occupying its capture slot. */
export async function captureOwnedOciGenerationSeal(lease: OwnedOciSession): Promise<OwnedOciGenerationSeal> {
  return safe(async () => {
    const snapshot = await captureOwnedOciSnapshot(lease);
    try {
      const original = snapshotRecord(snapshot);
      const seal = Object.freeze({}) as OwnedOciGenerationSeal;
      generationSeals.set(seal, {
        session: original.session,
        files: new Map([...original.files].map(([path, file]) => [path, {
          stat: file.stat, digest: createHash("sha256").update(file.bytes).digest("hex"),
        }])),
        directories: new Map(original.directories),
      });
      return seal;
    } finally { disposeOwnedOciSnapshot(snapshot); }
  });
}

/** Recaptures real owned files and rejects any generation or byte change since the chain began. */
export async function assertOwnedOciGenerationSeal(lease: OwnedOciSession, seal: OwnedOciGenerationSeal): Promise<void> {
  await safe(async () => {
    const state = session(lease), original = generationSeals.get(seal);
    if (!original || original.session !== state) fail("invalid_seal");
    const snapshot = await captureOwnedOciSnapshot(lease);
    try {
      const current = snapshotRecord(snapshot);
      if (current.files.size !== original.files.size || current.directories.size !== original.directories.size) fail("artifact_changed");
      for (const [path, before] of original.directories) {
        const after = current.directories.get(path);
        if (!after || !sameGeneration(before, after)) fail("artifact_changed");
      }
      for (const [path, before] of original.files) {
        const after = current.files.get(path);
        if (!after || !sameGeneration(before.stat, after.stat)
          || before.digest !== createHash("sha256").update(after.bytes).digest("hex")) fail("artifact_changed");
      }
    } finally { disposeOwnedOciSnapshot(snapshot); }
  });
}

/** Rechecks the exact captured byte generation after an awaited operation; never grants identity authority. */
export async function recheckOwnedOciSnapshot(lease: OwnedOciSession, snapshot: OwnedOciSnapshot): Promise<void> {
  await safe(async () => {
    const state = session(lease);
    const original = snapshotRecord(snapshot);
    if (original.session !== state) fail("invalid_snapshot");
    await recheckDirectories(state, original.directories);
    await checkLayout(state);
    let current: Map<string, CapturedFile>;
    try { current = await readFiles(state); }
    catch (error) {
      if (error instanceof OwnedOciSessionError && ["artifact_too_large", "invalid_artifact"].includes(error.code)) fail("artifact_changed");
      throw error;
    }
    try {
      for (const [path, file] of original.files) if (!sameFile(file, current.get(path)!)) fail("artifact_changed");
      const second = await readFiles(state);
      try {
        for (const [path, file] of original.files) if (!sameFile(file, second.get(path)!)) fail("artifact_changed");
        await checkLayout(state);
        await recheckDirectories(state, original.directories);
        if (snapshotRecord(snapshot) !== original) fail("invalid_snapshot");
      } finally { clearFiles(second); }
    } finally { clearFiles(current); }
  });
}

/** Authenticates a worker-only lease and its original base layout, before authentication produces credentials. */
export async function assertOwnedOciSession(lease: OwnedOciSession): Promise<void> {
  await safe(async () => {
    const state = session(lease);
    await checkDirectories(state);
    for (const path of [state.paths.configFile, state.paths.rcFile]) {
      const original = state.entries.get(path)!;
      await recheckEntry(original);
      const current = await entry(path, false);
      if (current.stat.size > BigInt(path === state.paths.rcFile ? 0 : CONFIG_LIMIT)) fail("invalid_artifact");
    }
    await checkDirectories(state);
  });
}
