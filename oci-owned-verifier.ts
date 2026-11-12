import cp from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { captureOwnedOciSnapshot, recheckOwnedOciSnapshot, disposeOwnedOciSnapshot, type OwnedOciSession, type OwnedOciSnapshot } from "./oci-owned-session.ts";
import { OCI_VERIFIER_SOURCE } from "./oci-verifier-source.ts";
import { prepareRetainedOwnedOciWriter, observeOwnedOciWriter, abandonOwnedOciWriter, waitForOwnedOciWriterCleanup } from "./oci-writer-journal.ts";

const reasons = ["configuration", "unsupported_region", "key", "token", "rejected", "identity_mismatch", "deadline", "cancelled", "sdk", "private_channel"] as const;
const responseSchema = z.object({ version: z.literal(1), type: z.literal("result"), attemptId: z.string(), match: z.boolean(),
  reason: z.enum(["matched", ...reasons]) }).strict().refine((value) => value.match === (value.reason === "matched"));
const inputSchema = z.object({
  attemptId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  timeoutMs: z.number().int().min(100).max(30000), signal: z.instanceof(AbortSignal), lifecycle: z.instanceof(AbortSignal),
  session: z.custom<OwnedOciSession>((v) => typeof v === "object" && v !== null),
  authorize: z.custom<() => Promise<void>>((v) => typeof v === "function"), retainWorker: z.custom<() => () => void>((v) => typeof v === "function"),
}).strict();
type Input = z.infer<typeof inputSchema>;
export type OwnedOciVerification = Readonly<{ match: boolean; reason: z.infer<typeof responseSchema>["reason"] }>;
export class OwnedOciVerificationError extends Error {
  constructor(readonly code: "unavailable" | "aborted" | "snapshot" | "protocol" | "cleanup_uncertain", readonly cleanupUncertain = false) {
    super("OCI verification unavailable."); this.name = "OwnedOciVerificationError";
  }
}
async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => { abort = () => reject(new OwnedOciVerificationError("aborted")); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); });
  try { const result = await Promise.race([pending, stopped]); signal.throwIfAborted(); return result; }
  finally { signal.removeEventListener("abort", abort); }
}
async function waitForClose(closed: Promise<void>, ms: number): Promise<boolean> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([closed.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Internal online implementation. Call only from a gated worker; it exposes no public success setter. */
export async function verifyOwnedOciSession(input: Input): Promise<OwnedOciVerification> {
  let cleanupFailure: OwnedOciVerificationError | undefined;
  let stopped: AbortSignal | undefined;
  let snapshot: OwnedOciSnapshot | undefined;
  let abandoned = false;
  try {
    const options = inputSchema.parse(input);
    const external = AbortSignal.any([options.signal, options.lifecycle, AbortSignal.timeout(options.timeoutMs + 1000)]);
    stopped = external;
    external.throwIfAborted();
    const authorize = () => raceAbort(Promise.resolve().then(options.authorize), AbortSignal.any([external, AbortSignal.timeout(8000)]));
    await authorize();
    const capturing = captureOwnedOciSnapshot(options.session).then((value) => {
      if (abandoned) disposeOwnedOciSnapshot(value); else snapshot = value;
      return value;
    });
    await raceAbort(capturing, external).catch(() => { throw new OwnedOciVerificationError("snapshot"); });
    if (!snapshot) throw new OwnedOciVerificationError("snapshot");
    if (options.session.paths.profileName !== `BB_REMOTE_${options.attemptId.replaceAll("-", "")}`) throw new OwnedOciVerificationError("snapshot");
    await authorize();
    const token = snapshot.tokenBytes, key = snapshot.privateKeyBytes;
    if (token.length > 65536 || key.length > 16384) { token.fill(0); key.fill(0); throw new OwnedOciVerificationError("snapshot"); }
    let packet: string | undefined;
    try { packet = JSON.stringify({ version: 1, type: "verify", attemptId: options.attemptId, timeoutMs: options.timeoutMs,
      expected: options.session.expectedIdentity, token: token.toString("base64"), key: key.toString("base64") }) + "\n"; }
    finally { token.fill(0); key.fill(0); }
    let release: () => void;
    try { release = options.retainWorker(); if (typeof release !== "function") throw new Error(); }
    catch { throw new OwnedOciVerificationError("unavailable"); }
    const journal = await prepareRetainedOwnedOciWriter(options.session, "verifier", external, release);
    if (external.aborted) { await waitForOwnedOciWriterCleanup(abandonOwnedOciWriter(journal).then(release)); throw new OwnedOciVerificationError("aborted"); }
    let child: cp.ChildProcess;
    try {
      child = cp.spawn("/opt/homebrew/Cellar/oci-cli/3.88.0/libexec/bin/python", ["-I", "-S", "-c", OCI_VERIFIER_SOURCE], {
        shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      });
    } catch {
      try { await waitForOwnedOciWriterCleanup(abandonOwnedOciWriter(journal).then(release)); }
      catch { throw new OwnedOciVerificationError("cleanup_uncertain", true); }
      throw new OwnedOciVerificationError("unavailable");
    }
    const journaled = observeOwnedOciWriter(journal, child);
    const commands = child.stdio[3] as Writable, messages = child.stdio[4] as Readable;
    let resolveClose!: () => void, rejectFinish!: (error: unknown) => void, resolveFinish!: (code: number | null) => void;
    const closed = new Promise<void>((resolve) => { resolveClose = resolve; });
    const finished = new Promise<number | null>((resolve, reject) => { resolveFinish = resolve; rejectFinish = reject; });
    void finished.catch(() => {});
    let isClosed = false, failure = false, output = Buffer.alloc(0), stopping: Promise<void> | undefined;
    const stop = () => stopping ??= (async () => {
      if (!isClosed) {
        if (commands.writable) commands.write(JSON.stringify({ version: 1, type: "cancel", attemptId: options.attemptId }) + "\n", () => {});
        if (!await waitForClose(closed, 250)) {
          child.kill("SIGTERM");
          if (!await waitForClose(closed, 500)) { child.kill("SIGKILL"); await waitForClose(closed, 1000); }
        }
      }
      if (!isClosed) throw new OwnedOciVerificationError("cleanup_uncertain", true);
      await waitForOwnedOciWriterCleanup(journaled.closed);
    })().catch(() => { cleanupFailure = new OwnedOciVerificationError("cleanup_uncertain", true); rejectFinish(cleanupFailure); });
    const abort = () => { void stop(); };
    const refuse = () => { failure = true; void stop(); };
    commands.on("error", refuse); messages.on("error", refuse); child.once("error", refuse);
    messages.on("data", (data: Buffer) => {
      if (output.length + data.length > 2048) { refuse(); return; }
      output = Buffer.concat([output, data]);
    });
    child.once("close", (code) => {
      isClosed = true; resolveClose(); external.removeEventListener("abort", abort);
      void journaled.closed.then(() => {
        try { release(); } catch { cleanupFailure = new OwnedOciVerificationError("cleanup_uncertain", true); }
      }, () => {});
      void waitForOwnedOciWriterCleanup(journaled.closed).then(() => {
        resolveFinish(code);
      }, () => { cleanupFailure = new OwnedOciVerificationError("cleanup_uncertain", true); rejectFinish(cleanupFailure); });
    });
    external.addEventListener("abort", abort, { once: true });
    if (external.aborted) abort();
    try {
      external.throwIfAborted();
      await raceAbort(journaled.attached, external);
      await raceAbort(new Promise<void>((resolve, reject) => { commands.write(packet!, (error) => error ? reject(new OwnedOciVerificationError("protocol")) : resolve()); }), external);
      packet = undefined;
      const code = await raceAbort(finished, external);
      if (cleanupFailure) throw cleanupFailure;
      external.throwIfAborted();
      if (failure || code !== 0 || !output.length) throw new OwnedOciVerificationError("protocol");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(output);
      if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) throw new OwnedOciVerificationError("protocol");
      const result = responseSchema.parse(JSON.parse(text));
      if (result.attemptId !== options.attemptId) throw new OwnedOciVerificationError("protocol");
      await authorize();
      await raceAbort(recheckOwnedOciSnapshot(options.session, snapshot), external).catch(() => { throw new OwnedOciVerificationError("snapshot"); });
      external.throwIfAborted();
      return Object.freeze({ match: result.match, reason: result.reason });
    } finally {
      packet = undefined;
      await stop();
      external.removeEventListener("abort", abort);
      if (cleanupFailure) throw cleanupFailure;
    }
  } catch (error) {
    if (cleanupFailure) throw cleanupFailure;
    if ((error as { cleanupUncertain?: unknown } | null)?.cleanupUncertain === true) throw new OwnedOciVerificationError("cleanup_uncertain", true);
    if (stopped?.aborted) throw new OwnedOciVerificationError("aborted");
    throw error instanceof OwnedOciVerificationError ? error : new OwnedOciVerificationError("unavailable");
  } finally {
    abandoned = true;
    if (snapshot) disposeOwnedOciSnapshot(snapshot);
  }
}
