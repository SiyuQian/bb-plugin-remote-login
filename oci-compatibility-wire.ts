import { z } from "zod";

/** Browser-safe non-secret source inventory; neither provider can be enabled here. */
export const ociCompatibilityReportSchema = z.object({
  pin: z.literal("oci-3.88.0/cpython-3.14.6"),
  sourceCompatibility: z.enum(["matched", "unrecognized"]),
  versionMatches: z.boolean(),
  fingerprints: z.object({
    launcher: z.boolean(), bootstrap: z.boolean(), session: z.boolean(), pythonBrowser: z.boolean(),
  }).strict(),
  protocol: z.object({
    browserHook: z.literal("python_webbrowser_open_new"),
    browserHelperFallback: z.literal(true),
    callbackBind: z.literal("0.0.0.0:8181"),
    callbackRedirect: z.literal("http://localhost:8181"),
    callbackAttemptBinding: z.literal(false),
    callbackTimeout: z.literal(false),
    authorizationUrlPrinted: z.literal(true),
    callbackFragmentLoggedInBrowser: z.literal(true),
  }).strict().nullable(),
  hostBrowser: z.object({
    enabled: z.literal(false),
    reason: z.literal("runtime_ownership_and_identity_unverified"),
  }).strict(),
  phoneCallback: z.object({
    enabled: z.literal(false),
    reason: z.literal("no_supported_redirect_override_or_bound_callback_bridge"),
  }).strict(),
}).strict().superRefine((value, context) => {
  const matches = value.versionMatches && Object.values(value.fingerprints).every(Boolean);
  if ((value.sourceCompatibility === "matched") !== matches || (value.protocol !== null) !== matches) {
    context.addIssue({ code: "custom", message: "Inconsistent source compatibility facts" });
  }
});

export type OciCompatibilityReport = z.infer<typeof ociCompatibilityReportSchema>;
