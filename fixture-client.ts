import { z } from "zod";
import { controlEndpoint } from "./control-client.ts";
import { controlScopeSchema } from "./control-wire.ts";
import { fixtureFrameSchema, fixtureInputSchema, frameRefSchema, inputIdSchema, type FixtureFrame } from "./fixture-wire.ts";
import { boundedJson, receiveResponse } from "./private-response.ts";
import { FrameChangedError, StaleFrameError } from "./frame-error.ts";
export { boundedJson, receiveResponse, withAbort } from "./private-response.ts";

export type FixtureAction = "start" | "frame" | "input" | "close";
type FixtureResults = {
  start: { width: 800; height: 600 };
  frame: FixtureFrame;
  input: { accepted: true };
  close: { closed: true };
};
const targetSchema = z.object({ hostId: z.string().min(1).max(200), scope: controlScopeSchema }).strict();
const inputSchema = targetSchema.extend({ event: fixtureInputSchema, frameRef: frameRefSchema }).strict();
const staleResponse = z.object({ error: z.literal("stale_frame") }).strict();
const results = {
  start: z.object({ width: z.literal(800), height: z.literal(600) }).strict(),
  frame: fixtureFrameSchema,
  input: z.object({ accepted: z.literal(true) }).strict(),
  close: z.object({ closed: z.literal(true) }).strict(),
};

/** Only a scoped private fixture request; no retries, normal RPC, or credential-bearing URL. */
export async function postFixture<Action extends FixtureAction>(
  origin: string, action: Action, payload: unknown, capability: string, signal?: AbortSignal,
): Promise<FixtureResults[Action]> {
  let response: Response | undefined;
  let decodedStale: StaleFrameError | FrameChangedError | undefined;
  try {
    signal?.throwIfAborted();
    if (!Object.hasOwn(results, action) || !/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new Error();
    const approvedOrigin = new URL(controlEndpoint(origin, "check")).origin;
    const parsed = (action === "input" ? inputSchema : targetSchema).parse(payload);
    const content = JSON.stringify(action === "input" ? { ...parsed, inputId: inputIdSchema.parse(crypto.randomUUID()) } : parsed);
    if (new TextEncoder().encode(content).length > 4096) throw new Error();
    response = await receiveResponse(fetch(`${approvedOrigin}/api/v1/plugins/remote-login/http/fixture/${action}`, {
      method: "POST", credentials: "include", cache: "no-store", referrerPolicy: "no-referrer", signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${capability}` }, body: content,
    }), signal);
    if (response.headers.get("cache-control") !== "no-store") throw new Error();
    if ((action === "input" || action === "frame") && response.status === 409) {
      const stale = staleResponse.safeParse(await boundedJson(response, signal));
      signal?.throwIfAborted();
      if (stale.success) { decodedStale = action === "input" ? new StaleFrameError() : new FrameChangedError(); throw decodedStale; }
      throw new Error();
    }
    if (!response.ok) throw new Error();
    const value = results[action].parse(await boundedJson(response, signal));
    signal?.throwIfAborted();
    return value as FixtureResults[Action];
  } catch (error) {
    void response?.body?.cancel().catch(() => undefined);
    if (decodedStale && error === decodedStale && !signal?.aborted) throw decodedStale;
    throw new Error("Fixture control failed.");
  }
}
