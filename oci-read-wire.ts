import { z } from "zod";

const reference = z.string().uuid();
const label = (length: number) => z.string().max(length).regex(/^[^\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]*$/u);
export const ociReadRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list_compartments") }).strict(),
  z.object({ operation: z.literal("list_instances"), compartmentRef: reference.optional() }).strict(),
]);
export type OciReadRequest = z.infer<typeof ociReadRequestSchema>;
export const ociReadResultSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list_compartments"), rootCompartmentRef: reference,
    rows: z.array(z.object({ compartmentRef: reference, name: label(128) }).strict()).max(25), truncated: z.boolean() }).strict(),
  z.object({ operation: z.literal("list_instances"), rows: z.array(z.object({
    id: z.string().max(512).regex(/^ocid1\.instance\.oc1\.ap-sydney-1\.[a-z0-9]+$/), displayName: label(128),
    lifecycleState: label(32), shape: label(64), availabilityDomain: label(128),
  }).strict()).max(25), truncated: z.boolean() }).strict(),
]);
export type OciReadResult = z.infer<typeof ociReadResultSchema>;
