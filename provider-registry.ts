import { loginCapabilitiesSchema, type LoginCapabilities, type LoginCapabilityReason } from "./provider-wire.ts";

type Runtime = { platform: string; architecture: string; chromeVersion: string | null; processInspection: boolean; cliSourceMatched: boolean };

/** Runtime candidates may queue; ownership, phone, target and live identity gates remain mandatory. */
export function assessLoginCapabilities(runtime: Runtime): LoginCapabilities {
  const common: LoginCapabilityReason[] = [];
  if (runtime.platform !== "darwin" || runtime.architecture !== "arm64") common.push("platform_unsupported");
  if (runtime.chromeVersion !== "157.0.8103.50") common.push("browser_pin_unmatched");
  if (!runtime.processInspection) common.push("process_inspection_unavailable");
  const cli = [...common]; if (!runtime.cliSourceMatched) cli.push("cli_source_unmatched");
  const candidate = (id: "oci_cli" | "oci_web", reasons: LoginCapabilityReason[]) => ({ id, method: "host_browser" as const,
    availability: reasons.length ? "unavailable" as const : "candidate" as const, reasons, acceptance: "not_accepted" as const });
  return loginCapabilitiesSchema.parse({ version: 1, providers: [candidate("oci_cli", cli), candidate("oci_web", [...common]),
    { id: "oci_identity_domain_device", method: "device_code", availability: "unavailable", reasons: ["provider_not_configured"], acceptance: "not_accepted" },
    { id: "oci_phone_callback", method: "phone_callback", availability: "unavailable", reasons: ["callback_not_supported"], acceptance: "not_accepted" },
  ] });
}
