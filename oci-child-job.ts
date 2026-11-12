import cp from "node:child_process";
import http from "node:http";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { inspectInstalledOciCompatibility } from "./oci-compatibility.ts";
import { assertOwnedLoopbackListener } from "./oci-port-ownership.ts";
import { OCI_CHILD_WRAPPER_SOURCE, OCI_CHILD_OUTCOMES, OCI_CHILD_EXIT_REASONS } from "./oci-wrapper-source.ts";
import { assertOwnedOciSession, type OwnedOciSession } from "./oci-owned-session.ts";
import { prepareRetainedOwnedOciWriter, observeOwnedOciWriter, abandonOwnedOciWriter, waitForOwnedOciWriterCleanup } from "./oci-writer-journal.ts";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const positive = z.number().int().positive().max(2_147_483_647);
const base = z.object({ version: z.literal(1), attemptId: uuid }).strict();
const event = z.discriminatedUnion("type", [
  base.extend({ type: z.literal("ready"), pid: positive, host: z.literal("127.0.0.1"), port: positive.max(65535) }).strict(),
  base.extend({ type: z.literal("browser"), url: z.string().max(8192) }).strict(),
  base.extend({ type: z.literal("exit"), outcome: z.enum(OCI_CHILD_OUTCOMES), reason: z.enum(OCI_CHILD_EXIT_REASONS) }).strict(),
]);
const optionsSchema = z.object({
  attemptId: uuid, callbackPort: z.enum(["fixed", "ephemeral"]), lifetimeMs: z.number().int().min(100).max(60000),
  signal: z.instanceof(AbortSignal), lifecycle: z.instanceof(AbortSignal),
  retainWorker: z.custom<() => () => void>((v) => typeof v === "function"),
  consumeBrowser: z.custom<(url: string, signal: AbortSignal) => Promise<void>>((v) => typeof v === "function"),
}).strict();
type Options = z.infer<typeof optionsSchema>;
type Outcome = { outcome: "fixture_complete" | "prekey_probe_complete" | "bootstrap_complete" | "cancelled" };
type Plan = { mode: "fixture" | "prekey_probe" | "authenticate"; config?: Record<string, string>; authorize?: () => Promise<void>; session?: OwnedOciSession };
type Code = "invalid_request" | "unsupported" | "aborted" | "spawn_failed" | "protocol" | "ownership" | "browser_refused" | "child_refused" | "child_exit" | "deadline" | "cleanup_uncertain";
export class OciChildError extends Error {
  constructor(readonly code: Code, readonly cleanupUncertain = false) { super("OCI child unavailable."); this.name = "OciChildError"; }
}
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
async function bounded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const stopped = new Promise<never>((_r, reject) => {
    abort = () => reject(new OciChildError("aborted"));
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
  });
  try { const value = await Promise.race([pending, stopped]); signal.throwIfAborted(); return value; }
  finally { signal.removeEventListener("abort", abort); }
}
async function waitAtMost(pending: Promise<void>, ms: number): Promise<boolean> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([pending.then(() => true), new Promise<false>((r) => { timer = setTimeout(() => r(false), ms); })]); }
  finally { clearTimeout(timer); }
}

export type OciFixtureChild = { result: Promise<Outcome>; completeFixture(): Promise<void>; cancel(): Promise<void> };

/** Internal account-free runner. No native tool or public RPC can launch this fixture or a real OCI command. */
export async function startOciFixtureChild(input: Options): Promise<OciFixtureChild> {
  const parsed = optionsSchema.safeParse(input);
  if (!parsed.success) throw new OciChildError("invalid_request");
  return startChild(parsed.data, { mode: "fixture" });
}

/** Calls the installed bootstrap but stops inside its server constructor, before key generation. */
export async function probeOciBootstrapBeforeKey(input: Omit<Options, "consumeBrowser">): Promise<{ outcome: "prekey_probe_complete" }> {
  const parsed = optionsSchema.omit({ consumeBrowser: true }).safeParse(input);
  if (!parsed.success) throw new OciChildError("invalid_request");
  const child = await startChild({ ...parsed.data, consumeBrowser: async () => { throw new OciChildError("protocol"); } }, { mode: "prekey_probe" });
  const result = await child.result;
  if (result.outcome !== "prekey_probe_complete") throw new OciChildError("child_refused");
  return { outcome: "prekey_probe_complete" };
}

type AuthenticationOptions = Omit<Options, "callbackPort"> & { session: OwnedOciSession; authorize(): Promise<void> };
/** Worker-only production implementation; no BB public/native entry can select or authorize this mode. */
export async function startOciAuthenticationChild(input: AuthenticationOptions): Promise<Pick<OciFixtureChild, "result" | "cancel">> {
  const parsed = optionsSchema.omit({ callbackPort: true }).extend({
    lifetimeMs: z.number().int().min(100).max(900000), session: z.custom<OwnedOciSession>((value) => typeof value === "object" && value !== null),
    authorize: z.custom<() => Promise<void>>((value) => typeof value === "function"),
  }).strict().safeParse(input);
  if (!parsed.success) throw new OciChildError("invalid_request");
  const { session, authorize, ...options } = parsed.data;
  const signal = AbortSignal.any([options.signal, options.lifecycle]);
  const check = async () => {
    const checkSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
    await bounded(Promise.resolve().then(authorize), checkSignal);
    await bounded(assertOwnedOciSession(session), checkSignal);
  };
  try {
    await check();
    if (session.expectedIdentity.region !== "ap-sydney-1" || session.expectedIdentity.realm !== "oc1"
      || session.paths.profileName !== `BB_REMOTE_${options.attemptId.replaceAll("-", "")}`) throw new OciChildError("unsupported");
    const child = await startChild({ ...options, callbackPort: "fixed" }, { mode: "authenticate", authorize: check, session,
      config: { sessionRoot: session.paths.root, profileName: session.paths.profileName, region: "ap-sydney-1" },
    });
    return { result: child.result, cancel: child.cancel };
  } catch (error) {
    if (error instanceof OciChildError) throw error;
    if ((error as { cleanupUncertain?: unknown } | null)?.cleanupUncertain === true) throw new OciChildError("cleanup_uncertain", true);
    throw new OciChildError("invalid_request");
  }
}

/** Shape and fixed destination only; this does not establish process ownership or account identity. */
export function isPinnedOciAuthorizationUrl(value: string): boolean {
  try {
    const url = new URL(value), keys = ["action", "client_id", "response_type", "scope", "redirect_uri", "nonce", "public_key"];
    if (url.origin !== "https://login.ap-sydney-1.oraclecloud.com" || url.pathname !== "/v1/oauth2/authorize"
      || url.username || url.password || url.hash || [...url.searchParams.keys()].length !== keys.length
      || keys.some((key) => url.searchParams.getAll(key).length !== 1)
      || url.searchParams.get("action") !== "login" || url.searchParams.get("client_id") !== "iaas_console"
      || url.searchParams.get("response_type") !== "token id_token" || url.searchParams.get("scope") !== "openid"
      || url.searchParams.get("redirect_uri") !== "http://localhost:8181" || !uuid.safeParse(url.searchParams.get("nonce")).success) return false;
    const encoded = url.searchParams.get("public_key")!;
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded) || encoded.length > 2048) return false;
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded.replace(/=+$/, "")) return false;
    const key = z.object({ kty: z.literal("RSA"), n: z.string().max(344).regex(/^[A-Za-z0-9_-]+={0,2}$/), e: z.literal("AQAB"), kid: z.literal("Ignored") }).strict().parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const modulus = Buffer.from(key.n, "base64url");
    return modulus.length === 256 && (modulus[0]! & 128) !== 0 && modulus.toString("base64url") === key.n.replace(/=+$/, "");
  } catch { return false; }
}

async function startChild(options: Options, plan: Plan): Promise<OciFixtureChild> {
  const external = AbortSignal.any([options.signal, options.lifecycle]);
  if (external.aborted) throw new OciChildError("aborted");
  if (plan.authorize) await bounded(plan.authorize(), external);
  const compatibility = await bounded(inspectInstalledOciCompatibility(), external).catch(() => { throw new OciChildError("unsupported"); });
  if (compatibility.sourceCompatibility !== "matched") throw new OciChildError("unsupported");
  let release: () => void;
  try { release = options.retainWorker(); if (typeof release !== "function") throw new Error(); }
  catch { throw new OciChildError("invalid_request"); }
  const journal = plan.session ? await prepareRetainedOwnedOciWriter(plan.session, "authentication", external, release) : undefined;
  if (external.aborted) {
    if (journal) { try { await waitForOwnedOciWriterCleanup(abandonOwnedOciWriter(journal).then(release)); } catch { throw new OciChildError("cleanup_uncertain", true); } }
    else { try { release(); } catch { throw new OciChildError("cleanup_uncertain", true); } }
    throw new OciChildError("aborted");
  }
  let child: cp.ChildProcess;
  try {
    child = cp.spawn("/opt/homebrew/Cellar/oci-cli/3.88.0/libexec/bin/python", ["-I", "-S", "-c", OCI_CHILD_WRAPPER_SOURCE], {
      shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    });
  } catch {
    if (journal) {
      try { await waitForOwnedOciWriterCleanup(abandonOwnedOciWriter(journal).then(release)); }
      catch { throw new OciChildError("cleanup_uncertain", true); }
    } else { try { release(); } catch { throw new OciChildError("cleanup_uncertain", true); } }
    throw new OciChildError("spawn_failed");
  }
  const journaled = journal ? observeOwnedOciWriter(journal, child) : undefined;
  const commands = child.stdio[3] as Writable;
  const messages = child.stdio[4] as Readable;
  const ready = deferred<void>(), closed = deferred<void>(), result = deferred<Outcome>();
  const workAbort = new AbortController();
  const deadline = new AbortController();
  const work = AbortSignal.any([external, workAbort.signal, deadline.signal]);
  let phase: "boot" | "bound" | "browser" | "exit" = "boot";
  let callbackPort = 0, consumed = false, isClosed = false, stopping = false, released = false;
  let failure: OciChildError | undefined;
  let exit: z.infer<typeof event> & { type: "exit" } | undefined;
  let queue: Promise<void> = Promise.resolve();
  let remainder = Buffer.alloc(0);
  let eventCount = 0, eventBytes = 0;
  let cleanup: Promise<void> | undefined;
  const releaseOnce = () => {
    if (!released) {
      released = true;
      try { release(); } catch { failure = new OciChildError("cleanup_uncertain", true); }
    }
  };
  const send = (value: unknown): Promise<void> => new Promise((resolve, reject) => {
    if (!commands?.writable || isClosed) { reject(new OciChildError("protocol")); return; }
    commands.write(`${JSON.stringify(value)}\n`, (error) => error ? reject(new OciChildError("protocol")) : resolve());
  });
  const stop = (): Promise<void> => {
    if (cleanup) return cleanup;
    stopping = true; workAbort.abort();
    cleanup = (async () => {
      if (isClosed) { if (journaled) await waitForOwnedOciWriterCleanup(journaled.closed); return; }
      void send({ version: 1, attemptId: options.attemptId, type: "cancel" }).catch(() => {});
      if (await waitAtMost(closed.promise, 250)) { if (journaled) await waitForOwnedOciWriterCleanup(journaled.closed); return; }
      child.kill("SIGTERM");
      if (await waitAtMost(closed.promise, 500)) { if (journaled) await waitForOwnedOciWriterCleanup(journaled.closed); return; }
      child.kill("SIGKILL");
      if (!await waitAtMost(closed.promise, 1000)) throw new OciChildError("cleanup_uncertain", true);
      if (journaled) await waitForOwnedOciWriterCleanup(journaled.closed);
    })().then(() => { if (failure?.cleanupUncertain) throw failure; });
    void cleanup.catch(() => {}); return cleanup;
  };
  const fail = (code: Code) => {
    if (!failure) failure = new OciChildError(code);
    ready.reject(failure); void stop().catch((error) => { result.reject(error); });
  };
  const onAbort = () => {
    ready.reject(new OciChildError("aborted"));
    void stop().catch((error) => result.reject(error));
  };
  external.addEventListener("abort", onAbort, { once: true });
  const lifetimeTimer = setTimeout(() => { deadline.abort(); fail("deadline"); }, options.lifetimeMs + 1000);
  const startupTimer = setTimeout(() => fail("deadline"), Math.min(8000, options.lifetimeMs + 1000));
  const handle = async (value: unknown): Promise<void> => {
    const parsedEvent = event.safeParse(value);
    if (!parsedEvent.success || parsedEvent.data.attemptId !== options.attemptId) throw new OciChildError("protocol");
    const message = parsedEvent.data;
    if (message.type === "exit") {
      if (exit || (message.outcome === "fixture_complete" && (!consumed || phase !== "browser" || message.reason !== "fixture_complete"))
        || (message.outcome === "bootstrap_complete" && (plan.mode !== "authenticate" || !consumed || phase !== "browser" || message.reason !== "bootstrap_complete"))
        || (message.outcome === "prekey_probe_complete" && (plan.mode !== "prekey_probe" || phase !== "bound" || message.reason !== "prekey_probe_complete"))
        || (message.outcome === "fixture_complete" && plan.mode !== "fixture")
        || (message.outcome === "cancelled" && message.reason !== "cancelled")) throw new OciChildError("protocol");
      exit = message; phase = "exit";
      if (message.outcome === "refused") fail(message.reason === "deadline" ? "deadline" : "child_refused");
      return;
    }
    if (isClosed || stopping || work.aborted) throw new OciChildError("aborted");
    if (message.type === "ready") {
      if (phase !== "boot" || message.pid !== child.pid || (options.callbackPort === "fixed" && message.port !== 8181)) throw new OciChildError("protocol");
      try { await bounded(assertOwnedLoopbackListener(message.pid, message.port, work), work); }
      catch { throw new OciChildError("ownership"); }
      callbackPort = message.port;
      if (plan.authorize) await bounded(plan.authorize(), work);
      await bounded(send({ version: 1, attemptId: options.attemptId, type: "accept_binding" }), work);
      phase = "bound"; return;
    }
    const expectedUrl = new URL("https://login.fixture.invalid/v1/oauth2/authorize");
    expectedUrl.search = new URLSearchParams({ nonce: options.attemptId, redirect_uri: "http://localhost:8181" }).toString();
    const acceptedUrl = plan.mode === "fixture" ? message.url === expectedUrl.href : plan.mode === "authenticate" && isPinnedOciAuthorizationUrl(message.url);
    if (phase !== "bound" || !acceptedUrl || !child.pid) throw new OciChildError("protocol");
    try { await bounded(assertOwnedLoopbackListener(child.pid, callbackPort, work), work); }
    catch { throw new OciChildError("ownership"); }
    phase = "browser";
    if (plan.authorize) await bounded(plan.authorize(), work);
    try { await bounded(Promise.resolve().then(() => options.consumeBrowser(message.url, work)), work); }
    catch { throw new OciChildError("browser_refused"); }
    work.throwIfAborted(); if (isClosed || stopping) throw new OciChildError("aborted");
    consumed = true; clearTimeout(startupTimer); ready.resolve();
  };
  messages.on("data", (chunk: Buffer) => {
    if (failure) return;
    eventBytes += chunk.length;
    if (eventBytes > 49152) { fail("protocol"); return; }
    remainder = Buffer.concat([remainder, chunk]);
    for (;;) {
      const end = remainder.indexOf(10);
      if (end < 0) break;
      const bytes = remainder.subarray(0, end); remainder = remainder.subarray(end + 1);
      eventCount++;
      if (!bytes.length || bytes.length > 16384 || eventCount > 3) { fail("protocol"); return; }
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { fail("protocol"); return; }
      queue = queue.then(() => handle(value)).catch((error) => { fail(error instanceof OciChildError ? error.code : "protocol"); });
    }
    if (remainder.length > 16384) fail("protocol");
  });
  messages.on("error", () => fail("protocol"));
  commands.on("error", () => fail("protocol"));
  child.once("error", () => fail("spawn_failed"));
  child.once("close", (code) => {
    isClosed = true; workAbort.abort(); closed.resolve(); if (!journaled) releaseOnce();
    if (journaled) void journaled.closed.then(releaseOnce, () => {});
    clearTimeout(startupTimer); clearTimeout(lifetimeTimer); external.removeEventListener("abort", onAbort);
    void (journaled ? waitForOwnedOciWriterCleanup(journaled.closed) : Promise.resolve()).then(() => queue).then(() => {
      if (remainder.length) failure ??= new OciChildError("protocol");
      if (failure) { ready.reject(failure); result.reject(failure); }
      else if (stopping) { ready.reject(new OciChildError("aborted")); result.resolve({ outcome: "cancelled" }); }
      else if (code === 0 && exit?.outcome === "prekey_probe_complete" && plan.mode === "prekey_probe") {
        result.resolve({ outcome: "prekey_probe_complete" }); ready.resolve();
      }
      else if (code === 0 && consumed && (exit?.outcome === "fixture_complete" || exit?.outcome === "bootstrap_complete")) result.resolve({ outcome: exit.outcome });
      else { const error = new OciChildError("child_exit"); ready.reject(error); result.reject(error); }
    }, () => { const error = new OciChildError("cleanup_uncertain", true); failure = error; ready.reject(error); result.reject(error); });
  });
  if (external.aborted) onAbort();
  try {
    if (journaled) await bounded(journaled.attached, work);
    await bounded(send({ version: 1, attemptId: options.attemptId, mode: plan.mode, callbackPort: options.callbackPort, lifetimeMs: options.lifetimeMs, ...plan.config }), work);
    await ready.promise;
    if (failure || stopping || (isClosed && plan.mode !== "prekey_probe") || external.aborted) throw failure ?? new OciChildError("aborted");
  } catch (error) {
    await stop(); throw failure ?? (error instanceof OciChildError ? error : new OciChildError("child_exit"));
  }
  return {
    result: result.promise,
    cancel: stop,
    completeFixture: async () => {
      if (isClosed || stopping) { await result.promise; return; }
      try {
        await bounded(new Promise<void>((resolve, reject) => {
          const request = http.get({ hostname: "127.0.0.1", port: callbackPort, path: "/fixture-complete", agent: false, timeout: 1500 }, (response) => {
            response.resume(); response.once("end", () => response.statusCode === 200 ? resolve() : reject(new OciChildError("child_refused")));
          });
          request.once("timeout", () => request.destroy(new Error())); request.once("error", () => reject(new OciChildError("child_exit")));
        }), AbortSignal.any([external, deadline.signal]));
        await result.promise;
      } catch (error) { await stop(); throw failure ?? (error instanceof OciChildError ? error : new OciChildError("child_exit")); }
    },
  };
}
