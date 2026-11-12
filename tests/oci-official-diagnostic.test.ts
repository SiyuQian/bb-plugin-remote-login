import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPrivateKey, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { createOwnedOciSession, releaseOwnedOciSession, type OwnedOciSession } from "../oci-owned-session.ts";
import { runOwnedOciDiagnostic, OciDiagnosticError } from "../oci-official-diagnostic.ts";
import { fixturePrivateKey, fixturePublicKey, fixtureTarget, fixtureToken, transportFixture, type TransportBehavior } from "./oci-verifier-fixture.ts";

async function system(t: TestContext, behavior: TransportBehavior = "accept", expired = false, delayConfig = false) {
  const parent = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "owned-oci-diagnostic-"));
  const attemptId = randomUUID(), session = await createOwnedOciSession(parent, attemptId, fixtureTarget);
  const token = fixtureToken({ sub: fixtureTarget.userOcid, tenant: fixtureTarget.tenancyOcid, exp: expired ? 0 : Math.floor(Date.now() / 1000) + 3600 });
  await fs.writeFile(session.paths.privateKeyFile, fixturePrivateKey, { mode: 0o600 });
  await fs.writeFile(session.paths.publicKeyFile, fixturePublicKey, { mode: 0o600 });
  await fs.writeFile(session.paths.tokenFile, token, { mode: 0o600 });
  await fs.writeFile(session.paths.configFile, `[${session.paths.profileName}]\nfingerprint=${Array(16).fill("aa").join(":")}\nkey_file=${session.paths.privateKeyFile}\nsecurity_token_file=${session.paths.tokenFile}\ntenancy=${fixtureTarget.tenancyOcid}\nregion=${fixtureTarget.region}\n`);
  t.after(async () => { try { await releaseOwnedOciSession(session); } catch { /* Mutation fixtures intentionally invalidate ownership. */ } await fs.rm(parent, { recursive: true, force: true }); });
  const spawn = cp.spawn;
  let retained = 0, launches = 0, authorizations = 0;
  const hooks = { afterSpawn: () => {}, source: (source: string) => source };
  t.mock.method(cp, "spawn", ((file: string, args: string[], options: cp.SpawnOptions) => {
    assert.equal(file, "/opt/homebrew/Cellar/oci-cli/3.88.0/libexec/bin/python");
    assert.deepEqual(args.slice(0, 3), ["-I", "-S", "-c"]);
    assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "pipe", "pipe"]);
    assert.equal(options.shell, false);
    launches++;
    const fixture = transportFixture(token, behavior).replace("    auth = request.headers[\"authorization\"]", String.raw`    import inspect
    assert any(frame.frame.f_code.co_name == "validate" and frame.frame.f_globals.get("__name__") == "oci_cli.cli_session" for frame in inspect.stack(context=0))
    assert not any(name in os.environ for name in ("OCI_CONFIG_FILE", "OCI_CLI_CONFIG_FILE", "OCI_CLI_KEY_CONTENT", "OCI_CLI_AUTH", "HTTPS_PROXY", "REQUESTS_CA_BUNDLE"))
    auth = request.headers["authorization"]`);
    const child = spawn(file, [...args.slice(0, 3), fixture + hooks.source(args[3]!)], options);
    if (delayConfig) {
      const commands = child.stdio[3] as import("node:stream").Writable;
      const write = commands.write.bind(commands);
      let first = true;
      t.mock.method(commands, "write", ((...args: Parameters<typeof write>) => {
        if (!first) return write(...args);
        first = false; setTimeout(() => write(...args), 1250); return true;
      }) as typeof commands.write);
    }
    hooks.afterSpawn(); return child;
  }) as typeof cp.spawn);
  const controller = new AbortController();
  return {
    input: { session, attemptId, signal: controller.signal, lifecycle: new AbortController().signal,
      authorize: async () => { authorizations++; }, retainWorker: () => { retained++; return () => { retained--; }; } },
    controller, hooks, token, retained: () => retained, launches: () => launches, authorizations: () => authorizations,
  };
}

test("official session validate uses the owned profile and real signer, returns no output, and fences artifacts", async (t) => {
  const s = await system(t);
  assert.equal(await runOwnedOciDiagnostic(s.input), undefined);
  assert.equal(s.launches(), 1); assert.equal(s.retained(), 0); assert.equal(s.authorizations(), 3);
  const directory = join(dirname(s.input.session.paths.root), "owned-resources-v1");
  const files = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
  const record = JSON.parse(await fs.readFile(join(directory, files[0]!), "utf8"));
  assert.deepEqual(record.writers.map(({ role, state }: { role: string; state: string }) => ({ role, state })), [{ role: "diagnostic", state: "closed" }]);
});

test("official validation waits for delayed private configuration without extending its service deadline", async (t) => {
  const s = await system(t, "accept", false, true);
  assert.equal(await runOwnedOciDiagnostic(s.input), undefined);
  assert.equal(s.retained(), 0);
});

test("official diagnostic refuses service rejection and redirects", async (t) => {
  for (const behavior of ["reject", "redirect", "header_error"] as const) {
    await t.test(behavior, async (child) => {
      const s = await system(child, behavior);
      await assert.rejects(runOwnedOciDiagnostic(s.input), OciDiagnosticError);
      assert.equal(s.retained(), 0);
    });
  }
});

test("an expired official CLI session refuses its reauthentication prompt", async (t) => {
  const s = await system(t, "accept", true);
  await assert.rejects(runOwnedOciDiagnostic(s.input), (error: unknown) => error instanceof OciDiagnosticError && error.code === "prompt");
  assert.equal(s.retained(), 0);
});

test("an encrypted owned key refuses its passphrase prompt", async (t) => {
  const s = await system(t);
  const encrypted = createPrivateKey(fixturePrivateKey).export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "disposable-fixture-passphrase" });
  await fs.writeFile(s.input.session.paths.privateKeyFile, encrypted);
  await assert.rejects(runOwnedOciDiagnostic(s.input), (error: unknown) => error instanceof OciDiagnosticError && error.code === "prompt");
  assert.equal(s.retained(), 0);
});

test("process exit zero without official completion and nonzero exits cannot pass", async (t) => {
  for (const exit of [0, 19]) {
    await t.test(String(exit), async (child) => {
      const s = await system(child);
      s.hooks.source = (source) => `import os\nos._exit(${exit})\n` + source;
      await assert.rejects(runOwnedOciDiagnostic(s.input), OciDiagnosticError);
      assert.equal(s.retained(), 0);
    });
  }
});

test("a changed installed source pin refuses before official validation", async (t) => {
  const s = await system(t);
  s.hooks.source = (source) => source.replace("4cba34c8fb2ba49b8b648c89131a559acfe2912b0662d2b28da2344a6d962de0", "0".repeat(64));
  await assert.rejects(runOwnedOciDiagnostic(s.input), (error: unknown) => error instanceof OciDiagnosticError && error.code === "sdk");
  assert.equal(s.retained(), 0);
});

test("a forged lease and another attempt cannot reach the official CLI", async (t) => {
  const s = await system(t);
  const forged: OwnedOciSession = { paths: s.input.session.paths, expectedIdentity: s.input.session.expectedIdentity };
  await assert.rejects(runOwnedOciDiagnostic({ ...s.input, session: forged }), OciDiagnosticError);
  await assert.rejects(runOwnedOciDiagnostic({ ...s.input, attemptId: randomUUID() }), OciDiagnosticError);
  assert.equal(s.launches(), 0); assert.equal(s.retained(), 0);
});

test("artifact mutation during official validation or final authorization rejects success", async (t) => {
  for (const when of ["spawn", "final_authorization"]) {
    await t.test(when, async (child) => {
      const s = await system(child);
      const mutate = () => writeFileSync(s.input.session.paths.tokenFile, s.token + " ");
      if (when === "spawn") s.hooks.afterSpawn = mutate;
      let checks = 0;
      await assert.rejects(runOwnedOciDiagnostic({ ...s.input, authorize: async () => { if (++checks === 3 && when === "final_authorization") mutate(); } }), OciDiagnosticError);
      assert.equal(s.retained(), 0);
    });
  }
});

test("late authorization refusal discards official validation success", async (t) => {
  const s = await system(t); let checks = 0;
  await assert.rejects(runOwnedOciDiagnostic({ ...s.input, authorize: async () => { if (++checks === 3) throw new Error("private-attempt-marker"); } }), (error: unknown) => {
    assert.ok(error instanceof OciDiagnosticError); assert.equal(String(error).includes("private-attempt"), false); return true;
  });
  assert.equal(checks, 3); assert.equal(s.retained(), 0);
});

test("cancellation closes a delayed official CLI and releases retention", async (t) => {
  const s = await system(t, "delay");
  const pending = runOwnedOciDiagnostic(s.input);
  const timer = setTimeout(() => s.controller.abort(), 1200);
  try { await assert.rejects(pending, (error: unknown) => error instanceof OciDiagnosticError && error.code === "aborted"); }
  finally { clearTimeout(timer); }
  assert.equal(s.retained(), 0);
});

test("pre-aborted official diagnostics cannot spawn or retain a worker", async (t) => {
  const s = await system(t); s.controller.abort();
  await assert.rejects(runOwnedOciDiagnostic(s.input), OciDiagnosticError);
  assert.equal(s.launches(), 0); assert.equal(s.retained(), 0);
});
