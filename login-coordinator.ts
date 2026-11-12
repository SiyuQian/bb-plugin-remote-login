import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { LoginProtocolError, loginAttemptSchema, reduceAttempt, type AttemptEvent, type AttemptIdentity, type LoginAttempt } from "./login-protocol.ts";

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const requestSchema = z.object({
  projectId: id, threadId: id, environmentId: id, hostId: id, principalId: id.nullable(),
  mode: z.enum(["synthetic", "oci_cli", "oci_web"]),
}).strict();
type Storage = Pick<BbPluginApi["storage"], "database" | "migrate">;
type Row = { attempt_id: string; project_id: string; thread_id: string; mode: string; phase: string; revision: number; active: number; expires_at: number; owner_epoch: string; record: string };
type Outcome<T> = { value: T } | { error: Error };
type CoordinatorCode = "invalid_request" | "not_found" | "coordinator_inactive" | "coordinator_replaced" | "storage_invalid" | "storage_unavailable" | "binding_changed" | "resume_uncertain";
export class LoginCoordinatorError extends Error {
  constructor(readonly code: CoordinatorCode) { super("Login coordinator refused."); this.name = "LoginCoordinatorError"; }
}
function fail(code: CoordinatorCode): never { throw new LoginCoordinatorError(code); }
function safe<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof LoginCoordinatorError || error instanceof LoginProtocolError) throw error;
    fail("storage_unavailable");
  }
}
export function attemptIdentity(a: LoginAttempt): AttemptIdentity {
  return { attemptId: a.attemptId, projectId: a.projectId, threadId: a.threadId, environmentId: a.environmentId,
    hostId: a.hostId, browserContextId: a.browserContextId, generation: a.generation, principalId: a.principalId };
}
function command(a: LoginAttempt, type: "expire" | "worker_lost"): AttemptEvent {
  return { type, expected: attemptIdentity(a), expectedRevision: a.revision };
}
function active(a: LoginAttempt): number {
  return ["cancelled", "expired", "failed", "unsupported"].includes(a.phase) || a.resume.state === "delivered" ? 0 : 1;
}
function resourcePhase(a: LoginAttempt): boolean { return ["checking_existing", "starting", "user_control", "verifying", "verified"].includes(a.phase); }

// Append only: SDK migration hashes are immutable once shipped.
const migrations = [
  "CREATE TABLE remote_login_owner_v1 (id INTEGER PRIMARY KEY CHECK (id = 1), epoch TEXT NOT NULL)",
  "CREATE TABLE remote_login_attempts_v1 (attempt_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT NOT NULL, mode TEXT NOT NULL, phase TEXT NOT NULL, revision INTEGER NOT NULL, active INTEGER NOT NULL, expires_at INTEGER NOT NULL, owner_epoch TEXT NOT NULL, record TEXT NOT NULL)",
  "CREATE UNIQUE INDEX remote_login_active_v1 ON remote_login_attempts_v1(project_id, thread_id, mode) WHERE active = 1",
  "CREATE TABLE remote_login_cleanup_v1 (attempt_id TEXT PRIMARY KEY REFERENCES remote_login_attempts_v1(attempt_id), status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged')))",
  "CREATE INDEX remote_login_expiry_v1 ON remote_login_attempts_v1(active,expires_at)",
];

/** Durable non-secret state. All event producers are internal trusted code, never a form payload. */
export class LoginCoordinator {
  #db!: ReturnType<Storage["database"]>;
  #storage: Storage;
  #activated = false;
  #epoch: string = randomUUID();
  #now: () => number;
  #ttl: number;
  constructor(storage: Storage, options?: { now?: () => number; ttlMs?: number }) {
    this.#storage = storage;
    this.#now = options?.now ?? Date.now;
    this.#ttl = options?.ttlMs ?? 900_000;
    if (!Number.isSafeInteger(this.#ttl) || this.#ttl < 1000 || this.#ttl > 900_000) fail("invalid_request");
  }
  /** Call only from a committed handler/service, never a candidate plugin factory. */
  activate(): void {
    if (this.#activated) { safe(() => this.#guard()); return; }
    this.#db = safe(() => this.#storage.database());
    safe(() => {
      this.#storage.migrate(this.#db, migrations);
      this.#db.transaction(() => {
        const rows = this.#db.prepare("SELECT * FROM remote_login_attempts_v1").all() as Row[];
        const now = this.#time();
        this.#db.prepare("INSERT INTO remote_login_owner_v1(id,epoch) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch").run(this.#epoch);
        for (const row of rows) {
          const before = this.#decode(row, false);
          let after = before;
          if (active(before)) {
            if (now >= before.expiresAt) after = reduceAttempt(before, command(before, "expire"), now);
            else if (resourcePhase(before)) after = reduceAttempt(before, command(before, "worker_lost"), now);
          }
          this.#write(before, after, row.owner_epoch);
        }
      }).immediate();
    });
    this.#activated = true;
  }
  #time(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) fail("storage_unavailable");
    return now;
  }
  #guard(): void {
    if (!this.#activated) fail("coordinator_inactive");
    const row = this.#db.prepare("SELECT epoch FROM remote_login_owner_v1 WHERE id=1").get() as { epoch: unknown } | undefined;
    if (row?.epoch !== this.#epoch) fail("coordinator_replaced");
  }
  #run<T>(operation: () => Outcome<T>): T {
    return safe(() => {
      const result = this.#db.transaction(() => { this.#guard(); return operation(); }).immediate();
      if ("error" in result) throw result.error;
      return result.value;
    });
  }
  #decode(row: Row, owner = true): LoginAttempt {
    if (typeof row.record !== "string" || (owner && row.owner_epoch !== this.#epoch)) fail("storage_invalid");
    let value: unknown;
    try { value = JSON.parse(row.record); } catch { fail("storage_invalid"); }
    const parsed = loginAttemptSchema.safeParse(value);
    if (!parsed.success) fail("storage_invalid");
    const a = parsed.data;
    if (a.attemptId !== row.attempt_id || a.projectId !== row.project_id || a.threadId !== row.thread_id
      || a.mode !== row.mode || a.phase !== row.phase || a.revision !== row.revision || active(a) !== row.active || a.expiresAt !== row.expires_at) fail("storage_invalid");
    return a;
  }
  #read(attemptId: string): LoginAttempt | null {
    if (!id.safeParse(attemptId).success) fail("invalid_request");
    const row = this.#db.prepare("SELECT * FROM remote_login_attempts_v1 WHERE attempt_id=?").get(attemptId) as Row | undefined;
    return row ? this.#decode(row) : null;
  }
  #write(before: LoginAttempt, after: LoginAttempt, priorOwner = this.#epoch): void {
    const result = this.#db.prepare("UPDATE remote_login_attempts_v1 SET phase=?,revision=?,active=?,owner_epoch=?,record=? WHERE attempt_id=? AND revision=? AND owner_epoch=?")
      .run(after.phase, after.revision, active(after), this.#epoch, JSON.stringify(after), before.attemptId, before.revision, priorOwner);
    if (result.changes !== 1) throw new LoginProtocolError("stale_revision");
    if (resourcePhase(before) && ["cancelled", "expired", "failed", "unsupported"].includes(after.phase)) this.#db.prepare("INSERT INTO remote_login_cleanup_v1(attempt_id,status) VALUES(?,'pending') ON CONFLICT(attempt_id) DO UPDATE SET status='pending'").run(after.attemptId);
  }
  #expire(a: LoginAttempt, now: number): LoginAttempt {
    if (!active(a) || now < a.expiresAt) return a;
    const next = reduceAttempt(a, command(a, "expire"), now);
    this.#write(a, next);
    return next;
  }
  request(input: z.infer<typeof requestSchema>): LoginAttempt {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) fail("invalid_request");
    const target = parsed.data;
    return this.#run<LoginAttempt>(() => {
      const now = this.#time();
      const row = this.#db.prepare("SELECT * FROM remote_login_attempts_v1 WHERE project_id=? AND thread_id=? AND mode=? AND active=1").get(target.projectId, target.threadId, target.mode) as Row | undefined;
      const prior = row ? this.#expire(this.#decode(row), now) : null;
      if (prior && active(prior)) {
        if (prior.hostId !== target.hostId || prior.environmentId !== target.environmentId
          || (prior.principalId !== null && prior.principalId !== target.principalId)) {
          const next = reduceAttempt(prior, { type: "reject", code: "host_changed", expected: attemptIdentity(prior), expectedRevision: prior.revision }, now);
          this.#write(prior, next);
          return { error: new LoginCoordinatorError("binding_changed") };
        }
        if (prior.principalId === null && target.principalId !== null) {
          const next = reduceAttempt(prior, { type: "paired", principalId: target.principalId, expected: attemptIdentity(prior), expectedRevision: prior.revision }, now);
          this.#write(prior, next);
          return { value: next };
        }
        return { value: prior };
      }
      const candidate = loginAttemptSchema.safeParse({
        version: 1, ...target, attemptId: randomUUID(), browserContextId: randomUUID(), generation: 1,
        phase: target.principalId === null ? "awaiting_pairing" : "awaiting_control", revision: 0,
        createdAt: now, updatedAt: now, expiresAt: now + this.#ttl, verification: null,
        resume: { state: "none", deliveryId: null }, failure: null,
      });
      if (!candidate.success) fail("invalid_request");
      const a = candidate.data;
      this.#db.prepare("INSERT INTO remote_login_attempts_v1(attempt_id,project_id,thread_id,mode,phase,revision,active,expires_at,owner_epoch,record) VALUES(?,?,?,?,?,?,1,?,?,?)")
        .run(a.attemptId, a.projectId, a.threadId, a.mode, a.phase, a.revision, a.expiresAt, this.#epoch, JSON.stringify(a));
      return { value: a };
    });
  }
  get(attemptId: string): LoginAttempt | null {
    return this.#run(() => { const a = this.#read(attemptId); return { value: a ? this.#expire(a, this.#time()) : null }; });
  }
  /** Remaining active lifetime from the same fenced clock used for protocol transitions. */
  remainingMs(attemptId: string): number {
    return this.#run(() => {
      const a = this.#read(attemptId);
      if (!a) fail("not_found");
      const now = this.#time();
      const current = this.#expire(a, now);
      return { value: active(current) ? current.expiresAt - now : 0 };
    });
  }
  list(projectId: string, threadId: string): LoginAttempt[] {
    if (!id.safeParse(projectId).success || !id.safeParse(threadId).success) fail("invalid_request");
    return this.#run(() => {
      const rows = this.#db.prepare("SELECT * FROM remote_login_attempts_v1 WHERE project_id=? AND thread_id=? ORDER BY rowid DESC LIMIT 50").all(projectId, threadId) as Row[];
      const now = this.#time();
      return { value: rows.map((row) => this.#expire(this.#decode(row), now)) };
    });
  }
  apply(attemptId: string, event: AttemptEvent): LoginAttempt {
    return this.#run<LoginAttempt>(() => {
      const a = this.#read(attemptId);
      if (!a) fail("not_found");
      const now = this.#time();
      let next: LoginAttempt;
      try {
        next = reduceAttempt(a, event, now);
      } catch (error) {
        if (error instanceof LoginProtocolError && error.code === "deadline_expired" && active(a)) this.#expire(a, now);
        return { error: error instanceof Error ? error : new LoginCoordinatorError("storage_unavailable") };
      }
      if (next.revision !== a.revision) this.#write(a, next);
      return { value: next };
    });
  }
  prepareResume(attemptId: string, expected: AttemptIdentity, expectedRevision: number): LoginAttempt {
    return this.#run<LoginAttempt>(() => {
      const a = this.#read(attemptId);
      if (!a) fail("not_found");
      const now = this.#time();
      let uncertain: LoginAttempt;
      try {
        const claimed = reduceAttempt(a, { type: "resume_claim", deliveryId: randomUUID(), expected, expectedRevision }, now);
        uncertain = reduceAttempt(claimed, { type: "resume_uncertain", expected: attemptIdentity(claimed), expectedRevision: claimed.revision }, now);
      } catch (error) {
        if (error instanceof LoginProtocolError && error.code === "deadline_expired" && active(a)) this.#expire(a, now);
        if (error instanceof LoginProtocolError && error.code === "invalid_transition" && ["claimed", "uncertain", "delivered"].includes(a.resume.state)) return { error: new LoginCoordinatorError("resume_uncertain") };
        return { error: error instanceof Error ? error : new LoginCoordinatorError("storage_unavailable") };
      }
      this.#write(a, uncertain);
      return { value: uncertain };
    });
  }
  pendingCleanup(afterId = ""): Array<{ attemptId: string; hostId: string; scope: { threadId: string; attemptId: string; browserContextId: string; generation: number } }> {
    if (afterId !== "" && !id.safeParse(afterId).success) fail("invalid_request");
    return this.#run(() => {
      const rows = this.#db.prepare("SELECT a.* FROM remote_login_attempts_v1 a JOIN remote_login_cleanup_v1 c ON a.attempt_id=c.attempt_id WHERE c.status='pending' AND a.attempt_id>? ORDER BY a.attempt_id LIMIT 100").all(afterId) as Row[];
      return { value: rows.map((row) => { const a = this.#decode(row); return { attemptId: a.attemptId, hostId: a.hostId,
        scope: { threadId: a.threadId, attemptId: a.attemptId, browserContextId: a.browserContextId, generation: a.generation } }; }) };
    });
  }
  acknowledgeCleanup(attemptId: string): void {
    this.#run(() => {
      if (!this.#read(attemptId)) fail("not_found");
      this.#db.prepare("UPDATE remote_login_cleanup_v1 SET status='acknowledged' WHERE attempt_id=? AND status='pending'").run(attemptId);
      return { value: undefined };
    });
  }
  expireDue(): number {
    return this.#run(() => {
      const now = this.#time();
      const rows = this.#db.prepare("SELECT * FROM remote_login_attempts_v1 WHERE active=1 AND expires_at<=? ORDER BY expires_at LIMIT 100").all(now) as Row[];
      for (const row of rows) this.#expire(this.#decode(row), now);
      return { value: rows.length };
    });
  }
}
