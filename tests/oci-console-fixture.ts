import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TestContext } from "node:test";
import puppeteer from "puppeteer-core";
import type { ConsoleSourceBoundary, ConsoleSourceProof } from "../oci-console-source.ts";

export const supportedConsoleFixture = process.platform === "darwin" && process.arch === "arm64" && existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
export const expectedConsole = { mode: "oci_web", userOcid: "ocid1.user.oc1..fixtureuser", tenancyOcid: "ocid1.tenancy.oc1..fixturetenancy", domainOcid: "ocid1.domain.oc1..fixturedomain", domainOrigin: "https://idcs-fixture.identity.oraclecloud.com", region: "ap-sydney-1", realm: "oc1" } as const;
export const consoleScope = { threadId: "thread-console-fixture", attemptId: "11111111-1111-4111-8111-111111111111", browserContextId: "context-console-fixture", generation: 1 };

export async function consoleFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "remote-console-fixture-"));
  await promisify(execFile)("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=console-fixture", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem")]);
  const state = {
    profile: { active: true, ocid: expectedConsole.userOcid, tenancyOcid: expectedConsole.tenancyOcid, domainOcid: expectedConsole.domainOcid } as Record<string, unknown>,
    status: 200, reads: 0, readAborted: 0, otherReads: 0, otherAborted: 0, owned: true, ownerChecks: 0,
    beforeRead: async () => {}, beforeOtherRead: async () => {},
  };
  const signature = 'Signature keyId="ST$fixture-private-token",version="1",algorithm="rsa-sha256",headers="host x-date (request-target)",signature="fixture-private-signature"';
  const html = `<!doctype html><title>Owned Console fixture</title><script>
  const identity={sub:${JSON.stringify(expectedConsole.userOcid)},tenant:${JSON.stringify(expectedConsole.tenancyOcid)},domain_ocid:${JSON.stringify(expectedConsole.domainOcid)},domain_stripe_url:${JSON.stringify(expectedConsole.domainOrigin)},nonce:"fixture-generation-1"};
  const authenticator={getIdentityToken:async()=>({...identity}),getOverrideTenant:async()=>undefined};
  const authenticatedFetch=async resource=>{const request=new Request(resource);request.headers.set("Authorization",${JSON.stringify(signature)});return fetch(request);};
  class SelfServiceMeApi{constructor(fetch,origin){this.fetch=fetch;this.origin=origin;}async getMe(input,options){const url=new URL("/admin/v1/Me",this.origin);url.searchParams.set("attributes",input.attributes);const response=await this.fetch(new Request(url,{...options,method:"GET",headers:{...options.headers,"Content-Type":input.contentType}}));if(!response.ok)throw new Error("fixture refusal");return{data:await response.json()};}}
  const Auth={getAuthenticator:()=>authenticator,getFetchApi:()=>authenticatedFetch};
  const modules={30045:{g:Auth},80002:{SelfServiceMeApi}};
  globalThis.webpackChunkoci_console={push:([ids,values,callback])=>callback(id=>modules[id])};
  globalThis.consoleFixture={identity,Auth};
  </script>`;
  const server = https.createServer({ key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) }, async (request, response) => {
    const origin = "https://cloud.oracle.com";
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Headers", "authorization,content-type,opc-request-id,x-date");
    response.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    if (request.headers.host?.startsWith("cloud.oracle.com") && request.url === "/") { response.writeHead(200, { "content-type": "text/html" }); response.end(html); return; }
    if (request.headers.host?.startsWith("idcs-fixture.identity.oraclecloud.com") && request.url?.startsWith("/admin/v1/Me?")) {
      state.reads++; response.on("close", () => { if (!response.writableEnded) state.readAborted++; }); await state.beforeRead();
      if (response.destroyed) return;
      response.writeHead(state.status, { "content-type": "application/json" }); response.end(JSON.stringify(state.profile)); return;
    }
    if (request.headers.host?.startsWith("idcs-fixture.identity.oraclecloud.com") && request.url === "/unrelated") {
      state.otherReads++; response.on("close", () => { if (!response.writableEnded) state.otherAborted++; }); await state.beforeOtherRead();
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "text/plain" }); response.end("unrelated fixture read"); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture socket unavailable");
  const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, pipe: true,
    userDataDir: join(root, "browser"), acceptInsecureCerts: true,
    args: ["--no-proxy-server", `--host-resolver-rules=MAP * 127.0.0.1:${address.port}`], dumpio: false,
  });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setCacheEnabled(false); await page.setBypassServiceWorker(true);
  const lifecycle = new AbortController();
  t.after(async () => { lifecycle.abort(); await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  // The external source-attestation boundary is replaced; actual request/response correlation remains real Chrome.
  const sources = (): ConsoleSourceBoundary => {
    const target = page.target(), context = page.browserContext(), proofs = new WeakSet<ConsoleSourceProof>();
    let disposed = false;
    return {
      async capture(signal) { signal.throwIfAborted(); const proof = Object.freeze({}) as ConsoleSourceProof; proofs.add(proof); return proof; },
      assert(proof) { if (disposed || !proofs.has(proof) || page.target() !== target || page.browserContext() !== context) throw new Error("Fixture source changed"); },
      dispose() { disposed = true; },
    };
  };
  const assertOwned = async () => { state.ownerChecks++; if (!state.owned) throw new Error("Fixture owner changed"); };
  await page.goto("https://cloud.oracle.com/", { waitUntil: "load", timeout: 8000 });
  return { page, browser, state, lifecycle, root, sources, assertOwned, signature };
}
