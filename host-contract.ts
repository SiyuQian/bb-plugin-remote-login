import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { controlScopeSchema, controlGrantSchema } from "./control-wire.ts";
import { fixtureFrameSchema, fixtureInputSchema, frameRefSchema, inputIdSchema } from "./fixture-wire.ts";
import { ociCompatibilityReportSchema } from "./oci-compatibility-wire.ts";
import { cliExpectedIdentitySchema } from "./oci-cli-protocol.ts";
import { ociHostStatusSchema, ociHandbackSchema } from "./oci-host-wire.ts";
import { ociReadRequestSchema, ociReadResultSchema } from "./oci-read-wire.ts";
import { consoleExpectedIdentitySchema } from "./oci-console-protocol.ts";
import { consoleHandbackSchema, consoleReadRequestSchema, consoleReadResultSchema } from "./oci-console-wire.ts";
import { loginCapabilitiesSchema } from "./provider-wire.ts";

const runtimeInspectionSchema = z.object({
  platform: z.string(),
  architecture: z.string(),
  nodeVersion: z.string(),
  browser: z.object({
    available: z.boolean(),
    name: z.string().nullable(),
  }).strict(),
}).strict();

/** Non-secret host facts; browser availability does not imply login support. */
export type RuntimeInspection = z.infer<typeof runtimeInspectionSchema>;

const refusal = z.object({ ok: z.literal(false), reason: z.string().max(80) }).strict();
const checked = z.union([z.object({ ok: z.literal(true) }).strict(), refusal]);
const granted = z.union([z.object({ ok: z.literal(true), grant: controlGrantSchema }).strict(), refusal]);
const capabilityInput = z.object({ capability: z.string().max(200), scope: controlScopeSchema }).strict();
const deadline = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional();

export const hostContract = defineRpcContract({
  inspectLoginCapabilities: { input: z.null(), output: loginCapabilitiesSchema, experimental_retryable: true },
  inspectOciCompatibility: {
    input: z.null(),
    output: ociCompatibilityReportSchema,
    experimental_retryable: true,
  },
  inspectRuntime: {
    input: z.null(),
    output: runtimeInspectionSchema,
    experimental_retryable: true,
  },
  controlInfo: {
    input: z.null(),
    output: z.object({ provisioned: z.boolean(), rootId: z.string().nullable(), provisioningDirectory: z.string() }).strict(),
    experimental_retryable: true,
  },
  authenticateControl: {
    input: z.object({ key: z.string().max(200), scope: controlScopeSchema, deadline }).strict(),
    output: granted,
  },
  authorizeControl: { input: capabilityInput, output: checked },
  renewControl: { input: capabilityInput.extend({ deadline }).strict(), output: granted },
  revokeControl: { input: capabilityInput, output: checked },
  startFixture: {
    input: capabilityInput,
    output: z.union([z.object({ ok: z.literal(true), viewport: z.object({ width: z.literal(800), height: z.literal(600) }).strict() }).strict(), refusal]),
  },
  frameFixture: {
    input: capabilityInput,
    output: z.union([z.object({ ok: z.literal(true), frame: fixtureFrameSchema }).strict(), refusal]),
  },
  verifyFixture: {
    input: capabilityInput,
    output: z.union([z.object({ ok: z.literal(true), verified: z.boolean() }).strict(), refusal]),
  },
  completePhoneFixture: {
    input: capabilityInput,
    output: z.union([z.object({ ok: z.literal(true), verified: z.boolean() }).strict(), refusal]),
  },
  ociStatus: { input: capabilityInput, output: z.union([z.object({ ok: z.literal(true), status: ociHostStatusSchema }).strict(), refusal]) },
  configureOci: { input: capabilityInput.extend({ expected: cliExpectedIdentitySchema }).strict(), output: checked },
  startOci: { input: capabilityInput, output: z.union([z.object({ ok: z.literal(true), viewport: z.object({ width: z.literal(800), height: z.literal(600) }).strict() }).strict(), refusal]) },
  frameOci: { input: capabilityInput, output: z.union([z.object({ ok: z.literal(true), frame: fixtureFrameSchema }).strict(), refusal]) },
  inputOci: { input: capabilityInput.extend({ inputId: inputIdSchema, frameRef: frameRefSchema, event: fixtureInputSchema }).strict(), output: checked },
  handbackOci: { input: capabilityInput, output: z.union([z.object({ ok: z.literal(true), result: ociHandbackSchema }).strict(), refusal]) },
  closeOci: { input: capabilityInput, output: checked },
  // Internal post-verification proof for the original native call, not a public control endpoint.
  ociResumeProof: {
    input: z.object({ scope: controlScopeSchema, receipt: z.string().uuid() }).strict(),
    output: z.union([z.object({ ok: z.literal(true), accountRef: z.string().uuid(), expiresAt: z.number().int().positive() }).strict(), refusal]),
  },
  readOciTask: {
    input: z.object({ scope: controlScopeSchema, receipt: z.string().uuid(), accountRef: z.string().uuid(), request: ociReadRequestSchema }).strict(),
    output: z.union([z.object({ ok: z.literal(true), result: ociReadResultSchema, expiresAt: z.number().int().positive() }).strict(), refusal]),
  },
  consoleStatus: { input: capabilityInput, output: z.union([z.object({ ok: z.literal(true), status: ociHostStatusSchema }).strict(), refusal]) },
  configureConsole: { input: capabilityInput.extend({ expected: consoleExpectedIdentitySchema }).strict(), output: checked },
  startConsole: { input: capabilityInput, output: z.union([z.object({ ok: z.literal(true), viewport: z.object({ width: z.literal(800), height: z.literal(600) }).strict() }).strict(), refusal]) },
  frameConsole: { input: capabilityInput, output: z.union([z.object({ ok: z.literal(true), frame: fixtureFrameSchema }).strict(), refusal]) },
  inputConsole: { input: capabilityInput.extend({ inputId: inputIdSchema, frameRef: frameRefSchema, event: fixtureInputSchema }).strict(), output: checked },
  handbackConsole: { input: capabilityInput, output: z.union([z.object({ ok: z.literal(true), result: consoleHandbackSchema }).strict(), refusal]) },
  closeConsole: { input: capabilityInput, output: checked },
  consoleResumeProof: {
    input: z.object({ scope: controlScopeSchema, receipt: z.string().uuid() }).strict(),
    output: z.union([z.object({ ok: z.literal(true), browserRef: z.string().uuid(), expiresAt: z.number().int().positive() }).strict(), refusal]),
  },
  readConsoleTask: {
    input: z.object({ scope: controlScopeSchema, receipt: z.string().uuid(), browserRef: z.string().uuid(), request: consoleReadRequestSchema }).strict(),
    output: z.union([z.object({ ok: z.literal(true), result: consoleReadResultSchema, expiresAt: z.number().int().positive() }).strict(), refusal]),
  },
  inputFixture: { input: capabilityInput.extend({ inputId: inputIdSchema, frameRef: frameRefSchema, event: fixtureInputSchema }).strict(), output: checked },
  closeFixture: { input: capabilityInput, output: checked },
  // Server-owned cleanup only; deliberately absent from public RPC/HTTP/agent methods.
  stopAttempt: { input: z.object({ scope: controlScopeSchema }).strict(), output: checked },
});
