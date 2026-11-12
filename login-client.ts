import { z } from "zod";
import { browserControlModeSchema } from "./browser-control.ts";
import { controlEndpoint } from "./control-client.ts";
import { controlGrantSchema } from "./control-wire.ts";
import { boundedJson, receiveResponse } from "./private-response.ts";
import { fixtureFrameSchema, fixtureInputSchema, frameRefSchema, inputIdSchema } from "./fixture-wire.ts";
import { loginAttemptSchema } from "./login-protocol.ts";
import { cliExpectedIdentitySchema } from "./oci-cli-protocol.ts";
import { ociHostStatusSchema, type OciHostStatus } from "./oci-host-wire.ts";
import { consoleExpectedIdentitySchema } from "./oci-console-protocol.ts";
import { FrameChangedError, StaleFrameError } from "./frame-error.ts";

const target = z.object({ attemptId: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/) }).strict();
const controlledTarget = target.extend({ controlMode: browserControlModeSchema.optional() }).strict();
const key = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const staleResponse = z.object({ error: z.literal("stale_frame") }).strict();
export type OciLoginStatus = OciHostStatus;
const results = {
  status: loginAttemptSchema,
  session: z.object({ grant: controlGrantSchema, attempt: loginAttemptSchema }).strict(),
  renew: controlGrantSchema,
  start: z.union([z.object({ width: z.literal(800), height: z.literal(600) }).strict(), z.object({ pending: z.literal(true) }).strict()]),
  frame: fixtureFrameSchema,
  input: z.object({ accepted: z.literal(true) }).strict(),
  handback: z.union([z.object({ verified: z.literal(true) }).strict(), z.object({ pending: z.literal(true) }).strict()]),
  close: z.object({ closed: z.literal(true) }).strict(),
  "oci-target": z.object({ configured: z.literal(true) }).strict(),
  "oci-status": ociHostStatusSchema,
  "console-target": z.object({ configured: z.literal(true) }).strict(),
  "console-status": ociHostStatusSchema,
};
export type LoginAction = keyof typeof results;

/** Job controls accept only the durable attempt ID; scope comes from the server record. */
export async function postLogin<Action extends LoginAction>(
  origin: string, action: Action, payload: unknown, capability?: string, signal?: AbortSignal,
): Promise<z.infer<(typeof results)[Action]>> {
  let response: Response | undefined;
  let decodedStale: StaleFrameError | FrameChangedError | undefined;
  try {
    signal?.throwIfAborted();
    if (!Object.hasOwn(results, action)) throw new Error();
    const approvedOrigin = new URL(controlEndpoint(origin, "check")).origin;
    const publicAction = action === "status" || action === "session";
    if (publicAction ? capability !== undefined : !key.safeParse(capability).success) throw new Error();
    const schema = action === "session" ? target.extend({ key }).strict()
      : action === "input" ? target.extend({ event: fixtureInputSchema, frameRef: frameRefSchema }).strict()
        : action === "oci-target" ? controlledTarget.extend({ expected: cliExpectedIdentitySchema }).strict()
          : action === "console-target" ? controlledTarget.extend({ expected: consoleExpectedIdentitySchema }).strict()
            : action === "start" || action === "oci-status" || action === "console-status" ? controlledTarget : target;
    const parsed = schema.parse(payload);
    const body = JSON.stringify(action === "input" ? { ...parsed, inputId: inputIdSchema.parse(crypto.randomUUID()) } : parsed);
    if (new TextEncoder().encode(body).length > 4096) throw new Error();
    const observingCleanup = action === "renew" || action === "handback";
    const pending = fetch(`${approvedOrigin}/api/v1/plugins/remote-login/http/login/${action}`, {
      method: "POST", credentials: "include", cache: "no-store", referrerPolicy: "no-referrer", signal,
      headers: { "content-type": "application/json", ...(capability ? { authorization: `Bearer ${capability}` } : {}) }, body,
    });
    response = await (observingCleanup ? pending : receiveResponse(pending, signal));
    if (response.headers.get("cache-control") !== "no-store") throw new Error();
    if ((action === "input" || action === "frame") && response.status === 409) {
      const stale = staleResponse.safeParse(await boundedJson(response, signal));
      signal?.throwIfAborted();
      if (stale.success) { decodedStale = action === "input" ? new StaleFrameError() : new FrameChangedError(); throw decodedStale; }
      throw new Error();
    }
    if (!response.ok) throw new Error();
    const value = results[action].parse(await boundedJson(response, observingCleanup ? undefined : signal));
    // Strict late acknowledgements carry cleanup ownership, never native completion authority.
    if (action !== "renew" && action !== "handback") signal?.throwIfAborted();
    return value as z.infer<(typeof results)[Action]>;
  } catch (error) {
    void response?.body?.cancel().catch(() => undefined);
    if (decodedStale && error === decodedStale && !signal?.aborted) throw decodedStale;
    throw new Error("Login control failed.");
  }
}
