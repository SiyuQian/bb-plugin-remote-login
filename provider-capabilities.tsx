import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import type { rpcContract } from "./server.ts";
import { loginCapabilitiesSchema, type LoginCapabilities, type LoginCapabilityReason } from "./provider-wire.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const responseSchema = z.object({ hostId: z.string(), report: loginCapabilitiesSchema }).strict();
const failureMessage = "无法读取所选 host 的登录方式，请确认 host 在线后重试。";
const providers = {
  oci_cli: { title: "OCI CLI", limit: "在 host 的插件管理的全新浏览器中完成 CLI 会话授权；凭据留在 host 的私有会话中。" },
  oci_web: { title: "OCI Console", limit: "在 host 的插件管理的全新浏览器中登录 Console；它与 CLI 会话分开核验，不支持外部联合 SSO。" },
  oci_identity_domain_device: { title: "OCI Identity Domains device flow", limit: "设备代码授权尚未配置，不能替代 OCI CLI 或 Console 登录。" },
  oci_phone_callback: { title: "手机回调转发", limit: "不转发手机浏览器回调；请使用受保护的 host 浏览器流程。" },
};
const reasons: Record<LoginCapabilityReason, string> = {
  platform_unsupported: "此主机不在支持范围内，仅支持 macOS arm64。",
  browser_pin_unmatched: "Chrome 版本与固定验证版本不匹配。",
  process_inspection_unavailable: "无法确认浏览器进程归属。",
  cli_source_unmatched: "OCI CLI 源码与已审核版本不匹配。",
  provider_not_configured: "此登录方式尚未配置。",
  callback_not_supported: "当前未支持手机回调转发。",
};
type Listing = { hostId: string; status: "pending" | "error" } | { hostId: string; status: "ready"; report: LoginCapabilities };
type Request = { controller: AbortController; timeout: ReturnType<typeof setTimeout> };

export function ProviderCapabilitiesPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [hostId, setHostId] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const request = useRef<Request | null>(null);
  // SDK RPC has no AbortSignal option; abort fences late results and clears presentation timers.
  const cancelRequest = () => {
    if (!request.current) return;
    request.current.controller.abort();
    clearTimeout(request.current.timeout);
    request.current = null;
  };
  useEffect(() => cancelRequest, []);
  const selectedHost = hostId.trim();
  const current = listing?.hostId === selectedHost ? listing : null;
  const pending = current?.status === "pending";
  const inspect = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedHost || selectedHost.length > 200 || request.current) return;
    const controller = new AbortController();
    setListing({ hostId: selectedHost, status: "pending" });
    const timeout = setTimeout(() => {
      controller.abort();
      request.current = null;
      setListing({ hostId: selectedHost, status: "error" });
    }, 8_000);
    request.current = { controller, timeout };
    try {
      const result = responseSchema.safeParse(await rpc.call("loginCapabilities", { hostId: selectedHost }));
      if (controller.signal.aborted) return;
      if (!result.success || result.data.hostId !== selectedHost) throw new Error("Invalid capabilities");
      setListing({ hostId: selectedHost, status: "ready", report: result.data.report });
    } catch {
      if (!controller.signal.aborted) setListing({ hostId: selectedHost, status: "error" });
    } finally {
      clearTimeout(timeout);
      if (request.current?.controller === controller) request.current = null;
    }
  };
  return <main className="h-full overflow-y-auto p-4">
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-lg font-semibold">远程登录方式诊断</h1>
      <p className="text-sm text-muted-foreground">检查指定 host 的运行时条件。真实手机控制、账号登录和原任务恢复尚未验收。</p>
      <form onSubmit={inspect} className="space-y-2">
        <label htmlFor="capabilities-host" className="block text-sm">目标 host ID</label>
        <Input id="capabilities-host" value={hostId} maxLength={200} autoCapitalize="none" spellCheck={false} required onChange={(event) => {
          cancelRequest(); setListing(null); setHostId(event.target.value);
        }} />
        <Button type="submit" className="w-full sm:w-auto" disabled={pending || !selectedHost || selectedHost.length > 200}>{pending ? "检查中…" : "检查登录方式"}</Button>
      </form>
      <p className="text-sm text-muted-foreground">当前固定验证环境：macOS arm64、Chrome 157.0.8103.51、Puppeteer 25.16.0、Sydney（ap-sydney-1）/ oc1。</p>
      <p className="text-sm text-muted-foreground">开始前还需完成控制配对，并确认预期账号。环境检查不代表已登录。</p>
      {pending ? <p role="status" aria-live="polite" className="text-sm">正在检查所选 host…</p> : null}
      {current?.status === "error" ? <p role="alert" className="text-sm text-destructive">{failureMessage}</p> : null}
      {current?.status === "ready" ? <section className="space-y-3" aria-label="所选 host 报告">
        <p className="break-all text-sm">报告 host：{current.hostId}</p>
        <ul aria-label="登录方式能力" className="space-y-3">
          {current.report.providers.map((provider) => <li key={provider.id} className="space-y-2 rounded-lg border border-border p-4">
            <h2 className="font-medium">{providers[provider.id].title}</h2>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              <dt>方式</dt><dd>{provider.method === "host_browser" ? "host 私有浏览器" : provider.method === "device_code" ? "设备代码授权" : "手机回调"}</dd>
              <dt>运行时</dt><dd>{provider.availability === "candidate" ? "环境检查通过" : "暂不可用"}</dd>
              <dt>实际验收</dt><dd>尚未验收</dd>
            </dl>
            <p className="text-sm text-muted-foreground">{providers[provider.id].limit}</p>
            {provider.reasons.length > 0 ? <ul className="list-disc space-y-1 pl-5 text-sm">
              {provider.reasons.map((reason) => <li key={reason}>{reasons[reason]}</li>)}
            </ul> : null}
          </li>)}
        </ul>
      </section> : null}
    </div>
  </main>;
}
