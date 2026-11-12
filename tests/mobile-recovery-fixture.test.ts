import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";
import { recoveryChromeGuard } from "./mobile-recovery-fixture.ts";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const resolver = "--host-resolver-rules=MAP localhost 127.0.0.1, MAP 127.0.0.1 127.0.0.1, MAP * ~NOTFOUND";
function child() {
  let kills = 0;
  const handle = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null,
    kill() { kills++; handle.signalCode = "SIGKILL"; handle.emit("close", null, "SIGKILL"); return true; } });
  return { handle, kills: () => kills, close() { handle.exitCode = 0; handle.emit("close", 0); } };
}

test("recovery confinement is present before the original Chrome spawn and retains only counts", t => {
  const owned = child(); let invoked = 0;
  t.mock.method(cp, "spawn", ((file: string, args: string[], options: cp.SpawnOptions) => {
    invoked++; assert.equal(file, chrome); assert.equal(options.shell, false);
    assert.equal(args.filter(arg => arg.startsWith("--host-resolver-rules=")).at(-1), resolver);
    assert.ok(args.includes("--no-proxy-server")); assert.ok(args.includes("--disable-quic"));
    return owned.handle;
  }) as typeof cp.spawn);
  const guard = recoveryChromeGuard(t);
  const result = cp.spawn(chrome, ["--remote-debugging-pipe", "--user-data-dir=/tmp/recovery-unit/fixture-browser-owned"], { shell: false });
  assert.equal(result, owned.handle); assert.equal(invoked, 1); owned.close();
  assert.deepEqual(guard.counts(), { frontend: 0, host: 1, closed: 1, total: 1 }); guard.assertClosed();
});

test("recovery confinement refuses unknown browser/profile/proxy transports before spawn", t => {
  let invoked = 0; t.mock.method(cp, "spawn", (() => { invoked++; return child().handle; }) as unknown as typeof cp.spawn);
  recoveryChromeGuard(t);
  for (const [file, args] of [
    ["/tmp/unreviewed-chromium", ["--remote-debugging-pipe", "--user-data-dir=/tmp/recovery-unit/profile"]],
    [chrome, ["--remote-debugging-port=9222", "--user-data-dir=/tmp/recovery-unit/profile"]],
    [chrome, ["--remote-debugging-pipe", "--user-data-dir=/tmp/recovery-unit/oci-browser-unexpected"]],
    [chrome, ["--remote-debugging-pipe", "--user-data-dir=/tmp/recovery-unit/profile", "--proxy-server=http://unreviewed.invalid"]],
  ] as Array<[string, string[]]>) assert.throws(() => cp.spawn(file, args, { shell: false }));
  assert.equal(invoked, 0);
});

test("recovery guard delegates non-browser children without claiming or closing them", t => {
  const unrelated = child(); let argsSeen: unknown[] = [];
  t.mock.method(cp, "spawn", ((...args: unknown[]) => { argsSeen = args; return unrelated.handle; }) as typeof cp.spawn);
  const guard = recoveryChromeGuard(t), options = { shell: false };
  assert.equal(cp.spawn("/usr/bin/fixture-helper", ["safe"], options), unrelated.handle);
  assert.deepEqual(argsSeen, ["/usr/bin/fixture-helper", ["safe"], options]);
  assert.deepEqual(guard.counts(), { frontend: 0, host: 0, closed: 0, total: 0 }); assert.equal(unrelated.kills(), 0);
});

test("guard fallback closes its captured handle before later fixture cleanup", async t => {
  const owned = child(), unrelated = child(); let observedClosed = false;
  await t.test("owned scope", scope => {
    scope.mock.method(cp, "spawn", (() => owned.handle) as unknown as typeof cp.spawn);
    recoveryChromeGuard(scope);
    scope.after(() => { observedClosed = owned.handle.signalCode === "SIGKILL"; });
    cp.spawn(chrome, ["--remote-debugging-pipe", "--user-data-dir=/tmp/recovery-unit/profile"], { shell: false });
  });
  assert.equal(observedClosed, true); assert.equal(owned.kills(), 1); assert.equal(unrelated.kills(), 0);
});
