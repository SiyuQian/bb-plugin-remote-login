import { z } from "zod";

/** Independently selected CLI target; parsing does not establish account identity or authorize an endpoint. */
export const cliExpectedIdentitySchema = z.object({
  mode: z.literal("oci_cli"),
  tenancyOcid: z.string().max(512).regex(/^ocid1\.tenancy\.oc1\.\.[a-z0-9]+$/),
  userOcid: z.string().max(512).regex(/^ocid1\.user\.oc1\.\.[a-z0-9]+$/),
  region: z.string().max(64).regex(/^[a-z]{2}-[a-z0-9]+-[1-9][0-9]*$/),
  realm: z.literal("oc1"),
}).strict();

export type CliExpectedIdentity = z.infer<typeof cliExpectedIdentitySchema>;
