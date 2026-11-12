import cp from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { captureOwnedOciSnapshot, recheckOwnedOciSnapshot, disposeOwnedOciSnapshot, type OwnedOciSession, type OwnedOciSnapshot } from "./oci-owned-session.ts";
import { OCI_TASK_SOURCE } from "./oci-task-source.ts";
import { prepareOwnedOciWriter, observeOwnedOciWriter, abandonOwnedOciWriter, waitForOwnedOciWriterCleanup } from "./oci-writer-journal.ts";

const compartment = z.string().max(512).regex(/^ocid1\.(compartment|tenancy)\.oc1\.\.[a-z0-9]+$/);
export const ociTaskRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list_compartments") }).strict(),
  z.object({ operation: z.literal("list_instances"), compartmentOcid: compartment }).strict(),
]);
export type OciTaskRequest = z.infer<typeof ociTaskRequestSchema>;
export const ociTaskResultSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list_compartments"), truncated: z.boolean(), rows: z.array(z.object({
    ocid: z.string().max(512).regex(/^ocid1\.compartment\.oc1\.\.[a-z0-9]+$/), name: z.string().max(128),
  }).strict()).max(25) }).strict(),
  z.object({ operation: z.literal("list_instances"), truncated: z.boolean(), rows: z.array(z.object({
    id: z.string().max(512).regex(/^ocid1\.instance\.oc1\.ap-sydney-1\.[a-z0-9]+$/), displayName: z.string().max(128),
    lifecycleState: z.string().max(32), shape: z.string().max(64), availabilityDomain: z.string().max(128),
  }).strict()).max(25) }).strict(),
]);
export type OciTaskResult = z.infer<typeof ociTaskResultSchema>;
const inputSchema = z.object({
  attemptId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  session: z.custom<OwnedOciSession>((value) => typeof value === "object" && value !== null),
  signal: z.instanceof(AbortSignal), lifecycle: z.instanceof(AbortSignal), request: ociTaskRequestSchema,
  authorize: z.custom<() => Promise<void>>((value) => typeof value === "function"),
  retainWorker: z.custom<() => () => void>((value) => typeof value === "function"),
}).strict();
type Options = z.infer<typeof inputSchema>;
const reasons = ["configuration", "unsupported_region", "key", "token", "rejected", "identity_mismatch", "response", "deadline", "cancelled", "sdk", "private_channel"] as const;
const responseSchema = z.object({ version: z.literal(1), type: z.literal("result"), attemptId: z.string(), ok: z.boolean(),
  reason: z.enum(["matched", ...reasons]), result: ociTaskResultSchema.nullable(),
}).strict().refine((value) => value.ok === (value.reason === "matched") && value.ok === (value.result !== null));
type Code = "unavailable" | "aborted" | "snapshot" | "protocol" | "cleanup_uncertain" | typeof reasons[number];
export class OciTaskError extends Error {
  constructor(readonly code: Code, readonly cleanupUncertain = false) { super("OCI read task unavailable."); this.name = "OciTaskError"; }
}
async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => { abort = () => reject(new OciTaskError("aborted")); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); });
  try { const value = await Promise.race([pending, stopped]); signal.throwIfAborted(); return value; }
  finally { signal.removeEventListener("abort", abort); }
}
async function waitForClose(closed: Promise<void>, ms: number): Promise<boolean> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([closed.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Worker-only task consumer. Public callers must use the owning thread's scoped account/compartment references. */
export async function runOwnedOciTask(input: Options): Promise<OciTaskResult> {
  let snapshot: OwnedOciSnapshot | undefined, external: AbortSignal | undefined;
  let abandoned = false, cleanupFailure: OciTaskError | undefined;
  try {
    const options = inputSchema.parse(input);
    external = AbortSignal.any([options.signal, options.lifecycle, AbortSignal.timeout(5500)]);
    const signal = external;
    signal.throwIfAborted();
    const authorize = () => raceAbort(Promise.resolve().then(options.authorize), signal);
    await authorize();
    await raceAbort(captureOwnedOciSnapshot(options.session).then((value) => {
      if (abandoned) disposeOwnedOciSnapshot(value); else snapshot = value;
    }), signal).catch(() => { throw new OciTaskError("snapshot"); });
    if (!snapshot || options.session.paths.profileName !== `BB_REMOTE_${options.attemptId.replaceAll("-", "")}`
      || options.session.expectedIdentity.region !== "ap-sydney-1" || options.session.expectedIdentity.realm !== "oc1") throw new OciTaskError("snapshot");
    if (options.request.operation === "list_instances" && options.request.compartmentOcid.startsWith("ocid1.tenancy.")
      && options.request.compartmentOcid !== options.session.expectedIdentity.tenancyOcid) throw new OciTaskError("configuration");
    await authorize();
    const token = snapshot.tokenBytes, key = snapshot.privateKeyBytes;
    let packet: string | undefined;
    try {
      if (token.length > 65536 || key.length > 16384) throw new OciTaskError("snapshot");
      packet = JSON.stringify({ version: 1, type: "task", attemptId: options.attemptId, timeoutMs: 5000,
        request: options.request, expected: options.session.expectedIdentity, token: token.toString("base64"), key: key.toString("base64") }) + "\n";
    } finally { token.fill(0); key.fill(0); }
    const release = options.retainWorker();
    if (typeof release !== "function") throw new OciTaskError("unavailable");
    let writer: Awaited<ReturnType<typeof prepareOwnedOciWriter>>;
    const preparing = prepareOwnedOciWriter(options.session, "task");
    try { writer = await raceAbort(preparing, signal); }
    catch {
      // A cancelled pre-spawn write can settle late; its exact intent still has no child.
      void preparing.then(async (late) => { await abandonOwnedOciWriter(late); release(); }).catch(() => { /* Unknown journal cleanup retains ownership. */ });
      throw new OciTaskError("cleanup_uncertain", true);
    }
    let child: cp.ChildProcess;
    try {
      child = cp.spawn("/opt/homebrew/Cellar/oci-cli/3.88.0/libexec/bin/python", ["-I", "-S", "-c", OCI_TASK_SOURCE], {
        shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      });
    } catch {
      const abandoning = abandonOwnedOciWriter(writer).then(release);
      try { await waitForOwnedOciWriterCleanup(abandoning); } catch { throw new OciTaskError("cleanup_uncertain", true); }
      throw new OciTaskError("unavailable");
    }
    const observed = observeOwnedOciWriter(writer, child);
    const commands = child.stdio[3] as Writable, messages = child.stdio[4] as Readable;
    let close!: () => void, finish!: (code: number | null) => void, reject!: (error: unknown) => void;
    const closed = new Promise<void>((resolve) => { close = resolve; });
    const finished = new Promise<number | null>((resolve, refused) => { finish = resolve; reject = refused; });
    void finished.catch(() => {});
    let isClosed = false, failed = false, output = Buffer.alloc(0), stopping: Promise<void> | undefined;
    const stop = () => stopping ??= (async () => {
      if (!isClosed) {
        if (commands.writable) commands.write(JSON.stringify({ version: 1, type: "cancel", attemptId: options.attemptId }) + "\n", () => {});
        if (!await waitForClose(closed, 250)) {
          child.kill("SIGTERM");
          if (!await waitForClose(closed, 500)) { child.kill("SIGKILL"); await waitForClose(closed, 1000); }
        }
      }
      if (!isClosed || !await waitForClose(observed.closed.catch(() => { throw new OciTaskError("cleanup_uncertain", true); }), 250).catch(() => false)) {
        cleanupFailure = new OciTaskError("cleanup_uncertain", true); reject(cleanupFailure);
      }
    })();
    const abort = () => { void stop(); };
    const refuse = () => { failed = true; void stop(); };
    commands.on("error", refuse); messages.on("error", refuse); child.once("error", refuse);
    messages.on("data", (data: Buffer) => {
      if (output.length + data.length > 65536) { refuse(); return; }
      output = Buffer.concat([output, data]);
    });
    child.once("close", (code) => {
      isClosed = true; close(); signal.removeEventListener("abort", abort);
      void observed.closed.then(() => {
        try { release(); } catch { cleanupFailure = new OciTaskError("cleanup_uncertain", true); }
        finish(code);
      }, () => { cleanupFailure = new OciTaskError("cleanup_uncertain", true); reject(cleanupFailure); });
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      signal.throwIfAborted();
      await raceAbort(observed.attached, signal);
      await raceAbort(new Promise<void>((resolve, refused) => { commands.write(packet!, (error) => error ? refused(new OciTaskError("protocol")) : resolve()); }), signal);
      packet = undefined;
      const code = await raceAbort(finished, signal);
      if (cleanupFailure) throw cleanupFailure;
      signal.throwIfAborted();
      if (failed || code !== 0 || !output.length) throw new OciTaskError("protocol");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(output);
      if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) throw new OciTaskError("protocol");
      const result = responseSchema.parse(JSON.parse(text));
      if (result.attemptId !== options.attemptId) throw new OciTaskError("protocol");
      if (!result.ok || !result.result) throw new OciTaskError(result.reason === "matched" ? "protocol" : result.reason);
      if (result.result.operation !== options.request.operation) throw new OciTaskError("protocol");
      await authorize();
      await raceAbort(recheckOwnedOciSnapshot(options.session, snapshot), signal).catch(() => { throw new OciTaskError("snapshot"); });
      signal.throwIfAborted();
      return Object.freeze(result.result);
    } finally {
      packet = undefined;
      await stop();
      signal.removeEventListener("abort", abort);
      if (cleanupFailure) throw cleanupFailure;
    }
  } catch (error) {
    if (cleanupFailure) throw cleanupFailure;
    if ((error as { cleanupUncertain?: unknown } | null)?.cleanupUncertain === true) throw new OciTaskError("cleanup_uncertain", true);
    if (external?.aborted) throw new OciTaskError("aborted");
    throw error instanceof OciTaskError ? error : new OciTaskError("unavailable");
  } finally {
    abandoned = true;
    if (snapshot) disposeOwnedOciSnapshot(snapshot);
  }
}
