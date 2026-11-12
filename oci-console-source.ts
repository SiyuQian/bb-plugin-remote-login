import { createHash } from "node:crypto";
import type { Frame, HTTPResponse, Page } from "puppeteer-core";
import { consoleBuild, consoleSourcePins } from "./oci-console-protocol.ts";

declare const sourceProof: unique symbol;
export type ConsoleSourceProof = { readonly [sourceProof]: true };
/** Worker-only boundary. A proof is an opaque object bound to a particular page document. */
export type ConsoleSourceBoundary = {
  capture(signal: AbortSignal): Promise<ConsoleSourceProof>;
  assert(proof: ConsoleSourceProof): void;
  dispose(): void;
};
class SourceError extends Error { constructor() { super("Console source attestation unavailable."); } }
const refuse = (): never => { throw new SourceError(); };
async function bounded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new SourceError()); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
  });
  try { const result = await Promise.race([pending, stopped]); signal.throwIfAborted(); return result; }
  finally { signal.removeEventListener("abort", abort); }
}

/** Attach before Console navigation; only bytes delivered as scripts to this main frame can attest it. */
export function createConsoleSourceAttestor(page: Page, lifecycle: AbortSignal,
  dependencies?: { digest(bytes: Buffer): string }): ConsoleSourceBoundary {
  const target = page.target(), context = page.browserContext(), browser = page.browser();
  const pins = new Map(consoleSourcePins.map((pin) => [pin.url, pin.sha256]));
  // Worker-private cryptographic boundary for fixtures; no public route accepts dependencies or pins.
  const digestBytes = dependencies?.digest ?? ((bytes: Buffer) => createHash("sha256").update(bytes).digest("hex"));
  const seen = new Set<string>(), pending = new Set<Promise<void>>();
  const proofs = new WeakMap<ConsoleSourceProof, { generation: number; revision: number; frame: Frame }>();
  let generation = 0, revision = 0, disposed = false, invalid = false;
  const live = () => {
    if (disposed || invalid || lifecycle.aborted || page.isClosed() || !browser.connected
      || page.target() !== target || page.browserContext() !== context || page.browser() !== browser
      || new URL(page.url()).origin !== "https://cloud.oracle.com") refuse();
  };
  const navigation = (frame: Frame) => { if (frame === page.mainFrame()) { generation++; seen.clear(); } };
  const response = (response: HTTPResponse) => {
    const request = response.request(), url = response.url();
    if (request.frame() !== page.mainFrame() || request.resourceType() !== "script") return;
    if (url.startsWith("https://cloud.oracle.com/plugins/console/") && !url.startsWith(`https://cloud.oracle.com/plugins/console/${consoleBuild}/`)) { invalid = true; return; }
    const digest = pins.get(url); if (!digest) return;
    // Delivery precedes body availability/execution; old proofs lose authority before any await.
    revision++; seen.delete(url);
    const document = generation, frame = page.mainFrame();
    const operation = (async () => {
      try {
        if (response.status() !== 200 || response.fromCache() || response.fromServiceWorker() || request.redirectChain().length
          || !/^(?:application|text)\/(?:javascript|x-javascript|ecmascript)(?:;|$)/i.test(response.headers()["content-type"] ?? "")) refuse();
        const bytes = await bounded(response.buffer(), AbortSignal.any([lifecycle, AbortSignal.timeout(8000)]));
        if (bytes.length > 2_000_000 || digestBytes(bytes) !== digest) refuse();
        if (!disposed && generation === document && frame === page.mainFrame()) seen.add(url);
      } catch { invalid = true; }
    })();
    pending.add(operation); void operation.finally(() => pending.delete(operation));
  };
  page.on("framenavigated", navigation); page.on("response", response);
  return {
    async capture(signal) {
      live(); const document = generation, captureRevision = revision, frame = page.mainFrame();
      await bounded(Promise.all([...pending]), signal);
      live(); if (document !== generation || captureRevision !== revision || pending.size || frame !== page.mainFrame() || seen.size !== pins.size) refuse();
      const proof = Object.freeze({}) as ConsoleSourceProof;
      proofs.set(proof, { generation, revision, frame }); return proof;
    },
    assert(proof) {
      live(); const issued = proofs.get(proof);
      if (!issued || issued.generation !== generation || issued.revision !== revision || pending.size || issued.frame !== page.mainFrame() || seen.size !== pins.size) refuse();
    },
    dispose() { disposed = true; page.off("framenavigated", navigation); page.off("response", response); seen.clear(); },
  };
}
