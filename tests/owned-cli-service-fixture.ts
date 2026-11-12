import assert from "node:assert/strict";
import cp, { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Readable } from "node:stream";
import type { TestContext } from "node:test";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { isPinnedOciAuthorizationUrl } from "../oci-child-job.ts";
import { OCI_CHILD_WRAPPER_SOURCE } from "../oci-wrapper-source.ts";
import { OCI_DIAGNOSTIC_SOURCE } from "../oci-official-diagnostic-source.ts";
import { OCI_VERIFIER_SOURCE } from "../oci-verifier-source.ts";
import { OCI_TASK_SOURCE } from "../oci-task-source.ts";
import { expected } from "./cli-flow-fixture.ts";
import { fixtureToken } from "./oci-verifier-fixture.ts";

const python = "/opt/homebrew/Cellar/oci-cli/3.88.0/libexec/bin/python";
const oracleHost = "login.ap-sydney-1.oraclecloud.com";
const denyPythonNetwork = String.raw`import os, sys
def _fixture_deny_network(event, args):
    if event in ("socket.connect", "socket.connect_ex", "socket.getaddrinfo", "socket.sendto"):
        os._exit(97)
sys.addaudithook(_fixture_deny_network)
`;

// Only the synthetic service response is substituted. The official diagnostic,
// SDK clients, signer, private child protocols and match predicate remain real.
function serviceTransport(token: string, publicJwk: Record<string, unknown>) {
  return denyPythonNetwork + String.raw`import builtins
_fixture_import_original = builtins.__import__
_fixture_patched = False
_fixture_calls = 0
def _fixture_send(self, request, **kwargs):
    global _fixture_calls
    _fixture_calls += 1
    assert _fixture_calls == 1
    import base64, io, json, re
    from urllib.parse import urlparse, parse_qs
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
    from oci._vendor.requests import Response
    parsed = urlparse(request.url)
    assert request.method == "GET" and parsed.scheme == "https"
    assert parsed.netloc == "identity.ap-sydney-1.oci.oraclecloud.com" and not parsed.fragment
    assert self.trust_env is False and self.proxies == {} and self.verify is True and self.cert is None
    assert self.max_redirects == 0 and kwargs["verify"] is True and kwargs["proxies"] == {}
    assert len(kwargs["timeout"]) == 2 and all(0 < value <= 3 for value in kwargs["timeout"])
    if parsed.path == "/20160918/regions":
        assert parsed.query == ""
        body = b'[]'
    else:
        assert parsed.path == "/20160918/compartments"
        assert parse_qs(parsed.query) == {"compartmentId": [${JSON.stringify(expected.tenancyOcid)}], "accessLevel": ["ACCESSIBLE"], "compartmentIdInSubtree": ["true"], "lifecycleState": ["ACTIVE"], "limit": ["25"]}
        assert kwargs["stream"] is True and kwargs["allow_redirects"] is False
        body = b'[{"id":"ocid1.compartment.oc1..composedfixture","name":"Composed fixture compartment","description":"private-service-description"}]'
    fields = dict(re.findall(r'(\w+)="([^"]*)"', request.headers["authorization"]))
    assert fields["keyId"] == "ST$" + ${JSON.stringify(token)}
    assert fields["algorithm"] == "rsa-sha256" and fields["headers"] == "date (request-target) host"
    jwk = ${JSON.stringify(publicJwk)}
    def _integer(value):
        return int.from_bytes(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)), "big")
    public = rsa.RSAPublicNumbers(_integer(jwk["e"]), _integer(jwk["n"])).public_key()
    signed = ("date: " + request.headers["date"] + "\n(request-target): get " + request.path_url + "\nhost: " + parsed.netloc).encode("ascii")
    public.verify(base64.b64decode(fields["signature"]), signed, padding.PKCS1v15(), hashes.SHA256())
    response = Response()
    response.status_code = 200
    response.raw = io.BytesIO(body)
    response._content = body
    response.headers["content-type"] = "application/json"
    response.headers["opc-request-id"] = "private-composed-fixture-request"
    response.request = request
    response.url = request.url
    return response
def _fixture_import(name, globals=None, locals=None, fromlist=(), level=0):
    global _fixture_patched
    result = _fixture_import_original(name, globals, locals, fromlist, level)
    requests = sys.modules.get("oci._vendor.requests")
    if not _fixture_patched and requests is not None and hasattr(requests, "Session"):
        _fixture_patched = True
        requests.Session.send = _fixture_send
    return result
builtins.__import__ = _fixture_import
`;
}

/** Temporary non-redeemable service: no real account, Oracle socket or default config. */
export async function ownedCliServiceFixture(t: TestContext, options: { onProviderPage?: (page: Page) => void } = {}) {
  const root = await mkdtemp(join(tmpdir(), "owned-cli-synthetic-service-"));
  await promisify(execFile)("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=cli-fixture",
    "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem")]);
  const token = fixtureToken({ sub: expected.userOcid, tenant: expected.tenancyOcid, exp: Math.floor(Date.now() / 1000) + 3600 });
  const state = { authorizationUrl: "", publicJwk: null as Record<string, unknown> | null, documents: 0,
    stages: [] as string[], events: [] as Array<{ stage: string; value: Record<string, unknown> }>,
    browserTransports: [] as Array<{ guardedBeforeSpawn: boolean; loopbackDocument: boolean; otherDnsDenied: boolean; directConnections: boolean; closed: boolean }> };
  const server = https.createServer({ key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) }, (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const url = `https://${request.headers.host}${request.url}`;
    if (request.method !== "GET" || !isPinnedOciAuthorizationUrl(url)) { response.writeHead(404); response.end(); return; }
    state.authorizationUrl = url;
    state.publicJwk = JSON.parse(Buffer.from(new URL(url).searchParams.get("public_key")!, "base64url").toString("utf8")) as Record<string, unknown>;
    state.documents++;
    const callback = `http://localhost:8181/#security_token=${encodeURIComponent(token)}`;
    const html = `<!doctype html><title>Account-free CLI fixture</title><style>button{position:absolute;left:40px;top:110px;width:240px;height:40px}</style><button onclick='location.href=${JSON.stringify(callback)}'>Complete synthetic callback</button>`;
    response.writeHead(200, { "content-type": "text/html" }); response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const onProviderPage = options.onProviderPage;
  if (onProviderPage) {
    const launch = puppeteer.launch.bind(puppeteer);
    t.mock.method(puppeteer, "launch", (settings: Parameters<typeof puppeteer.launch>[0]) => {
      const promise = launch(settings);
      void promise.then(browser => {
        if (!settings?.allowlist?.some(value => value.includes(oracleHost))) return;
        const createContext = browser.createBrowserContext.bind(browser);
        t.mock.method(browser, "createBrowserContext", (settings: Parameters<Browser["createBrowserContext"]>[0]) => {
          const promise = createContext(settings);
          void promise.then(context => {
            const newPage = context.newPage.bind(context);
            t.mock.method(context, "newPage", () => {
              const promise = newPage();
              void promise.then(onProviderPage).catch(() => undefined);
              return promise;
            });
          }).catch(() => undefined);
          return promise;
        });
      }).catch(() => undefined);
      return promise;
    });
  }
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const resolver = `--host-resolver-rules=MAP localhost 127.0.0.1, MAP 127.0.0.1 127.0.0.1, MAP ${oracleHost} 127.0.0.1:${address.port}, MAP * ~NOTFOUND`;
  const stages = new Map([[OCI_CHILD_WRAPPER_SOURCE, "authentication"], [OCI_DIAGNOSTIC_SOURCE, "diagnostic"],
    [OCI_VERIFIER_SOURCE, "verifier"], [OCI_TASK_SOURCE, "task"]]);
  const spawn = cp.spawn;
  t.mock.method(cp, "spawn", ((file: string, args: string[], options: cp.SpawnOptions) => {
    if (file === chrome) {
      // The compiled host bundles Puppeteer. The shared Node spawn boundary
      // confines both source and bundled launchers before Chrome can execute.
      const confined = [...args, "--ignore-certificate-errors", "--no-proxy-server", resolver];
      assert.equal(confined.filter((arg) => arg.startsWith("--host-resolver-rules=")).at(-1), resolver);
      assert.ok(confined.includes("--remote-debugging-pipe"));
      assert.ok(confined.includes("--no-proxy-server"));
      assert.equal(confined.some((arg) => arg.startsWith("--proxy-server=")), false);
      const transport = { guardedBeforeSpawn: true, loopbackDocument: true, otherDnsDenied: true, directConnections: true, closed: false };
      state.browserTransports.push(transport);
      const child = spawn(file, confined, options);
      child.once("close", () => { transport.closed = true; });
      return child;
    }
    assert.equal(/chrome|chromium/i.test(file), false, "an unrecognized browser executable must never launch");
    if (file !== python) return spawn(file, args, options);
    const stage = stages.get(args[3]!);
    assert.ok(stage, "only the pinned owned authentication/diagnostic/SDK child may start");
    assert.deepEqual(args.slice(0, 3), ["-I", "-S", "-c"]);
    assert.equal(options.shell, false);
    state.stages.push(stage);
    if (stage !== "authentication") assert.ok(state.publicJwk, "service verification needs the actual captured bootstrap key");
    const prefix = stage === "authentication" ? denyPythonNetwork : serviceTransport(token, state.publicJwk!);
    const child = spawn(file, [...args.slice(0, 3), prefix + args[3]], options);
    let remainder = "";
    (child.stdio[4] as Readable).on("data", (chunk: Buffer) => {
      remainder += chunk.toString("utf8");
      for (;;) {
        const newline = remainder.indexOf("\n"); if (newline < 0) break;
        state.events.push({ stage, value: JSON.parse(remainder.slice(0, newline)) as Record<string, unknown> });
        remainder = remainder.slice(newline + 1);
      }
    });
    return child;
  }) as typeof cp.spawn);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  return { state, token, root };
}
