import type { ChildProcess } from "node:child_process";
import { ownedOciResourceContext, type OwnedOciSession } from "./oci-owned-session.ts";
import { inspectOwnedProcess } from "./owned-process-identity.ts";
import type { OwnedResourceWriter, OwnedWriterRole } from "./owned-resource-ledger.ts";

declare const preparedBrand: unique symbol;
export type PreparedOwnedOciWriter = Readonly<{ [preparedBrand]: true }>;
type State = ReturnType<typeof ownedOciResourceContext> & { writer: OwnedResourceWriter; observed: boolean; processClosed?: Promise<void> };
const prepared = new WeakMap<PreparedOwnedOciWriter, State>();
export class OciWriterJournalError extends Error {
  readonly cleanupUncertain = true;
  constructor() { super("OCI writer ownership unavailable."); this.name = "OciWriterJournalError"; }
}
/** Uncertain persistence must not turn a bounded process stop into an indefinite wait. */
export async function waitForOwnedOciWriterCleanup(pending: Promise<void>, timeoutMs = 250): Promise<void> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OciWriterJournalError()), timeoutMs); })]);
  } catch { throw new OciWriterJournalError(); }
  finally { clearTimeout(timer); }
}
/** Must complete before spawn; an interrupted spawn intent can never authorize restart cleanup. */
export async function prepareOwnedOciWriter(session: OwnedOciSession, role: OwnedWriterRole): Promise<PreparedOwnedOciWriter> {
  try {
    const context = ownedOciResourceContext(session), writer = await context.ledger.beginWriter(context.resource, role);
    const value = Object.freeze({}) as PreparedOwnedOciWriter; prepared.set(value, { ...context, writer, observed: false }); return value;
  } catch { throw new OciWriterJournalError(); }
}
/** Caller acquires retention first; cancellation keeps it until its exact late intent is abandoned. */
export async function prepareRetainedOwnedOciWriter(session: OwnedOciSession, role: OwnedWriterRole, signal: AbortSignal, release: () => void): Promise<PreparedOwnedOciWriter> {
  const preparing = prepareOwnedOciWriter(session, role);
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new OciWriterJournalError());
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
  });
  try {
    const writer = await Promise.race([preparing, cancelled]);
    if (signal.aborted) throw new OciWriterJournalError();
    return writer;
  } catch {
    void preparing.then(async (writer) => { await abandonOwnedOciWriter(writer); release(); }).catch(() => { /* Unconfirmed journal ownership keeps retention. */ });
    throw new OciWriterJournalError();
  } finally { signal.removeEventListener("abort", abort); }
}
/** Only for a synchronous spawn throw, before any ChildProcess handle exists. */
export async function abandonOwnedOciWriter(value: PreparedOwnedOciWriter): Promise<void> {
  const state = prepared.get(value); if (!state || state.observed) throw new OciWriterJournalError();
  state.observed = true;
  try { await state.ledger.confirmWriterClosed(state.writer); } catch { throw new OciWriterJournalError(); }
}
/** Call synchronously immediately after spawn; install caller handlers before awaiting attached. */
export function observeOwnedOciWriter(value: PreparedOwnedOciWriter, child: ChildProcess, options: { closeOnExit?: boolean } = {}): { attached: Promise<void>; closed: Promise<void> } {
  const state = prepared.get(value); if (!state || state.observed) throw new OciWriterJournalError();
  state.observed = true;
  let observedClose = false, resolveClose!: () => void;
  const rawClosed = new Promise<void>((resolve) => { resolveClose = resolve; });
  child.once("close", () => { observedClose = true; resolveClose(); });
  const attached = (async () => {
    if (!Number.isSafeInteger(child.pid) || !child.pid) throw new OciWriterJournalError();
    const process = await inspectOwnedProcess(child.pid);
    if (observedClose) return;
    if (!process || process.pid !== child.pid) throw new OciWriterJournalError();
    await state.ledger.attachWriter(state.writer, process);
  })().catch(() => { throw new OciWriterJournalError(); });
  const processClosed = (async () => {
    await rawClosed;
    await attached.catch(() => {});
  })().catch(() => { throw new OciWriterJournalError(); });
  state.processClosed = processClosed;
  const closed = options.closeOnExit === false ? processClosed : processClosed.then(() => state.ledger.confirmWriterClosed(state.writer)).catch(() => { throw new OciWriterJournalError(); });
  void attached.catch(() => {}); void closed.catch(() => {});
  return { attached, closed };
}
export async function recordOwnedOciWriterDirectory(value: PreparedOwnedOciWriter, path: string): Promise<void> {
  const state = prepared.get(value); if (!state || state.observed) throw new OciWriterJournalError();
  try { await state.ledger.recordWriterDirectory(state.writer, path); } catch { throw new OciWriterJournalError(); }
}
/** Browser only: called after confirmed process closure AND deletion of its original private profile. */
export async function finishOwnedOciWriterCleanup(value: PreparedOwnedOciWriter): Promise<void> {
  const state = prepared.get(value); if (!state || !state.observed || !state.processClosed) throw new OciWriterJournalError();
  try { await state.processClosed; await state.ledger.confirmWriterClosed(state.writer); } catch { throw new OciWriterJournalError(); }
}
