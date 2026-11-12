import { z } from "zod";

/** Owner-selected target, never inferred from a Console token, label or returned profile. */
export const consoleExpectedIdentitySchema = z.object({
  mode: z.literal("oci_web"),
  userOcid: z.string().max(512).regex(/^ocid1\.user\.oc1\.\.[a-z0-9]+$/),
  tenancyOcid: z.string().max(512).regex(/^ocid1\.tenancy\.oc1\.\.[a-z0-9]+$/),
  domainOcid: z.string().max(512).regex(/^ocid1\.domain\.oc1\.\.[a-z0-9]+$/),
  domainOrigin: z.string().max(512).regex(/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.identity\.oraclecloud\.com$/),
  region: z.literal("ap-sydney-1"), realm: z.literal("oc1"),
}).strict();
export type ConsoleExpectedIdentity = z.infer<typeof consoleExpectedIdentitySchema>;
export const consoleBuild = "4.26.2hotfix.2" as const;
const base = `https://cloud.oracle.com/plugins/console/${consoleBuild}/js/`;
/** Anonymous public shell assets measured on 2026-11-11; not an account or login attestation. */
export const consoleSourcePins = Object.freeze([
  Object.freeze({ url: base + "console.43dd7041.aa250f40.js", sha256: "b75681dfd1ed9800a1deb96737df72065d3b1643130e831bf4e57316960a4583" }),
  Object.freeze({ url: base + "console.bde52cb3.9abc6a1f.js", sha256: "33a517985bbcacd8c46048e008787029c1636d8ac48061c71c4f58e8a5e2c01d" }),
  Object.freeze({ url: base + "vendors.console.49d0a293.js", sha256: "55bec46d4da6d8afb39a1b8ccd577fa91fb75e0f4904f344df7af560b4064a7d" }),
  Object.freeze({ url: base + "console.e96e9bea.ebfcb918.js", sha256: "d7fdc7ecac6b265b27e7099acc8dad9ca3f7abdb679eef72753a0632cd0d17b2" }),
]);
