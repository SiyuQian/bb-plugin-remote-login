import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createServer, type Server } from "node:net";
import test, { type TestContext } from "node:test";
import { assertOwnedLoopbackListener } from "../oci-port-ownership.ts";

const darwin = process.platform === "darwin";
const unavailable = (error: unknown) => error instanceof Error
  && error.message === "oci_listener_ownership_unverified" && error.cause === undefined;

async function listener(t: TestContext, host = "127.0.0.1", port = 0): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, resolve);
  });
  t.after(() => server.listening
    ? new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) : undefined);
  return server;
}

function fakeLsof(t: TestContext, output: string, stderr = "", error: Error | null = null, onRead?: () => void): void {
  t.mock.method(childProcess, "execFile", ((file: string, args: readonly string[], options: childProcess.ExecFileOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    assert.equal(file, "/usr/sbin/lsof");
    assert.deepEqual(args, ["-nP", "-iTCP:32123", "-sTCP:LISTEN", "-Fpn"]);
    assert.equal(options.maxBuffer, 8192);
    assert.equal(options.timeout, 2000);
    assert.equal(options.killSignal, "SIGKILL");
    assert.deepEqual(options.env, { LANG: "C", LC_ALL: "C" });
    onRead?.();
    callback(error, output, stderr);
    return new childProcess.ChildProcess();
  }) as unknown as typeof childProcess.execFile);
}

test("the exact owned IPv4 loopback listener is accepted", { skip: !darwin }, async (t) => {
  const server = await listener(t);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await assertOwnedLoopbackListener(process.pid, address.port, new AbortController().signal);
  await assert.rejects(() => assertOwnedLoopbackListener(process.pid + 1, address.port, new AbortController().signal), unavailable);
  assert.equal(server.listening, true);
});

test("a wildcard listener is rejected and left running", { skip: !darwin }, async (t) => {
  const server = await listener(t, "0.0.0.0");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await assert.rejects(() => assertOwnedLoopbackListener(process.pid, address.port, new AbortController().signal), unavailable);
  assert.equal(server.listening, true);
});

test("a same-port IPv6 loopback listener prevents acceptance", { skip: !darwin }, async (t) => {
  const ipv4 = await listener(t);
  const address = ipv4.address();
  assert.ok(address && typeof address !== "string");
  let ipv6: Server;
  try { ipv6 = await listener(t, "::1", address.port); }
  catch (error) {
    if (["EAFNOSUPPORT", "EADDRNOTAVAIL", "EADDRINUSE"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("separate IPv6 loopback listener is unavailable"); return;
    }
    throw error;
  }
  await assert.rejects(() => assertOwnedLoopbackListener(process.pid, address.port, new AbortController().signal), unavailable);
  assert.equal(ipv4.listening, true);
  assert.equal(ipv6.listening, true);
});

test("no listener cannot establish ownership", { skip: !darwin }, async (t) => {
  const server = await listener(t);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await assert.rejects(() => assertOwnedLoopbackListener(process.pid, address.port, new AbortController().signal), unavailable);
});

test("invalid PID or port and pre-cancellation never execute a process", async (t) => {
  const execute = t.mock.method(childProcess, "execFile", () => { assert.fail("invalid ownership requests must not start lsof"); });
  for (const pid of [NaN, Infinity, 0, -1, 1.5, 2_147_483_648]) {
    await assert.rejects(() => assertOwnedLoopbackListener(pid, 32123, new AbortController().signal), unavailable);
  }
  for (const port of [NaN, Infinity, 0, -1, 1.5, 65_536]) {
    await assert.rejects(() => assertOwnedLoopbackListener(23456, port, new AbortController().signal), unavailable);
  }
  await assert.rejects(() => assertOwnedLoopbackListener(23456, 32123, AbortSignal.abort()), unavailable);
  assert.equal(execute.mock.callCount(), 0);
});

test("bounded lsof records accept only the exact PID and loopback address", { skip: !darwin }, async (t) => {
  fakeLsof(t, "p23456\nf12\nn127.0.0.1:32123\nf13\nn127.0.0.1:32123\n");
  await assertOwnedLoopbackListener(23456, 32123, new AbortController().signal);
});

test("malformed, extra, incomplete and oversized lsof records are rejected privately", { skip: !darwin }, async (t) => {
  for (const output of [
    "", "p23456\n", "n127.0.0.1:32123\n", "p23456\nf12\nn127.0.0.1:32123",
    "p23457\nf12\nn127.0.0.1:32123\n", "p023456\nf12\nn127.0.0.1:32123\n",
    "p23456\nf12\nn127.0.0.1:32124\n", "p23456\nf12\nnlocalhost:32123\n",
    "p23456\nf12\nn*:32123\n", "p23456\nf12\nn[::1]:32123\n", "p23456\nf12\nn[::]:32123\n",
    "p23456\nf12\nn127.0.0.1:32123\np34567\nf13\nn127.0.0.1:32123\n",
    "p23456\nf12\nn127.0.0.1:32123\nf99\n", "p23456\nf12\nn127.0.0.1:32123\n\n",
    "p23456\nf12\nn127.0.0.1:32123\nPRIVATE_OS_OUTPUT\n", "p23456\nf12\nn127.0.0.1:32123\u0000\n",
    "p23456\nn127.0.0.1:32123\n", "p23456\nfcwd\nn127.0.0.1:32123\n",
    "p23456\nf12\nn127.0.0.1:32123\nf12\nn127.0.0.1:32123\n",
    "p23456\n" + "f12\nn127.0.0.1:32123\n".repeat(600),
  ]) {
    await t.test("rejects an untrusted record", async (t) => {
      fakeLsof(t, output);
      await assert.rejects(() => assertOwnedLoopbackListener(23456, 32123, new AbortController().signal), unavailable);
    });
  }
});

test("lsof diagnostics and failures never become error details", { skip: !darwin }, async (t) => {
  for (const [stderr, error] of [
    ["PRIVATE_WARNING_PATH", null], ["", new Error("PRIVATE_SPAWN_PATH")],
    ["", Object.assign(new Error("PRIVATE_TIMEOUT_OUTPUT"), { killed: true })],
  ] as const) {
    await t.test("returns a fixed error", async (t) => {
      fakeLsof(t, "p23456\nf12\nn127.0.0.1:32123\n", stderr, error);
      await assert.rejects(() => assertOwnedLoopbackListener(23456, 32123, new AbortController().signal), unavailable);
    });
  }
});

test("cancellation after lsof starts rejects an otherwise matching record", { skip: !darwin }, async (t) => {
  const controller = new AbortController();
  fakeLsof(t, "p23456\nf12\nn127.0.0.1:32123\n", "", null, () => controller.abort());
  await assert.rejects(() => assertOwnedLoopbackListener(23456, 32123, controller.signal), unavailable);
});
