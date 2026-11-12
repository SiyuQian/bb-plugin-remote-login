import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { createOwnedOciSession, releaseOwnedOciSession } from "../oci-owned-session.ts";
import { verifyOwnedOciSession, OwnedOciVerificationError } from "../oci-owned-verifier.ts";
import { fixturePrivateKey, fixturePublicKey, fixtureTarget, fixtureToken, transportFixture } from "./oci-verifier-fixture.ts";

async function system(t: TestContext, behavior: "accept" | "reject" | "delay" = "accept") {
  const parent = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "owned-verifier-"));
  const attemptId = randomUUID(), session = await createOwnedOciSession(parent, attemptId, fixtureTarget);
  const token = fixtureToken();
  await fs.writeFile(session.paths.privateKeyFile, fixturePrivateKey, { mode: 0o600 });
  await fs.writeFile(session.paths.publicKeyFile, fixturePublicKey, { mode: 0o600 });
  await fs.writeFile(session.paths.tokenFile, token, { mode: 0o600 });
  await fs.writeFile(session.paths.configFile, `[${session.paths.profileName}]\nfingerprint=${Array(16).fill("aa").join(":")}\nkey_file=${session.paths.privateKeyFile}\nsecurity_token_file=${session.paths.tokenFile}\ntenancy=${fixtureTarget.tenancyOcid}\nregion=${fixtureTarget.region}\n`);
  t.after(async () => { try { await releaseOwnedOciSession(session); } catch { /* A mutation test deliberately invalidates ownership. */ } await fs.rm(parent, { recursive: true, force: true }); });
  const spawn = cp.spawn; let retained = 0, launches = 0;
  const hooks = { afterSpawn: () => {}, behavior };
  // Replace only the external HTTP boundary inside the fixed child, never its signer or client.
  t.mock.method(cp, "spawn", ((file: string, args: string[], options: cp.SpawnOptions) => {
    assert.equal(file, "/opt/homebrew/Cellar/oci-cli/3.88.0/libexec/bin/python");
    assert.deepEqual(args.slice(0, 3), ["-I", "-S", "-c"]); launches++;
    const child = spawn(file, [...args.slice(0, 3), transportFixture(token, hooks.behavior) + args[3]], options);
    hooks.afterSpawn(); return child;
  }) as typeof cp.spawn);
  const controller = new AbortController(); let authorizations = 0;
  const input = { attemptId, session, timeoutMs: 4000, signal: controller.signal, lifecycle: new AbortController().signal,
    authorize: async () => { authorizations++; }, retainWorker: () => { retained++; return () => { retained--; }; },
  };
  return { input, controller, hooks, retained: () => retained, launches: () => launches, authorizations: () => authorizations };
}

test("owned snapshot reaches the real SDK signer and returns only fenced match facts", async (t) => {
  const s = await system(t);
  assert.deepEqual(await verifyOwnedOciSession(s.input), { match: true, reason: "matched" });
  assert.equal(s.retained(), 0); assert.equal(s.launches(), 1); assert.equal(s.authorizations(), 3);
  const directory = join(dirname(s.input.session.paths.root), "owned-resources-v1");
  const files = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
  const record = JSON.parse(await fs.readFile(join(directory, files[0]!), "utf8"));
  assert.deepEqual(record.writers.map(({ role, state }: { role: string; state: string }) => ({ role, state })), [{ role: "verifier", state: "closed" }]);
});

test("online rejection cannot become an owned-session match", async (t) => {
  const s = await system(t, "reject");
  assert.deepEqual(await verifyOwnedOciSession(s.input), { match: false, reason: "rejected" });
  assert.equal(s.retained(), 0);
});

test("a rejected verification disposes its private capture before a later retry", async (t) => {
  const s = await system(t, "reject");
  assert.deepEqual(await verifyOwnedOciSession(s.input), { match: false, reason: "rejected" });
  s.hooks.behavior = "accept";
  assert.deepEqual(await verifyOwnedOciSession(s.input), { match: true, reason: "matched" });
  assert.equal(s.launches(), 2); assert.equal(s.retained(), 0);
});

test("a token changed after snapshot capture defeats a successful service response", async (t) => {
  const s = await system(t);
  s.hooks.afterSpawn = () => {
    // Parent capture is already complete; rewrite the same owned inode before child result.
    writeFileSync(s.input.session.paths.tokenFile, fixtureToken({ sub: fixtureTarget.userOcid, tenant: fixtureTarget.tenancyOcid, exp: 1 }));
  };
  await assert.rejects(verifyOwnedOciSession(s.input), (e: unknown) => e instanceof OwnedOciVerificationError && e.code === "snapshot");
  assert.equal(s.retained(), 0);
});

test("late attempt authorization refusal prevents returning service acceptance", async (t) => {
  const s = await system(t); let checks = 0;
  await assert.rejects(verifyOwnedOciSession({ ...s.input, authorize: async () => { if (++checks === 3) throw new Error("private-attempt-marker"); } }), (e: unknown) => {
    assert.ok(e instanceof OwnedOciVerificationError); assert.equal(String(e).includes("private-attempt"), false); return true;
  });
  assert.equal(checks, 3); assert.equal(s.launches(), 1);
  assert.equal(s.retained(), 0);
});

test("artifact mutation during final attempt authorization still defeats service acceptance", async (t) => {
  const s = await system(t); let checks = 0;
  await assert.rejects(verifyOwnedOciSession({ ...s.input, authorize: async () => {
    if (++checks === 3) await fs.writeFile(s.input.session.paths.tokenFile, fixtureToken({ sub: fixtureTarget.userOcid, tenant: fixtureTarget.tenancyOcid, exp: 1 }));
  } }), (e: unknown) => e instanceof OwnedOciVerificationError && e.code === "snapshot");
  assert.equal(checks, 3); assert.equal(s.retained(), 0);
});

test("cancellation bounds a delayed private SDK child and releases retention", async (t) => {
  const s = await system(t, "delay");
  const pending = verifyOwnedOciSession(s.input);
  const timer = setTimeout(() => s.controller.abort(), 1200);
  try { await assert.rejects(pending, (e: unknown) => e instanceof OwnedOciVerificationError && e.code === "aborted"); }
  finally { clearTimeout(timer); }
  assert.equal(s.retained(), 0);
});

test("pre-aborted verification reports cancellation without spawning a worker", async (t) => {
  const s = await system(t); s.controller.abort();
  await assert.rejects(verifyOwnedOciSession(s.input), (e: unknown) => e instanceof OwnedOciVerificationError && e.code === "aborted");
  assert.equal(s.launches(), 0); assert.equal(s.retained(), 0);
});
