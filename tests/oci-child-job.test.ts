import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import cp from "node:child_process";
import { setImmediate } from "node:timers/promises";
import type { Readable } from "node:stream";
import test from "node:test";
import { startOciFixtureChild, OciChildError, probeOciBootstrapBeforeKey, isPinnedOciAuthorizationUrl } from "../oci-child-job.ts";

function options() {
  const controller = new AbortController();
  let retained = 0;
  const privateUrls: string[] = [];
  return {
    controller, privateUrls, retained: () => retained,
    input: { attemptId: randomUUID(), callbackPort: "ephemeral" as const, lifetimeMs: 5000,
      signal: controller.signal, lifecycle: new AbortController().signal,
      retainWorker: () => { retained++; return () => { retained--; }; },
      consumeBrowser: async (url: string) => { privateUrls.push(url); },
    },
  };
}

test("owned fixture child captures through private IPC and releases only after completion", async () => {
  const s = options();
  const job = await startOciFixtureChild(s.input);
  try {
    assert.equal(s.retained(), 1);
    assert.equal(s.privateUrls.length, 1);
    assert.equal(new URL(s.privateUrls[0]!).hostname, "login.fixture.invalid");
    assert.equal(new URL(s.privateUrls[0]!).searchParams.get("nonce"), s.input.attemptId);
    assert.equal(JSON.stringify(job).includes(s.privateUrls[0]!), false);
    await job.completeFixture();
    assert.deepEqual(await job.result, { outcome: "fixture_complete" });
    assert.equal(s.retained(), 0);
  } finally { await job.cancel(); }
});

test("actual installed bootstrap reaches owned binding and stops before generating a login", async () => {
  const s = options(); const { consumeBrowser: _privateConsumer, ...input } = s.input;
  assert.deepEqual(await probeOciBootstrapBeforeKey(input), { outcome: "prekey_probe_complete" });
  assert.equal(s.privateUrls.length, 0); assert.equal(s.retained(), 0);
});

test("real authorization URL policy accepts only the fixed Oracle destination and public JWK", () => {
  const key = { kty: "RSA", n: Buffer.concat([Buffer.from([128]), Buffer.alloc(255)]).toString("base64url"), e: "AQAB", kid: "Ignored" };
  const url = new URL("https://login.ap-sydney-1.oraclecloud.com/v1/oauth2/authorize");
  url.search = new URLSearchParams({ action: "login", client_id: "iaas_console", response_type: "token id_token", scope: "openid",
    redirect_uri: "http://localhost:8181", nonce: randomUUID(), public_key: Buffer.from(JSON.stringify(key)).toString("base64url") }).toString();
  assert.equal(isPinnedOciAuthorizationUrl(url.href), true);
  for (const [field, value] of [["redirect_uri", "https://phone.invalid/"], ["scope", "other"], ["nonce", "caller"],
    ["public_key", Buffer.from(JSON.stringify({ ...key, d: "private-field" })).toString("base64url")]] as const) {
    const changed = new URL(url); changed.searchParams.set(field, value); assert.equal(isPinnedOciAuthorizationUrl(changed.href), false);
  }
  const duplicate = new URL(url); duplicate.searchParams.append("nonce", randomUUID()); assert.equal(isPinnedOciAuthorizationUrl(duplicate.href), false);
  const other = new URL(url); other.hostname = "login.ap-sydney-1.oraclecloud.com.evil.invalid"; assert.equal(isPinnedOciAuthorizationUrl(other.href), false);
});

test("cancelling a live fixture ends its exact child and never claims completion", async () => {
  const s = options(); const job = await startOciFixtureChild(s.input);
  s.controller.abort(); await job.cancel();
  assert.deepEqual(await job.result, { outcome: "cancelled" });
  assert.equal(s.retained(), 0);
  await job.cancel(); assert.equal(s.retained(), 0);
});

test("private browser consumer refusal closes the child without exposing its URL", async () => {
  const s = options();
  await assert.rejects(startOciFixtureChild({ ...s.input, consumeBrowser: async () => { throw new Error("private-url-callback-secret"); } }), (error: unknown) => {
    assert.ok(error instanceof OciChildError);
    assert.equal(error.message, "OCI child unavailable.");
    assert.equal(String(error).includes("private-url"), false); return true;
  });
  assert.equal(s.retained(), 0);
});

test("already aborted or malformed fixture requests never retain or spawn", async () => {
  const s = options(); s.controller.abort();
  await assert.rejects(startOciFixtureChild(s.input), OciChildError);
  assert.equal(s.retained(), 0);
  const valid = options();
  for (const changed of [{ attemptId: "caller-selected" }, { lifetimeMs: 0 }, { callbackPort: 8181 }, { mode: "authenticate" }, { executable: "/bin/sh" }]) {
    await assert.rejects(startOciFixtureChild({ ...valid.input, ...changed } as never), OciChildError);
  }
  assert.equal(valid.retained(), 0);
});

test("a private consumer that ignores lifecycle abort cannot retain the owned child", async () => {
  const s = options(); const lifecycle = new AbortController();
  let entered = false, finish!: () => void;
  const held = new Promise<void>((r) => { finish = r; });
  const pending = startOciFixtureChild({ ...s.input, lifecycle: lifecycle.signal,
    consumeBrowser: async () => { entered = true; await held; },
  });
  while (!entered) await setImmediate();
  lifecycle.abort(); await assert.rejects(pending, OciChildError);
  assert.equal(s.retained(), 0); finish(); await setImmediate(); assert.equal(s.retained(), 0);
});

test("private pipe flood is bounded even while its browser consumer remains pending", async (t) => {
  const s = options(); let child: cp.ChildProcess | undefined;
  const spawn = cp.spawn;
  t.mock.method(cp, "spawn", ((...args: Parameters<typeof cp.spawn>) => { child = spawn(...args); return child; }) as typeof cp.spawn);
  let entered = false, finish!: () => void;
  const held = new Promise<void>((r) => { finish = r; });
  const pending = startOciFixtureChild({ ...s.input, consumeBrowser: async () => { entered = true; await held; } });
  while (!entered) await setImmediate();
  const line = JSON.stringify({ version: 1, attemptId: s.input.attemptId, type: "exit", outcome: "fixture_complete", reason: "fixture_complete" });
  (child!.stdio[4] as Readable).emit("data", Buffer.from(`${line}\n`.repeat(100)));
  await assert.rejects(pending, (error: unknown) => error instanceof OciChildError && error.code === "protocol");
  assert.equal(s.retained(), 0); finish();
});

test("retention acquisition and release failures are private, settled errors", async () => {
  const s = options();
  await assert.rejects(startOciFixtureChild({ ...s.input, retainWorker: () => { throw new Error("private-retain-marker"); } }), (error: unknown) => {
    assert.ok(error instanceof OciChildError); assert.equal(String(error).includes("private-retain"), false); return true;
  });
  let releaseCount = 0;
  const job = await startOciFixtureChild({ ...s.input, retainWorker: () => () => { releaseCount++; throw new Error("private-release-marker"); } });
  await assert.rejects(job.completeFixture(), (error: unknown) => {
    assert.ok(error instanceof OciChildError); assert.equal(error.cleanupUncertain, true); assert.equal(String(error).includes("private-release"), false); return true;
  });
  await assert.rejects(job.result, OciChildError);
  await assert.rejects(job.cancel(), OciChildError); assert.equal(releaseCount, 1);
  await assert.rejects(startOciFixtureChild({ ...s.input,
    consumeBrowser: async () => { throw new Error("private-consumer-marker"); },
    retainWorker: () => () => { throw new Error("private-release-marker"); },
  }), (error: unknown) => error instanceof OciChildError && error.cleanupUncertain && error.code === "cleanup_uncertain");
});

test("corrupted initial private events cannot authorize a browser consumer", async (t) => {
  const changes: Record<string, (value: any) => Buffer> = {
    wrongPid: (v) => Buffer.from(JSON.stringify({ ...v, pid: process.pid }) + "\n"),
    wrongAttempt: (v) => Buffer.from(JSON.stringify({ ...v, attemptId: randomUUID() }) + "\n"),
    wrongAddress: (v) => Buffer.from(JSON.stringify({ ...v, host: "::1" }) + "\n"),
    outOfOrder: (v) => Buffer.from(JSON.stringify({ version: 1, attemptId: v.attemptId, type: "browser", url: "https://login.fixture.invalid/" }) + "\n"),
    invalidUtf8: () => Buffer.from([255, 10]),
    oversized: () => Buffer.from("x".repeat(16385)),
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async (t) => {
    const s = options(); const spawn = cp.spawn;
    t.mock.method(cp, "spawn", ((...args: Parameters<typeof cp.spawn>) => {
      const child = spawn(...args), stream = child.stdio[4] as Readable, emit = stream.emit;
      let first = true;
      t.mock.method(stream, "emit", ((kind: string, ...values: unknown[]) => {
        if (kind === "data" && first) {
          first = false;
          const initial = JSON.parse((values[0] as Buffer).toString("utf8"));
          return emit.call(stream, kind, change(initial));
        }
        return emit.call(stream, kind, ...values);
      }) as typeof stream.emit);
      return child;
    }) as typeof cp.spawn);
    await assert.rejects(startOciFixtureChild(s.input), (error: unknown) => error instanceof OciChildError && error.code === "protocol");
    assert.equal(s.privateUrls.length, 0); assert.equal(s.retained(), 0);
  });
});
