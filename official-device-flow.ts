import { Buffer } from "node:buffer";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const maxBody = 16_384;
const visible = (max: number) => z.string().min(1).max(max).regex(/^[\x21-\x7e]+$/);
const configSchema = z.object({
  issuerOrigin: z.string().regex(/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.identity\.oraclecloud\.com$/),
  clientId: visible(128), scopes: z.array(z.string().min(1).max(200).regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/)).min(1).max(8).refine(values => new Set(values).size === values.length),
  clientAuthentication: z.literal("none"),
}).strict();
const deviceSchema = z.object({
  device_code: visible(4096), user_code: z.string().regex(/^[A-Za-z0-9-]{4,32}$/),
  verification_uri: z.string().max(1024), verification_uri_complete: visible(2048).optional(),
  expires_in: z.number().int().min(1).max(900), interval: z.number().int().min(1).max(300).optional(),
}).strict();
const tokenSchema = z.object({
  access_token: visible(8192), token_type: z.string().regex(/^bearer$/i), expires_in: z.number().int().min(1).max(86400),
  scope: z.string().max(1607).optional(), refresh_token: visible(8192).optional(), id_token: visible(8192).optional(),
}).strict();
const errorSchema = z.object({ error: visible(128), error_description: z.string().max(512).optional(), error_uri: z.string().max(1024).optional() }).strict();

type Response = { status: number; contentType: string; body: Buffer };
type Request = { url: string; body: Buffer; signal: AbortSignal; timeoutMs: number };
type Dependencies = { post(request: Request): Promise<Response>; now(): number; wait(ms: number, signal: AbortSignal): Promise<void> };
type Status = "consumed" | "cancelled" | "expired" | "denied" | "failed";
/** Host-internal only. Nothing in the public plugin accepts this configuration or these callbacks. */
export type OfficialDeviceFlowInput = {
  trustedConfig: unknown; signal: AbortSignal;
  assertOwned(signal: AbortSignal): Promise<void>;
  present(value: Readonly<{ verificationUri: string; userCode: string }>): Promise<void>;
  consumeToken(accessToken: Uint8Array): Promise<void>;
  dependencies?: Dependencies;
};
class Stopped extends Error { constructor(readonly status: Status) { super("Official device flow stopped."); } }
function fail(): never { throw new Stopped("failed"); }
function erase(value: Record<string, unknown> | undefined): void { if (value) for (const key of Object.keys(value)) value[key] = undefined; }

// OAuth responses here are flat objects. Reject duplicate (including escaped) keys before schema parsing.
function parse(response: Response): Record<string, unknown> {
  let source = "";
  const result: Record<string, unknown> = Object.create(null);
  try {
    if (!Buffer.isBuffer(response.body) || response.body.length > maxBody || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.contentType)) fail();
    source = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
    const string = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
    let at = 0, fields = 0;
    const space = () => { while (/[ \t\r\n]/.test(source[at] ?? "") && at < source.length) at++; };
    const readString = (): string => { string.lastIndex = at; const match = string.exec(source); if (!match) fail(); at = string.lastIndex; return JSON.parse(match[0]) as string; };
    space(); if (source[at++] !== "{") fail(); space();
    if (source[at] !== "}") for (;;) {
      const key = readString(); if (++fields > 16 || Object.hasOwn(result, key)) fail();
      space(); if (source[at++] !== ":") fail(); space();
      if (source[at] === '"') result[key] = readString();
      else {
        const match = /^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/.exec(source.slice(at));
        if (!match) fail(); result[key] = JSON.parse(match[0]) as unknown; at += match[0].length;
      }
      space(); if (source[at] !== ",") break; at++; space();
    }
    if (source[at++] !== "}") fail(); space(); if (at !== source.length) fail();
    return result;
  } catch (error) { erase(result); throw error; }
  finally { source = ""; response.body?.fill(0); }
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
    return a > 0 && a < 224 && a !== 10 && a !== 127 && !(a === 100 && b >= 64 && b <= 127)
      && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
      && !(a === 192 && (b === 168 || b === 0 || b === 2)) && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      && !(a === 203 && b === 0 && c === 113);
  }
  // Only global unicast; mapped IPv4, local, multicast, transition and documentation ranges fail closed.
  return isIP(address) === 6 && /^[23]/.test(address) && !/^(?:200[12]|3ffe|3fff):/i.test(address);
}
const publicLookup: LookupFunction = (hostname, options, callback) => {
  void lookup(hostname, { all: true, verbatim: true }).then(addresses => {
    if (!addresses.length || addresses.some(value => !publicAddress(value.address))) { callback(new Error("Official endpoint unavailable."), ""); return; }
    const selected = options.family ? addresses.filter(value => value.family === options.family) : addresses;
    if (!selected.length) { callback(new Error("Official endpoint unavailable."), ""); return; }
    if (options.all) callback(null, selected); else callback(null, selected[0]!.address, selected[0]!.family);
  }, () => callback(new Error("Official endpoint unavailable."), ""));
};

function post(input: Request): Promise<Response> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0, settled = false;
    const finish = (error?: Error, value?: Response) => {
      if (settled) { value?.body.fill(0); return; } settled = true; clearTimeout(timer);
      for (const chunk of chunks) chunk.fill(0);
      if (error) reject(error); else resolve(value!);
    };
    const req = request(input.url, {
      method: "POST", agent: false, lookup: publicLookup, rejectUnauthorized: true, minVersion: "TLSv1.2", signal: input.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8", Accept: "application/json", "Content-Length": input.body.length, "Cache-Control": "no-store" },
      maxHeaderSize: 8192,
    }, response => {
      const contentType = response.headers["content-type"] ?? "";
      if (![200, 400, 401].includes(response.statusCode ?? 0) || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) { response.destroy(); req.destroy(); finish(new Error("Official endpoint unavailable.")); return; }
      response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBody) { chunk.fill(0); response.destroy(); req.destroy(); finish(new Error("Official endpoint unavailable.")); } else if (!settled) chunks.push(chunk); else chunk.fill(0); });
      response.once("error", () => finish(new Error("Official endpoint unavailable.")));
      response.once("aborted", () => finish(new Error("Official endpoint unavailable.")));
      response.once("end", () => finish(undefined, { status: response.statusCode!, contentType, body: Buffer.concat(chunks, bytes) }));
    });
    const timer = setTimeout(() => { req.destroy(); finish(Object.assign(new Error("Official endpoint timed out."), { code: "ETIMEDOUT" })); }, input.timeoutMs);
    req.once("error", () => finish(new Error("Official endpoint unavailable.")));
    req.end(input.body);
  });
}
const defaults: Dependencies = { post, now: () => performance.now(), wait: async (ms, signal) => {
  const until = performance.now() + ms;
  do { await delay(Math.max(1, Math.ceil(until - performance.now())), undefined, { signal }); } while (performance.now() < until);
} };

/** Unconfigured internal RFC 8628 executor. A consumed grant is never OCI CLI/Console verification. */
export async function runOfficialDeviceFlow(input: OfficialDeviceFlowInput): Promise<Readonly<{ status: Status }>> {
  const dependencies = input.dependencies ?? defaults;
  let deadline = 0, previous = -1, deviceCode = "", accessToken: Buffer | undefined;
  let parsed: Record<string, unknown> | undefined, authorization: z.infer<typeof deviceSchema> | undefined, token: z.infer<typeof tokenSchema> | undefined;
  const now = () => { const value = dependencies.now(); if (!Number.isFinite(value) || value < previous || value < 0 || value > Number.MAX_SAFE_INTEGER - 900_000) fail(); previous = value; return value; };
  const check = () => { if (input.signal.aborted) throw new Stopped("cancelled"); if (now() >= deadline) throw new Stopped("expired"); };
  const bounded = async <T>(operation: () => Promise<T>, timeoutMs?: number, timeoutError?: Error): Promise<T> => {
    check(); let timer: ReturnType<typeof setTimeout> | undefined, abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new Stopped("cancelled")); input.signal.addEventListener("abort", abort, { once: true });
      const remaining = deadline - now();
      timer = setTimeout(() => reject(timeoutMs !== undefined && timeoutMs < remaining ? timeoutError : new Stopped("expired")), Math.max(1, Math.min(timeoutMs ?? remaining, remaining)));
      if (input.signal.aborted) abort();
    });
    try { const value = await Promise.race([operation(), stopped]); check(); return value; }
    finally { clearTimeout(timer); input.signal.removeEventListener("abort", abort); }
  };
  const owned = async () => { await bounded(() => input.assertOwned(input.signal)); };
  const boundary = async (operation: () => Promise<void>) => { await owned(); await bounded(operation); await owned(); };
  const exchange = async (url: string, fields: Record<string, string>): Promise<Response> => {
    let body: Buffer | undefined, response: Response | undefined, requestController: AbortController | undefined;
    try {
      await owned(); body = Buffer.from(new URLSearchParams(fields).toString()); if (body.length > 8192) fail();
      requestController = new AbortController(); const signal = AbortSignal.any([input.signal, requestController.signal]);
      let pending: Promise<Response> | undefined;
      const timeoutMs = Math.max(1, Math.min(10_000, deadline - now()));
      try {
        response = await bounded(() => pending = dependencies.post({ url, body: body!, signal, timeoutMs }), timeoutMs, Object.assign(new Error("Official endpoint timed out."), { code: "ETIMEDOUT" }));
      } catch (error) {
        requestController.abort(); void pending?.then(late => late.body.fill(0), () => {});
        await owned(); throw error;
      }
      await owned(); return response;
    } catch (error) { response?.body.fill(0); throw error; }
    finally { requestController?.abort(); body?.fill(0); erase(fields); }
  };
  try {
    deadline = now() + 10_000; check(); const config = configSchema.parse(input.trustedConfig);
    if (typeof input.assertOwned !== "function" || typeof input.present !== "function" || typeof input.consumeToken !== "function") fail();
    const started = now();
    const initial = await exchange(`${config.issuerOrigin}/oauth2/v1/device`, { response_type: "device_code", client_id: config.clientId, scope: config.scopes.join(" ") });
    parsed = parse(initial); if (initial.status !== 200) fail(); authorization = deviceSchema.parse(parsed); erase(parsed); parsed = undefined;
    if (authorization.verification_uri !== `${config.issuerOrigin}/ui/v1/device`) fail();
    deadline = started + authorization.expires_in * 1000; check();
    deviceCode = authorization.device_code; let interval = (authorization.interval ?? 5) * 1000;
    await boundary(() => input.present(Object.freeze({ verificationUri: authorization!.verification_uri, userCode: authorization!.user_code })));
    erase(authorization); authorization = undefined;
    for (;;) {
      check(); const before = now(), wait = Math.min(interval, deadline - before), notBefore = before + wait;
      await bounded(() => dependencies.wait(wait, input.signal)); check(); if (now() < notBefore) fail();
      let response: Response; const requestedAt = now();
      try { response = await exchange(`${config.issuerOrigin}/oauth2/v1/token`, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: config.clientId, device_code: deviceCode }); }
      catch (error) {
        check(); if ((error as NodeJS.ErrnoException)?.code !== "ETIMEDOUT") throw error;
        interval = Math.min(interval * 2, 900_000); continue;
      }
      parsed = parse(response);
      if (response.status !== 200) {
        const error = errorSchema.parse(parsed); erase(parsed); parsed = undefined;
        if (response.status !== 400) fail();
        if (error.error === "authorization_pending") continue;
        if (error.error === "slow_down") { interval += 5000; continue; }
        if (error.error === "access_denied") return { status: "denied" };
        if (error.error === "expired_token") return { status: "expired" };
        fail();
      }
      token = tokenSchema.parse(parsed); erase(parsed); parsed = undefined;
      deadline = Math.min(deadline, requestedAt + token.expires_in * 1000); check();
      if (token.scope !== undefined) {
        const scopes = token.scope.split(" ");
        if (new Set(scopes).size !== scopes.length || scopes.some(scope => !config.scopes.includes(scope))) fail();
      }
      accessToken = Buffer.from(token.access_token); erase(token); token = undefined; deviceCode = "";
      await boundary(() => input.consumeToken(accessToken!));
      return { status: "consumed" };
    }
  } catch (error) { return { status: input.signal.aborted ? "cancelled" : error instanceof Stopped ? error.status : "failed" }; }
  finally { deviceCode = ""; accessToken?.fill(0); accessToken = undefined; erase(parsed); erase(authorization); erase(token); }
}
