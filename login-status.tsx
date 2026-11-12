import { useEffect, useState, type JSX } from "react";
import { useBbContext, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.ts";
import type { AttemptPhase, LoginAttempt, LoginMode } from "./login-protocol.ts";
import { Button } from "@/components/ui/button";
import { canControlLogin, LoginControls } from "./login-control.tsx";

const modes: Record<LoginMode, string> = { synthetic: "测试", oci_cli: "OCI 命令行授权", oci_web: "OCI 网页登录" };
const phases: Record<AttemptPhase, string> = {
  awaiting_pairing: "等待配对", awaiting_control: "等待控制", checking_existing: "检查已有会话", starting: "启动中", user_control: "用户控制中",
  verifying: "核验中", verified: "已核验", cancelled: "已取消", expired: "已过期", failed: "未完成", unsupported: "暂不支持",
};
const resumes: Record<LoginAttempt["resume"]["state"], string> = {
  none: "未请求恢复", pending: "等待恢复", claimed: "恢复结果待确认", uncertain: "恢复结果待确认", delivered: "恢复已确认送达",
};
type Listing = { threadId: string | null; status: "loading" | "ready" | "error"; attempts: LoginAttempt[] };

function Timestamp({ value }: { value: number }) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? <time dateTime={date.toISOString()}>{date.toLocaleString("zh-CN")}</time>
    : <span>时间不可用</span>;
}

/** Persistent attempt history for the SDK-selected thread. */
export function LoginStatusPage(): JSX.Element {
  const { threadId } = useBbContext();
  const rpc = useRpc<typeof rpcContract>();
  const [refresh, setRefresh] = useState(0);
  const [selection, setSelection] = useState<{ threadId: string; attemptId: string } | null>(null);
  const [listing, setListing] = useState<Listing>({ threadId: null, status: "loading", attempts: [] });
  useEffect(() => { setSelection(null); }, [threadId]);
  useEffect(() => {
    if (!threadId) return;
    const controller = new AbortController();
    setListing({ threadId, status: "loading", attempts: [] });
    const timeout = setTimeout(() => {
      controller.abort();
      setListing({ threadId, status: "error", attempts: [] });
    }, 8_000);
    void (async () => {
      try {
        const attempts = await rpc.call("loginAttempts", { threadId });
        if (!controller.signal.aborted) setListing({ threadId, status: "ready", attempts: attempts.filter((attempt) => attempt.threadId === threadId) });
      } catch {
        if (!controller.signal.aborted) setListing({ threadId, status: "error", attempts: [] });
      } finally { clearTimeout(timeout); }
    })();
    // The SDK RPC has no AbortSignal option; abort prevents consuming its result.
    return () => { controller.abort(); clearTimeout(timeout); };
  }, [rpc, threadId, refresh]);
  const current = listing.threadId === threadId ? listing : null;
  const loading = current === null || current.status === "loading";
  return <main className="h-full overflow-y-auto p-4">
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-lg font-semibold">登录请求状态</h1>
      {!threadId ? <p>请选择一个 thread 查看登录请求。</p> : <>
        <p className="text-sm text-muted-foreground">查看当前 thread 的请求，可接管合成测试、受保护的 OCI CLI 或 Console 授权。核验与恢复结果分别记录；完成记录不会公开账号或浏览器引用。</p>
        <Button type="button" variant="outline" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>刷新</Button>
        {loading ? <p role="status">读取中…</p> : null}
        {current?.status === "error" ? <p role="alert">暂时无法读取登录请求，请稍后刷新。</p> : null}
        {current?.status === "ready" && current.attempts.length === 0 ? <p>当前 thread 暂无登录请求。</p> : null}
        {current?.status === "ready" && current.attempts.length > 0 ? <ul aria-label="登录请求" className="space-y-3">
          {current.attempts.map((attempt) => <li key={attempt.attemptId} className="rounded-lg border p-3">
            <h2 className="font-medium">{modes[attempt.mode]}</h2>
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              <dt>状态</dt><dd>{phases[attempt.phase]}</dd>
              <dt>配对</dt><dd>{attempt.principalId === null ? "尚未配对" : "已配对"}</dd>
              <dt>Host</dt><dd className="break-all">{attempt.hostId}</dd>
              <dt>创建</dt><dd><Timestamp value={attempt.createdAt} /></dd>
              <dt>期限</dt><dd><Timestamp value={attempt.expiresAt} /></dd>
              <dt>恢复</dt><dd>{resumes[attempt.resume.state]}</dd>
            </dl>
            {canControlLogin(attempt) ? <Button type="button" variant="outline" className="mt-3" onClick={() => setSelection({ threadId, attemptId: attempt.attemptId })}>{attempt.mode === "oci_web" ? "接管 OCI Console 授权" : attempt.mode === "oci_cli" ? "接管 OCI 授权" : "接管测试"}</Button> : null}
          </li>)}
        </ul> : null}
        {selection?.threadId === threadId ? <section className="space-y-3 rounded-lg border p-3">
          <Button type="button" variant="outline" onClick={() => setSelection(null)}>关闭登录控制</Button>
          <LoginControls attemptId={selection.attemptId} />
        </section> : null}
      </>}
    </div>
  </main>;
}
