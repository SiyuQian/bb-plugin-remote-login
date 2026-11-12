import { z } from "zod";
import { controlGrantSchema } from "./control-wire.ts";
import { boundedJson, receiveResponse } from "./private-response.ts";

export type ControlAction = "session" | "check" | "renew" | "release";
export async function probeControlChannel(origin: string, target: unknown, signal?: AbortSignal): Promise<boolean> {
  try {
    signal?.throwIfAborted();
    const response = await receiveResponse(fetch(controlEndpoint(origin, "check"), {
      method: "POST", credentials: "include", cache: "no-store", referrerPolicy: "no-referrer", signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify(target),
    }), signal);
    const result: unknown = await boundedJson(response, signal);
    signal?.throwIfAborted();
    return response.status === 401 && response.headers.get("cache-control") === "no-store"
      && z.object({ error: z.literal("control_authorization_failed") }).strict().safeParse(result).success;
  } catch { return false; }
}
export function controlEndpoint(origin: string, action: ControlAction): string {
  const url = new URL(origin);
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || !["session", "check", "renew", "release"].includes(action)) throw new Error("Unsafe control endpoint");
  return `${url.origin}/api/v1/plugins/remote-login/http/control/${action}`;
}

export async function postControl(origin: string, action: ControlAction, payload: unknown, capability?: string, signal?: AbortSignal): Promise<{ capability: string; expiresAt: number } | null> {
  signal?.throwIfAborted();
  const content = JSON.stringify(payload);
  if (new TextEncoder().encode(content).length > 4096) throw new Error("Invalid control request.");
  if (capability !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new Error("Invalid control request.");
  const response = await receiveResponse(fetch(controlEndpoint(origin, action), {
    method: "POST", credentials: "include", cache: "no-store", referrerPolicy: "no-referrer", signal,
    headers: { "content-type": "application/json", ...(capability ? { authorization: `Bearer ${capability}` } : {}) },
    body: content,
  }), signal);
  if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Error("Control request refused."); }
  try {
    const value: unknown = await boundedJson(response, signal);
    signal?.throwIfAborted();
    if (action === "session" || action === "renew") return controlGrantSchema.parse(value);
    const expected = action === "release" ? z.object({ released: z.literal(true) }).strict() : z.object({ authorized: z.literal(true) }).strict();
    expected.parse(value);
    return null;
  } catch { void response.body?.cancel().catch(() => undefined); throw new Error("Invalid control response."); }
}
