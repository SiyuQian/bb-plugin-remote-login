import assert from "node:assert/strict";
import cp from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import test, { type TestContext } from "node:test";
import { OCI_CHILD_WRAPPER_SOURCE } from "../oci-wrapper-source.ts";
import { cliFlowFixture as system, eventually, nativeValue, supportedHost } from "./cli-flow-fixture.ts";

const privateMarker = "private-cli-flow-fault-marker";

// Hold the real parent's binding ACK. The installed bootstrap remains blocked
// in its owned server constructor, before key generation, nonce or browser URL.
// These additional child guards make a test regression unable to reach account IO.
function holdBeforeKey(t: TestContext) {
  const spawn = cp.spawn;
  const events: Array<Record<string, unknown>> = [];
  let child: cp.ChildProcess | undefined, spawns = 0, heldAcks = 0;
  let bound!: () => void, refuseBinding!: (error: Error) => void;
  const bindingHeld = new Promise<void>((resolve, reject) => { bound = resolve; refuseBinding = reject; });
  void bindingHeld.catch(() => {});
  const guard = String.raw`import builtins, os, sys
_prekey_import = builtins.__import__
def _prekey_keygen_forbidden(*args, **kwargs):
    os._exit(98)
def _prekey_no_network(event, args):
    if event in ("socket.connect", "socket.connect_ex", "socket.getaddrinfo", "socket.sendto"):
        os._exit(97)
sys.addaudithook(_prekey_no_network)
def _prekey_guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    result = _prekey_import(name, globals, locals, fromlist, level)
    bootstrap = sys.modules.get("oci_cli.cli_setup_bootstrap")
    if bootstrap is not None and hasattr(bootstrap, "cli_util"):
        bootstrap.cli_util.generate_key = _prekey_keygen_forbidden
        if hasattr(bootstrap, "uuid"):
            bootstrap.uuid.uuid4 = _prekey_keygen_forbidden
        if hasattr(bootstrap, "persist_user_session"):
            bootstrap.persist_user_session = _prekey_keygen_forbidden
    return result
builtins.__import__ = _prekey_guarded_import
`;
  t.mock.method(cp, "spawn", ((file: string, args: string[], options: cp.SpawnOptions) => {
    if (file !== "/opt/homebrew/Cellar/oci-cli/3.88.0/libexec/bin/python") return spawn(file, args, options);
    assert.deepEqual(args.slice(0, 3), ["-I", "-S", "-c"]);
    assert.equal(args[3], OCI_CHILD_WRAPPER_SOURCE, "only the guarded owned child may run");
    spawns++;
    child = spawn(file, [...args.slice(0, 3), guard + args[3]], options);
    child.once("close", () => { if (!heldAcks) refuseBinding(new Error("pre-key child exited before owned binding")); });
    const commands = child.stdio[3] as Writable;
    const write = commands.write.bind(commands);
    t.mock.method(commands, "write", ((...args: Parameters<typeof write>) => {
      const message = JSON.parse(String(args[0])) as { type?: string };
      if (message.type !== "accept_binding") return write(...args);
      heldAcks++;
      const callback = args.at(-1);
      if (typeof callback === "function") queueMicrotask(() => callback());
      bound();
      return true;
    }) as typeof commands.write);
    let remainder = "";
    (child.stdio[4] as Readable).on("data", (chunk: Buffer) => {
      remainder += chunk.toString("utf8");
      for (;;) {
        const newline = remainder.indexOf("\n");
        if (newline < 0) break;
        events.push(JSON.parse(remainder.slice(0, newline)) as Record<string, unknown>);
        remainder = remainder.slice(newline + 1);
      }
    });
    return child;
  }) as typeof cp.spawn);
  return { bindingHeld, events, child: () => child, counts: () => ({ spawns, heldAcks }) };
}


async function assertPrekeyArtifacts(dataDir: string, attemptId: string) {
  const root = join(dataDir, `oci-session-${attemptId}`), profile = `BB_REMOTE_${attemptId.replaceAll("-", "")}`;
  for (const file of ["config", "oci_cli_rc", ...["oci_api_key.pem", "oci_api_key_public.pem", "token"].map((name) => `tokens/${profile}/${name}`)]) {
    assert.equal((await stat(join(root, file))).size, 0, "pre-key fault must leave every owned authentication artifact empty");
  }
}
async function assertCleanup(s: Awaited<ReturnType<typeof system>>) {
  await eventually(async () => s.worker.experimental_getRetainedWorkerLeaseCount() === 0);
  assert.deepEqual((await readdir(s.dataDir)).sort(), ["control-budget.json", "control-root.json", "owned-resources-v1", "paired-control-acceptance.json"]);
  const directory = join(s.dataDir, "owned-resources-v1");
  const records = await Promise.all((await readdir(directory)).filter((name) => name.endsWith(".json"))
    .map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8")) as { state: string; writers: Array<{ role: string; state: string }> }));
  assert.equal(records.length, 1);
  assert.equal(records[0]!.state, "released");
  assert.deepEqual(records[0]!.writers.map(({ role, state }) => ({ role, state })), [{ role: "authentication", state: "closed" }]);
}

// These are genuine composed negative paths, not account authentication or
// successful bootstrap/service/native-delivery evidence.
test("lost CLI startup ACK refuses replay and native completion while exact pre-key cleanup succeeds", {
  skip: !supportedHost, timeout: 45_000, concurrency: false,
}, async (t) => {
  const s = await system(t), prekey = holdBeforeKey(t);
  s.faults.afterHostCall = async (method) => {
    if (method === "startOci") { await prekey.bindingHeld; throw new Error(privateMarker); }
  };
  const response = await s.send("start");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "login_control_failed" });
  assert.deepEqual(prekey.counts(), { spawns: 1, heldAcks: 1 });
  assert.deepEqual(prekey.events.map((event) => event.type), ["ready"]);
  await assertPrekeyArtifacts(s.dataDir, s.attemptId);
  assert.equal(s.worker.experimental_getRetainedWorkerLeaseCount(), 1);
  const failed = await s.status();
  assert.equal(failed.phase, "failed");
  assert.equal(failed.verification, null);
  assert.equal(failed.resume.state, "none");
  assert.equal((await s.send("start")).status, 409);
  assert.equal((await s.send("handback", { verified: true })).status, 400);
  assert.equal(s.settled(), false);
  s.harness.behavior.submitInteraction(s.interaction.id, { attemptId: s.attemptId, verified: true });
  const result = await s.native;
  assert.equal(typeof result === "object" && result.isError, true);
  assert.deepEqual(nativeValue(result), { error: "unavailable" });
  const service = s.harness.behavior.runService("login-coordinator");
  try {
    await assertCleanup(s);
    await eventually(async () => (s.bb.storage.database().prepare("SELECT status FROM remote_login_cleanup_v1 WHERE attempt_id=?")
      .get(s.attemptId) as { status: string }).status === "acknowledged");
  } finally { service.controller.abort(); await service.done; }
  assert.deepEqual(prekey.counts(), { spawns: 1, heldAcks: 1 });
  assert.equal(prekey.child()?.exitCode, 1);
  assert.deepEqual(prekey.events.map((event) => event.type), ["ready", "exit"]);
  assert.equal(prekey.events[1]!.outcome, "cancelled");
  await s.assertPrivate();
});

test("host worker exit during pre-key startup cannot create verification or a native account reference", {
  skip: !supportedHost, timeout: 45_000, concurrency: false,
}, async (t) => {
  const s = await system(t), prekey = holdBeforeKey(t);
  assert.equal((await s.send("start")).status, 202);
  await prekey.bindingHeld;
  await assertPrekeyArtifacts(s.dataDir, s.attemptId);
  assert.deepEqual(prekey.events.map((event) => event.type), ["ready"]);
  await s.worker.experimental_dispose();
  await assertCleanup(s);
  assert.equal(prekey.child()?.exitCode, 1);
  assert.deepEqual(prekey.counts(), { spawns: 1, heldAcks: 1 });
  assert.deepEqual(prekey.events.map((event) => event.type), ["ready", "exit"]);
  assert.equal(prekey.events[1]!.outcome, "cancelled");
  assert.equal((await s.send("start")).status, 409);
  s.harness.behavior.submitInteraction(s.interaction.id, { attemptId: s.attemptId });
  const result = await s.native;
  assert.equal(typeof result === "object" && result.isError, true);
  assert.deepEqual(nativeValue(result), { error: "unavailable" });
  assert.equal((await s.status()).verification, null);
  assert.equal((await s.status()).resume.state, "none");
  await s.assertPrivate();
});
