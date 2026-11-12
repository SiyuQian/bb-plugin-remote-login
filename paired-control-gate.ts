import { browserControlModeSchema, type BrowserControlMode } from "./browser-control.ts";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { ControlAuthority, ControlScope } from "./control-authority.ts";

const lifetime = 86_400_000;
const pin = "private-fixture/Chrome-157.0.8103.51/v1";
// An old, otherwise valid receipt may be replaced only by a fresh protected producer.
const readablePin = z.enum([pin, "private-fixture/Chrome-157.0.8103.50/v1"]);
const receiptSchema = z.object({ version: z.literal(1), generation: z.string().regex(/^[a-f0-9]{64}$/),
  pin: readablePin, controlMode: browserControlModeSchema.optional(), nonce: z.string().uuid(), acceptedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
}).strict().refine((v) => v.expiresAt - v.acceptedAt === lifetime);
export class PairedControlGateError extends Error {
  readonly code = "phone_control_required";
  constructor() { super("Paired control acceptance unavailable."); this.name = "PairedControlGateError"; }
}
const fail = (): never => { throw new PairedControlGateError(); };
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
function privateStat(stat: Stats, directory: boolean) {
  if (typeof process.getuid !== "function" || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600)
    || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || stat.size > 4096)) fail();
}

/** Key-possession/control-path acceptance, never device attestation or account identity. */
export class PairedControlGate {
  #path: string;
  #dataDir: string;
  #authority: ControlAuthority;
  #now: () => number;
  constructor(dataDir: string, authority: ControlAuthority, now = Date.now) {
    this.#dataDir = resolve(dataDir); this.#path = join(this.#dataDir, "paired-control-acceptance.json");
    this.#authority = authority; this.#now = now;
  }
  async #directory(): Promise<Stats> {
    if (!constants.O_NOFOLLOW || await fs.realpath(this.#dataDir) !== this.#dataDir) fail();
    const stat = await fs.lstat(this.#dataDir); privateStat(stat, true); return stat;
  }
  async #read(): Promise<z.infer<typeof receiptSchema> | null> {
    await this.#directory();
    let handle;
    try { handle = await fs.open(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const before = await handle.stat(); privateStat(before, false);
      const bytes = Buffer.alloc(4097); let size = 0;
      while (size < bytes.length) { const read = await handle.read(bytes, size, bytes.length - size, size); if (!read.bytesRead) break; size += read.bytesRead; }
      if (size > 4096) fail();
      const after = await handle.stat(), current = await fs.lstat(this.#path); privateStat(after, false); privateStat(current, false);
      if (!same(before, after) || !same(before, current) || before.size !== size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail();
      return receiptSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))));
    } finally { await handle.close(); }
  }
  async accepted(controlMode: BrowserControlMode = "remote"): Promise<boolean> {
    try {
      const generation = await this.#authority.generation(), receipt = await this.#read(), now = this.#now();
      return Boolean(browserControlModeSchema.safeParse(controlMode).success && receipt && receipt.pin === pin && (receipt.controlMode ?? "remote") === controlMode && Number.isSafeInteger(now) && now >= receipt.acceptedAt && now < receipt.expiresAt
        && receipt.generation === generation && generation === await this.#authority.generation());
    } catch { return false; }
  }
  async require(controlMode: BrowserControlMode = "remote"): Promise<void> { if (!await this.accepted(controlMode)) fail(); }
  /** Host-only producer: the callback must verify its owned fixture and confirm that exact browser's closure. */
  async acceptClosedFixture(capability: string, scope: ControlScope, signal: AbortSignal, verifyAndClose: () => Promise<boolean>, controlMode: BrowserControlMode = "remote"): Promise<boolean> {
    let temporary: string | undefined;
    let created: Stats | undefined, committed = false;
    try {
      if (!browserControlModeSchema.safeParse(controlMode).success) fail();
      signal.throwIfAborted(); await this.#authority.authorize(capability, scope);
      const generation = await this.#authority.generation();
      const verified = await verifyAndClose();
      signal.throwIfAborted(); if (!verified) return false;
      await this.#authority.authorize(capability, scope);
      if (generation !== await this.#authority.generation()) fail();
      const directory = await this.#directory(); await this.#read();
      const now = this.#now(); if (!Number.isSafeInteger(now) || now < 0) fail();
      const receipt = receiptSchema.parse({ version: 1, generation, pin, controlMode, nonce: randomUUID(), acceptedAt: now, expiresAt: now + lifetime });
      temporary = join(this.#dataDir, `.paired-control-${randomUUID()}.tmp`);
      const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { privateStat(await handle.stat(), false); await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); created = await handle.stat(); }
      finally { await handle.close(); }
      signal.throwIfAborted(); await this.#authority.authorize(capability, scope);
      if (generation !== await this.#authority.generation() || !same(directory, await this.#directory())) fail();
      await this.#read();
      await fs.rename(temporary, this.#path); temporary = undefined; committed = true;
      signal.throwIfAborted();
      await this.#authority.authorize(capability, scope);
      if (generation !== await this.#authority.generation() || !same(directory, await this.#directory())) fail();
      signal.throwIfAborted();
      return true;
    } catch {
      if (committed && created) {
        try { const current = await fs.lstat(this.#path); privateStat(current, false); if (same(created, current)) await fs.unlink(this.#path); }
        catch { /* Never remove an unrecognized replacement receipt. */ }
      }
      return fail();
    }
    finally { if (temporary) await fs.unlink(temporary).catch(() => {}); }
  }
}
