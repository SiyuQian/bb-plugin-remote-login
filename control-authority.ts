import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

export type ControlScope = { threadId: string; attemptId: string; browserContextId: string; generation: number };
export type ControlGrant = { capability: string; expiresAt: number };

const TOKEN_LIFETIME = 300_000;
const HARD_LIFETIME = 900_000;
const BUDGET_WINDOW = 60_000;
const inFlight = new Set<string>();
type Root = { version: 1; rootId: string; verifier: string; tag: string };
type Session = { scope: ControlScope; rootTag: string; expiresAt: number; hardDeadline: number; createdAt: number };

export class ControlAuthError extends Error {
  code: string;
  constructor(code: string) {
    super("Control authorization refused.");
    this.name = "ControlAuthError";
    this.code = code;
  }
}

function fail(code: string): never { throw new ControlAuthError(code); }
function fsCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException | null)?.code; }
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof ControlAuthError) throw error;
    if (fsCode(error) === "ELOOP") fail("unsafe_storage");
    fail("storage_unavailable");
  }
}

function keyBytes(key: string): Buffer {
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key)) fail("invalid_key");
  const bytes = Buffer.from(key, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== key) fail("invalid_key");
  return bytes;
}

function digest(bytes: Buffer | string): Buffer { return createHash("sha256").update(bytes).digest(); }
export function controlKeyFingerprint(key: string): string {
  return createHash("sha256").update("bb-remote-login pairing root v1\0").update(keyBytes(key)).digest("hex");
}

function owned(stat: Stats): boolean {
  return typeof process.getuid === "function" && stat.uid === process.getuid();
}
async function directory(dataDir: string, provision = false): Promise<Stats> {
  if (provision) {
    try { await fs.mkdir(dataDir, { mode: 0o700 }); }
    catch (error) { if (fsCode(error) !== "EEXIST") throw error; }
  }
  let stat = await fs.lstat(dataDir);
  if (!stat.isDirectory() || !owned(stat) || (stat.mode & 0o7022) !== 0) fail("unsafe_storage");
  // Only the offline operator importer may tighten SDK-created directories.
  if (provision && (stat.mode & 0o777) !== 0o700) {
    await fs.chmod(dataDir, 0o700);
    stat = await fs.lstat(dataDir);
  }
  return stat;
}
function privateDirectory(stat: Stats): void {
  if ((stat.mode & 0o7777) !== 0o700) fail("unsafe_storage");
}

async function privateFile(path: string, flags = constants.O_RDONLY): Promise<FileHandle> {
  if (!constants.O_NOFOLLOW) fail("unsafe_storage");
  const handle = await fs.open(path, flags | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !owned(stat) || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.size > 4096) {
      fail("unsafe_storage");
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function readRoot(dataDir: string, optional = false): Promise<Root | null> {
  let handle: FileHandle | undefined;
  try {
    const stat = await directory(dataDir);
    if (optional) await fs.lstat(join(dataDir, "control-root.json"));
    privateDirectory(stat);
    handle = await privateFile(join(dataDir, "control-root.json"));
    const content = await handle.readFile("utf8");
    const root = JSON.parse(content);
    if (root?.version !== 1 || typeof root.rootId !== "string" || !/^[0-9a-f-]{36}$/.test(root.rootId)
      || typeof root.verifier !== "string" || !/^[0-9a-f]{64}$/.test(root.verifier)
      || Object.keys(root).sort().join() !== "rootId,verifier,version") fail("root_unavailable");
    const fileStat = await handle.stat();
    return { ...root, tag: `${fileStat.dev}:${fileStat.ino}:${fileStat.mtimeMs}:${fileStat.ctimeMs}:${content}` };
  } catch (error) {
    if (fsCode(error) === "ENOENT") { if (optional) return null; fail("root_unavailable"); }
    if (error instanceof SyntaxError) fail("root_unavailable");
    throw error;
  } finally { await handle?.close(); }
}

async function writePrivateJson(handle: FileHandle, value: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value));
  const { bytesWritten } = await handle.write(bytes, 0, bytes.length, 0);
  if (bytesWritten !== bytes.length) fail("storage_unavailable");
  await handle.truncate(bytes.length);
  await handle.sync();
}

export async function provisionControlRoot(dataDir: string, key: string, expectedFingerprint: string): Promise<{ rootId: string }> {
  const bytes = keyBytes(key);
  const fingerprint = controlKeyFingerprint(key);
  if (typeof expectedFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(expectedFingerprint)
    || !timingSafeEqual(Buffer.from(fingerprint, "hex"), Buffer.from(expectedFingerprint, "hex"))) fail("fingerprint_mismatch");
  return safe(async () => {
    privateDirectory(await directory(dataDir, true));
    let root: FileHandle;
    try { root = await privateFile(join(dataDir, "control-root.json"), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR); }
    catch (error) { if (fsCode(error) === "EEXIST") fail("root_exists"); throw error; }
    const rootId = randomUUID();
    try {
      await writePrivateJson(root, { version: 1, rootId, verifier: digest(bytes).toString("hex") });
      try {
        const budget = await privateFile(join(dataDir, "control-budget.json"), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR);
        try { await writePrivateJson(budget, { version: 1, attempts: [] }); }
        finally { await budget.close(); }
      } catch (error) { if (fsCode(error) !== "EEXIST") throw error; }
    } finally { await root.close(); }
    return { rootId };
  });
}

export async function inspectControlRoot(dataDir: string): Promise<{ provisioned: boolean; rootId: string | null }> {
  return safe(async () => {
    const root = await readRoot(dataDir, true);
    return { provisioned: root !== null, rootId: root?.rootId ?? null };
  });
}

async function reserveGuess(dataDir: string, now: number): Promise<void> {
  const lockPath = join(dataDir, "control-budget.lock");
  let lock: FileHandle;
  try { lock = await privateFile(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR); }
  catch (error) { if (fsCode(error) === "EEXIST") fail("auth_busy"); throw error; }
  try {
    let budget: FileHandle;
    try { budget = await privateFile(join(dataDir, "control-budget.json"), constants.O_RDWR); }
    catch (error) { if (fsCode(error) === "ENOENT") fail("budget_invalid"); throw error; }
    try {
      let state;
      try { state = JSON.parse(await budget.readFile("utf8")); }
      catch (error) { if (error instanceof SyntaxError) fail("budget_invalid"); throw error; }
      if (state?.version !== 1 || Object.keys(state).sort().join() !== "attempts,version"
        || !Array.isArray(state.attempts) || state.attempts.length > 5
        || state.attempts.some((at: unknown, index: number) => typeof at !== "number" || !Number.isSafeInteger(at)
          || at < 0 || at > now || (index > 0 && at < state.attempts[index - 1]))) fail("budget_invalid");
      const recent: number[] = state.attempts.filter((at: number) => now - at < BUDGET_WINDOW);
      if (recent.length >= 5) fail("rate_limited");
      // Reserve durably before checking K; crash-corrupted state stays closed.
      await writePrivateJson(budget, { version: 1, attempts: [...recent, now] });
    } finally { await budget.close(); }
  } finally {
    await lock.close();
    // A crash may leave this lock behind; only the operator may recover it.
    await fs.unlink(lockPath);
  }
}

function scopeValue(scope: ControlScope): ControlScope {
  if (!scope || Object.keys(scope).sort().join() !== "attemptId,browserContextId,generation,threadId"
    || ![scope.threadId, scope.attemptId, scope.browserContextId].every((value) => typeof value === "string" && value.length > 0 && value.length <= 200)
    || !Number.isSafeInteger(scope.generation) || scope.generation < 0) fail("invalid_scope");
  return {
    threadId: scope.threadId, attemptId: scope.attemptId,
    browserContextId: scope.browserContextId, generation: scope.generation,
  };
}

export class ControlAuthority {
  #dataDir: string;
  #now: () => number;
  #rootTag: string | undefined;
  #sessions = new Map<string, Session>();
  constructor(dataDir: string, options?: { now?: () => number }) {
    this.#dataDir = resolve(dataDir);
    this.#now = options?.now ?? Date.now;
  }
  #time(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) fail("storage_unavailable");
    return now;
  }
  async #root(): Promise<Root> {
    try {
      const root = await readRoot(this.#dataDir);
      if (!root) fail("root_unavailable");
      if (this.#rootTag !== root.tag) this.#sessions.clear();
      this.#rootTag = root.tag;
      return root;
    } catch (error) { this.#sessions.clear(); this.#rootTag = undefined; throw error; }
  }
  #issue(session: Session): ControlGrant {
    const now = this.#time();
    if (now < session.createdAt || now >= session.hardDeadline) fail("expired");
    for (const [id, existing] of this.#sessions) if (existing.expiresAt <= now) this.#sessions.delete(id);
    const capability = randomBytes(32).toString("base64url");
    const expiresAt = Math.min(now + TOKEN_LIFETIME, session.hardDeadline);
    this.#sessions.set(digest(capability).toString("hex"), { ...session, expiresAt });
    return { capability, expiresAt };
  }
  #deadline(deadline: number | undefined, ceiling: number): number {
    if (deadline === undefined) return ceiling;
    if (!Number.isSafeInteger(deadline) || deadline <= this.#time()) fail("invalid_deadline");
    return Math.min(deadline, ceiling);
  }
  /** The optional observer is worker-owned and synchronous; it is not part of any RPC input. */
  async authenticate(key: string, scope: ControlScope, deadline?: number, onGrant?: (grant: ControlGrant) => void): Promise<ControlGrant> {
    const target = scopeValue(scope);
    this.#deadline(deadline, Number.MAX_SAFE_INTEGER);
    if (inFlight.has(this.#dataDir)) fail("auth_busy");
    inFlight.add(this.#dataDir);
    try {
      return await safe(async () => {
        const root = await this.#root();
        await reserveGuess(this.#dataDir, this.#time());
        if (!timingSafeEqual(digest(keyBytes(key)), Buffer.from(root.verifier, "hex"))) fail("invalid_key");
        if ((await this.#root()).tag !== root.tag) fail("root_unavailable");
        const now = this.#time();
        let createdAt = now, ceiling = now + HARD_LIFETIME;
        for (const [id, prior] of this.#sessions) if (JSON.stringify(prior.scope) === JSON.stringify(target)) {
          createdAt = Math.min(createdAt, prior.createdAt); ceiling = Math.min(ceiling, prior.hardDeadline);
          this.#sessions.delete(id);
        }
        const grant = this.#issue({ scope: target, rootTag: root.tag, createdAt, expiresAt: now, hardDeadline: this.#deadline(deadline, ceiling) });
        try { onGrant?.(grant); }
        catch (error) { this.#sessions.delete(digest(grant.capability).toString("hex")); throw error; }
        return grant;
      });
    } finally { inFlight.delete(this.#dataDir); }
  }
  async #check(capability: string, scope: ControlScope): Promise<{ id: string; session: Session }> {
    const target = scopeValue(scope);
    if (typeof capability !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(capability)) fail("invalid_capability");
    const root = await this.#root();
    const id = digest(capability).toString("hex");
    const session = this.#sessions.get(id);
    if (!session || session.rootTag !== root.tag || JSON.stringify(session.scope) !== JSON.stringify(target)) fail("invalid_capability");
    const now = this.#time();
    if (now >= session.expiresAt || now < session.createdAt) { this.#sessions.delete(id); fail("expired"); }
    return { id, session };
  }
  async authorize(capability: string, scope: ControlScope): Promise<number> {
    return safe(async () => {
      const { id, session } = await this.#check(capability, scope);
      if (this.#sessions.get(id) !== session) fail("invalid_capability");
      return session.expiresAt;
    });
  }
  /** Worker-only generation binding, never a credential or public authorization flag. */
  async generation(): Promise<string> {
    return safe(async () => digest((await this.#root()).tag).toString("hex"));
  }
  async renew(capability: string, scope: ControlScope, deadline?: number): Promise<ControlGrant> {
    return safe(async () => {
      const { id, session } = await this.#check(capability, scope);
      if (this.#sessions.get(id) !== session) fail("invalid_capability");
      const hardDeadline = this.#deadline(deadline, session.hardDeadline);
      this.#sessions.delete(id);
      return this.#issue({ ...session, hardDeadline });
    });
  }
  async revoke(capability: string, scope: ControlScope): Promise<void> {
    await safe(async () => {
      const { id, session } = await this.#check(capability, scope);
      if (this.#sessions.get(id) !== session) fail("invalid_capability");
      this.#sessions.delete(id);
    });
  }
}
