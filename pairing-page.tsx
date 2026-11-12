import { useEffect, useRef, useState } from "react";
import { experimental_copyToClipboard, experimental_useServers, useBbContext, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server.ts";
import type { ControlGrant, ControlScope } from "./control-authority.ts";
import { createPairingKey } from "./pairing-key.ts";
import { postControl, probeControlChannel } from "./control-client.ts";
import { withAbort } from "./private-response.ts";
import { FixtureControls } from "./fixture-controls.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const connectivityScope = { threadId: "pairing-probe", attemptId: "connectivity-probe", browserContextId: "unopened", generation: 0 };

export function PairingPage() {
  const rpc = useRpc<typeof rpcContract>();
  const context = useBbContext();
  const servers = experimental_useServers();
  const origin = servers === null
    ? (typeof window === "undefined" ? "" : window.location.origin)
    : servers.servers.find((server) => server.active)?.origin ?? "";
  const [hosts, setHosts] = useState<{ id: string; name: string }[]>([]);
  const [hostId, setHostId] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [channel, setChannel] = useState(false);
  const [generated, setGenerated] = useState<{ key: string; fingerprint: string } | null>(null);
  const [key, setKey] = useState("");
  const [pending, setPending] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [message, setMessage] = useState("");
  const grant = useRef<{ value: ControlGrant; scope: ControlScope; hostId: string; origin: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); request.current = null; grant.current = null; }, []);
  const beginRequest = () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const timer = setTimeout(() => controller.abort(), 8000);
    return { signal: controller.signal, current: () => request.current === controller, finish: () => {
      clearTimeout(timer);
      if (request.current === controller) { request.current = null; setPending(false); }
    } };
  };
  useEffect(() => {
    const current = grant.current;
    if (!authorized || !current) return;
    const timeout = setTimeout(() => {
      if (grant.current !== current) return;
      grant.current = null; setAuthorized(false); setKey("");
      setMessage("控制授权已过期，请重新验证。");
    }, Math.min(300_000, Math.max(0, current.value.expiresAt - Date.now())));
    return () => { clearTimeout(timeout); };
  }, [authorized]);
  useEffect(() => {
    let current = true;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
    void withAbort(rpc.call("hostChoices"), controller.signal).then((choices) => {
      if (!current || controller.signal.aborted) return;
      setHosts(choices);
      if (choices.length === 1) setHostId(choices[0]!.id);
    }, () => { if (current) setMessage("无法读取 host 列表。"); }).finally(() => clearTimeout(timer));
    return () => { current = false; controller.abort(); clearTimeout(timer); };
  }, [rpc]);
  const refresh = async () => {
    if (!hostId || !origin || pending) return;
    setPending(true); setMessage(""); setChannel(false);
    const operation = beginRequest();
    try {
      const [status, connected] = await Promise.all([
        withAbort(rpc.call("controlStatus", { hostId }), operation.signal),
        probeControlChannel(origin, { hostId, scope: connectivityScope }, operation.signal),
      ]);
      operation.signal.throwIfAborted(); if (!operation.current()) return;
      setConfigured(status.provisioned); setChannel(connected);
      setMessage(connected ? "控制通道可连接，尚未授予浏览器控制权。" : "当前客户端的控制通道尚未确认，请保持 BB 登录后重试。");
    } catch { if (operation.current()) setMessage("无法检查该 host 的配对状态。"); }
    finally { operation.finish(); }
  };
  useEffect(() => {
    request.current?.abort(); request.current = null;
    grant.current = null; setAuthorized(false); setKey(""); setGenerated(null);
    setConfigured(null); setChannel(false); setMessage(""); setPending(false);
  }, [hostId, origin]);
  const generate = async () => {
    if (!hostId || pending) return;
    setPending(true); setMessage("");
    const operation = beginRequest();
    try { const value = await withAbort(createPairingKey(), operation.signal); if (operation.current()) setGenerated(value); }
    catch { if (operation.current()) setMessage("此客户端不能安全生成密钥，请更新客户端后重试。"); }
    finally { operation.finish(); }
  };
  const copy = async (value: string) => {
    try {
      const done = await experimental_copyToClipboard({ text: value });
      setMessage(done ? "已复制。" : "未能复制，请长按对应字段复制。");
    } catch { setMessage("未能复制，请长按对应字段复制。"); }
  };
  const authenticate = async () => {
    if (!hostId || !origin || !key || pending || !channel || configured !== true) return;
    const suppliedKey = key.trim(); setKey(""); setPending(true); setMessage("");
    const operation = beginRequest();
    const scope: ControlScope = {
      threadId: context.threadId ?? "pairing-probe", attemptId: crypto.randomUUID(),
      browserContextId: crypto.randomUUID(), generation: 1,
    };
    try {
      const value = await postControl(origin, "session", { hostId, scope, key: suppliedKey }, undefined, operation.signal);
      if (!value) throw new Error("Missing grant");
      await postControl(origin, "check", { hostId, scope }, value.capability, operation.signal);
      operation.signal.throwIfAborted(); if (!operation.current()) return;
      grant.current = { value, scope, hostId, origin };
      setGenerated(null); setAuthorized(true);
      setMessage("控制密钥验证通过，可开始假页面测试。OCI 登录尚未开启。");
    } catch { if (operation.current()) setMessage("控制鉴权未通过。请确认密钥、host 和配对状态；连续尝试过多时稍后再试。"); }
    finally { operation.finish(); }
  };
  const release = async () => {
    const current = grant.current;
    if (!current || pending) return;
    setPending(true);
    const operation = beginRequest();
    try {
      await postControl(current.origin, "release", { hostId: current.hostId, scope: current.scope }, current.value.capability, operation.signal);
      operation.signal.throwIfAborted(); if (!operation.current() || grant.current !== current) return;
      grant.current = null; setAuthorized(false); setMessage("本次控制授权已撤销。");
    } catch { if (operation.current()) setMessage("未确认授权已撤销，请重试；授权也会在短时限内失效。"); }
    finally { operation.finish(); }
  };
  const activeGrant = authorized ? grant.current : null;
  return <main className="h-full overflow-y-auto p-4">
    <div className="mx-auto max-w-2xl space-y-5">
      <h1 className="text-lg font-semibold">控制配对</h1>
      <p className="text-sm text-muted-foreground">为指定 host 设置独立控制密钥。它与 OCI 密码无关。</p>
      <label className="block space-y-2 text-sm">目标 host
        <select className="w-full rounded-md border border-input bg-background px-3 py-2" value={hostId} disabled={pending || authorized} onChange={(event) => setHostId(event.target.value)}>
          <option value="">选择 host</option>
          {hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={!hostId || !origin || pending || authorized} onClick={() => void refresh()}>检查连接与配对状态</Button>
        <span className="text-sm">{configured === null ? "尚未检查" : configured ? "host 已配对" : "host 尚未配对"}</span>
      </div>
      {configured === false ? <section className="space-y-3 rounded-lg border border-border p-4">
        <h2 className="font-medium">首次配对</h2>
        <p className="text-sm text-muted-foreground">密钥只在当前客户端生成。请先保存到密码管理器，再把配对指纹发给我；密钥只填写到后续安全表单，由 owner 在 host 上核对后启用。</p>
        <Button disabled={pending || !channel || generated !== null} onClick={() => void generate()}>生成控制密钥</Button>
        {generated ? <div className="space-y-3">
          <label className="block space-y-1 text-sm">控制密钥（请勿发送到聊天）<Input type="password" readOnly autoComplete="off" value={generated.key} /></label>
          <Button variant="outline" onClick={() => void copy(generated.key)}>复制密钥以安全保存</Button>
          <div className="space-y-1 text-sm"><p>配对指纹（可发给我）</p><code className="block break-all select-text text-xs">{generated.fingerprint}</code></div>
          <Button variant="outline" onClick={() => void copy(generated.fingerprint)}>复制配对指纹</Button>
        </div> : null}
      </section> : null}
      {configured === true ? <section className="space-y-3 rounded-lg border border-border p-4">
        <h2 className="font-medium">验证控制密钥</h2>
        <label className="block space-y-1 text-sm">控制密钥<Input type="password" autoComplete="off" value={key} disabled={pending || authorized} onChange={(event) => setKey(event.target.value)} /></label>
        <div className="flex flex-wrap gap-2"><Button disabled={!key || !channel || pending || authorized} onClick={() => void authenticate()}>验证配对</Button><Button variant="outline" disabled={!authorized || pending} onClick={() => void release()}>撤销本次授权</Button></div>
      </section> : null}
      {activeGrant ? <FixtureControls origin={activeGrant.origin} hostId={activeGrant.hostId} scope={activeGrant.scope} capability={activeGrant.value.capability} /> : null}
      {message ? <p role="status" aria-label="配对状态" aria-live="polite" className="text-sm">{message}</p> : null}
    </div>
  </main>;
}
