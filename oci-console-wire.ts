import { z } from "zod";
import { consoleBuild } from "./oci-console-protocol.ts";
import { ociHostStatusSchema } from "./oci-host-wire.ts";

export const consoleHandbackSchema = ociHostStatusSchema.extend({
  verified: z.boolean(), receipt: z.string().uuid().optional(), browserRef: z.string().uuid().optional(),
}).strict().superRefine((value, context) => {
  if (value.verified !== (value.phase === "verified") || (value.verified
    ? !value.receipt || !value.browserRef : value.receipt !== undefined || value.browserRef !== undefined)) {
    context.addIssue({ code: "custom", message: "Inconsistent Console completion" });
  }
});
export const consoleReadRequestSchema = z.object({ operation: z.enum(["read_identity", "read_page"]) }).strict();
export type ConsoleReadRequest = z.infer<typeof consoleReadRequestSchema>;
const text = z.string().max(128).regex(/^[^\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]*$/u);
export const consoleReadResultSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("read_identity"), matched: z.literal(true), userMatched: z.literal(true),
    tenancyMatched: z.literal(true), domainMatched: z.literal(true), sourceBuild: z.literal(consoleBuild) }).strict(),
  z.object({ operation: z.literal("read_page"), title: text, headings: z.array(text).max(20) }).strict(),
]);
export type ConsoleReadResult = z.infer<typeof consoleReadResultSchema>;
