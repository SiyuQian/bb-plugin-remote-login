import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CDPSession, Frame, JSHandle, Page, Protocol } from "puppeteer-core";
import { controlScopeSchema } from "./control-wire.ts";
import type { ControlScope } from "./control-authority.ts";
import { consoleBuild, consoleExpectedIdentitySchema, type ConsoleExpectedIdentity } from "./oci-console-protocol.ts";
import { createConsoleSourceAttestor, type ConsoleSourceBoundary, type ConsoleSourceProof } from "./oci-console-source.ts";
import { OCI_CONSOLE_PAGE_SOURCE, type ConsolePageBridge } from "./oci-console-page.ts";

type Failure = "source" | "ownership" | "context" | "network" | "identity" | "expired" | "aborted" | "busy" | "cleanup_uncertain";
export class ConsoleVerificationError extends Error {
  constructor(readonly code: Failure) { super("Console verification unavailable."); this.name = "ConsoleVerificationError"; }
}
const fail = (code: Failure): never => { throw new ConsoleVerificationError(code); };
export type ConsoleIdentityMatch = Readonly<{ matched: true; userMatched: true; tenancyMatched: true; domainMatched: true; sourceBuild: typeof consoleBuild }>;
type Options = {
  page: Page; expected: ConsoleExpectedIdentity; scope: ControlScope; expiresAt: number; lifecycle: AbortSignal;
  /** Trusted worker callback: must assert the genuine private browser lease and full live attempt/root binding. */
  assertOwned(scope: ControlScope, signal: AbortSignal): Promise<void>;
  timeoutMs?: number;
  /** Worker-private browser barrier. Installs one exact request allowance before page dispatch. */
  allowRead?: (request: Readonly<{ marker: string; url: string }>, signal: AbortSignal) => Promise<() => Promise<void>>;
  // Private external-source boundary only, never accepted by RPC, tools or interaction input.
  dependencies?: { sources?: (page: Page, lifecycle: AbortSignal) => ConsoleSourceBoundary };
};
const bodySchema = z.object({ active: z.literal(true), ocid: z.string().max(512), tenancyOcid: z.string().max(512), domainOcid: z.string().max(512) });
const bridgeSchema = z.object({ authorizationDigest: z.string().regex(/^[a-f0-9]{64}$/), stamp: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const header = (headers: Record<string, unknown>, name: string): string | undefined => {
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]; return typeof value === "string" ? value : undefined;
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new ConsoleVerificationError("aborted")); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
  });
  try { const result = await Promise.race([promise, stopped]); signal.throwIfAborted(); return result; }
  finally { signal.removeEventListener("abort", abort); }
}

/** Attach before Console navigation. This adapter has no public entry and never returns browser/account material. */
export function createConsoleIdentityVerifier(supplied: Options) {
  let expected: ConsoleExpectedIdentity, scope: ControlScope;
  try { expected = Object.freeze(consoleExpectedIdentitySchema.parse(supplied.expected)); scope = Object.freeze(controlScopeSchema.parse(supplied.scope)); }
  catch { return fail("identity"); }
  const { page, lifecycle } = supplied;
  const expiresAt = supplied.expiresAt, assertOwned = supplied.assertOwned;
  const timeout = supplied.timeoutMs ?? 8000;
  if (!Number.isSafeInteger(supplied.expiresAt) || !Number.isSafeInteger(timeout) || timeout < 100 || timeout > 8000 || typeof supplied.assertOwned !== "function") fail("ownership");
  const browser = page.browser(), context = page.browserContext(), target = page.target();
  const sources = (supplied.dependencies?.sources ?? createConsoleSourceAttestor)(page, lifecycle);
  let generation = 0, disposed = false, poisoned = false, busy = false, current: AbortController | undefined;
  const invalidate = () => { generation++; current?.abort(); };
  const navigate = (frame: Frame) => { if (frame === page.mainFrame()) invalidate(); };
  page.on("framenavigated", navigate); page.on("close", invalidate); browser.on("targetcreated", invalidate);
  const live = (document?: number, frame?: Frame) => {
    if (poisoned) fail("cleanup_uncertain");
    if (disposed || lifecycle.aborted) fail("aborted");
    if (Date.now() >= expiresAt) fail("expired");
    if (page.isClosed() || !browser.connected || page.browser() !== browser || page.browserContext() !== context || page.target() !== target
      || (document !== undefined && document !== generation) || (frame && page.mainFrame() !== frame)) fail("context");
    try { if (new URL(page.url()).origin !== "https://cloud.oracle.com") fail("context"); } catch { fail("context"); }
  };
  return {
    async verify(signal: AbortSignal): Promise<ConsoleIdentityMatch> {
      if (busy) fail("busy"); busy = true;
      const controller = new AbortController(); current = controller;
      const stopped = AbortSignal.any([signal, lifecycle, controller.signal, AbortSignal.timeout(timeout)]);
      let cdp: CDPSession | undefined, bridge: JSHandle | undefined;
      let sessionAcquisition: Promise<CDPSession> | undefined, bridgeAcquisition: Promise<JSHandle> | undefined, bridgeMarker = "";
      let allowanceAcquisition: Promise<() => Promise<void>> | undefined;
      let cleaning = false, cleanupFailed = false, assertNetwork: (() => void) | undefined;
      const sessions = new Map<CDPSession, Promise<void>>(), handles = new Map<JSHandle, Promise<void>>();
      const allowances = new Map<() => Promise<void>, Promise<void>>();
      const uncertain = () => { cleanupFailed = true; poisoned = true; };
      const cleanAllowance = (revoke: () => Promise<void>) => {
        let pending = allowances.get(revoke);
        if (!pending) { pending = bounded(Promise.resolve().then(revoke), AbortSignal.timeout(1000)); allowances.set(revoke, pending); void pending.catch(uncertain); }
        return pending;
      };
      const cleanSession = (session: CDPSession) => {
        let pending = sessions.get(session);
        if (!pending) {
          pending = bounded(session.detach(), AbortSignal.timeout(1000)); sessions.set(session, pending);
          void pending.catch(uncertain);
        }
        return pending;
      };
      const cleanBridge = (handle: JSHandle, marker: string) => {
        let pending = handles.get(handle);
        if (!pending) {
          const operation = (async () => {
            try { if (await page.evaluate((bridge) => bridge.dispose(), handle as JSHandle<ConsolePageBridge>) !== marker) fail("cleanup_uncertain"); }
            finally { await handle.dispose(); }
          })();
          pending = bounded(operation, AbortSignal.timeout(1000)); handles.set(handle, pending);
          void pending.catch(uncertain);
        }
        return pending;
      };
      let accepted = false, proof: ConsoleSourceProof | undefined, checkedDocument: number | undefined, checkedFrame: Frame | undefined;
      let revokeRead: (() => Promise<void>) | undefined;
      const remove: Array<() => void> = [];
      try {
        live(); stopped.throwIfAborted();
        const document = generation, frame = page.mainFrame();
        checkedDocument = document; checkedFrame = frame;
        const own = async () => {
          live(document, frame);
          try { await bounded(assertOwned(scope, stopped), stopped); } catch { fail("ownership"); }
          live(document, frame);
        };
        await own();
        const sourceProof = await bounded(sources.capture(stopped), stopped).catch(() => fail("source"));
        proof = sourceProof;
        try { sources.assert(sourceProof); } catch { fail("source"); }
        await own();
        sessionAcquisition = page.createCDPSession().then((session) => {
          cdp = session; if (cleaning) void cleanSession(session); return session;
        });
        void sessionAcquisition.catch(() => {});
        cdp = await bounded(sessionAcquisition, stopped);
        const session = cdp;
        await bounded(session.send("Network.enable", { maxResourceBufferSize: 32768, maxTotalBufferSize: 131072 }), stopped);
        const tree = await bounded(session.send("Page.getFrameTree"), stopped);
        const main = tree.frameTree.frame;
        if (new URL(main.url).origin !== "https://cloud.oracle.com") fail("context");
        const id = randomUUID();
        const url = new URL("/admin/v1/Me", expected.domainOrigin); url.searchParams.set("attributes", "id,ocid,tenancyOcid,domainOcid,active");
        let requestId: string | undefined, wireId: string | undefined, wireDigest: string | undefined;
        let response: Protocol.Network.Response | undefined, finished = false, refused = false;
        const cached = new Set<string>();
        let complete!: () => void, reject!: () => void;
        const network = new Promise<void>((resolve, no) => { complete = resolve; reject = () => no(new ConsoleVerificationError("network")); });
        void network.catch(() => {});
        const rejectNetwork = () => { refused = true; reject(); };
        assertNetwork = () => { if (refused || (requestId && cached.has(requestId))) fail("network"); };
        const done = () => { if (requestId && wireId === requestId && wireDigest && response && finished && !refused) complete(); };
        const request = (event: Protocol.Network.RequestWillBeSentEvent) => {
          try { if (/(?:^|\/)(?:logout|logoff|userlogout|signout|sign-out)(?:\/|$)/i.test(new URL(event.request.url).pathname)) { invalidate(); return; } }
          catch { invalidate(); return; }
          if (event.requestId === requestId && event.redirectResponse) { rejectNetwork(); return; }
          if (header(event.request.headers, "opc-request-id") !== id) return;
          if (requestId || event.redirectResponse || event.request.url !== url.href || event.request.method !== "GET" || event.request.hasPostData
            || event.frameId !== main.id || event.loaderId !== main.loaderId || event.type !== "Fetch") { rejectNetwork(); return; }
          requestId = event.requestId; if (cached.has(requestId)) { rejectNetwork(); return; } done();
        };
        const extra = (event: Protocol.Network.RequestWillBeSentExtraInfoEvent) => {
          if (header(event.headers, "opc-request-id") !== id) return;
          const authorization = header(event.headers, "authorization");
          if (wireId || !authorization || authorization.length > 65536 || !/^Signature /.test(authorization)
            || !authorization.includes('keyId="ST$') || !authorization.includes('version="1"') || !authorization.includes('algorithm="rsa-sha256"')) { rejectNetwork(); return; }
          wireId = event.requestId; wireDigest = digest(authorization); done();
        };
        const received = (event: Protocol.Network.ResponseReceivedEvent) => {
          if (event.requestId !== requestId) return;
          const value = event.response;
          if (response || value.url !== url.href || value.status !== 200 || event.frameId !== main.id || event.loaderId !== main.loaderId
            || value.fromDiskCache || value.fromServiceWorker || value.fromPrefetchCache || !/^(?:application\/json|application\/scim\+json)(?:;|$)/i.test(header(value.headers, "content-type") ?? "")) { rejectNetwork(); return; }
          response = value; done();
        };
        const loaded = (event: Protocol.Network.LoadingFinishedEvent) => {
          if (event.requestId !== requestId) return;
          if (!Number.isFinite(event.encodedDataLength) || event.encodedDataLength > 32768) { rejectNetwork(); return; }
          finished = true; done();
        };
        const failed = (event: Protocol.Network.LoadingFailedEvent) => { if (event.requestId === requestId) rejectNetwork(); };
        const servedFromCache = (event: Protocol.Network.RequestServedFromCacheEvent) => {
          if (cached.size >= 256) { rejectNetwork(); return; }
          cached.add(event.requestId); if (event.requestId === requestId) rejectNetwork();
        };
        session.on("Network.requestWillBeSent", request); session.on("Network.requestWillBeSentExtraInfo", extra);
        session.on("Network.responseReceived", received); session.on("Network.loadingFinished", loaded); session.on("Network.loadingFailed", failed);
        session.on("Network.requestServedFromCache", servedFromCache);
        remove.push(() => { session.off("Network.requestWillBeSent", request); session.off("Network.requestWillBeSentExtraInfo", extra); session.off("Network.responseReceived", received); session.off("Network.loadingFinished", loaded); session.off("Network.loadingFailed", failed); session.off("Network.requestServedFromCache", servedFromCache); });
        bridgeMarker = id;
        bridgeAcquisition = page.evaluateHandle(`(${OCI_CONSOLE_PAGE_SOURCE})(${JSON.stringify({ origin: expected.domainOrigin, marker: id })})`).then((handle) => {
          bridge = handle; if (cleaning) void cleanBridge(handle, id); return handle;
        });
        void bridgeAcquisition.catch(() => {});
        bridge = await bounded(bridgeAcquisition, stopped);
        const ownedBridge = bridge;
        if (supplied.allowRead) {
          allowanceAcquisition = supplied.allowRead(Object.freeze({ marker: id, url: url.href }), stopped).then(revoke => {
            revokeRead = revoke; if (cleaning) void cleanAllowance(revoke); return revoke;
          });
          void allowanceAcquisition.catch(() => {});
          revokeRead = await bounded(allowanceAcquisition, stopped);
        }
        const execution = page.evaluate((bridge, requestId, url) => bridge.read(requestId, url), ownedBridge as JSHandle<ConsolePageBridge>, id, url.href);
        const [raw] = await bounded(Promise.all([execution, network]), stopped);
        const acknowledgement = bridgeSchema.parse(raw);
        if (!wireDigest || acknowledgement.authorizationDigest !== wireDigest || refused) fail("network");
        assertNetwork();
        live(document, frame); sources.assert(sourceProof);
        const captured = await bounded(session.send("Network.getResponseBody", { requestId: requestId! }), stopped);
        const bytes = captured.base64Encoded ? Buffer.from(captured.body, "base64") : Buffer.from(captured.body, "utf8");
        let profile: z.infer<typeof bodySchema>;
        try { if (!bytes.length || bytes.length > 32768) fail("network"); profile = bodySchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
        finally { bytes.fill(0); }
        if (profile.ocid !== expected.userOcid || profile.tenancyOcid !== expected.tenancyOcid || profile.domainOcid !== expected.domainOcid) fail("identity");
        assertNetwork();
        await own();
        await bounded(page.evaluate((bridge, stamp) => bridge.check(stamp), ownedBridge as JSHandle<ConsolePageBridge>, acknowledgement.stamp), stopped);
        const after = await bounded(session.send("Page.getFrameTree"), stopped);
        if (after.frameTree.frame.id !== main.id || after.frameTree.frame.loaderId !== main.loaderId) fail("context");
        live(document, frame); sources.assert(sourceProof); assertNetwork(); stopped.throwIfAborted();
        accepted = true;
        return Object.freeze({ matched: true, userMatched: true, tenancyMatched: true, domainMatched: true, sourceBuild: consoleBuild });
      } catch (error) {
        if (Date.now() >= expiresAt) fail("expired");
        if (stopped.aborted) fail("aborted");
        throw error instanceof ConsoleVerificationError ? error : new ConsoleVerificationError("network");
      } finally {
        cleaning = true;
        try {
          const cleanupSignal = AbortSignal.timeout(1000);
          try { await bounded(Promise.allSettled([sessionAcquisition, bridgeAcquisition, allowanceAcquisition]), cleanupSignal); } catch { uncertain(); }
          // Stop the owned fetch and restore its wrapper before dropping handles/connections.
          try { if (bridge) await bounded(cleanBridge(bridge, bridgeMarker), cleanupSignal); } catch { uncertain(); }
          try { if (revokeRead) await bounded(cleanAllowance(revokeRead), cleanupSignal); } catch { uncertain(); }
          try { if (cdp) await bounded(cleanSession(cdp), cleanupSignal); } catch { uncertain(); }
          for (const dispose of remove) dispose();
          if (cleanupFailed) fail("cleanup_uncertain");
          if (accepted) {
            try { await bounded(assertOwned(scope, stopped), stopped); } catch { fail("ownership"); }
            live(checkedDocument, checkedFrame);
            try { sources.assert(proof!); } catch { fail("source"); }
            assertNetwork?.(); if (stopped.aborted) fail("aborted");
          }
        } finally { if (current === controller) current = undefined; busy = false; }
      }
    },
    dispose() { disposed = true; invalidate(); sources.dispose(); page.off("framenavigated", navigate); page.off("close", invalidate); browser.off("targetcreated", invalidate); },
  };
}
