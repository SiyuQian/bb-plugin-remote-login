import { loadPluginApp, renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";

type Mount = {
  slot: "pairing" | "login-attempts" | "login-control";
  revision: number;
  context: { projectId: string; threadId: string };
  interaction: PluginPendingInteractionProps["interaction"] | null;
};
const app = loadPluginApp(() => import("../app.tsx"));
let rendered: RenderedSlot | undefined, mounting = false;
async function post(path: string, value: unknown): Promise<unknown> {
  const response = await fetch(path, { method: "POST", credentials: "include", cache: "no-store", referrerPolicy: "no-referrer",
    headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  if (!response.ok) throw new Error("Mobile fixture bridge unavailable.");
  return response.json();
}
async function mount(): Promise<void> {
  if (mounting) return;
  mounting = true;
  try {
    const response = await fetch("/__test/mount", { cache: "no-store" });
    if (!response.ok) throw new Error();
    const config = await response.json() as Mount, captured = await app;
    if (rendered) { rendered.unmount(); rendered.container.remove(); }
    const options = { pluginId: "remote-login", context: config.context, servers: null,
      rpc: Object.fromEntries(["hostChoices", "controlStatus", "loginAttempts"].map(method => [method, (input: unknown) => post("/__test/rpc", { method, input })])) };
    if (config.slot === "login-control") {
      const registration = captured.pendingInteractions.find(item => item.id === "login-control");
      if (!registration || !config.interaction) throw new Error();
      const interactionId = config.interaction.id;
      rendered = renderSlot(registration, { interaction: config.interaction,
        submit: async value => { await post("/__test/interaction/submit", { interactionId, value }); },
        cancel: async () => { await post("/__test/interaction/cancel", { interactionId }); },
      }, options);
    } else {
      const registration = captured.navPanels.find(item => item.id === config.slot);
      if (!registration) throw new Error();
      rendered = renderSlot(registration, { subPath: "" }, options);
    }
    rendered.container.setAttribute("data-bb-plugin", "remote-login");
    document.documentElement.dataset.mobileFixtureRevision = String(config.revision);
  } finally { mounting = false; }
}
function renderSelected(): void {
  void mount().catch(() => {
    const failure = document.createElement("p"); failure.setAttribute("role", "alert"); failure.textContent = "Mobile fixture mount unavailable."; document.body.append(failure);
  });
}
document.querySelector("#mobile-fixture-mount")!.addEventListener("click", renderSelected);
renderSelected();
