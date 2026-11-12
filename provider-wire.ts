import { z } from "zod";

const reason = z.enum(["platform_unsupported", "browser_pin_unmatched", "process_inspection_unavailable", "cli_source_unmatched", "provider_not_configured", "callback_not_supported"]);
export type LoginCapabilityReason = z.infer<typeof reason>;
const entry = z.object({
  id: z.enum(["oci_cli", "oci_web", "oci_identity_domain_device", "oci_phone_callback"]),
  method: z.enum(["host_browser", "device_code", "phone_callback"]),
  availability: z.enum(["candidate", "unavailable"]), reasons: z.array(reason).max(6), acceptance: z.literal("not_accepted"),
}).strict();
export const loginCapabilitiesSchema = z.object({ version: z.literal(1), providers: z.tuple([entry, entry, entry, entry]) }).strict().superRefine((value, context) => {
  const ids = ["oci_cli", "oci_web", "oci_identity_domain_device", "oci_phone_callback"];
  const methods = ["host_browser", "host_browser", "device_code", "phone_callback"];
  for (let i = 0; i < value.providers.length; i++) {
    const p = value.providers[i]!;
    if (p.id !== ids[i] || p.method !== methods[i] || new Set(p.reasons).size !== p.reasons.length
      || (p.availability === "candidate" ? p.reasons.length !== 0 : p.reasons.length === 0)
      || (i >= 2 && (p.availability !== "unavailable" || p.reasons.length !== 1
        || p.reasons[0] !== (i === 2 ? "provider_not_configured" : "callback_not_supported")))) {
      context.addIssue({ code: "custom", message: "Invalid method capability" });
    }
  }
});
export type LoginCapabilities = z.infer<typeof loginCapabilitiesSchema>;
