import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { ControlScope } from "./control-authority.ts";
import { controlScopeSchema } from "./control-wire.ts";
import { nativeOwnedProcesses, ownedProcessIdentitySchema, type OwnedProcessBoundary, type OwnedProcessIdentity } from "./owned-process-identity.ts";

const uuid = z.string().uuid();
const decimal = z.string().max(40).regex(/^[0-9]+$/);
const identitySchema = z.object({ dev: decimal, ino: decimal, uid: decimal, mode: decimal, birth: decimal }).strict();
const entrySchema = z.object({ path: z.string().max(1024), directory: z.boolean(), identity: identitySchema,
  state: z.enum(["present", "removing", "gone"]) }).strict();
export type OwnedWriterRole = "authentication" | "diagnostic" | "verifier" | "task" | "browser";
const writerSchema = z.object({ id: uuid, role: z.enum(["authentication", "diagnostic", "verifier", "task", "browser"]),
  state: z.enum(["pending", "attached", "closed"]), process: ownedProcessIdentitySchema.nullable(),
  directory: z.object({ name: z.string().max(200), identity: identitySchema }).strict().nullable() }).strict();
const recordSchema = z.object({ version: z.literal(1), scope: controlScopeSchema, kind: z.enum(["oci_session", "browser_profile"]),
  root: z.string().max(200), epoch: uuid, owner: ownedProcessIdentitySchema,
  parent: identitySchema, entries: z.array(entrySchema).max(512), writers: z.array(writerSchema).max(16),
  state: z.enum(["owned", "releasing", "released"]) }).strict();
type Record = z.infer<typeof recordSchema>;
type Identity = z.infer<typeof identitySchema>;
export type OwnedResourceKind = Record["kind"];
export type OwnedRecovery = "recovered" | "uncertain" | "unknown";
declare const resourceBrand: unique symbol;
declare const writerBrand: unique symbol;
export type OwnedResource = Readonly<{ [resourceBrand]: true }>;
export type OwnedResourceWriter = Readonly<{ [writerBrand]: true }>;
type Handle = { ledger: OwnedResourceLedger; key: string; epoch: string; scope: ControlScope; kind: OwnedResourceKind; root: string };
const handles = new WeakMap<OwnedResource, Handle>();
const writerHandles = new WeakMap<OwnedResourceWriter, { resource: OwnedResource; id: string }>();
export class OwnedResourceError extends Error {
  constructor(readonly code: "unavailable" | "busy" | "invalid_handle" | "uncertain") { super("Owned resource unavailable."); this.name = "OwnedResourceError"; }
}
function fail(code: OwnedResourceError["code"] = "uncertain"): never { throw new OwnedResourceError(code); }
function identity(stat: BigIntStats): Identity {
  return { dev: String(stat.dev), ino: String(stat.ino), uid: String(stat.uid), mode: String(stat.mode & 0o7777n), birth: String(stat.birthtimeNs) };
}
function same(left: Identity, right: Identity): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function privateEntry(stat: BigIntStats, directory: boolean): void {
  if (typeof process.getuid !== "function" || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o7777n) !== (directory ? 0o700n : 0o600n)
    || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) fail();
}
function relative(value: string): boolean {
  return value === "" || (value.length <= 1024 && !isAbsolute(value) && value.split("/").every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== ".."));
}
function scopeValue(scope: ControlScope): ControlScope {
  const result = controlScopeSchema.safeParse(scope);
  if (!result.success || !uuid.safeParse(result.data.attemptId).success) fail("invalid_handle");
  return result.data;
}
function keyOf(scope: ControlScope, kind: OwnedResourceKind): string {
  return createHash("sha256").update(JSON.stringify([kind, scope.threadId, scope.attemptId, scope.browserContextId, scope.generation])).digest("hex");
}
async function absent(path: string): Promise<boolean> {
  try { await fs.lstat(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}

/** Durable metadata only. No restart path signals a PID or adopts a resource by its name. */
export class OwnedResourceLedger {
  #dataDir: string;
  #directory: string;
  #processes: OwnedProcessBoundary;
  #initializing?: Promise<void>;
  #parent?: Identity;
  #journal?: Identity;
  #owner?: OwnedProcessIdentity;
  #queue: Promise<unknown> = Promise.resolve();
  constructor(dataDir: string, processes: OwnedProcessBoundary = nativeOwnedProcesses) {
    this.#dataDir = dataDir; this.#directory = join(dataDir, "owned-resources-v1"); this.#processes = processes;
  }
  async #initialize(): Promise<void> {
    this.#initializing ??= (async () => {
      if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY || !isAbsolute(this.#dataDir) || resolve(this.#dataDir) !== this.#dataDir
        || await fs.realpath(this.#dataDir) !== this.#dataDir) fail("unavailable");
      const parent = await fs.lstat(this.#dataDir, { bigint: true }); privateEntry(parent, true); this.#parent = identity(parent);
      try { await fs.mkdir(this.#directory, { mode: 0o700 }); await this.#sync(this.#dataDir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const journal = await fs.lstat(this.#directory, { bigint: true }); privateEntry(journal, true); this.#journal = identity(journal);
      this.#owner = ownedProcessIdentitySchema.parse(await this.#processes.self());
      if (this.#owner.uid !== process.getuid!()) fail("unavailable");
    })();
    await this.#initializing; await this.#check();
  }
  async #check(): Promise<void> {
    if (await fs.realpath(this.#dataDir) !== this.#dataDir) fail();
    for (const [path, original] of [[this.#dataDir, this.#parent], [this.#directory, this.#journal]] as const) {
      const stat = await fs.lstat(path, { bigint: true }); privateEntry(stat, true);
      if (!original || !same(original, identity(stat))) fail();
    }
  }
  async #sync(path: string): Promise<void> {
    const handle = await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async #json(path: string): Promise<{ value: unknown; identity: Identity }> {
    const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true }); privateEntry(before, false);
      if (before.size > 131072n) fail();
      const buffer = Buffer.alloc(Number(before.size) + 1); let length = 0;
      while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length); if (!bytesRead) break; length += bytesRead; }
      const after = await handle.stat({ bigint: true }), current = await fs.lstat(path, { bigint: true });
      privateEntry(after, false); privateEntry(current, false);
      if (before.size !== BigInt(length) || !same(identity(before), identity(after)) || !same(identity(before), identity(current))
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== current.mtimeNs || before.ctimeNs !== current.ctimeNs) fail();
      return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))), identity: identity(before) };
    } finally { await handle.close(); }
  }
  async #write(key: string, value: Record): Promise<void> {
    await this.#check();
    const temporary = join(this.#directory, `.${key}-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(recordSchema.parse(value))); await handle.sync(); }
    finally { await handle.close(); }
    try { await this.#check(); await fs.rename(temporary, join(this.#directory, `${key}.json`)); await this.#sync(this.#directory); }
    catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
  }
  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation); this.#queue = result.catch(() => {}); return result;
  }
  async #locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.#serialized(async () => {
      await this.#initialize();
      const path = join(this.#directory, `${key}.lock`);
      let lock;
      try { lock = await fs.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const previous = await this.#json(path);
        const owner = ownedProcessIdentitySchema.parse(previous.value);
        if (await this.#processes.inspect(owner.pid) !== null) fail("busy");
        if (!same(previous.identity, identity(await fs.lstat(path, { bigint: true })))) fail();
        await fs.unlink(path); await this.#sync(this.#directory);
        lock = await fs.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      }
      let original: Identity | undefined;
      try {
        await lock.writeFile(JSON.stringify(this.#owner)); await lock.sync(); original = identity(await lock.stat({ bigint: true }));
        await this.#sync(this.#directory); return await operation();
      } finally {
        await lock.close();
        if (original && same(original, identity(await fs.lstat(path, { bigint: true })))) { await fs.unlink(path); await this.#sync(this.#directory); }
      }
    });
  }
  async #read(key: string, scope: ControlScope, kind: OwnedResourceKind): Promise<Record | null> {
    try {
      const record = recordSchema.parse((await this.#json(join(this.#directory, `${key}.json`))).value);
      if (keyOf(record.scope, record.kind) !== key || JSON.stringify(record.scope) !== JSON.stringify(scope) || record.kind !== kind
        || !same(record.parent, this.#parent!) || record.entries.some((entry) => !relative(entry.path))
        || new Set(record.entries.map((entry) => entry.path)).size !== record.entries.length
        || new Set(record.writers.map((writer) => writer.id)).size !== record.writers.length
        || record.writers.some((writer) => writer.directory && !/^oci-browser-[A-Za-z0-9-]+$/.test(writer.directory.name))
        || (kind === "oci_session" ? record.root !== `oci-session-${scope.attemptId}` : !/^oci-browser-[0-9a-f-]{36}$/.test(record.root))) fail();
      return record;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  #handle(resource: OwnedResource): Handle {
    const value = handles.get(resource); if (!value || value.ledger !== this) fail("invalid_handle"); return value;
  }
  async #mutate<T>(resource: OwnedResource, operation: (record: Record, handle: Handle) => Promise<T>): Promise<T> {
    const handle = this.#handle(resource);
    return this.#locked(handle.key, async () => {
      const record = await this.#read(handle.key, handle.scope, handle.kind);
      if (!record || record.epoch !== handle.epoch || record.state === "released") fail("invalid_handle");
      return operation(record, handle);
    });
  }
  async prepare(supplied: ControlScope, kind: OwnedResourceKind): Promise<OwnedResource> {
    const scope = scopeValue(supplied), key = keyOf(scope, kind);
    return this.#locked(key, async () => {
      if (await this.#read(key, scope, kind)) fail("busy");
      const root = kind === "oci_session" ? `oci-session-${scope.attemptId}` : `oci-browser-${randomUUID()}`;
      if (!await absent(join(this.#dataDir, root))) fail();
      const record: Record = { version: 1, scope, kind, root, epoch: randomUUID(), owner: this.#owner!, parent: this.#parent!, entries: [], writers: [], state: "owned" };
      await this.#write(key, record);
      const resource = Object.freeze({}) as OwnedResource;
      handles.set(resource, { ledger: this, key, epoch: record.epoch, scope, kind, root }); return resource;
    });
  }
  path(resource: OwnedResource): string { return join(this.#dataDir, this.#handle(resource).root); }
  async recordEntry(resource: OwnedResource, path: string, directory: boolean): Promise<void> {
    if (!relative(path)) fail("invalid_handle");
    await this.#mutate(resource, async (record, handle) => {
      if (record.state !== "owned" || record.entries.some((entry) => entry.path === path)
        || (path !== "" && !record.entries.some((entry) => entry.path === (dirname(path) === "." ? "" : dirname(path)) && entry.directory))) fail();
      const stat = await fs.lstat(join(this.#dataDir, handle.root, path), { bigint: true }); privateEntry(stat, directory);
      record.entries.push({ path, directory, identity: identity(stat), state: "present" }); await this.#write(handle.key, record);
    });
  }
  async beginWriter(resource: OwnedResource, role: OwnedWriterRole): Promise<OwnedResourceWriter> {
    return this.#mutate(resource, async (record, handle) => {
      if (record.state !== "owned" || !record.entries.some((entry) => entry.path === "")) fail();
      record.writers = record.writers.filter((writer) => writer.state !== "closed" || writer.role === "browser");
      const id = randomUUID(); record.writers.push({ id, role, state: "pending", process: null, directory: null }); await this.#write(handle.key, record);
      const writer = Object.freeze({}) as OwnedResourceWriter; writerHandles.set(writer, { resource, id }); return writer;
    });
  }
  async #writer(writer: OwnedResourceWriter, operation: (value: Record["writers"][number]) => void): Promise<void> {
    const value = writerHandles.get(writer); if (!value) fail("invalid_handle");
    await this.#mutate(value.resource, async (record, handle) => {
      const target = record.writers.find((item) => item.id === value.id); if (!target) fail("invalid_handle");
      operation(target); await this.#write(handle.key, record);
    });
  }
  attachWriter(writer: OwnedResourceWriter, process: OwnedProcessIdentity): Promise<void> {
    return this.#writer(writer, (value) => {
      if (value.state !== "pending") fail();
      const parsed = ownedProcessIdentitySchema.parse(process); if (parsed.uid !== processUid()) fail();
      value.process = parsed; value.state = "attached";
    });
  }
  async confirmWriterClosed(writer: OwnedResourceWriter): Promise<void> {
    const handle = writerHandles.get(writer); if (!handle) fail("invalid_handle");
    await this.#mutate(handle.resource, async (record, resource) => {
      const value = record.writers.find((item) => item.id === handle.id); if (!value) fail("invalid_handle");
      if (value.role === "browser" && value.directory && !await absent(join(this.#dataDir, value.directory.name))) fail();
      value.state = "closed"; await this.#write(resource.key, record);
    });
  }
  async recordWriterDirectory(writer: OwnedResourceWriter, path: string): Promise<void> {
    if (dirname(path) !== this.#dataDir || !/^oci-browser-[A-Za-z0-9-]+$/.test(basename(path))) fail("invalid_handle");
    const stat = await fs.lstat(path, { bigint: true }); privateEntry(stat, true);
    await this.#writer(writer, (value) => {
      if (value.role !== "browser" || value.state !== "pending" || value.directory) fail();
      value.directory = { name: basename(path), identity: identity(stat) };
    });
  }
  /** Live owned browser only; recovery never adopts or recursively deletes its unrecorded contents. */
  async prepareBrowserRemoval(resource: OwnedResource, writer: OwnedResourceWriter): Promise<void> {
    const ownership = writerHandles.get(writer);
    if (!ownership || ownership.resource !== resource) fail("invalid_handle");
    await this.#mutate(resource, async (record, handle) => {
      const entry = record.entries[0], owner = record.writers.find((value) => value.id === ownership.id);
      if (record.kind !== "browser_profile" || !owner || owner.role !== "browser" || record.entries.length !== 1
        || !entry || entry.path !== "" || !entry.directory || entry.state === "gone" || !owner.directory || owner.directory.name !== record.root) fail();
      await this.#check();
      const stat = await fs.lstat(join(this.#dataDir, record.root), { bigint: true }); privateEntry(stat, true);
      if (!same(entry.identity, identity(stat)) || !same(owner.directory.identity, identity(stat))) fail();
      entry.state = "removing"; record.state = "releasing";
      await this.#write(handle.key, record);
    });
  }
  async #validate(record: Record): Promise<void> {
    await this.#check();
    if (!record.entries.some((entry) => entry.path === "" && entry.directory)) fail();
    for (const entry of record.entries) {
      const path = join(this.#dataDir, record.root, entry.path);
      if (await absent(path)) { if (entry.state === "present") fail(); continue; }
      if (entry.state === "gone") fail();
      const stat = await fs.lstat(path, { bigint: true }); privateEntry(stat, entry.directory);
      if (!same(identity(stat), entry.identity)) fail();
      if (entry.directory) {
        const names = await fs.readdir(path);
        const expected = new Set(record.entries.filter((item) => item.path !== entry.path && (dirname(item.path) === "." ? "" : dirname(item.path)) === entry.path && item.state !== "gone").map((item) => basename(item.path)));
        if (names.some((name) => !expected.has(name))) fail();
      }
    }
  }
  async #remove(key: string, record: Record): Promise<void> {
    if (record.writers.some((writer) => writer.state !== "closed")) fail();
    for (const writer of record.writers) if (writer.role === "browser" && writer.directory && !await absent(join(this.#dataDir, writer.directory.name))) fail();
    await this.#validate(record); record.state = "releasing"; await this.#write(key, record);
    const entries = [...record.entries].sort((a, b) => b.path.split("/").length - a.path.split("/").length || b.path.length - a.path.length);
    for (const entry of entries) {
      if (entry.state === "gone") continue;
      const path = join(this.#dataDir, record.root, entry.path);
      await this.#validate(record);
      entry.state = "removing"; await this.#write(key, record);
      if (!await absent(path)) {
        const stat = await fs.lstat(path, { bigint: true }); privateEntry(stat, entry.directory); if (!same(identity(stat), entry.identity)) fail();
        if (entry.directory) await fs.rmdir(path); else await fs.unlink(path);
        await this.#sync(dirname(path));
      }
      entry.state = "gone"; await this.#write(key, record);
    }
    record.state = "released"; await this.#write(key, record);
  }
  async release(resource: OwnedResource): Promise<void> {
    await this.#mutate(resource, async (record, handle) => this.#remove(handle.key, record));
  }
  async recover(supplied: ControlScope, kind: OwnedResourceKind): Promise<OwnedRecovery> {
    try {
      const scope = scopeValue(supplied), key = keyOf(scope, kind);
      return await this.#locked(key, async () => {
        const record = await this.#read(key, scope, kind); if (!record) return "unknown";
        if (record.state === "released") return await absent(join(this.#dataDir, record.root)) ? "recovered" : "uncertain";
        // A live PID, even with a different start identity, is never signalled or adopted.
        if (await this.#processes.inspect(record.owner.pid) !== null) return "uncertain";
        for (const writer of record.writers) {
          if (writer.state === "closed") continue;
          if (writer.state !== "attached" || !writer.process || writer.role === "browser" || await this.#processes.inspect(writer.process.pid) !== null) return "uncertain";
          writer.state = "closed";
        }
        await this.#remove(key, record); return "recovered";
      });
    } catch { return "uncertain"; }
  }
}
function processUid(): number { if (typeof process.getuid !== "function") fail("unavailable"); return process.getuid(); }
