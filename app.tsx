import { useState } from "react";
import { definePluginApp, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { PairingPage } from "./pairing-page.tsx";
import { LoginStatusPage } from "./login-status.tsx";
import { LoginControlInteraction } from "./login-control.tsx";
import { ProviderCapabilitiesPage } from "./provider-capabilities.tsx";

function WaitProbe({ submit, cancel }: PluginPendingInteractionProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const finish = async (complete: boolean) => {
    if (pending) return;
    setPending(true);
    try {
      if (complete) await submit({ confirmation: "fixture-only" });
      else await cancel();
    } catch {
      setError("操作未完成，请重试。");
      setPending(false);
    }
  };
  return <div className="space-y-3 p-4">
    <p>测试等待与继续流程。此处只提交公开测试标记，请勿输入账号凭据。</p>
    <div className="flex gap-2"><Button disabled={pending} onClick={() => void finish(true)}>完成测试</Button><Button variant="outline" disabled={pending} onClick={() => void finish(false)}>取消</Button></div>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "pairing", title: "控制配对", icon: "KeyRound", path: "pairing", component: PairingPage });
  app.slots.navPanel({ id: "login-attempts", title: "登录会话", icon: "KeyRound", path: "attempts", component: LoginStatusPage });
  app.slots.navPanel({ id: "capabilities", title: "远程登录诊断", icon: "KeyRound", path: "capabilities", component: ProviderCapabilitiesPage });
  app.slots.pendingInteraction({ id: "wait-probe", component: WaitProbe });
  app.slots.pendingInteraction({ id: "login-control", component: LoginControlInteraction });
});
