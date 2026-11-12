import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import {
  ControlAuthority, ControlAuthError, controlKeyFingerprint,
  inspectControlRoot, provisionControlRoot, type ControlScope,
} from "../control-authority.ts";

// Public, deterministic test bytes; these never authenticate a real service.
const KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("base64url");
const WRONG_KEY = Buffer.alloc(32, 42).toString("base64url");
const FINGERPRINT = createHash("sha256")
  .update("bb-remote-login pairing root v1\0").update(Buffer.from(KEY, "base64url")).digest("hex");
const SCOPE: ControlScope = {
  threadId: "fixture-thread", attemptId: "fixture-attempt", browserContextId: "fixture-context", generation: 1,
};

async function directory(t: TestContext) {
  const parent = await fs.mkdtemp(join(tmpdir(), "remote-login-control-test-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return join(parent, "private");
}

async function fixture(t: TestContext) {
  const dataDir = await directory(t);
  await provisionControlRoot(dataDir, KEY, FINGERPRINT);
  let now = 1_000;
  return {
    dataDir,
    authority: new ControlAuthority(dataDir, { now: () => now }),
    advance: (milliseconds: number) => { now += milliseconds; },
    now: () => now,
  };
}

function refused(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ControlAuthError);
    assert.equal(error.code, code);
    assert.equal(error.message, "Control authorization refused.");
    return true;
  };
}

test("fingerprint uses the pairing domain rather than the stored key verifier", () => {
  const verifier = createHash("sha256").update(Buffer.from(KEY, "base64url")).digest("hex");
  assert.equal(controlKeyFingerprint(KEY), FINGERPRINT);
  assert.notEqual(controlKeyFingerprint(KEY), verifier);
});

test("authorized expiry is verified on the host rather than supplied by the caller", async (t) => {
  const { authority } = await fixture(t);
  const grant = await authority.authenticate(KEY, SCOPE);
  assert.equal(await authority.authorize(grant.capability, SCOPE), 301_000);
});

test("a second phone key authentication replaces only the same scope and preserves its original ceiling", async (t) => {
  const { authority, advance, now } = await fixture(t);
  const first = await authority.authenticate(KEY, SCOPE, now() + 450_000);
  const otherScope = { ...SCOPE, browserContextId: "independent-context" };
  const other = await authority.authenticate(KEY, otherScope);
  advance(240_000);
  const replacement = await authority.authenticate(KEY, SCOPE, now() + 900_000);
  await assert.rejects(authority.authorize(first.capability, SCOPE), refused("invalid_capability"));
  assert.equal(replacement.expiresAt, 451_000);
  assert.equal(await authority.authorize(other.capability, otherScope), other.expiresAt);
  assert.equal(await authority.authorize(replacement.capability, SCOPE), replacement.expiresAt);
});

test("invalid key reauthentication cannot revoke a legitimate phone grant or notify a trusted observer", async (t) => {
  const { authority } = await fixture(t);
  const first = await authority.authenticate(KEY, SCOPE);
  let observed = 0;
  await assert.rejects(authority.authenticate(WRONG_KEY, SCOPE, undefined, () => { observed++; }), refused("invalid_key"));
  assert.equal(observed, 0);
  assert.equal(await authority.authorize(first.capability, SCOPE), first.expiresAt);
});

test("the trusted worker observes a replacement before the authentication promise resolves", async (t) => {
  const { authority } = await fixture(t);
  let observed: unknown;
  const replacement = await authority.authenticate(KEY, SCOPE, undefined, (grant) => { observed = grant; });
  assert.deepEqual(observed, replacement);
  await assert.rejects(authority.authenticate(KEY, SCOPE, undefined, (grant) => { observed = grant; throw new Error("private observer failure"); }));
  await assert.rejects(authority.authorize((observed as typeof replacement).capability, SCOPE), refused("invalid_capability"));
});

test("trusted job deadline bounds actual initial and renewed host authorization", async (t) => {
  const { authority, advance, now } = await fixture(t);
  const deadline = now() + 450_000;
  const first = await authority.authenticate(KEY, SCOPE, deadline);
  assert.equal(await authority.authorize(first.capability, SCOPE), 301_000);
  advance(240_000);
  const renewed = await authority.renew(first.capability, SCOPE, deadline + 900_000);
  assert.equal(renewed.expiresAt, deadline, "renewal cannot extend a previously bounded host deadline");
  assert.equal(await authority.authorize(renewed.capability, SCOPE), deadline);
  await assert.rejects(authority.authorize(first.capability, SCOPE), refused("invalid_capability"));
  advance(210_000);
  await assert.rejects(authority.authorize(renewed.capability, SCOPE), refused("expired"));
});

test("invalid trusted deadline neither issues a grant nor consumes an existing proof", async (t) => {
  const { authority, now } = await fixture(t);
  for (const deadline of [0, now(), -1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(authority.authenticate(KEY, SCOPE, deadline), refused("invalid_deadline"));
  }
  const grant = await authority.authenticate(KEY, SCOPE);
  for (const deadline of [now(), Infinity, 1.5]) {
    await assert.rejects(authority.renew(grant.capability, SCOPE, deadline), refused("invalid_deadline"));
    assert.equal(await authority.authorize(grant.capability, SCOPE), grant.expiresAt);
  }
});

test("fingerprint mismatch cannot initialize an operator root", async (t) => {
  const dataDir = await directory(t);
  await assert.rejects(provisionControlRoot(dataDir, WRONG_KEY, FINGERPRINT), refused("fingerprint_mismatch"));
  await assert.rejects(fs.lstat(dataDir), { code: "ENOENT" });
});

test("keys require canonical 32-byte base64url without padding", async (t) => {
  const dataDir = await directory(t);
  for (const key of ["", `${KEY}=`, KEY.slice(0, -1), `${KEY.slice(0, -1)}9`]) {
    assert.throws(() => controlKeyFingerprint(key), refused("invalid_key"));
    await assert.rejects(provisionControlRoot(dataDir, key, FINGERPRINT), refused("invalid_key"));
  }
});

test("unprovisioned status neither creates files nor repairs directory permissions", async (t) => {
  const dataDir = await directory(t);
  assert.deepEqual(await inspectControlRoot(dataDir), { provisioned: false, rootId: null });
  await assert.rejects(fs.lstat(dataDir), { code: "ENOENT" });
  await fs.mkdir(dataDir, { mode: 0o755 });
  await fs.chmod(dataDir, 0o755);
  assert.deepEqual(await inspectControlRoot(dataDir), { provisioned: false, rootId: null });
  assert.deepEqual(await fs.readdir(dataDir), []);
  assert.equal((await fs.stat(dataDir)).mode & 0o777, 0o755);
});

test("offline provisioning creates private files and never overwrites a root", async (t) => {
  const dataDir = await directory(t);
  await fs.mkdir(dataDir, { mode: 0o755 });
  await fs.chmod(dataDir, 0o755);
  const { rootId } = await provisionControlRoot(dataDir, KEY, FINGERPRINT);
  assert.equal((await fs.stat(dataDir)).mode & 0o777, 0o700);
  const original = await fs.readFile(join(dataDir, "control-root.json"), "utf8");
  assert.equal((await fs.stat(join(dataDir, "control-root.json"))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(join(dataDir, "control-budget.json"))).mode & 0o777, 0o600);
  assert.deepEqual(await inspectControlRoot(dataDir), { provisioned: true, rootId });
  await assert.rejects(provisionControlRoot(dataDir, KEY, FINGERPRINT), refused("root_exists"));
  assert.equal(await fs.readFile(join(dataDir, "control-root.json"), "utf8"), original);
  assert.ok(!original.includes(KEY));
});

test("operator provisioning refuses symlinks and externally writable directories", async (t) => {
  const dataDir = await directory(t);
  const target = `${dataDir}-target`;
  await fs.mkdir(target, { mode: 0o700 });
  await fs.symlink(target, dataDir);
  await assert.rejects(provisionControlRoot(dataDir, KEY, FINGERPRINT), refused("unsafe_storage"));
  await fs.unlink(dataDir);
  await fs.mkdir(dataDir, { mode: 0o777 });
  await fs.chmod(dataDir, 0o777);
  await assert.rejects(provisionControlRoot(dataDir, KEY, FINGERPRINT), refused("unsafe_storage"));
});

test("runtime refuses unsafe root metadata without repairing it", async (t) => {
  const f = await fixture(t);
  await fs.chmod(join(f.dataDir, "control-root.json"), 0o644);
  await assert.rejects(f.authority.authenticate(KEY, SCOPE), refused("unsafe_storage"));
  await assert.rejects(inspectControlRoot(f.dataDir), refused("unsafe_storage"));
  assert.equal((await fs.stat(join(f.dataDir, "control-root.json"))).mode & 0o777, 0o644);
});

test("runtime refuses a root symlink even when the target is private", async (t) => {
  const f = await fixture(t);
  const root = join(f.dataDir, "control-root.json");
  const target = join(f.dataDir, "root-copy.json");
  await fs.rename(root, target);
  await fs.symlink(target, root);
  await assert.rejects(f.authority.authenticate(KEY, SCOPE), refused("unsafe_storage"));
});

test("ordinary callers without the preprovisioned key cannot mint a grant", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.authority.authenticate(WRONG_KEY, SCOPE), refused("invalid_key"));
  await assert.rejects(f.authority.authenticate("client", SCOPE), refused("invalid_key"));
  await assert.rejects(f.authority.authorize("client", SCOPE), refused("invalid_capability"));
  const grant = await f.authority.authenticate(KEY, SCOPE);
  assert.match(grant.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(grant.expiresAt, 301_000);
  await f.authority.authorize(grant.capability, SCOPE);
});

test("a capability is bound to every scope field and generation", async (t) => {
  const f = await fixture(t);
  const grant = await f.authority.authenticate(KEY, SCOPE);
  for (const changed of [
    { threadId: "other-thread" }, { attemptId: "other-attempt" },
    { browserContextId: "other-context" }, { generation: 2 },
  ]) {
    await assert.rejects(f.authority.authorize(grant.capability, { ...SCOPE, ...changed }), refused("invalid_capability"));
  }
  await f.authority.authorize(grant.capability, SCOPE);
  await assert.rejects(f.authority.authenticate(KEY, { ...SCOPE, generation: -1 }), refused("invalid_scope"));
});

test("equivalent scope fields do not depend on caller JSON property order", async (t) => {
  const f = await fixture(t);
  const grant = await f.authority.authenticate(KEY, SCOPE);
  await f.authority.authorize(grant.capability, {
    generation: SCOPE.generation, browserContextId: SCOPE.browserContextId,
    attemptId: SCOPE.attemptId, threadId: SCOPE.threadId,
  });
});

test("renewal rotates the token without extending the original hard deadline", async (t) => {
  const f = await fixture(t);
  const first = await f.authority.authenticate(KEY, SCOPE);
  f.advance(240_000);
  const second = await f.authority.renew(first.capability, SCOPE);
  assert.notEqual(second.capability, first.capability);
  await assert.rejects(f.authority.authorize(first.capability, SCOPE), refused("invalid_capability"));
  f.advance(240_000);
  const third = await f.authority.renew(second.capability, SCOPE);
  f.advance(240_000);
  const fourth = await f.authority.renew(third.capability, SCOPE);
  assert.equal(fourth.expiresAt, 901_000);
  f.advance(180_000);
  await assert.rejects(f.authority.authorize(fourth.capability, SCOPE), refused("expired"));
});

test("expiry and explicit revocation invalidate old tokens", async (t) => {
  const f = await fixture(t);
  const revoked = await f.authority.authenticate(KEY, SCOPE);
  await f.authority.revoke(revoked.capability, SCOPE);
  await assert.rejects(f.authority.authorize(revoked.capability, SCOPE), refused("invalid_capability"));
  const expired = await f.authority.authenticate(KEY, SCOPE);
  f.advance(300_000);
  await assert.rejects(f.authority.renew(expired.capability, SCOPE), refused("expired"));
});

test("root replacement invalidates grants", async (t) => {
  const f = await fixture(t);
  const grant = await f.authority.authenticate(KEY, SCOPE);
  const path = join(f.dataDir, "control-root.json");
  const root = JSON.parse(await fs.readFile(path, "utf8"));
  root.rootId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  await fs.writeFile(path, JSON.stringify(root), { mode: 0o600 });
  await assert.rejects(f.authority.authorize(grant.capability, SCOPE), refused("invalid_capability"));
});

test("root deletion clears grants even if the old root is later restored", async (t) => {
  const f = await fixture(t);
  const grant = await f.authority.authenticate(KEY, SCOPE);
  const path = join(f.dataDir, "control-root.json");
  const root = await fs.readFile(path);
  await fs.unlink(path);
  await assert.rejects(f.authority.authorize(grant.capability, SCOPE), refused("root_unavailable"));
  await fs.writeFile(path, root, { mode: 0o600 });
  await assert.rejects(f.authority.authorize(grant.capability, SCOPE), refused("invalid_capability"));
});

test("a worker restart does not retain bearer tokens", async (t) => {
  const f = await fixture(t);
  const grant = await f.authority.authenticate(KEY, SCOPE);
  const restarted = new ControlAuthority(f.dataDir, { now: f.now });
  await assert.rejects(restarted.authorize(grant.capability, SCOPE), refused("invalid_capability"));
});

test("five failed guesses exhaust a persistent rolling minute budget across instances", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 5; index++) {
    const restarted = new ControlAuthority(f.dataDir, { now: f.now });
    await assert.rejects(restarted.authenticate(WRONG_KEY, SCOPE), refused("invalid_key"));
  }
  await assert.rejects(f.authority.authenticate(KEY, SCOPE), refused("rate_limited"));
  f.advance(60_000);
  await f.authority.authenticate(KEY, SCOPE);
});

test("the guessing budget cannot reset at a fixed minute boundary", async (t) => {
  const f = await fixture(t);
  f.advance(58_000);
  for (let index = 0; index < 5; index++) {
    await assert.rejects(f.authority.authenticate(WRONG_KEY, SCOPE), refused("invalid_key"));
  }
  f.advance(2_000);
  await assert.rejects(f.authority.authenticate(KEY, SCOPE), refused("rate_limited"));
  f.advance(58_000);
  await f.authority.authenticate(KEY, SCOPE);
});

test("concurrent authentications are bounded across authority instances", async (t) => {
  const f = await fixture(t);
  const other = new ControlAuthority(f.dataDir, { now: f.now });
  const results = await Promise.allSettled([
    f.authority.authenticate(KEY, SCOPE), other.authenticate(KEY, SCOPE),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  refused("auth_busy")(rejected.reason);
});

test("missing or corrupt persistent budget fails closed rather than resetting guesses", async (t) => {
  const f = await fixture(t);
  const path = join(f.dataDir, "control-budget.json");
  await fs.writeFile(path, "not-json", { mode: 0o600 });
  await assert.rejects(f.authority.authenticate(KEY, SCOPE), refused("budget_invalid"));
  await fs.unlink(path);
  await assert.rejects(f.authority.authenticate(KEY, SCOPE), refused("budget_invalid"));
});

test("a public or symlinked guessing budget is never repaired or followed", async (t) => {
  const f = await fixture(t);
  const path = join(f.dataDir, "control-budget.json");
  await fs.chmod(path, 0o644);
  await assert.rejects(f.authority.authenticate(KEY, SCOPE), refused("unsafe_storage"));
  assert.equal((await fs.stat(path)).mode & 0o777, 0o644);
  await fs.chmod(path, 0o600);
  await fs.rename(path, `${path}-target`);
  await fs.symlink(`${path}-target`, path);
  await assert.rejects(f.authority.authenticate(KEY, SCOPE), refused("unsafe_storage"));
});

test("hard-linked root files are unsafe even when their mode is private", async (t) => {
  const f = await fixture(t);
  await fs.link(join(f.dataDir, "control-root.json"), join(f.dataDir, "root-hardlink.json"));
  await assert.rejects(f.authority.authenticate(KEY, SCOPE), refused("unsafe_storage"));
});

test("parallel renewals cannot exchange the same old token twice", async (t) => {
  const f = await fixture(t);
  const grant = await f.authority.authenticate(KEY, SCOPE);
  const results = await Promise.allSettled([
    f.authority.renew(grant.capability, SCOPE), f.authority.renew(grant.capability, SCOPE),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  await assert.rejects(f.authority.authorize(grant.capability, SCOPE), refused("invalid_capability"));
});

test("concurrent renewal and revocation cannot both consume the old token", { timeout: 2_000 }, async (t) => {
  const f = await fixture(t);
  const grant = await f.authority.authenticate(KEY, SCOPE);
  const originalOpen = fs.open;
  const release: Array<(() => void) | undefined> = [undefined, undefined];
  let rootReads = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const read = args[0] === join(f.dataDir, "control-root.json") ? rootReads++ : -1;
    const handle = await originalOpen(...args);
    if (read >= 0 && read < 2) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        // Release both real root reads together; either operation may win.
        await new Promise<void>((resolve) => {
          release[read] = resolve;
          if (release[0] && release[1]) { release[0](); release[1](); }
        });
      };
    }
    return handle;
  });
  const [renewed, revoked] = await Promise.allSettled([
    f.authority.renew(grant.capability, SCOPE), f.authority.revoke(grant.capability, SCOPE),
  ]);
  t.mock.restoreAll();
  assert.equal([renewed, revoked].filter((result) => result.status === "fulfilled").length, 1);
  if (renewed.status === "rejected") refused("invalid_capability")(renewed.reason);
  if (revoked.status === "rejected") refused("invalid_capability")(revoked.reason);
  if (renewed.status === "fulfilled") await f.authority.authorize(renewed.value.capability, SCOPE);
  await assert.rejects(f.authority.authorize(grant.capability, SCOPE), refused("invalid_capability"));
});

test("keys and bearer tokens are never persisted or echoed in exceptions", async (t) => {
  const f = await fixture(t);
  const grant = await f.authority.authenticate(KEY, SCOPE);
  for (const name of await fs.readdir(f.dataDir)) {
    const value = await fs.readFile(join(f.dataDir, name), "utf8");
    assert.ok(!value.includes(KEY));
    assert.ok(!value.includes(grant.capability));
  }
  try { await f.authority.authenticate(WRONG_KEY, SCOPE); assert.fail("expected refusal"); }
  catch (error) {
    assert.ok(error instanceof ControlAuthError);
    const serialized = String(error);
    for (const forbidden of [KEY, WRONG_KEY, grant.capability, f.dataDir]) assert.ok(!serialized.includes(forbidden));
  }
});
