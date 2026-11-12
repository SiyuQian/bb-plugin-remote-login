import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { createOwnedOciSession, releaseOwnedOciSession } from "../oci-owned-session.ts";
import { fixturePrivateKey, fixturePublicKey, fixtureTarget, fixtureToken } from "./oci-verifier-fixture.ts";
import { OwnedResourceLedger } from "../owned-resource-ledger.ts";

const compartment = "ocid1.compartment.oc1..fixturecompartment";
const instance = "ocid1.instance.oc1.ap-sydney-1.fixtureinstance";
type Behavior = "accept" | "reject" | "redirect" | "delay" | "header_error" | "oversized" | "invalid_json" | "many" | "private_label" | "token_label" | "key_label" | "foreign_region";
async function api() {
  const module = await import("../oci-owned-task.ts").catch(() => null);
  assert.ok(module, "the owned CLI session must have a real read-only task consumer"); return module;
}
function transport(token: string, behavior: Behavior) {
  return String.raw`import builtins, sys
_import = builtins.__import__
_patched = False
_calls = 0
def _deny_network(event, args):
    if event in ("socket.connect", "socket.getaddrinfo"):
        os._exit(97)
sys.addaudithook(_deny_network)
def _send(self, request, **kwargs):
    global _calls
    _calls += 1
    assert _calls == 1
    import base64, io, json, re, time
    from urllib.parse import urlparse, parse_qs
    from cryptography.hazmat.primitives import serialization, hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    from oci._vendor.requests import Response
    parsed = urlparse(request.url)
    query = parse_qs(parsed.query)
    assert request.method == "GET"
    assert self.trust_env is False and self.proxies == {} and self.verify is True and self.cert is None
    assert self.max_redirects == 0 and kwargs["verify"] is True and kwargs["proxies"] == {}
    assert kwargs["stream"] is True and kwargs["allow_redirects"] is False
    assert all(0 < value <= 3 for value in kwargs["timeout"])
    assert query["limit"] == ["25"] and "page" not in query
    if parsed.path == "/20160918/compartments":
        assert parsed.netloc == "identity.ap-sydney-1.oci.oraclecloud.com"
        assert query == {"compartmentId": [${JSON.stringify(fixtureTarget.tenancyOcid)}], "accessLevel": ["ACCESSIBLE"], "compartmentIdInSubtree": ["true"], "lifecycleState": ["ACTIVE"], "limit": ["25"]}
        rows = [{"id": ${JSON.stringify(compartment)}, "name": "Project One", "description": "excluded-private-description", "freeformTags": {"private": "excluded-private-tag"}}]
    else:
        assert parsed.netloc == "iaas.ap-sydney-1.oraclecloud.com" and parsed.path == "/20160918/instances"
        assert query == {"compartmentId": [${JSON.stringify(compartment)}], "limit": ["25"]}
        rows = [{"id": ${JSON.stringify(instance)}, "displayName": "worker\u0000\n\u202e1", "lifecycleState": "RUNNING", "shape": "VM.Standard.E4.Flex", "availabilityDomain": "fixture:SYD-1-AD-1", "metadata": {"user_data": "excluded-private-user-data"}}]
    fields = dict(re.findall(r'(\w+)="([^"]*)"', request.headers["authorization"]))
    assert fields["keyId"] == "ST$" + ${JSON.stringify(token)}
    assert fields["algorithm"] == "rsa-sha256" and fields["headers"] == "date (request-target) host"
    signed = ("date: " + request.headers["date"] + "\n(request-target): get " + request.path_url + "\nhost: " + parsed.netloc).encode("ascii")
    public = serialization.load_pem_public_key(${JSON.stringify(fixturePublicKey)}.encode("ascii"))
    public.verify(base64.b64decode(fields["signature"]), signed, padding.PKCS1v15(), hashes.SHA256())
    if ${JSON.stringify(behavior)} == "delay": time.sleep(60)
    if ${JSON.stringify(behavior)} == "header_error":
        from urllib3.exceptions import HeaderParsingError
        raise HeaderParsingError([], "excluded-private-header-error")
    if ${JSON.stringify(behavior)} == "private_label": rows[0]["name"] = ${JSON.stringify(fixtureTarget.userOcid + " " + fixtureTarget.tenancyOcid)}
    if ${JSON.stringify(behavior)} == "token_label": rows[0]["name"] = ${JSON.stringify(token)}
    if ${JSON.stringify(behavior)} == "key_label": rows[0]["name"] = "-----BEGIN PRIVATE KEY-----\nfixture-only-material"
    if ${JSON.stringify(behavior)} == "foreign_region": rows[0]["id"] = "ocid1.instance.oc1.us-phoenix-1.foreigninstance"
    if ${JSON.stringify(behavior)} == "many": rows *= 27
    body = json.dumps(rows).encode("utf-8")
    if ${JSON.stringify(behavior)} == "oversized": body = b"x" * (1048576 + 1)
    if ${JSON.stringify(behavior)} == "invalid_json": body = b'[{"id":"bad","id":"duplicate"}]'
    response = Response()
    response.status_code = 401 if ${JSON.stringify(behavior)} == "reject" else 302 if ${JSON.stringify(behavior)} == "redirect" else 200
    if response.status_code == 401: body = b'{"code":"NotAuthenticated","message":"excluded-private-backend-error"}'
    response.raw = io.BytesIO(body)
    response.headers["content-type"] = "application/json"
    response.headers["location"] = "https://evil.invalid/"
    if ${JSON.stringify(behavior)} == "accept": response.headers["opc-next-page"] = "excluded-private-page-token"
    response.request = request
    response.url = request.url
    return response
def _fixture_import(name, globals=None, locals=None, fromlist=(), level=0):
    global _patched
    result = _import(name, globals, locals, fromlist, level)
    if name == "oci.base_client" and not _patched:
        _patched = True
        sys.modules["oci._vendor.requests"].Session.send = _send
    return result
builtins.__import__ = _fixture_import
`;
}
async function setup(t: TestContext, behavior: Behavior = "accept", wrongIdentity = false, delayConfig = false) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "oci-task-reader-"));
  const attemptId = randomUUID(), session = await createOwnedOciSession(root, attemptId, fixtureTarget);
  const token = fixtureToken(wrongIdentity ? { sub: "ocid1.user.oc1..different", tenant: fixtureTarget.tenancyOcid, exp: 0 } : undefined);
  await fs.writeFile(session.paths.privateKeyFile, fixturePrivateKey, { mode: 0o600 });
  await fs.writeFile(session.paths.publicKeyFile, fixturePublicKey, { mode: 0o600 });
  await fs.writeFile(session.paths.tokenFile, token, { mode: 0o600 });
  await fs.writeFile(session.paths.configFile, `[${session.paths.profileName}]\nfingerprint=${Array(16).fill("aa").join(":")}\nkey_file=${session.paths.privateKeyFile}\nsecurity_token_file=${session.paths.tokenFile}\ntenancy=${fixtureTarget.tenancyOcid}\nregion=${fixtureTarget.region}\n`);
  t.after(async () => { try { await releaseOwnedOciSession(session); } catch { /* Mutation fixtures preserve rejected artifacts. */ } await fs.rm(root, { recursive: true, force: true }); });
  let retained = 0, calls = 0, authorizations = 0;
  const spawn = cp.spawn;
  t.mock.method(cp, "spawn", ((file: string, args: string[], options: cp.SpawnOptions) => {
    assert.equal(file, "/opt/homebrew/Cellar/oci-cli/3.88.0/libexec/bin/python");
    assert.deepEqual(args.slice(0, 3), ["-I", "-S", "-c"]);
    assert.equal(options.shell, false); assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "pipe", "pipe"]); calls++;
    const child = spawn(file, [...args.slice(0, 3), transport(token, behavior) + args[3]], options);
    if (delayConfig) {
      const commands = child.stdio[3] as import("node:stream").Writable;
      const write = commands.write.bind(commands);
      let first = true;
      t.mock.method(commands, "write", ((...args: Parameters<typeof write>) => {
        if (!first) return write(...args);
        first = false; setTimeout(() => write(...args), 1250); return true;
      }) as typeof commands.write);
    }
    return child;
  }) as typeof cp.spawn);
  const controller = new AbortController();
  return { input: { attemptId, session, signal: controller.signal, lifecycle: new AbortController().signal,
    authorize: async () => { authorizations++; }, retainWorker: () => { retained++; return () => { retained--; }; } },
    controller, token, retained: () => retained, calls: () => calls, authorizations: () => authorizations };
}

test("the owned CLI signer performs a real bounded compartment read and returns only projected rows", async (t) => {
  const module = await api(), s = await setup(t);
  const result = await module.runOwnedOciTask({ ...s.input, request: { operation: "list_compartments" } });
  assert.deepEqual(result, { operation: "list_compartments", rows: [{ ocid: compartment, name: "Project One" }], truncated: true });
  assert.equal(s.retained(), 0); assert.equal(s.calls(), 1); assert.equal(s.authorizations(), 3);
  for (const value of [s.token, fixturePrivateKey, s.input.session.paths.root, "excluded-private"]) assert.equal(JSON.stringify(result).includes(value), false);
});

test("the real signer reads instances only in the host-mapped compartment with no metadata export", async (t) => {
  const module = await api(), s = await setup(t);
  assert.deepEqual(await module.runOwnedOciTask({ ...s.input, request: { operation: "list_instances", compartmentOcid: compartment } }), {
    operation: "list_instances", rows: [{ id: instance, displayName: "worker1", lifecycleState: "RUNNING", shape: "VM.Standard.E4.Flex", availabilityDomain: "fixture:SYD-1-AD-1" }], truncated: true,
  });
  assert.equal(s.retained(), 0);
});

test("the worker refuses a non-Sydney instance before any projected rows leave its private pipe", async (t) => {
  const module = await api(), s = await setup(t, "foreign_region");
  await assert.rejects(module.runOwnedOciTask({ ...s.input, request: { operation: "list_instances", compartmentOcid: compartment } }),
    (error: unknown) => error instanceof module.OciTaskError && error.code === "response");
  assert.equal(s.calls(), 1); assert.equal(s.retained(), 0);
});

test("delayed private configuration leaves time for durable ownership attachment before the SDK task begins", async (t) => {
  const module = await api(), s = await setup(t, "accept", false, true);
  const result = await module.runOwnedOciTask({ ...s.input, request: { operation: "list_compartments" } });
  assert.equal(result.rows.length, 1); assert.equal(s.retained(), 0);
});

test("service refusal, redirects, header retries, malformed JSON and oversized bodies cannot return account data", async (t) => {
  const module = await api();
  for (const behavior of ["reject", "redirect", "header_error", "invalid_json", "oversized"] as const) await t.test(behavior, async (child) => {
    const s = await setup(child, behavior);
    await assert.rejects(module.runOwnedOciTask({ ...s.input, request: { operation: "list_compartments" } }), (error: unknown) => {
      assert.ok(error instanceof module.OciTaskError); assert.equal(String(error).includes("excluded-private"), false); return true;
    });
    assert.equal(s.retained(), 0);
  });
});

test("an accepted task response with the wrong token identity exports no rows", async (t) => {
  const module = await api(), s = await setup(t, "accept", true);
  await assert.rejects(module.runOwnedOciTask({ ...s.input, request: { operation: "list_compartments" } }), module.OciTaskError);
  assert.equal(s.retained(), 0);
});

test("resource labels cannot disclose independently selected user or tenancy identities", async (t) => {
  const module = await api(), s = await setup(t, "private_label");
  const result = await module.runOwnedOciTask({ ...s.input, request: { operation: "list_compartments" } });
  assert.ok(result.operation === "list_compartments");
  assert.equal(result.rows[0]?.name, "[account] [account]");
  assert.equal(JSON.stringify(result).includes(fixtureTarget.userOcid), false);
  assert.equal(JSON.stringify(result).includes(fixtureTarget.tenancyOcid), false);
  assert.equal(result.truncated, false);
});

test("known token and private key labels are redacted before output truncation", async (t) => {
  const module = await api();
  for (const behavior of ["token_label", "key_label"] as const) await t.test(behavior, async (child) => {
    const s = await setup(child, behavior);
    const result = await module.runOwnedOciTask({ ...s.input, request: { operation: "list_compartments" } });
    assert.ok(result.operation === "list_compartments");
    assert.ok(result.rows[0]?.name === "[credential]", "known credentials must be redacted before label truncation");
    assert.equal(JSON.stringify(result).includes(s.token.slice(0, 64)), false);
    assert.equal(JSON.stringify(result).includes("BEGIN PRIVATE KEY"), false);
  });
});

test("a service exceeding the requested row limit is truncated without another page request", async (t) => {
  const module = await api(), s = await setup(t, "many");
  const result = await module.runOwnedOciTask({ ...s.input, request: { operation: "list_compartments" } });
  assert.equal(result.rows.length, 25); assert.equal(result.truncated, true); assert.equal(s.calls(), 1);
});

test("a late authority refusal or artifact mutation discards successful task rows and releases the capture", async (t) => {
  const module = await api();
  for (const mutation of [false, true]) await t.test(String(mutation), async (child) => {
    const s = await setup(child); let checks = 0;
    await assert.rejects(module.runOwnedOciTask({ ...s.input, request: { operation: "list_compartments" }, authorize: async () => {
      if (++checks === 3) { if (mutation) await fs.writeFile(s.input.session.paths.tokenFile, "changed.synthetic.token"); else throw new Error("excluded-private-authority"); }
    } }), module.OciTaskError);
    assert.equal(s.retained(), 0);
  });
});

test("cancellation closes a delayed task child and releases its worker", async (t) => {
  const module = await api(), s = await setup(t, "delay");
  const pending = module.runOwnedOciTask({ ...s.input, request: { operation: "list_compartments" } });
  const timer = setTimeout(() => s.controller.abort(), 1200);
  try { await assert.rejects(pending, module.OciTaskError); } finally { clearTimeout(timer); }
  assert.equal(s.retained(), 0);
});

test("unrecognized commands, paths, endpoints and foreign root compartments cannot start a task process", async (t) => {
  const module = await api(), s = await setup(t);
  for (const request of [
    { operation: "delete_instance", instanceId: instance },
    { operation: "list_compartments", endpoint: "https://evil.invalid" },
    { operation: "list_instances", compartmentOcid: "/private/account/config" },
    { operation: "list_instances", compartmentOcid: "ocid1.tenancy.oc1..different" },
  ]) await assert.rejects(module.runOwnedOciTask({ ...s.input, request } as never), module.OciTaskError);
  await assert.rejects(module.runOwnedOciTask({ ...s.input, request: { operation: "list_compartments" }, session: { ...s.input.session } }), module.OciTaskError);
  assert.equal(s.calls(), 0); assert.equal(s.retained(), 0);
});

test("an already cancelled task performs no process or worker activity", async (t) => {
  const module = await api(), s = await setup(t); s.controller.abort();
  await assert.rejects(module.runOwnedOciTask({ ...s.input, request: { operation: "list_compartments" } }), module.OciTaskError);
  assert.equal(s.calls(), 0); assert.equal(s.retained(), 0); assert.equal(s.authorizations(), 0);
});

test("cancellation during writer preparation closes its late intent without spawning or retaining a worker", async (t) => {
  const module = await api(), s = await setup(t);
  let entered!: () => void, resume!: () => void;
  const preparing = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { resume = resolve; });
  const begin = OwnedResourceLedger.prototype.beginWriter;
  t.mock.method(OwnedResourceLedger.prototype, "beginWriter", async function (this: OwnedResourceLedger, resource: Parameters<typeof begin>[0], role: Parameters<typeof begin>[1]) {
    const writer = await begin.call(this, resource, role); entered(); await held; return writer;
  });
  const pending = module.runOwnedOciTask({ ...s.input, request: { operation: "list_compartments" } });
  await preparing; s.controller.abort(); await assert.rejects(pending, module.OciTaskError);
  assert.equal(s.calls(), 0);
  resume();
  for (let n = 0; n < 50 && s.retained(); n++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(s.retained(), 0, "a settled pre-spawn intent has no process left to retain");
  await releaseOwnedOciSession(s.input.session);
});

test("a failed late pre-spawn intent closure retains uncertain cleanup after cancellation", async (t) => {
  const module = await api(), s = await setup(t);
  let entered!: () => void, resume!: () => void;
  const preparing = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { resume = resolve; });
  const begin = OwnedResourceLedger.prototype.beginWriter;
  t.mock.method(OwnedResourceLedger.prototype, "beginWriter", async function (this: OwnedResourceLedger, resource: Parameters<typeof begin>[0], role: Parameters<typeof begin>[1]) {
    const writer = await begin.call(this, resource, role); entered(); await held; return writer;
  });
  t.mock.method(OwnedResourceLedger.prototype, "confirmWriterClosed", async () => { throw new Error("synthetic closure refusal"); });
  const pending = module.runOwnedOciTask({ ...s.input, request: { operation: "list_compartments" } });
  await preparing; s.controller.abort();
  try {
    await assert.rejects(pending, (error: unknown) => error instanceof module.OciTaskError && error.cleanupUncertain);
  } finally { resume(); }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(s.calls(), 0); assert.equal(s.retained(), 1);
});

test("a synchronous task spawn failure cannot hang on a stalled writer abandonment", async (t) => {
  const module = await api(), s = await setup(t);
  let entered!: () => void, resume!: () => void;
  const abandoning = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { resume = resolve; });
  const confirm = OwnedResourceLedger.prototype.confirmWriterClosed;
  t.mock.method(OwnedResourceLedger.prototype, "confirmWriterClosed", async function (this: OwnedResourceLedger, writer: Parameters<typeof confirm>[0]) {
    entered(); await held; await confirm.call(this, writer);
  });
  t.mock.method(cp, "spawn", () => { throw new Error("synthetic spawn refusal"); });
  const pending = module.runOwnedOciTask({ ...s.input, request: { operation: "list_compartments" } }); void pending.catch(() => {});
  await abandoning;
  let timer!: ReturnType<typeof setTimeout>;
  try {
    const result = await Promise.race([pending.then(() => "success", (error: unknown) =>
      error instanceof module.OciTaskError && error.cleanupUncertain ? "uncertain" : "other"),
    new Promise<string>((resolve) => { timer = setTimeout(() => resolve("hung"), 1000); })]);
    assert.equal(result, "uncertain"); assert.equal(s.retained(), 1);
  } finally { clearTimeout(timer); resume(); await pending.catch(() => {}); }
  for (let n = 0; n < 100 && s.retained(); n++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(s.retained(), 0);
  await releaseOwnedOciSession(s.input.session);
});
