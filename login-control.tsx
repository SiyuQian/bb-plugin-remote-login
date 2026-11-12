import { useEffect, useMemo, useRef, useState } from "react";
import { experimental_useServers, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import type { ControlGrant } from "./control-authority.ts";
import type { AttemptPhase, LoginAttempt } from "./login-protocol.ts";
import { postLogin, type OciLoginStatus } from "./login-client.ts";
import { cliExpectedIdentitySchema } from "./oci-cli-protocol.ts";
import { consoleExpectedIdentitySchema } from "./oci-console-protocol.ts";
import { FixtureControls, type FixtureTransport } from "./fixture-controls.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";

const payloadSchema = z.object({ attemptId: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/) }).strict();
const phases: Record<AttemptPhase, string> = {
  awaiting_pairing: "等待配对", awaiting_control: "等待控制", checking_existing: "检查已有会话", starting: "启动中", user_control: "用户控制中",
  verifying: "核验中", verified: "已核验", cancelled: "已取消", expired: "已过期", failed: "未完成", unsupported: "暂不支持",
};
type Session = { attemptId: string; origin: string; live: boolean; controller: AbortController | null; verified: boolean; completing: boolean; authorizing: boolean; cancelling: boolean; proof: ControlGrant | null; binding: LoginAttempt | null; hardDeadline: number; controlling: boolean; ociReady: boolean; started: boolean };
type View = {
  session: Session; attempt: LoginAttempt | null; grant: ControlGrant | null; key: string; pending: boolean;
  expired: boolean; message: string; phase: AttemptPhase | null; completion: "none" | "pending" | "error" | "done";
  stopped: boolean | null; cancellation: "none" | "pending" | "error" | "done";
  oci: OciLoginStatus | null; tenancyOcid: string; userOcid: string; region: string; domainOcid: string; domainOrigin: string;
};
const initial = (session: Session): View => ({ session, attempt: null, grant: null, key: "", pending: false, expired: false, message: "", phase: null, completion: "none", stopped: null, cancellation: "none", oci: null, tenancyOcid: "", userOcid: "", region: "", domainOcid: "", domainOrigin: "" });
export const canControlLogin = (attempt: LoginAttempt): boolean => attempt.expiresAt > Date.now()
  && (["awaiting_pairing", "awaiting_control"].includes(attempt.phase) || (attempt.mode === "oci_web" && attempt.phase === "verifying"));

/** The native interaction and history page share this private, memory-only controller. */
export function LoginControls({ attemptId, onComplete, onCancel }: { attemptId: string; onComplete?: () => Promise<void>; onCancel?: () => Promise<void> }) {
  const servers = experimental_useServers();
  const origin = servers === null ? (typeof window === "undefined" ? "" : window.location.origin)
    : servers.servers.find((server) => server.active)?.origin ?? "";
  const [refresh, setRefresh] = useState(0);
  const session = useMemo<Session>(() => ({ attemptId, origin, live: true, controller: null, verified: false, completing: false, authorizing: false, cancelling: false, proof: null, binding: null, hardDeadline: 0, controlling: false, ociReady: false, started: false }), [attemptId, origin, refresh]);
  const completion = useRef(onComplete); completion.current = onComplete;
  const cancellation = useRef(onCancel); cancellation.current = onCancel;
  const [view, setView] = useState(() => initial(session));
  const shown = view.session === session ? view : initial(session);
  const consoleLogin = shown.attempt?.mode === "oci_web";
  const oci = shown.attempt?.mode === "oci_cli" || consoleLogin;
  const provider = consoleLogin ? "OCI Console" : "OCI CLI";
  const update = (change: (current: View) => View) => {
    if (session.live) setView((current) => current.session === session ? change(current) : current);
  };
  useEffect(() => {
    session.live = true;
    setView({ ...initial(session), pending: Boolean(origin), message: origin ? "" : "请选择当前 BB 服务器后重试。" });
    if (!origin) return () => { session.live = false; };
    const controller = new AbortController(); session.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    void postLogin(origin, "status", { attemptId }, undefined, controller.signal).then((attempt) => {
      if (attempt.attemptId !== attemptId) throw new Error();
      session.verified = attempt.phase === "verified" && attempt.resume.state === "pending" && attempt.expiresAt > Date.now();
      update((current) => ({ ...current, attempt, phase: attempt.phase }));
    }).catch(() => update((current) => ({ ...current, message: "暂时无法读取登录请求，请重新打开。" })))
      .finally(() => { clearTimeout(timeout); update((current) => ({ ...current, pending: false })); });
    return () => { session.live = false; controller.abort(); session.controller?.abort(); clearTimeout(timeout); };
  }, [session]);
  useEffect(() => {
    if (!shown.grant || !shown.attempt) return;
    const expiring = shown.grant;
    const timeout = setTimeout(() => {
      if (session.proof !== expiring) return;
      session.controlling = false;
      update((current) => ({ ...current, grant: null, key: "", tenancyOcid: "", userOcid: "", region: "", domainOcid: "", domainOrigin: "", expired: true, message: "控制授权已过期，请重新发起请求。" }));
    }, Math.max(0, Math.min(shown.grant.expiresAt, shown.attempt.expiresAt, session.hardDeadline) - Date.now()));
    return () => clearTimeout(timeout);
  }, [session, shown.grant, shown.attempt]);
  const authenticate = async () => {
    if (session.authorizing || shown.pending || shown.grant || !shown.key || !origin || !shown.attempt || !canControlLogin(shown.attempt) || shown.expired) return;
    session.authorizing = true;
    const suppliedKey = shown.key.trim();
    update((current) => ({ ...current, key: "", pending: true, message: "" }));
    const controller = new AbortController(); session.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const value = await postLogin(origin, "session", { attemptId, key: suppliedKey }, undefined, controller.signal);
      if (value.attempt.attemptId !== attemptId || !canControlLogin(value.attempt)
        || (["hostId", "threadId", "environmentId", "browserContextId", "generation", "mode"] as const).some((field) => value.attempt[field] !== shown.attempt![field])) throw new Error();
      if (!session.live || controller.signal.aborted || value.grant.expiresAt <= Date.now()
        || value.grant.expiresAt > value.attempt.expiresAt || value.grant.expiresAt > Date.now() + 300_000) throw new Error();
      session.proof = value.grant; session.binding = value.attempt; session.controlling = true;
      session.hardDeadline = Math.min(value.grant.expiresAt + 600_000, value.attempt.expiresAt);
      update((current) => ({ ...current, attempt: value.attempt, phase: value.attempt.phase, grant: value.grant, message: "已验证控制密钥。每次授权最长五分钟，可手动续期，累计最长十五分钟。" }));
      if (value.attempt.mode !== "synthetic") await readOciStatus(value.grant.capability, controller.signal);
    } catch { update((current) => ({ ...current, message: oci ? "OCI 控制鉴权未通过。请确认主机控制根已配置，并检查密钥和请求状态。" : "测试控制鉴权未通过，请确认密钥和请求状态后重试。" })); }
    finally { clearTimeout(timeout); session.authorizing = false; update((current) => ({ ...current, pending: false })); }
  };
  const readOciStatus = async (capability: string, signal: AbortSignal) => {
    const status = await postLogin(origin, session.binding?.mode === "oci_web" ? "console-status" : "oci-status", { attemptId }, capability, signal);
    if (!session.live || !session.controlling || signal.aborted) throw new Error();
    session.ociReady = status.configured && status.phoneControlAccepted && status.phase === "ready" && status.failure === null;
    update((current) => ({ ...current, oci: status }));
  };
  const expected = consoleLogin ? consoleExpectedIdentitySchema.safeParse({ mode: "oci_web", tenancyOcid: shown.tenancyOcid.trim(), userOcid: shown.userOcid.trim(),
    domainOcid: shown.domainOcid.trim(), domainOrigin: shown.domainOrigin.trim(), region: "ap-sydney-1", realm: "oc1" })
    : cliExpectedIdentitySchema.safeParse({ mode: "oci_cli", tenancyOcid: shown.tenancyOcid.trim(), userOcid: shown.userOcid.trim(), region: shown.region.trim(), realm: "oc1" });
  const configureOci = async () => {
    if (!oci || !expected.success || session.authorizing || shown.pending || !session.proof || shown.oci?.configured || !shown.oci?.phoneControlAccepted || shown.oci.failure !== null || shown.expired) return;
    session.authorizing = true;
    const selected = expected.data;
    const capability = session.proof.capability;
    update((current) => ({ ...current, tenancyOcid: "", userOcid: "", region: "", domainOcid: "", domainOrigin: "", pending: true, message: "" }));
    const controller = new AbortController(); session.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      await postLogin(origin, consoleLogin ? "console-target" : "oci-target", { attemptId, expected: selected }, capability, controller.signal);
      await readOciStatus(capability, controller.signal);
      update((current) => ({ ...current, message: `已私下绑定 ${provider} 目标；账号标识不会写入等待卡片。` }));
    } catch { update((current) => ({ ...current, message: `${provider} 目标尚未确认，请检查私有控制状态后重试。` })); }
    finally { clearTimeout(timeout); session.authorizing = false; update((current) => ({ ...current, pending: false })); }
  };
  const refreshOci = async () => {
    if (!oci || session.authorizing || shown.pending || !session.proof || shown.expired || session.started) return;
    session.authorizing = true;
    update((current) => ({ ...current, pending: true }));
    const controller = new AbortController(); session.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try { await readOciStatus(session.proof.capability, controller.signal); }
    catch { session.ociReady = false; update((current) => ({ ...current, oci: null, message: "无法确认 OCI 启动条件，请重试检查。" })); }
    finally { clearTimeout(timeout); session.authorizing = false; update((current) => ({ ...current, pending: false })); }
  };
  const finish = async () => {
    if (!session.live || !session.verified || session.completing) return;
    session.completing = true;
    update((current) => ({ ...current, completion: "pending" }));
    try {
      await completion.current?.();
      update((current) => ({ ...current, completion: "done", message: completion.current
        ? "登录结果已核验。恢复送达状态请查看登录请求列表。"
        : "登录结果已核验。请返回原始等待卡片提交完成标记，再查看恢复状态。" }));
    } catch { update((current) => ({ ...current, completion: "error", message: "登录结果已核验，完成标记尚未确认提交。" })); }
    finally { session.completing = false; }
  };
  const settleCancellation = async (explicitStop = false, cancel = cancellation.current) => {
    if ((!session.live && !explicitStop) || session.verified || session.cancelling) return;
    session.cancelling = true;
    update((current) => ({ ...current, cancellation: "pending" }));
    try {
      await cancel?.();
      update((current) => ({ ...current, cancellation: "done", message: current.stopped === false
        ? "等待已结束；浏览器清理尚未确认，请查看请求状态。"
        : cancel ? "登录等待已结束。" : "登录控制已停止，请刷新登录请求列表查看状态。" }));
    } catch { update((current) => ({ ...current, cancellation: "error", message: "结束等待尚未确认，请重试。" })); }
    finally { session.cancelling = false; }
  };
  const grant = shown.grant;
  const transport = useMemo<FixtureTransport>(() => {
    const proof = () => {
      if (!session.live || !session.controlling || !session.proof || Date.now() >= Math.min(session.proof.expiresAt, session.hardDeadline)) throw new Error();
      return session.proof.capability;
    };
    const close = async (capability: string, signal: AbortSignal) => postLogin(origin, "close", { attemptId }, capability, signal);
    return {
      start: async (signal) => {
        if (session.binding?.mode !== "synthetic" && !session.ociReady) throw new Error();
        session.started = true;
        update((current) => ({ ...current, phase: "starting" }));
        const result = await postLogin(origin, "start", { attemptId }, proof(), signal);
        if ("pending" in result) {
          if (session.binding?.mode === "synthetic") throw new Error();
        } else update((current) => ({ ...current, phase: "user_control" }));
        return result;
      },
      readyStatus: async (signal) => {
        if (!session.binding || session.binding.mode === "synthetic") throw new Error();
        const status = await postLogin(origin, session.binding.mode === "oci_web" ? "console-status" : "oci-status", { attemptId }, proof(), signal);
        if (!status.configured || !status.phoneControlAccepted || status.failure !== null) throw new Error();
        if (status.phase === "starting") return false;
        if (status.phase !== "user_control") throw new Error();
        update((current) => ({ ...current, phase: "user_control" }));
        return true;
      },
      frame: (signal) => postLogin(origin, "frame", { attemptId }, proof(), signal),
      input: (event, signal, frameRef) => postLogin(origin, "input", { attemptId, event, frameRef }, proof(), signal),
      close: async (signal) => {
        session.controlling = false;
        const current = session.proof; session.proof = null;
        if (!current) return;
        const result = await close(current.capability, signal);
        update((current) => ({ ...current, phase: "cancelled" }));
        return result;
      },
      handback: async (signal) => {
        const result = await postLogin(origin, "handback", { attemptId }, proof(), signal);
        if (session.binding?.mode !== "oci_web") signal.throwIfAborted();
        if ("pending" in result) { update((current) => ({ ...current, phase: "verifying" })); return result; }
        session.controlling = false; session.proof = null;
        update((current) => ({ ...current, phase: "verified" }));
        return result;
      },
      renew: async (signal) => {
        const previous = session.proof;
        const received = postLogin(origin, "renew", { attemptId }, proof(), signal).then(async (renewed) => {
          if (!session.live || !session.controlling || signal.aborted || session.proof !== previous || !session.binding
            || renewed.capability === previous?.capability || renewed.expiresAt <= Date.now()
            || renewed.expiresAt > Math.min(Date.now() + 300_000, session.hardDeadline, session.binding.expiresAt)) {
            session.controlling = false; session.proof = null;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            try { await close(renewed.capability, controller.signal); } catch { /* Cleanup remains unconfirmed. */ }
            finally { clearTimeout(timeout); }
            throw new Error();
          }
          // Cleanup must own the new proof even if the viewer leaves before its continuation.
          session.proof = renewed;
          return renewed;
        });
        return new Promise<ControlGrant>((resolve, reject) => {
          const abort = () => { session.controlling = false; reject(new Error()); };
          signal.addEventListener("abort", abort, { once: true });
          void received.then((renewed) => { signal.removeEventListener("abort", abort); resolve(renewed); },
            (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); });
          if (signal.aborted) abort();
        });
      },
    };
  }, [session]);
  const stopUnstartedOci = async () => {
    if (!session.live || session.authorizing || session.started || !session.proof || shown.pending) return;
    session.authorizing = true;
    const cancel = onCancel;
    update((current) => ({ ...current, pending: true, tenancyOcid: "", userOcid: "", region: "", domainOcid: "", domainOrigin: "" }));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      await transport.close(controller.signal);
      update((current) => ({ ...current, grant: null, stopped: true }));
      await settleCancellation(true, cancel);
    } catch { update((current) => ({ ...current, grant: null, stopped: false, message: "OCI 控制已停止，浏览器清理尚未确认。可结束等待并查看请求状态。" })); }
    finally { clearTimeout(timeout); session.authorizing = false; update((current) => ({ ...current, pending: false })); }
  };
  const acceptRenewal = (renewed: ControlGrant) => {
    if (!session.live || !session.controlling || session.proof !== renewed) throw new Error();
    update((current) => ({ ...current, grant: renewed, message: "控制授权已续期；累计最长十五分钟，并受原请求截止时间限制。" }));
  };
  const usable = shown.attempt && canControlLogin(shown.attempt) && !shown.expired && !session.verified && shown.stopped === null && shown.cancellation === "none";
  return <section className="space-y-3" aria-label={oci ? "OCI 登录控制" : "登录测试控制"}>
    <p className="text-sm">{consoleLogin ? "OCI Console 登录：需要已配置的主机控制根、私有目标和手机控制验收。账号登录只在私有浏览器中进行；交还后由主机在同一浏览器上下文核验身份。" : oci ? "OCI CLI 登录：需要已配置的主机控制根、私有目标和手机控制验收。账号登录只在私有浏览器中进行；交还后由主机独立核验 CLI 身份与资源。" : "合成登录控制原型：仅操作固定假页面，请勿输入真实账号凭据。每次授权最长五分钟，可手动续期，累计最长十五分钟。"}</p>
    <Button type="button" variant="outline" disabled={shown.pending || grant !== null || shown.completion === "pending" || shown.cancellation === "pending"}
      onClick={() => { if (!session.authorizing && !grant) setRefresh((value) => value + 1); }}>{oci ? "刷新 OCI 请求状态" : "刷新测试状态"}</Button>
    {shown.attempt ? <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm" aria-label="绑定的登录请求">
      <dt>Host</dt><dd className="break-all">{shown.attempt.hostId}</dd>
      <dt>工作环境</dt><dd className="break-all">{shown.attempt.environmentId}</dd>
      <dt>Thread</dt><dd className="break-all">{shown.attempt.threadId}</dd>
      <dt>浏览器上下文</dt><dd className="break-all">{shown.attempt.browserContextId}</dd>
      <dt>模式</dt><dd>{shown.attempt.mode === "oci_cli" ? "OCI CLI" : shown.attempt.mode === "synthetic" ? "Synthetic" : "OCI Console"}</dd>
      <dt>状态</dt><dd>{shown.phase ? phases[shown.phase] : "读取中"}</dd>
    </dl> : null}
    {shown.pending && !shown.attempt ? <p role="status">读取登录请求中…</p> : null}
    {shown.attempt && !usable && !session.verified ? <p>此请求当前不能接管，请查看登录请求状态。</p> : null}
    {usable ? <div className="space-y-2">
      <label className="block space-y-1 text-sm">控制密钥<Input type="password" autoComplete="off" value={shown.key} disabled={shown.pending || grant !== null}
        onChange={(event) => update((current) => ({ ...current, key: event.target.value }))} /></label>
      <Button type="button" disabled={shown.pending || grant !== null || !shown.key} onClick={() => void authenticate()}>{oci ? "验证 OCI 控制密钥" : "验证并接管测试"}</Button>
    </div> : null}
    {oci && grant && !shown.expired ? <div className="space-y-2" aria-label={`私有 ${provider} 目标`}>
      {!shown.oci?.configured ? <>
        <p className="text-sm">请输入已独立确认的目标身份。Realm 固定为 oc1；提交后清空这些输入。</p>
        <label className="block space-y-1 text-sm">目标 Tenancy OCID<Input type="password" autoComplete="off" value={shown.tenancyOcid} disabled={shown.pending} onChange={(event) => update((current) => ({ ...current, tenancyOcid: event.target.value }))} /></label>
        <label className="block space-y-1 text-sm">目标 User OCID<Input type="password" autoComplete="off" value={shown.userOcid} disabled={shown.pending} onChange={(event) => update((current) => ({ ...current, userOcid: event.target.value }))} /></label>
        {consoleLogin ? <>
          <label className="block space-y-1 text-sm">目标 Domain OCID<Input type="password" autoComplete="off" value={shown.domainOcid} disabled={shown.pending} onChange={(event) => update((current) => ({ ...current, domainOcid: event.target.value }))} /></label>
          <label className="block space-y-1 text-sm">目标 Domain Origin<Input type="password" autoComplete="off" value={shown.domainOrigin} disabled={shown.pending} onChange={(event) => update((current) => ({ ...current, domainOrigin: event.target.value }))} /></label>
        </> : null}
        <label className="block space-y-1 text-sm">目标 Region<Input autoComplete="off" value={consoleLogin ? "ap-sydney-1" : shown.region} readOnly={consoleLogin} disabled={shown.pending} onChange={(event) => update((current) => ({ ...current, region: event.target.value }))} /></label>
        <Button type="button" disabled={shown.pending || !expected.success || !shown.oci?.phoneControlAccepted || shown.oci.failure !== null} onClick={() => void configureOci()}>确认私有 {provider} 目标</Button>
      </> : <p>已绑定私有 {provider} 目标。</p>}
      {!shown.oci?.phoneControlAccepted ? <p>手机控制验收尚未通过。请先完成配对控制通道的合成测试，再检查 OCI 启动条件。</p> : null}
      {shown.oci?.failure ? <p>OCI 主机条件未就绪，请查看请求状态。</p> : null}
      <Button type="button" variant="outline" disabled={shown.pending || session.started} onClick={() => void refreshOci()}>检查 OCI 启动条件</Button>
      {!shown.oci?.configured ? <Button type="button" variant="outline" disabled={shown.pending} onClick={() => void stopUnstartedOci()}>停止 {provider} 登录</Button> : null}
    </div> : null}
    {oci && grant && shown.oci?.configured ? <p className="text-sm">{consoleLogin
      ? "点击“交还并授权只读”并通过主机核验后，原任务可在同一浏览器上下文执行 read_identity 和 read_page，只读取当前页面的标题与标题层级。主机会保留该浏览器；不授权表单、输入、Cookie 或截图访问。交还会暂停浏览器输入。"
      : "点击“交还并授权只读”并通过主机核验后，原任务可只读列出此账号的 compartments 和悉尼（ap-sydney-1）区域实例。交还会暂停浏览器输入。"}</p> : null}
    {grant && shown.attempt && transport && (!oci || shown.oci?.configured) ? <FixtureControls origin={origin} hostId={shown.attempt.hostId} scope={shown.attempt} capability={grant.capability}
      mode={consoleLogin ? "oci_web" : oci ? "oci_cli" : "synthetic"} startDisabled={oci && (!session.ociReady || shown.pending)}
      initialVerifying={consoleLogin && shown.oci?.phase === "verifying"}
      handbackLabel={oci ? "交还并授权只读" : undefined}
      transport={transport} onRenewed={acceptRenewal} onVerified={() => { session.verified = true; update((current) => ({ ...current, grant: null, key: "" })); void finish(); }}
      onStopped={() => { update((current) => ({ ...current, grant: null, key: "", stopped: true })); void settleCancellation(true, onCancel); }}
      onFailure={(action) => { session.controlling = false; update((current) => ({ ...current, grant: null, key: "", stopped: false, message: action === "input"
        ? "输入回执未确认；输入可能已执行，控制已停止。请勿直接重发，浏览器清理尚未确认。可结束等待并查看请求状态。"
        : "登录控制未完成，浏览器清理尚未确认。可结束等待并查看请求状态。" })); }} /> : null}
    {session.verified && shown.completion === "none" && onComplete ? <Button type="button" onClick={() => void finish()}>{oci ? "提交已核验 OCI 完成" : "提交已核验测试完成"}</Button> : null}
    {shown.completion === "error" ? <Button type="button" onClick={() => void finish()}>{oci ? "重试提交 OCI 完成" : "重试提交测试完成"}</Button> : null}
    {onCancel && !session.verified && !grant && shown.cancellation !== "pending" && shown.cancellation !== "done"
      ? <Button type="button" variant="outline" onClick={() => void settleCancellation()}>{shown.stopped === false ? "取消等待（清理未确认）" : shown.cancellation === "error" ? "重试结束等待" : "取消等待"}</Button> : null}
    {shown.message ? <p role="status" aria-live="polite">{shown.message}</p> : null}
  </section>;
}

export function LoginControlInteraction({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const parsed = payloadSchema.safeParse(interaction.payload);
  if (!parsed.success) return <p role="alert">登录请求无效，请重新发起。</p>;
  const { attemptId } = parsed.data;
  return <div className="p-4"><LoginControls attemptId={attemptId} onComplete={() => submit({ attemptId })} onCancel={cancel} /></div>;
}
