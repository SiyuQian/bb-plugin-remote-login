import { z } from "zod";

export const ociHostStatusSchema = z.object({
  configured: z.boolean(), phoneControlAccepted: z.boolean(),
  phase: z.enum(["unconfigured", "ready", "starting", "user_control", "verifying", "verified", "cancelled", "failed"]),
  failure: z.enum(["unavailable", "authorization", "unsupported", "expired", "cancelled", "child_failed", "verification_failed", "cleanup_uncertain"]).nullable(),
}).strict();
export type OciHostStatus = z.infer<typeof ociHostStatusSchema>;
export const ociHandbackSchema = ociHostStatusSchema.extend({
  verified: z.boolean(), receipt: z.string().uuid().optional(), accountRef: z.string().uuid().optional(),
}).strict().superRefine((value, context) => {
  if (value.verified !== (value.phase === "verified") || value.verified !== Boolean(value.receipt && value.accountRef)) {
    context.addIssue({ code: "custom", message: "Inconsistent OCI completion" });
  }
});
