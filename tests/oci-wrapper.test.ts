import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex, Readable } from "node:stream";
import test from "node:test";
import { OCI_CHILD_WRAPPER_SOURCE } from "../oci-wrapper-source.ts";

const python = "/opt/homebrew/Cellar/oci-cli/3.88.0/libexec/bin/python";
const supported = process.platform === "darwin" && process.arch === "arm64";
type Event = Record<string, unknown>;

function runWrapper(options: { raw?: string; mode?: "fixture" | "prekey_probe"; callbackPort?: "fixed" | "ephemeral"; lifetimeMs?: number; env?: NodeJS.ProcessEnv; prelude?: string; eventPipe?: boolean; configureOnly?: boolean; entrySource?: string; configurationDelayMs?: number } = {}) {
  const attemptId = randomUUID();
  const source = options.entrySource ? OCI_CHILD_WRAPPER_SOURCE.replace("raise SystemExit(main())", options.entrySource) : options.configureOnly ? OCI_CHILD_WRAPPER_SOURCE.replace("raise SystemExit(main())", "runtime = PrivateRuntime()\ntry:\n    runtime.configure()\n    runtime.emit(\"exit\", outcome=\"configured\", reason=\"configured\")\nexcept ChildStop as stopped:\n    runtime.emit(\"exit\", outcome=stopped.outcome, reason=stopped.reason)\n    raise SystemExit(1)") : OCI_CHILD_WRAPPER_SOURCE;
  const child = spawn(python, ["-I", "-S", "-c", (options.prelude ?? "") + source], {
    stdio: ["ignore", "pipe", "pipe", "pipe", options.eventPipe === false ? "ignore" : "pipe"],
    env: { PATH: "/usr/bin:/bin", ...options.env },
  });
  const input = child.stdio[3] as Duplex;
  input.on("error", () => {});
  const events: Event[] = [];
  let pending = "";
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (data: Buffer) => { stdout += data.toString(); });
  child.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });
  (child.stdio[4] as Readable | null)?.on("data", (data: Buffer) => {
    pending += data.toString();
    while (pending.includes("\n")) {
      const lineEnd = pending.indexOf("\n");
      const line = pending.slice(0, lineEnd);
      pending = pending.slice(lineEnd + 1);
      assert.ok(Buffer.byteLength(line) < 16_384);
      events.push(JSON.parse(line) as Event);
    }
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  function send(value: unknown) { input.write(JSON.stringify(value) + "\n"); }
  const configure = () => input.write(options.raw ?? JSON.stringify({ version: 1, attemptId, mode: options.mode ?? "fixture", callbackPort: options.callbackPort ?? "ephemeral", lifetimeMs: options.lifetimeMs ?? 5_000 }) + "\n");
  if (options.configurationDelayMs) { const timer = setTimeout(configure, options.configurationDelayMs); void exited.finally(() => clearTimeout(timer)); }
  else configure();
  async function event(type: string): Promise<Event> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const found = events.find((value) => value.type === type);
      if (found) return found;
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail(`missing private ${type} event; exit=${child.exitCode}; events=${JSON.stringify(events)}`);
  }
  async function finish() {
    const code = await Promise.race([exited, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("fixture child did not exit")); }, 4_000);
      timer.unref();
      void exited.finally(() => clearTimeout(timer));
    })]);
    assert.equal(stdout, "");
    assert.equal(stderr, "");
    assert.equal(pending, "");
    return code;
  }
  function ack() { send({ version: 1, attemptId, type: "accept_binding" }); }
  function cancel() { send({ version: 1, attemptId, type: "cancel" }); }
  return { child, input, attemptId, events, event, finish, send, ack, cancel };
}

async function dispose(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

test("durable parent ownership may finish before a delayed first configuration packet", { skip: !supported }, async (t) => {
  const fixture = runWrapper({ configureOnly: true, configurationDelayMs: 1250 });
  t.after(() => dispose(fixture.child));
  assert.equal(await fixture.finish(), 0);
  assert.equal(fixture.events.at(-1)?.outcome, "configured");
});

test("fixture binds loopback, waits for ownership acknowledgement and captures only a private synthetic URL", { skip: !supported }, async (t) => {
  const fixture = runWrapper();
  t.after(() => dispose(fixture.child));
  const ready = await fixture.event("ready");
  assert.deepEqual(ready, { version: 1, attemptId: fixture.attemptId, type: "ready", pid: fixture.child.pid, host: "127.0.0.1", port: ready.port });
  assert.equal(typeof ready.port, "number");
  assert.ok(Number(ready.port) > 0);
  assert.equal(fixture.events.some((value) => value.type === "browser"), false);
  fixture.ack();
  const browser = await fixture.event("browser");
  const url = new URL(String(browser.url));
  assert.equal(url.hostname, "login.fixture.invalid");
  assert.equal(url.pathname, "/v1/oauth2/authorize");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:8181");
  assert.equal(url.searchParams.get("nonce"), fixture.attemptId);
  const response = await fetch(`http://127.0.0.1:${ready.port}/fixture-complete`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "Synthetic fixture complete.");
  assert.equal(await fixture.finish(), 0);
  assert.deepEqual(fixture.events.at(-1), { version: 1, attemptId: fixture.attemptId, type: "exit", outcome: "fixture_complete", reason: "fixture_complete" });
});

test("malformed, oversized and extra configuration fields fail closed without reflecting input", { skip: !supported }, async (t) => {
  for (const raw of ["not-json\n", "null\n", "x".repeat(4_097) + "\n", JSON.stringify({ version: 1, attemptId: randomUUID(), mode: "authenticate", callbackPort: "ephemeral", lifetimeMs: 100 }) + "\n", JSON.stringify({ version: 1, attemptId: randomUUID(), mode: "fixture", callbackPort: "ephemeral", lifetimeMs: 100, secret: "SYNTHETIC_PRIVATE_INPUT" }) + "\n", JSON.stringify({ version: 1, attemptId: "wrong-attempt", mode: "fixture", callbackPort: "ephemeral", lifetimeMs: 100 }) + "\n", JSON.stringify({ version: 1, attemptId: randomUUID(), mode: "fixture", callbackPort: 8_181, lifetimeMs: 100 }) + "\n", JSON.stringify({ version: 1, attemptId: randomUUID(), mode: "fixture", callbackPort: "ephemeral", lifetimeMs: true }) + "\n"]) {
    const fixture = runWrapper({ raw });
    t.after(() => dispose(fixture.child));
    assert.notEqual(await fixture.finish(), 0);
    assert.equal(fixture.events.some((value) => value.type === "ready" || value.type === "browser"), false);
    assert.equal(JSON.stringify(fixture.events).includes("SYNTHETIC_PRIVATE_INPUT"), false);
  }
});

test("mismatched or malformed binding acknowledgement cannot release a browser URL", { skip: !supported }, async (t) => {
  for (const command of [{ version: 1, attemptId: randomUUID(), type: "accept_binding" }, { version: 1, type: "accept_binding" }, { type: "accept_binding", extra: true }]) {
    const fixture = runWrapper();
    t.after(() => dispose(fixture.child));
    await fixture.event("ready");
    fixture.send(command);
    assert.notEqual(await fixture.finish(), 0);
    assert.equal(fixture.events.some((value) => value.type === "browser"), false);
    assert.equal(fixture.events.at(-1)?.outcome, "refused");
  }
});

test("cancel, signal, config EOF and deadline close only the fixture's own listener", { skip: !supported }, async (t) => {
  for (const action of ["cancel", "signal", "eof", "deadline", "ack_timeout"] as const) {
    const fixture = runWrapper({ lifetimeMs: action === "ack_timeout" ? 400 : 5_000 });
    t.after(() => dispose(fixture.child));
    const ready = await fixture.event("ready");
    if (action !== "ack_timeout" && action !== "deadline") fixture.ack();
    if (action === "cancel") { await fixture.event("browser"); fixture.cancel(); }
    if (action === "signal") { await fixture.event("browser"); fixture.child.kill("SIGTERM"); }
    if (action === "eof") { await fixture.event("browser"); fixture.input.end(); }
    // Exercise the expiry handler after ready, before ACK can release a browser event.
    if (action === "deadline") fixture.child.kill("SIGALRM");
    assert.notEqual(await fixture.finish(), 0);
    const socket = connect({ host: "127.0.0.1", port: Number(ready.port) });
    await new Promise<void>((resolve, reject) => {
      socket.once("error", () => resolve());
      socket.once("connect", () => { socket.destroy(); reject(new Error("owned listener survived fixture exit")); });
    });
    assert.equal(fixture.events.at(-1)?.outcome, action === "cancel" || action === "signal" ? "cancelled" : "refused");
    if (action === "deadline") assert.equal(fixture.events.at(-1)?.reason, "deadline");
    if (action === "ack_timeout" || action === "deadline") assert.equal(fixture.events.some((value) => value.type === "browser"), false);
  }
});

test("expiry before browser emission closes the owned listener and leaves the failed event channel silent", { skip: !supported }, async (t) => {
  const entrySource = String.raw`original_command = PrivateRuntime.command
def expire_before_browser(self, end, accepting):
    original_command(self, end, accepting)
    if accepting:
        signal.setitimer(signal.ITIMER_REAL, 0)
        self.deadline = time.monotonic() - 1
PrivateRuntime.command = expire_before_browser
raise SystemExit(main())`;
  const fixture = runWrapper({ entrySource });
  t.after(() => dispose(fixture.child));
  const ready = await fixture.event("ready");
  fixture.ack();
  assert.notEqual(await fixture.finish(), 0);
  const socket = connect({ host: "127.0.0.1", port: Number(ready.port) });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", () => resolve());
    socket.once("connect", () => { socket.destroy(); reject(new Error("owned listener survived failed event emission")); });
  });
  assert.deepEqual(fixture.events, [ready]);
});

test("a client trickling an incomplete HTTP request cannot extend the child deadline", { skip: !supported }, async (t) => {
  const fixture = runWrapper({ lifetimeMs: 200 });
  t.after(() => dispose(fixture.child));
  const ready = await fixture.event("ready");
  fixture.ack();
  await fixture.event("browser");
  const socket = connect({ host: "127.0.0.1", port: Number(ready.port) });
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write("GET /fixture-complete HTTP/1.1\r\nX-Trickle: ");
  const trickle = setInterval(() => socket.write("x"), 20);
  t.after(() => clearInterval(trickle));
  const started = Date.now();
  assert.notEqual(await fixture.finish(), 0);
  assert.ok(Date.now() - started < 750, "request bytes must not reset the process deadline");
  assert.equal(fixture.events.at(-1)?.reason, "deadline");
});

test("fixture and actual bootstrap keep their owned listener until a delayed ownership acknowledgement", { skip: !supported }, async (t) => {
  for (const mode of ["fixture", "prekey_probe"] as const) {
    const fixture = runWrapper({ mode, lifetimeMs: 8_000 });
    t.after(() => dispose(fixture.child));
    const ready = await fixture.event("ready");
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    assert.equal(fixture.child.exitCode, null, "ownership checks may exceed one second under cold-import load");
    assert.equal(fixture.events.some((value) => value.type === "browser" || value.type === "exit"), false);
    const listener = connect({ host: "127.0.0.1", port: Number(ready.port) });
    await new Promise<void>((resolve, reject) => { listener.once("connect", resolve); listener.once("error", reject); });
    listener.destroy();
    fixture.ack();
    if (mode === "fixture") {
      await fixture.event("browser");
      assert.equal((await fetch(`http://127.0.0.1:${ready.port}/fixture-complete`)).status, 200);
    }
    assert.equal(await fixture.finish(), 0);
    assert.equal(fixture.events.at(-1)?.outcome, mode === "fixture" ? "fixture_complete" : "prekey_probe_complete");
  }
});

test("existing fixed-port listener is refused without adopting or killing it", { skip: !supported }, async (t) => {
  const existing = createServer((socket) => socket.end("existing-listener"));
  await new Promise<void>((resolve, reject) => { existing.once("error", reject); existing.listen(8_181, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>((resolve, reject) => existing.close((error) => error ? reject(error) : resolve())));
  for (const mode of ["fixture", "prekey_probe"] as const) {
    const fixture = runWrapper({ callbackPort: "fixed", mode });
    t.after(() => dispose(fixture.child));
    assert.notEqual(await fixture.finish(), 0);
    assert.equal(fixture.events.some((value) => value.type === "ready" || value.type === "browser"), false);
    assert.equal(fixture.events.at(-1)?.reason, "binding_conflict");
  }
  const reply = await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: 8_181 });
    let text = "";
    socket.on("data", (data: Buffer) => { text += data.toString(); });
    socket.once("end", () => resolve(text));
    socket.once("error", reject);
  });
  assert.equal(reply, "existing-listener");
});

test("browser environment and private-channel failure cannot dispatch an OS browser", { skip: !supported }, async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "oci-wrapper-browser-fixture-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sentinel = join(root, "browser-was-launched");
  const env = { BROWSER: `/usr/bin/touch ${sentinel} %s`, PYTHONPATH: root };
  for (const eventPipe of [true, false]) {
    const fixture = runWrapper({ env, eventPipe });
    t.after(() => dispose(fixture.child));
    if (eventPipe) {
      await fixture.event("ready");
      (fixture.child.stdio[4] as Readable).destroy();
      fixture.ack();
    }
    assert.notEqual(await fixture.finish(), 0);
    await assert.rejects(fs.stat(sentinel), { code: "ENOENT" });
  }
});

test("fixture never imports OCI, reads account config or starts an outbound process or connection", { skip: !supported }, async (t) => {
  const prelude = String.raw`import os, sys
def audit_fixture(event, args):
    if ((event == "import" and args[0].split(".")[0] in ("oci", "oci_cli"))
        or (event == "open" and "/.oci" in str(args[0]))
        or event in ("subprocess.Popen", "os.system", "os.posix_spawn", "socket.connect")):
        os._exit(97)
sys.addaudithook(audit_fixture)
`;
  const fixture = runWrapper({ prelude });
  t.after(() => dispose(fixture.child));
  const ready = await fixture.event("ready");
  fixture.ack();
  await fixture.event("browser");
  await fetch(`http://127.0.0.1:${ready.port}/fixture-complete`);
  assert.equal(await fixture.finish(), 0);
});

test("real installed bootstrap binds through its replaced class and exits before keys, nonce, browser or account IO", { skip: !supported }, async (t) => {
  const prelude = String.raw`import os, sys
real_bootstrap_called = False
def account_free_calls(frame, event, arg):
    global real_bootstrap_called
    if event != "call":
        return
    source = frame.f_code.co_filename
    name = frame.f_code.co_name
    if source.endswith("/oci_cli/cli_setup_bootstrap.py") and name == "create_user_session":
        original = frame.f_globals["StoppableHttpServer"].__mro__[1]
        if original.__module__ != "oci_cli.cli_setup_bootstrap" or original.__name__ != "StoppableHttpServer":
            os._exit(96)
        real_bootstrap_called = True
    if ((source.endswith("/oci_cli/cli_util.py") and name == "generate_key")
        or (real_bootstrap_called and source.endswith("/uuid.py") and name == "uuid4")
        or name == "persist_user_session"
        or (source.endswith("/webbrowser.py") and name.startswith("open"))):
        os._exit(96)
def account_free_audit(event, args):
    if (event in ("subprocess.Popen", "os.system", "os.posix_spawn", "socket.connect", "socket.sendto")
        or (event == "open" and type(args[0]) is str and (args[0].startswith("/Users/") or "/.oci/" in args[0]))
        or (event == "socket.bind" and not real_bootstrap_called)):
        os._exit(96)
sys.setprofile(account_free_calls)
sys.addaudithook(account_free_audit)
`;
  const fixture = runWrapper({ mode: "prekey_probe", lifetimeMs: 15_000, prelude });
  t.after(() => dispose(fixture.child));
  const ready = await fixture.event("ready");
  assert.deepEqual(ready, { version: 1, attemptId: fixture.attemptId, type: "ready", pid: fixture.child.pid, host: "127.0.0.1", port: ready.port });
  assert.equal(fixture.events.some((value) => value.type === "browser" || value.type === "exit"), false);
  fixture.ack();
  assert.equal(await fixture.finish(), 0);
  assert.deepEqual(fixture.events.at(-1), { version: 1, attemptId: fixture.attemptId, type: "exit", outcome: "prekey_probe_complete", reason: "prekey_probe_complete" });
  assert.equal(fixture.events.some((value) => value.type === "browser"), false);
  const socket = connect({ host: "127.0.0.1", port: Number(ready.port) });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", () => resolve());
    socket.once("connect", () => { socket.destroy(); reject(new Error("prekey listener survived child exit")); });
  });
});

test("authenticate rejects unowned or extra caller-selected layout before OCI import", { skip: !supported }, async (t) => {
  for (const layout of [{ sessionRoot: "/missing/oci-session", profileName: "DEFAULT", region: "ap-sydney-1" }, { sessionRoot: "/missing/oci-session", profileName: "DEFAULT", region: "ap-sydney-1", enabled: true }]) {
    const attemptId = randomUUID();
    const fixture = runWrapper({ raw: JSON.stringify({ version: 1, attemptId, mode: "authenticate", callbackPort: "fixed", lifetimeMs: 900_000, ...layout }) + "\n" });
    t.after(() => dispose(fixture.child));
    assert.notEqual(await fixture.finish(), 0);
    assert.equal(fixture.events.some((value) => value.type === "ready" || value.type === "browser"), false);
    assert.equal(fixture.events.at(-1)?.reason, "configuration");
  }
});

test("authentication configuration accepts only the fresh owned layout and fixed callback", { skip: !supported }, async (t) => {
  const attemptId = randomUUID();
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "oci-config-fixture-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const sessionRoot = join(base, `oci-session-${attemptId}`);
  const profileName = `BB_REMOTE_${attemptId.replaceAll("-", "")}`;
  await fs.mkdir(join(sessionRoot, "tokens", profileName), { recursive: true, mode: 0o700 });
  await fs.writeFile(join(sessionRoot, "config"), "", { mode: 0o600 });
  await fs.writeFile(join(sessionRoot, "oci_cli_rc"), "", { mode: 0o600 });
  for (const name of ["oci_api_key.pem", "oci_api_key_public.pem", "token"]) await fs.writeFile(join(sessionRoot, "tokens", profileName, name), "", { mode: 0o600 });
  const config = { version: 1, attemptId, mode: "authenticate", callbackPort: "fixed", lifetimeMs: 900_000, sessionRoot, profileName, region: "ap-sydney-1" };
  const accepted = runWrapper({ raw: JSON.stringify(config) + "\n", configureOnly: true });
  t.after(() => dispose(accepted.child));
  assert.equal(await accepted.finish(), 0);
  assert.equal(accepted.events.at(-1)?.outcome, "configured");
  for (const wrong of [{ ...config, callbackPort: "ephemeral" }, { ...config, profileName: "DEFAULT" }, { ...config, region: "us-ashburn-1" }, { ...config, lifetimeMs: 900_001 }, { ...config, sessionRoot: sessionRoot + "/." }]) {
    const refused = runWrapper({ raw: JSON.stringify(wrong) + "\n", configureOnly: true });
    t.after(() => dispose(refused.child));
    assert.notEqual(await refused.finish(), 0);
    assert.equal(refused.events.at(-1)?.reason, "configuration");
  }
  await fs.writeFile(join(sessionRoot, "tokens", profileName, "token"), "existing token refuses a fresh authentication run");
  const existing = runWrapper({ raw: JSON.stringify(config) + "\n", configureOnly: true });
  t.after(() => dispose(existing.child));
  assert.notEqual(await existing.finish(), 0);
  assert.equal(existing.events.at(-1)?.reason, "configuration");
});

test("production browser capture accepts only the pinned Oracle authorization shape and public JWK", { skip: !supported }, async (t) => {
  const jwk = { kty: "RSA", n: Buffer.alloc(256, 0xff).toString("base64url"), e: "AQAB", kid: "Ignored" };
  function url(key: unknown = jwk) {
    const query = new URLSearchParams({ action: "login", client_id: "iaas_console", response_type: "token id_token", nonce: randomUUID(), scope: "openid", public_key: Buffer.from(JSON.stringify(key)).toString("base64").replaceAll("+", "-").replaceAll("/", "_"), redirect_uri: "http://localhost:8181" });
    return `https://login.ap-sydney-1.oraclecloud.com/v1/oauth2/authorize?${query}`;
  }
  const acceptedUrl = url();
  for (const [value, accepted] of [[acceptedUrl, true], [acceptedUrl.replace("login.ap-sydney-1.oraclecloud.com", "login.ap-sydney-1.oraclecloud.com.evil.invalid"), false], [acceptedUrl + "&scope=openid", false], [acceptedUrl.replace("localhost%3A8181", "127.0.0.1%3A8181"), false], [url({ ...jwk, d: "synthetic-private-field" }), false], [url({ ...jwk, e: "Aw" }), false], [url({ ...jwk, n: "AA" }), false]] as const) {
    const entrySource = `runtime = PrivateRuntime()\nruntime.configure()\nruntime.mode = "authenticate"\ntry:\n    runtime.capture_browser(${JSON.stringify(value)})\nexcept ChildStop as stopped:\n    runtime.emit("exit", outcome=stopped.outcome, reason=stopped.reason)\n    raise SystemExit(1)\nruntime.emit("exit", outcome="fixture_complete", reason="fixture_complete")`;
    const fixture = runWrapper({ entrySource });
    t.after(() => dispose(fixture.child));
    assert.equal(await fixture.finish(), accepted ? 0 : 1);
    assert.equal(fixture.events.some((event) => event.type === "browser"), accepted);
    if (!accepted) assert.equal(fixture.events.at(-1)?.reason, "browser_capture");
  }
});

test("installed import cannot open an unapproved file or start a network connection", { skip: !supported }, async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "oci-denied-io-fixture-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const synthetic = join(root, "synthetic-config");
  await fs.writeFile(synthetic, "synthetic-account-only");
  for (const [operation, reason] of [[`open(${JSON.stringify(synthetic)}, "r")`, "audit_file"], ['__import__("socket").socket().connect(("127.0.0.1", 9))', "audit_operation"]] as const) {
    const prelude = `import builtins\noriginal_import = builtins.__import__\ndef guarded_import(name, *args, **kwargs):\n    if name == "oci_cli":\n        ${operation}\n    return original_import(name, *args, **kwargs)\nbuiltins.__import__ = guarded_import\n`;
    const fixture = runWrapper({ mode: "prekey_probe", prelude });
    t.after(() => dispose(fixture.child));
    assert.notEqual(await fixture.finish(), 0);
    assert.equal(fixture.events.at(-1)?.reason, reason);
    assert.equal(fixture.events.some((event) => event.type === "ready" || event.type === "browser"), false);
  }
});

test("production call contract binds genuine installed signatures and requires create before persistence", { skip: !supported }, async (t) => {
  const entrySource = String.raw`runtime = PrivateRuntime()
runtime.configure()
bootstrap = import_bootstrap(runtime)
import inspect
create_signature = inspect.signature(bootstrap.create_user_session)
persist_signature = inspect.signature(bootstrap.persist_user_session)
runtime.mode = "authenticate"
runtime.session_root = "/synthetic-owned-session"
runtime.profile = "BB_REMOTE_785e2bf665204c05bcb2e1db930a161a"
session = object()
expected_create = {"region": "ap-sydney-1"}
expected_persist = {"profile_name": runtime.profile, "config": runtime.session_root + "/config", "token_location": runtime.session_root + "/tokens", "persist_token": True, "session_auth": True, "use_passphrase": False}
create_signature.bind(**expected_create)
persist_signature.bind(session, **expected_persist)
calls = []
fail_persist = False
def create(*args, **kwargs):
    create_signature.bind(*args, **kwargs)
    assert not args and kwargs == expected_create and not runtime.persisting
    calls.append("create")
    runtime.captured = True
    return session
def persist(*args, **kwargs):
    persist_signature.bind(*args, **kwargs)
    assert args == (session,) and kwargs == expected_persist and runtime.persisting
    assert calls[-1] == "create"
    calls.append("persist")
    if fail_persist:
        raise ChildStop("bootstrap_failure")
    return runtime.profile, runtime.session_root + "/config"
bootstrap.create_user_session = create
bootstrap.persist_user_session = persist
# The module was actually imported and checked above; only auth effects are stubbed here.
import_bootstrap = lambda ignored: bootstrap
installed_bootstrap(runtime)
assert calls == ["create", "persist"] and not runtime.persisting
fail_persist = True
try:
    installed_bootstrap(runtime)
    raise AssertionError("persistence failure returned success")
except ChildStop as stopped:
    assert stopped.reason == "bootstrap_failure" and not runtime.persisting
assert calls == ["create", "persist", "create", "persist"]
runtime.emit("exit", outcome="contract_checked", reason="contract_checked")`;
  const fixture = runWrapper({ entrySource, lifetimeMs: 15_000 });
  t.after(() => dispose(fixture.child));
  assert.equal(await fixture.finish(), 0);
  assert.deepEqual(fixture.events, [{ version: 1, attemptId: fixture.attemptId, type: "exit", outcome: "contract_checked", reason: "contract_checked" }]);
});

test("actual OCI persistence writes a synthetic session that the owned snapshot accepts", { skip: !supported }, async (t) => {
  const { createOwnedOciSession, captureOwnedOciSnapshot, releaseOwnedOciSession } = await import("../oci-owned-session.ts");
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "oci-real-writer-fixture-")));
  await fs.chmod(base, 0o700);
  const attemptId = randomUUID();
  const expected = { mode: "oci_cli" as const, tenancyOcid: "ocid1.tenancy.oc1..fixturetenancy", userOcid: "ocid1.user.oc1..fixtureuser", region: "ap-sydney-1", realm: "oc1" as const };
  const lease = await createOwnedOciSession(base, attemptId, expected);
  const originalFiles = new Map(await Promise.all([lease.paths.configFile, lease.paths.rcFile, lease.paths.publicKeyFile, lease.paths.privateKeyFile, lease.paths.tokenFile]
    .map(async (path) => [path, await fs.lstat(path, { bigint: true })] as const)));
  t.after(async () => { try { await releaseOwnedOciSession(lease); } finally { await fs.rm(base, { recursive: true, force: true }); } });
  const entrySource = String.raw`runtime = PrivateRuntime()
runtime.configure()
bootstrap = import_bootstrap(runtime)
# Disposable fixture RSA and an unsigned, non-redeemable token exercise only the writer.
private_key = bootstrap.cli_util.generate_key()
public_key = private_key.public_key()
token = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJmaXh0dXJlIiwidGVuYW50IjoiZml4dHVyZSJ9.synthetic"
session = bootstrap.UserSession("ocid1.user.oc1..fixtureuser", "ocid1.tenancy.oc1..fixturetenancy", "ap-sydney-1", token, public_key, private_key, bootstrap.cli_setup.public_key_to_fingerprint(public_key))
def create_fixture_session(*, region):
    assert region == "ap-sydney-1"
    runtime.captured = True
    return session
bootstrap.create_user_session = create_fixture_session
import_bootstrap = lambda ignored: bootstrap
installed_bootstrap(runtime)
runtime.emit("exit", outcome="persisted_fixture", reason="persisted_fixture")`;
  const fixture = runWrapper({ entrySource, raw: JSON.stringify({ version: 1, attemptId, mode: "authenticate", callbackPort: "fixed", lifetimeMs: 15_000, sessionRoot: lease.paths.root, profileName: lease.paths.profileName, region: expected.region }) + "\n" });
  t.after(() => dispose(fixture.child));
  assert.equal(await fixture.finish(), 0);
  assert.deepEqual(fixture.events, [{ version: 1, attemptId, type: "exit", outcome: "persisted_fixture", reason: "persisted_fixture" }]);
  const snapshot = await captureOwnedOciSnapshot(lease);
  assert.equal(snapshot.config.tenancyOcid, expected.tenancyOcid);
  assert.equal(snapshot.config.region, expected.region);
  assert.equal(snapshot.tokenBytes.toString("ascii").endsWith(".synthetic"), true);
  assert.equal(snapshot.privateKeyBytes.includes(Buffer.from("BEGIN PRIVATE KEY")), true);
  for (const path of [lease.paths.configFile, lease.paths.rcFile, lease.paths.publicKeyFile, lease.paths.privateKeyFile, lease.paths.tokenFile]) {
    const entry = await fs.lstat(path);
    assert.equal(entry.mode & 0o7777, 0o600);
    assert.equal(entry.nlink, 1);
    assert.equal(entry.uid, process.getuid!());
    const original = originalFiles.get(path)!;
    const current = await fs.lstat(path, { bigint: true });
    assert.equal(current.dev, original.dev); assert.equal(current.ino, original.ino); assert.equal(current.birthtimeNs, original.birthtimeNs);
  }
});
