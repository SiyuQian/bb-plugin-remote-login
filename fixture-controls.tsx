import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { ControlGrant, ControlScope } from "./control-authority.ts";
import type { BrowserControlMode } from "./browser-control.ts";
import type { FixtureFrame, FixtureInput } from "./fixture-wire.ts";
import { postFixture } from "./fixture-client.ts";
import { withAbort } from "./private-response.ts";
import { FrameChangedError, StaleFrameError } from "./frame-error.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";

export type FixtureControlsProps = {
  origin: string;
  hostId: string;
  scope: ControlScope;
  capability: string;
  mode?: "synthetic" | "oci_cli" | "oci_web";
  controlMode?: BrowserControlMode;
  startDisabled?: boolean;
  initialVerifying?: boolean;
  handbackLabel?: string;
  transport?: FixtureTransport;
  onRenewed?: (grant: ControlGrant) => void;
  onVerified?: () => void;
  onStopped?: () => void;
  onFailure?: (action: "start" | "ready" | "frame" | "input" | "close" | "handback" | "renew") => void;
};
export type FixtureTransport = {
  start(signal: AbortSignal): Promise<unknown>;
  readyStatus?: (signal: AbortSignal) => Promise<boolean>;
  frame(signal: AbortSignal): Promise<FixtureFrame>;
  input(event: FixtureInput, signal: AbortSignal, frameRef: string): Promise<unknown>;
  close(signal: AbortSignal): Promise<unknown>;
  handback?: (signal: AbortSignal) => Promise<unknown>;
  renew?: (signal: AbortSignal) => Promise<ControlGrant>;
};
type Session = {
  transport: FixtureTransport;
  live: boolean;
  started: boolean;
  starting: boolean;
  opened: boolean;
  finished: boolean;
  verifying: boolean;
  busy: boolean;
  closingRequest: boolean;
  handbackRequest: boolean;
  retained: boolean;
  controller: AbortController | null;
  pending: Promise<void> | null;
  cleanupObservation: Promise<void> | null;
  closing: Promise<void> | null;
};
type View = { session: Session; started: boolean; starting: boolean; pending: boolean; reading: boolean; finished: boolean; verifying: boolean; text: string; frame: FixtureFrame | null; error: boolean; handbackError: boolean; stale: boolean; changed: boolean };
const initialView = (session: Session): View => ({ session, started: session.started, starting: false, pending: false, reading: false, finished: false, verifying: session.verifying, text: "", frame: null, error: false, handbackError: false, stale: false, changed: false });

async function closeAfterPending(session: Session): Promise<void> {
  if (session.closing) return session.closing;
  if (!session.opened || session.retained) return;
  const pending = session.pending;
  session.closing = (async () => {
    await pending;
    // A late protected Console acknowledgement may have retained this exact browser.
    await session.cleanupObservation;
    if (!session.opened || session.retained) return;
    session.opened = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      await withAbort(session.transport.close(controller.signal), controller.signal);
    } finally { clearTimeout(timer); }
  })().catch(() => undefined);
  return session.closing;
}

export function FixtureControls({ origin, hostId, scope, capability, mode = "synthetic", controlMode = "remote", startDisabled = false, initialVerifying = false, handbackLabel, transport, onRenewed, onVerified, onStopped, onFailure }: FixtureControlsProps) {
  const renewed = useRef(onRenewed); renewed.current = onRenewed;
  const failure = useRef(onFailure);
  failure.current = onFailure;
  const verified = useRef(onVerified);
  verified.current = onVerified;
  const stopped = useRef(onStopped);
  stopped.current = onStopped;
  const session = useMemo<Session>(() => ({
    transport: transport ?? {
      start: (signal) => postFixture(origin, "start", { hostId, scope: { ...scope } }, capability, signal),
      frame: (signal) => postFixture(origin, "frame", { hostId, scope: { ...scope } }, capability, signal),
      input: (event, signal, frameRef) => postFixture(origin, "input", { hostId, scope: { ...scope }, event, frameRef }, capability, signal),
      close: (signal) => postFixture(origin, "close", { hostId, scope: { ...scope } }, capability, signal),
    }, live: true, started: mode === "oci_web" && initialVerifying, starting: false, opened: mode === "oci_web" && initialVerifying, finished: false, verifying: mode === "oci_web" && initialVerifying,
    busy: false, closingRequest: false, handbackRequest: false, retained: mode === "oci_web" && initialVerifying, controller: null, pending: null, cleanupObservation: null, closing: null,
  }), [origin, hostId, transport ? null : capability, scope.threadId, scope.attemptId, scope.browserContextId, scope.generation, transport, mode, controlMode, initialVerifying]);
  const [view, setView] = useState(() => initialView(session));
  // A supplied transport owns proof rotation; its stable identity preserves the live viewer.
  const shown = view.session === session ? view : initialView(session);
  const update = (change: (current: View) => View) => {
    if (session.live) setView((current) => current.session === session ? change(current) : current);
  };
  const run = (action: "start" | "ready" | "frame" | "input" | "close" | "handback" | "renew", event?: FixtureInput): void => {
    const inputFrameRef = action === "input" ? shown.frame?.frameRef : undefined;
    if ((controlMode === "host" && (action === "frame" || action === "input")) || (action === "input" && !inputFrameRef)) return;
    if (!session.live || session.busy || (action === "start" && startDisabled) || (action !== "start" && action !== "ready" && action !== "close" && action !== "renew" && !session.started)
      || (session.verifying && action !== "handback" && action !== "close" && action !== "renew")
      || (action === "close" && !session.opened && (!session.transport.handback || session.finished))
      || (action === "ready" && (!session.starting || !session.transport.readyStatus))
      || (action === "renew" && (!session.transport.renew || session.finished))
      || (action === "handback" && !session.transport.handback)
      || (action === "start" && (session.opened || session.closing || session.finished))) return;
    session.busy = true;
    // An explicit stop owns its original completion even if its panel is left.
    const stopCompletion = action === "close" ? stopped.current : undefined;
    const controller = new AbortController();
    session.controller = controller;
    session.closingRequest = action === "close";
    session.handbackRequest = action === "handback";
    const timer = setTimeout(() => controller.abort(), 8000);
    update((current) => ({ ...current, pending: true, handbackError: false, reading: action === "frame" || action === "ready" || action === "renew", ...(action === "input" ? { frame: null, stale: false, changed: false } : {}), ...(action === "renew" ? { frame: null } : {}), ...(event?.type === "text" ? { text: "" } : {}),
      ...(action === "close" ? { frame: null, text: "", started: false, starting: false } : {}) }));
    let readingFrame = false;
    const operation = (async () => {
      try {
        if (action === "renew") {
          const grant = await withAbort(session.transport.renew!(controller.signal), controller.signal);
          controller.signal.throwIfAborted();
          if (!session.live) throw new Error();
          renewed.current?.(grant);
          return;
        }
        if (action === "close") {
          session.started = false; session.starting = false; session.opened = false; session.finished = true;
          await withAbort(session.transport.close(controller.signal), controller.signal);
          controller.signal.throwIfAborted();
          update((current) => ({ ...current, finished: true }));
          stopCompletion?.();
          return;
        }
        if (action === "handback") {
          const received = session.transport.handback!(controller.signal).then((result) => {
            // Keep observing cleanup ownership after the visible request times out.
            if (mode === "oci_web" && result && typeof result === "object"
              && (("pending" in result && result.pending === true) || ("verified" in result && result.verified === true))) session.retained = true;
            return result;
          });
          if (mode === "oci_web") session.cleanupObservation = received.then(() => {}, () => {});
          const result = await withAbort(received, controller.signal);
          controller.signal.throwIfAborted();
          if (result && typeof result === "object" && "pending" in result && result.pending === true) {
            session.verifying = true;
            update((current) => ({ ...current, verifying: true, text: "", frame: null }));
            return;
          }
          session.started = false; session.opened = false; session.finished = true;
          update((current) => ({ ...current, finished: true, started: false, frame: null, text: "" }));
          if (session.live) verified.current?.();
          return;
        }
        if (action === "start") {
          session.opened = true;
          const result = await withAbort(session.transport.start(controller.signal), controller.signal);
          controller.signal.throwIfAborted();
          if (result && typeof result === "object" && "pending" in result && result.pending === true) {
            if (!session.transport.readyStatus) throw new Error();
            session.starting = true;
            update((current) => ({ ...current, starting: true }));
            return;
          }
          session.started = true;
          update((current) => ({ ...current, started: true }));
        }
        if (action === "ready") {
          const ready = await withAbort(session.transport.readyStatus!(controller.signal), controller.signal);
          controller.signal.throwIfAborted();
          if (!ready) return;
          session.starting = false; session.started = true;
          update((current) => ({ ...current, starting: false, started: true }));
        }
        if (action === "input") {
          await withAbort(session.transport.input(event!, controller.signal, inputFrameRef!), controller.signal);
        }
        if (controlMode === "host") return;
        readingFrame = true;
        const frame = await withAbort(session.transport.frame(controller.signal), controller.signal);
        if (session.live && !controller.signal.aborted && session.started) update((current) => ({ ...current, frame }));
      } catch (error) {
        if (readingFrame && error instanceof FrameChangedError && session.live && !controller.signal.aborted
          && session.started && !session.finished && !session.verifying) {
          update((current) => ({ ...current, frame: null, stale: false, changed: true }));
          return;
        }
        if (action === "input" && !readingFrame && error instanceof StaleFrameError && session.live && !controller.signal.aborted
          && session.started && !session.finished && !session.verifying) {
          update((current) => ({ ...current, frame: null, stale: true, changed: false, ...(event?.type === "text" ? { text: event.text } : {}) }));
          return;
        }
        if (action === "handback" && !session.verifying && !controller.signal.aborted && session.live) {
          update((current) => ({ ...current, handbackError: true }));
          return;
        }
        session.started = false; session.starting = false;
        if (session.live) {
          update((current) => ({ ...current, started: false, starting: false, frame: null, text: "", error: true }));
          void closeAfterPending(session);
          try { failure.current?.(action); } catch { /* A consumer callback cannot expose transport failures. */ }
        }
      } finally {
        clearTimeout(timer);
        session.controller = null; session.busy = false; session.closingRequest = false; session.handbackRequest = false;
        update((current) => ({ ...current, pending: false, reading: false }));
      }
    })();
    session.pending = operation;
    void operation.finally(() => { if (session.pending === operation) session.pending = null; });
  };
  useEffect(() => {
    session.live = true;
    setView(initialView(session));
    const poll = setInterval(() => {
      if (session.live && !session.busy && !document.hidden) {
        if (session.starting) run("ready");
        else if (session.started && (session.verifying || controlMode === "remote")) run(session.verifying ? "handback" : "frame");
      }
    }, 1000);
    return () => {
      session.live = false;
      // A stop already owns the only close request; let its independent deadline finish it.
      if (!session.closingRequest && !(mode === "oci_web" && session.handbackRequest)) session.controller?.abort();
      clearInterval(poll);
      void closeAfterPending(session);
    };
  }, [session]);
  const tap = (event: MouseEvent<HTMLImageElement>) => {
    if (!shown.frame || session.busy) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    if (bounds.width <= 0 || bounds.height <= 0 || x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return;
    run("input", { type: "click", x: Math.floor(x * 800 / bounds.width), y: Math.floor(y * 600 / bounds.height) });
  };
   const disabled = !shown.started || !shown.frame || shown.pending || shown.error || shown.verifying;
   const textDisabled = !shown.started || !shown.frame || shown.error || shown.verifying || (shown.pending && !shown.reading);
  const oci = mode === "oci_cli" || mode === "oci_web";
  const provider = mode === "oci_web" ? "OCI Console" : "OCI CLI";
  return <section className="space-y-3 rounded-lg border border-border p-4" aria-label={oci ? "OCI 私有登录控制" : "假页面测试控制"}>
    {controlMode === "host" ? <p className="text-sm font-medium">请在目标 host（{hostId}）的插件专属浏览器窗口中直接操作。需要该 host 的图形桌面；完成后回到这里交还并核验。</p> : <p className="text-sm font-medium">{oci ? "仅在下方私有浏览器画面中操作 OCI 登录；文字只发送至该浏览器。" : "仅假页面测试，勿输入账号凭据"}</p>}
    {controlMode === "host" && !oci ? <p className="text-sm">仅假页面测试，勿输入账号凭据。</p> : null}
    <div className="flex flex-wrap gap-2">
      <Button type="button" disabled={startDisabled || shown.started || shown.starting || shown.pending || shown.error || shown.finished} onClick={() => run("start")}>{oci ? `开始 ${provider} 登录` : "开始假页面测试"}</Button>
      <Button type="button" variant="outline" disabled={(!shown.started && !shown.starting && !session.transport.handback) || shown.pending || shown.finished || shown.error} onClick={() => run("close")}>{oci ? `停止 ${provider} 登录` : "停止假页面测试"}</Button>
      {session.transport.renew ? <Button type="button" variant="outline" disabled={shown.pending || shown.finished || shown.error} onClick={() => run("renew")}>{oci ? "延长 OCI 控制授权" : "延长测试控制授权"}</Button> : null}
      {session.transport.handback ? <Button type="button" disabled={!shown.started || shown.pending || shown.error} onClick={() => run("handback")}>{handbackLabel ?? (oci ? "交还并核验 OCI CLI 登录" : "交还并核验测试结果")}</Button> : null}
      {controlMode === "remote" && shown.started && !shown.frame && !shown.error && !shown.verifying ? <Button type="button" variant="outline" disabled={shown.pending} onClick={() => run("frame")}>刷新私有浏览器画面</Button> : null}
    </div>
    {controlMode === "remote" && shown.frame ? <img src={`data:image/png;base64,${shown.frame.png}`} alt={oci ? "OCI 私有登录画面" : "假页面测试画面"} width={800} height={600}
      role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} draggable={false}
      onClick={tap} onKeyDown={(event) => { if (event.key === "Enter" && !disabled) { event.preventDefault(); run("input", { type: "key", key: "Enter" }); } }}
      style={{ width: "100%", maxWidth: 800, height: "auto", touchAction: "manipulation" }} /> : null}
    {controlMode === "remote" ? <>
    <label className="block space-y-1 text-sm">{oci ? "OCI 登录文字（仅发送到私有浏览器）" : "测试文字"}<Input type={oci ? "password" : "text"} autoComplete="off" value={shown.text} maxLength={256} disabled={textDisabled}
      onChange={(event) => update((current) => ({ ...current, text: event.target.value }))}
      onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} /></label>
    <Button type="button" disabled={disabled || !shown.text || shown.text.length > 256} onClick={() => run("input", { type: "text", text: shown.text })}>{oci ? "发送到 OCI 私有浏览器" : "发送测试文字"}</Button>
    <div className="flex flex-wrap gap-2">
      {(["Backspace", "Tab", "Enter", "ArrowLeft", "ArrowRight"] as const).map((key) => <Button type="button" key={key} variant="outline" disabled={disabled} onClick={() => run("input", { type: "key", key })}>{key}</Button>)}
      <Button type="button" variant="outline" disabled={disabled} onClick={() => run("input", { type: "wheel", deltaY: -300 })}>向上滚动</Button>
      <Button type="button" variant="outline" disabled={disabled} onClick={() => run("input", { type: "wheel", deltaY: 300 })}>向下滚动</Button>
    </div>
    </> : null}
    {shown.stale ? <p role="status" aria-live="polite">画面已更新，本次输入未发送。请查看新画面后重新操作。</p> : null}
    {shown.changed ? <p role="status" aria-live="polite">画面读取时发生变化。请查看新画面后继续操作。</p> : null}
    {shown.handbackError ? <p role="status" aria-live="polite">{oci ? "OCI CLI 尚未核验成功。请完成私有浏览器登录，等待 CLI 回调后重试。" : "核验未通过，请完成假页面测试后重试。"}</p> : null}
    {shown.starting && !shown.error && !shown.finished ? <p role="status" aria-live="polite">OCI 私有浏览器启动中；尚不能输入，可以停止或延长本次控制授权。</p> : null}
    {shown.verifying && !shown.error && !shown.finished ? <p role="status" aria-live="polite">正在等待 OCI CLI 回调并核验身份与资源。浏览器输入已暂停，可以停止本次登录。</p> : null}
    {shown.error ? <p role="status" aria-live="polite">{oci ? "OCI 登录控制未完成，请查看请求状态。" : "假页面测试未完成，请重新验证配对后重试。"}</p>
      : shown.finished ? <p role="status" aria-live="polite">{oci ? "本次 OCI 登录控制已结束。" : "本次假页面测试已结束。请撤销本次授权并重新验证后再开始。"}</p> : null}
  </section>;
}
