import cp from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { captureOwnedOciSnapshot, recheckOwnedOciSnapshot, disposeOwnedOciSnapshot, type OwnedOciSession, type OwnedOciSnapshot } from "./oci-owned-session.ts";
import { OCI_DIAGNOSTIC_SOURCE } from "./oci-official-diagnostic-source.ts";
import { prepareRetainedOwnedOciWriter, observeOwnedOciWriter, abandonOwnedOciWriter, waitForOwnedOciWriterCleanup } from "./oci-writer-journal.ts";

type Options = { session: OwnedOciSession; attemptId: string; signal: AbortSignal; lifecycle: AbortSignal; authorize(): Promise<void>; retainWorker(): () => void };
const optionsSchema = z.object({
  session: z.custom<OwnedOciSession>((value) => typeof value === "object" && value !== null),
  attemptId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  signal: z.instanceof(AbortSignal), lifecycle: z.instanceof(AbortSignal),
  authorize: z.custom<() => Promise<void>>((value) => typeof value === "function"),
  retainWorker: z.custom<() => () => void>((value) => typeof value === "function"),
}).strict();
const reasons = ["configuration", "sdk", "prompt", "reauth", "rejected", "deadline", "cancelled", "private_channel"] as const;
const resultSchema = z.object({ version: z.literal(1), type: z.literal("result"), attemptId: z.string(), ok: z.boolean(),
  reason: z.enum(["complete", ...reasons]) }).strict().refine((value) => value.ok === (value.reason === "complete"));
type Code = "unavailable" | "aborted" | "snapshot" | "protocol" | "cleanup_uncertain" | typeof reasons[number];
export class OciDiagnosticError extends Error {
  constructor(readonly code: Code, readonly cleanupUncertain = false) { super("OCI diagnostic unavailable."); this.name = "OciDiagnosticError"; }
}
async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new OciDiagnosticError("aborted")); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); });
  try { const result = await Promise.race([pending, cancelled]); signal.throwIfAborted(); return result; }
  finally { signal.removeEventListener("abort", abort); }
}
async function waitForClose(closed: Promise<void>, ms: number): Promise<boolean> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([closed.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Additional official CLI diagnostic. Success is not independent identity verification or a public success producer. */
export async function runOwnedOciDiagnostic(input: Options): Promise<void> {
  let snapshot: OwnedOciSnapshot | undefined;
  let abandoned = false, external: AbortSignal | undefined;
  let cleanupFailure: OciDiagnosticError | undefined;
  try {
    const options = optionsSchema.parse(input);
    external = AbortSignal.any([options.signal, options.lifecycle, AbortSignal.timeout(7000)]);
    const signal = external;
    signal.throwIfAborted();
    const authorize = () => raceAbort(Promise.resolve().then(options.authorize), signal);
    await authorize();
    await raceAbort(captureOwnedOciSnapshot(options.session).then((value) => {
      if (abandoned) disposeOwnedOciSnapshot(value); else snapshot = value;
    }), signal).catch(() => { throw new OciDiagnosticError("snapshot"); });
    if (!snapshot || options.session.paths.profileName !== `BB_REMOTE_${options.attemptId.replaceAll("-", "")}`
      || options.session.expectedIdentity.region !== "ap-sydney-1" || options.session.expectedIdentity.realm !== "oc1") throw new OciDiagnosticError("snapshot");
    await authorize();
    let release: () => void;
    try { release = options.retainWorker(); if (typeof release !== "function") throw new Error(); }
    catch { throw new OciDiagnosticError("unavailable"); }
    const journal = await prepareRetainedOwnedOciWriter(options.session, "diagnostic", signal, release);
    if (signal.aborted) { await waitForOwnedOciWriterCleanup(abandonOwnedOciWriter(journal).then(release)); throw new OciDiagnosticError("aborted"); }
    let child: cp.ChildProcess;
    try {
      child = cp.spawn("/opt/homebrew/Cellar/oci-cli/3.88.0/libexec/bin/python", ["-I", "-S", "-c", OCI_DIAGNOSTIC_SOURCE], {
        shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      });
    } catch {
      try { await waitForOwnedOciWriterCleanup(abandonOwnedOciWriter(journal).then(release)); }
      catch { throw new OciDiagnosticError("cleanup_uncertain", true); }
      throw new OciDiagnosticError("unavailable");
    }
    const journaled = observeOwnedOciWriter(journal, child);
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
      if (!isClosed) throw new OciDiagnosticError("cleanup_uncertain", true);
      await waitForOwnedOciWriterCleanup(journaled.closed);
    })().catch(() => { cleanupFailure = new OciDiagnosticError("cleanup_uncertain", true); reject(cleanupFailure); });
    const abort = () => { void stop(); };
    const refuse = () => { failed = true; void stop(); };
    commands.on("error", refuse); messages.on("error", refuse); child.once("error", refuse);
    messages.on("data", (data: Buffer) => {
      if (output.length + data.length > 2048) { refuse(); return; }
      output = Buffer.concat([output, data]);
    });
    child.once("close", (code) => {
      isClosed = true; close(); signal.removeEventListener("abort", abort);
      void journaled.closed.then(() => {
        try { release(); } catch { cleanupFailure = new OciDiagnosticError("cleanup_uncertain", true); }
      }, () => {});
      void waitForOwnedOciWriterCleanup(journaled.closed).then(() => {
        finish(code);
      }, () => { cleanupFailure = new OciDiagnosticError("cleanup_uncertain", true); reject(cleanupFailure); });
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      signal.throwIfAborted();
      await raceAbort(journaled.attached, signal);
      const packet = JSON.stringify({ version: 1, type: "diagnostic", attemptId: options.attemptId, root: options.session.paths.root }) + "\n";
      await raceAbort(new Promise<void>((resolve, refused) => { commands.write(packet, (error) => error ? refused(new OciDiagnosticError("protocol")) : resolve()); }), signal);
      const code = await raceAbort(finished, signal);
      if (cleanupFailure) throw cleanupFailure;
      signal.throwIfAborted();
      if (failed || code !== 0 || !output.length) throw new OciDiagnosticError("protocol");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(output);
      if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) throw new OciDiagnosticError("protocol");
      const result = resultSchema.parse(JSON.parse(text));
      if (result.attemptId !== options.attemptId) throw new OciDiagnosticError("protocol");
      if (!result.ok) throw new OciDiagnosticError(result.reason === "complete" ? "protocol" : result.reason);
      await authorize();
      await raceAbort(recheckOwnedOciSnapshot(options.session, snapshot), signal).catch(() => { throw new OciDiagnosticError("snapshot"); });
      signal.throwIfAborted();
    } finally {
      await stop();
      signal.removeEventListener("abort", abort);
      if (cleanupFailure) throw cleanupFailure;
    }
  } catch (error) {
    if (cleanupFailure) throw cleanupFailure;
    if ((error as { cleanupUncertain?: unknown } | null)?.cleanupUncertain === true) throw new OciDiagnosticError("cleanup_uncertain", true);
    if (external?.aborted) throw new OciDiagnosticError("aborted");
    throw error instanceof OciDiagnosticError ? error : new OciDiagnosticError("unavailable");
  } finally {
    abandoned = true;
    if (snapshot) disposeOwnedOciSnapshot(snapshot);
  }
}
