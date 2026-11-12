import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { CliExpectedIdentity } from "../oci-cli-protocol.ts";

const ATTEMPT = "785e2bf6-6520-4c05-bcb2-e1db930a161a";
const TARGET: CliExpectedIdentity = {
  mode: "oci_cli", tenancyOcid: "ocid1.tenancy.oc1..fixturetenancy", userOcid: "ocid1.user.oc1..fixtureuser",
  region: "us-ashburn-1", realm: "oc1",
};
const SYNTHETIC_KEY = "SYNTHETIC PRIVATE KEY, NEVER USED FOR AUTHENTICATION";
const SYNTHETIC_TOKEN = "synthetic.token.fixture";

async function api() {
  const module = await import("../oci-owned-session.ts").catch(() => null);
  assert.ok(module, "owned session implementation must exist");
  return module;
}
async function fixture(t: TestContext) {
  const dataDir = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "remote-login-owned-test-"));
  await fs.chmod(dataDir, 0o700);
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}
function refused(code: string) {
  return (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    assert.equal((error as Error).message, "Owned OCI session refused.");
    return true;
  };
}

test("owned layout starts empty and private and refuses reuse", async (t) => {
  const { createOwnedOciSession, releaseOwnedOciSession } = await api();
  const dataDir = await fixture(t);
  const lease = await createOwnedOciSession(dataDir, ATTEMPT, TARGET);
  for (const directory of [lease.paths.root, lease.paths.tokenLocation, lease.paths.profileDir]) {
    assert.equal((await fs.lstat(directory)).mode & 0o7777, 0o700);
  }
  for (const path of [lease.paths.configFile, lease.paths.rcFile, lease.paths.privateKeyFile, lease.paths.publicKeyFile, lease.paths.tokenFile]) {
    assert.equal((await fs.lstat(path)).mode & 0o7777, 0o600);
    assert.equal((await fs.stat(path)).size, 0);
  }
  assert.equal(lease.paths.profileName, "BB_REMOTE_785e2bf665204c05bcb2e1db930a161a");
  assert.equal(JSON.stringify(lease), "{}", "private filesystem paths are not serializable status");
  await assert.rejects(createOwnedOciSession(dataDir, ATTEMPT, TARGET), refused("session_exists"));
  await releaseOwnedOciSession(lease);
  await assert.rejects(fs.lstat(lease.paths.root), { code: "ENOENT" });
});

async function syntheticArtifacts(lease: import("../oci-owned-session.ts").OwnedOciSession, editConfig?: (config: string) => string) {
  const { paths, expectedIdentity } = lease;
  const config = `\n\n[${paths.profileName}]\nfingerprint=00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff\nkey_file=${paths.privateKeyFile}\ntenancy=${expectedIdentity.tenancyOcid}\nregion=${expectedIdentity.region}\nsecurity_token_file=${paths.tokenFile}\n`;
  await fs.writeFile(paths.configFile, editConfig ? editConfig(config) : config, { mode: 0o600 });
  await fs.writeFile(paths.privateKeyFile, SYNTHETIC_KEY, { mode: 0o600 });
  await fs.writeFile(paths.publicKeyFile, "SYNTHETIC PUBLIC KEY", { mode: 0o600 });
  await fs.writeFile(paths.tokenFile, SYNTHETIC_TOKEN, { mode: 0o600 });
}

test("owned creation refuses unsafe storage and malformed attempt identities", async (t) => {
  const { createOwnedOciSession } = await api();
  const dataDir = await fixture(t);
  await fs.chmod(dataDir, 0o755);
  await assert.rejects(createOwnedOciSession(dataDir, ATTEMPT, TARGET), refused("unsafe_storage"));
  await fs.chmod(dataDir, 0o700);
  const alias = `${dataDir}-alias`;
  await fs.symlink(dataDir, alias);
  t.after(() => fs.unlink(alias));
  await assert.rejects(createOwnedOciSession(alias, ATTEMPT, TARGET), refused("unsafe_storage"));
  await assert.rejects(createOwnedOciSession(`${dataDir}/.`, ATTEMPT, TARGET), refused("unsafe_storage"));
  await assert.rejects(createOwnedOciSession(dataDir, "../../profile", TARGET), refused("invalid_session"));
  await assert.rejects(createOwnedOciSession(dataDir, `${ATTEMPT}\n`, TARGET), refused("invalid_session"));
  await assert.rejects(createOwnedOciSession(dataDir, ATTEMPT, { ...TARGET, region: "Bad Region" }), refused("invalid_identity"));
  assert.deepEqual(await fs.readdir(dataDir), []);
});

test("captured signer bytes form one private immutable snapshot and are retained until release", async (t) => {
  const { createOwnedOciSession, captureOwnedOciSnapshot, recheckOwnedOciSnapshot, releaseOwnedOciSession } = await api();
  assert.equal(typeof captureOwnedOciSnapshot, "function", "coherent capture implementation must exist");
  const lease = await createOwnedOciSession(await fixture(t), ATTEMPT, TARGET);
  await syntheticArtifacts(lease);
  const snapshot = await captureOwnedOciSnapshot(lease);
  assert.equal(snapshot.tokenBytes.toString("utf8"), SYNTHETIC_TOKEN);
  assert.equal(snapshot.privateKeyBytes.toString("utf8"), SYNTHETIC_KEY);
  snapshot.tokenBytes.fill(0);
  snapshot.privateKeyBytes.fill(0);
  assert.equal(snapshot.tokenBytes.toString("utf8"), SYNTHETIC_TOKEN, "consumers cannot alter the accepted captured bytes");
  assert.equal(snapshot.privateKeyBytes.toString("utf8"), SYNTHETIC_KEY);
  assert.equal(JSON.stringify(snapshot), "{}", "raw bytes and account selectors are not serializable status");
  assert.deepEqual(snapshot.config, { tenancyOcid: TARGET.tenancyOcid, region: TARGET.region, fingerprint: "00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff" });
  await recheckOwnedOciSnapshot(lease, snapshot);
  assert.equal((await fs.stat(lease.paths.tokenFile)).size, SYNTHETIC_TOKEN.length);
  await releaseOwnedOciSession(lease);
  await assert.rejects(fs.lstat(lease.paths.root), { code: "ENOENT" });
  await assert.rejects(recheckOwnedOciSnapshot(lease, snapshot), refused("invalid_lease"));
  assert.throws(() => snapshot.tokenBytes, refused("invalid_snapshot"));
});

test("config parser rejects ambiguous or unowned selectors before capturing credentials", async (t) => {
  const { createOwnedOciSession, captureOwnedOciSnapshot } = await api();
  assert.equal(typeof captureOwnedOciSnapshot, "function", "coherent capture implementation must exist");
  const lease = await createOwnedOciSession(await fixture(t), ATTEMPT, TARGET);
  for (const mutate of [
    (config: string) => `${config}region=us-phoenix-1\n`,
    (config: string) => `${config}region = ${TARGET.region}\n`,
    (config: string) => `[DEFAULT]\nregion = ${TARGET.region}\n${config}`,
    (config: string) => config.replace(`key_file=${lease.paths.privateKeyFile}`, "key_file = /invented/outside/private-key.pem"),
    (config: string) => config.replace("key_file=", "key_file= "),
    (config: string) => `[DEFAULT]\nregion=${TARGET.region}\n${config}`,
    (config: string) => `${config}[OTHER]\nregion=${TARGET.region}\n`,
    (config: string) => config.replace(lease.paths.privateKeyFile, "/invented/outside/private-key.pem"),
    (config: string) => config.replace(lease.paths.tokenFile, `${lease.paths.profileDir}/../${lease.paths.profileName}/token`),
    (config: string) => `${config}pass_phrase=synthetic-passphrase\n`,
    (config: string) => `${config}user=ocid1.user.oc1..differentfixture\n`,
    (config: string) => config.replace(TARGET.tenancyOcid, "ocid1.tenancy.oc1..differentfixture"),
    (config: string) => config.replace(`region=${TARGET.region}`, "region=us-phoenix-1"),
    (config: string) => config.replace("fingerprint=", " fingerprint="),
    (config: string) => config.replace("region=", "region: "),
    (config: string) => `${config}# unknown parser extension\n`,
    (config: string) => `\ufeff${config}`,
  ]) {
    await syntheticArtifacts(lease, mutate);
    await assert.rejects(captureOwnedOciSnapshot(lease), refused("invalid_config"));
  }
});

test("snapshot rejects symlinks, hardlinks, wrong permissions, oversized and unexpected artifacts", async (t) => {
  const { createOwnedOciSession, captureOwnedOciSnapshot } = await api();
  assert.equal(typeof captureOwnedOciSnapshot, "function", "coherent capture implementation must exist");
  const lease = await createOwnedOciSession(await fixture(t), ATTEMPT, TARGET);
  await syntheticArtifacts(lease);
  await fs.chmod(lease.paths.tokenFile, 0o644);
  await assert.rejects(captureOwnedOciSnapshot(lease), refused("unsafe_storage"));
  await fs.chmod(lease.paths.tokenFile, 0o600);
  const extra = join(lease.paths.profileDir, "unexpected");
  await fs.link(lease.paths.tokenFile, extra);
  await assert.rejects(captureOwnedOciSnapshot(lease), refused("unexpected_artifact"));
  await fs.unlink(extra);
  const elsewhere = `${lease.paths.root}-hardlink`;
  await fs.link(lease.paths.tokenFile, elsewhere);
  await assert.rejects(captureOwnedOciSnapshot(lease), refused("unsafe_storage"));
  await fs.unlink(elsewhere);
  const outsideToken = `${lease.paths.root}-token-copy`;
  await fs.rename(lease.paths.tokenFile, outsideToken);
  await fs.symlink(outsideToken, lease.paths.tokenFile);
  await assert.rejects(captureOwnedOciSnapshot(lease), refused("unsafe_storage"));
  await fs.unlink(lease.paths.tokenFile);
  await fs.rename(outsideToken, lease.paths.tokenFile);
  await fs.writeFile(lease.paths.tokenFile, Buffer.alloc(65_537, 120));
  await assert.rejects(captureOwnedOciSnapshot(lease), refused("artifact_too_large"));
});

test("await-time mutation of every owned artifact or selector invalidates an old snapshot", async (t) => {
  const { createOwnedOciSession, captureOwnedOciSnapshot, recheckOwnedOciSnapshot } = await api();
  assert.equal(typeof captureOwnedOciSnapshot, "function", "coherent capture implementation must exist");
  for (const kind of ["configFile", "rcFile", "privateKeyFile", "publicKeyFile", "tokenFile"] as const) {
    const lease = await createOwnedOciSession(await fixture(t), ATTEMPT, TARGET);
    await syntheticArtifacts(lease);
    const snapshot = await captureOwnedOciSnapshot(lease);
    const original = await fs.readFile(lease.paths[kind]);
    await fs.writeFile(lease.paths[kind], original.length ? Buffer.alloc(original.length, 120) : "x");
    await assert.rejects(recheckOwnedOciSnapshot(lease, snapshot), refused("artifact_changed"));
    await fs.writeFile(lease.paths[kind], original);
    await assert.rejects(recheckOwnedOciSnapshot(lease, snapshot), refused("artifact_changed"), "ABA rewrite cannot restore the old generation");
  }
});

test("replacement with identical bytes invalidates capture and cleanup never deletes replacements", async (t) => {
  const { createOwnedOciSession, captureOwnedOciSnapshot, recheckOwnedOciSnapshot, releaseOwnedOciSession, disposeOwnedOciSnapshot } = await api();
  assert.equal(typeof captureOwnedOciSnapshot, "function", "coherent capture implementation must exist");
  const lease = await createOwnedOciSession(await fixture(t), ATTEMPT, TARGET);
  await syntheticArtifacts(lease);
  const snapshot = await captureOwnedOciSnapshot(lease);
  await fs.rename(lease.paths.tokenFile, `${lease.paths.root}-original-token`);
  await fs.writeFile(lease.paths.tokenFile, SYNTHETIC_TOKEN, { mode: 0o600 });
  await assert.rejects(recheckOwnedOciSnapshot(lease, snapshot), refused("artifact_changed"));
  disposeOwnedOciSnapshot(snapshot);
  await assert.rejects(captureOwnedOciSnapshot(lease), refused("artifact_changed"));
  await assert.rejects(releaseOwnedOciSession(lease), refused("artifact_changed"));
  assert.equal(await fs.readFile(lease.paths.tokenFile, "utf8"), SYNTHETIC_TOKEN);
});

test("forged leases and snapshots cannot authorize artifact access", async (t) => {
  const { createOwnedOciSession, captureOwnedOciSnapshot, recheckOwnedOciSnapshot, releaseOwnedOciSession } = await api();
  assert.equal(typeof captureOwnedOciSnapshot, "function", "coherent capture implementation must exist");
  const lease = await createOwnedOciSession(await fixture(t), ATTEMPT, TARGET);
  await syntheticArtifacts(lease);
  await assert.rejects(captureOwnedOciSnapshot({ ...lease }), refused("invalid_lease"));
  await assert.rejects(releaseOwnedOciSession({ ...lease }), refused("invalid_lease"));
  await assert.rejects(recheckOwnedOciSnapshot(lease, {} as never), refused("invalid_snapshot"));
});

test("pre-auth lease fence checks original private directories and empty RC without reading credentials", async (t) => {
  const { createOwnedOciSession, assertOwnedOciSession } = await api();
  assert.equal(typeof assertOwnedOciSession, "function", "pre-auth lease fence must exist");
  const lease = await createOwnedOciSession(await fixture(t), ATTEMPT, TARGET);
  await assertOwnedOciSession(lease);
  await syntheticArtifacts(lease);
  await assertOwnedOciSession(lease);
  await fs.writeFile(lease.paths.rcFile, "[SYNTHETIC DEFAULT]\n");
  await assert.rejects(assertOwnedOciSession(lease), refused("invalid_artifact"));
  await fs.writeFile(lease.paths.rcFile, "");
  await fs.rename(lease.paths.profileDir, `${lease.paths.profileDir}-old`);
  await fs.mkdir(lease.paths.profileDir, { mode: 0o700 });
  await assert.rejects(assertOwnedOciSession(lease), refused("artifact_changed"));
});

test("release refuses unexpected files and replacement of the original empty config", async (t) => {
  const { createOwnedOciSession, releaseOwnedOciSession } = await api();
  const lease = await createOwnedOciSession(await fixture(t), ATTEMPT, TARGET);
  await fs.writeFile(join(lease.paths.profileDir, "do-not-delete"), "synthetic", { mode: 0o600 });
  await assert.rejects(releaseOwnedOciSession(lease), refused("cleanup_refused"));
  assert.equal(await fs.readFile(join(lease.paths.profileDir, "do-not-delete"), "utf8"), "synthetic");
  await fs.unlink(join(lease.paths.profileDir, "do-not-delete"));
  await fs.rename(lease.paths.configFile, join(lease.paths.root, "original-config"));
  await fs.writeFile(lease.paths.configFile, "", { mode: 0o600 });
  await assert.rejects(releaseOwnedOciSession(lease), refused("artifact_changed"));
  assert.equal((await fs.stat(lease.paths.configFile)).size, 0);
});

test("a moved and restored profile directory cannot restore an old captured generation", async (t) => {
  const { createOwnedOciSession, captureOwnedOciSnapshot, recheckOwnedOciSnapshot } = await api();
  const lease = await createOwnedOciSession(await fixture(t), ATTEMPT, TARGET);
  await syntheticArtifacts(lease);
  const snapshot = await captureOwnedOciSnapshot(lease);
  const moved = `${lease.paths.profileDir}-moved`;
  await fs.rename(lease.paths.profileDir, moved);
  await fs.rename(moved, lease.paths.profileDir);
  await assert.rejects(recheckOwnedOciSnapshot(lease, snapshot), refused("artifact_changed"));
});


test("snapshot accepts the real Python ConfigParser writer's canonical separators", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async (t) => {
  const { createOwnedOciSession, captureOwnedOciSnapshot, recheckOwnedOciSnapshot } = await api();
  const lease = await createOwnedOciSession(await fixture(t), ATTEMPT, TARGET);
  await syntheticArtifacts(lease);
  // Matches cli_setup.remove_profile_from_config's stdlib writer. Only invented fixture values are read.
  await promisify(execFile)("/opt/homebrew/Cellar/oci-cli/3.88.0/libexec/bin/python", ["-I", "-S", "-c", `import configparser, sys
config = configparser.ConfigParser(default_section="")
config.read(sys.argv[1])
with open(sys.argv[1], "w") as output:
    config.write(output)
`, lease.paths.configFile], { timeout: 2000, maxBuffer: 1024, env: { PATH: "/usr/bin:/bin" } });
  const snapshot = await captureOwnedOciSnapshot(lease);
  assert.equal(snapshot.config.region, TARGET.region);
  assert.equal(snapshot.tokenBytes.toString("utf8"), SYNTHETIC_TOKEN);
  await recheckOwnedOciSnapshot(lease, snapshot);
});

test("disposing a snapshot revokes its bytes and fence while retaining owned session files", async (t) => {
  const { createOwnedOciSession, captureOwnedOciSnapshot, recheckOwnedOciSnapshot, disposeOwnedOciSnapshot } = await api();
  assert.equal(typeof disposeOwnedOciSnapshot, "function", "snapshot disposal implementation must exist");
  const lease = await createOwnedOciSession(await fixture(t), ATTEMPT, TARGET);
  await syntheticArtifacts(lease);
  const snapshot = await captureOwnedOciSnapshot(lease);
  disposeOwnedOciSnapshot(snapshot);
  disposeOwnedOciSnapshot(snapshot);
  for (const field of ["tokenBytes", "privateKeyBytes", "config"] as const) {
    assert.throws(() => snapshot[field], refused("invalid_snapshot"));
  }
  await assert.rejects(recheckOwnedOciSnapshot(lease, snapshot), refused("invalid_snapshot"));
  assert.equal((await fs.stat(lease.paths.tokenFile)).size, SYNTHETIC_TOKEN.length);
  assert.equal((await fs.stat(lease.paths.privateKeyFile)).size, SYNTHETIC_KEY.length);
  const next = await captureOwnedOciSnapshot(lease);
  await recheckOwnedOciSnapshot(lease, next);
  assert.equal(next.tokenBytes.toString("utf8"), SYNTHETIC_TOKEN);
  disposeOwnedOciSnapshot(next);
});

test("one lease permits only one active or in-flight capture", async (t) => {
  const { createOwnedOciSession, captureOwnedOciSnapshot, disposeOwnedOciSnapshot } = await api();
  const lease = await createOwnedOciSession(await fixture(t), ATTEMPT, TARGET);
  await syntheticArtifacts(lease);
  const outcomes = await Promise.allSettled([captureOwnedOciSnapshot(lease), captureOwnedOciSnapshot(lease)]);
  const fulfilled = outcomes.filter((result) => result.status === "fulfilled");
  const rejected = outcomes.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1, "concurrent captures cannot retain multiple copies of private bytes");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.status === "rejected" && rejected[0].reason.code, "snapshot_active");
  const snapshot = fulfilled[0]!.status === "fulfilled" && fulfilled[0].value;
  assert.ok(snapshot);
  await assert.rejects(captureOwnedOciSnapshot(lease), refused("snapshot_active"));
  disposeOwnedOciSnapshot(snapshot);
  disposeOwnedOciSnapshot(await captureOwnedOciSnapshot(lease));
});

test("a token changed between separate diagnostic and verifier snapshots cannot satisfy a chain seal", async (t) => {
  const module = await api();
  assert.equal(typeof module.captureOwnedOciGenerationSeal, "function", "a private verification-chain seal must exist");
  assert.equal(typeof module.assertOwnedOciGenerationSeal, "function", "the verification chain must compare its original generation");
  const lease = await module.createOwnedOciSession(await fixture(t), ATTEMPT, TARGET);
  await syntheticArtifacts(lease);
  const seal = await module.captureOwnedOciGenerationSeal(lease);
  const diagnostic = await module.captureOwnedOciSnapshot(lease);
  await module.recheckOwnedOciSnapshot(lease, diagnostic);
  module.disposeOwnedOciSnapshot(diagnostic);
  await fs.writeFile(lease.paths.tokenFile, "different.synthetic.token", { mode: 0o600 });
  // A later individual capture can be coherent and still belong to another generation.
  const verifier = await module.captureOwnedOciSnapshot(lease);
  await module.recheckOwnedOciSnapshot(lease, verifier);
  module.disposeOwnedOciSnapshot(verifier);
  await assert.rejects(module.assertOwnedOciGenerationSeal(lease, seal), refused("artifact_changed"));
});

test("a generation seal exposes no paths, bytes, hashes or acceptance flags and releases its capture", async (t) => {
  const module = await api();
  const lease = await module.createOwnedOciSession(await fixture(t), ATTEMPT, TARGET);
  await syntheticArtifacts(lease);
  const seal = await module.captureOwnedOciGenerationSeal(lease);
  assert.equal(Object.isFrozen(seal), true);
  assert.deepEqual(Reflect.ownKeys(seal), []);
  assert.equal(JSON.stringify(seal), "{}");
  const later = await module.captureOwnedOciSnapshot(lease);
  assert.equal(later.tokenBytes.toString("utf8"), SYNTHETIC_TOKEN);
  module.disposeOwnedOciSnapshot(later);
  await module.assertOwnedOciGenerationSeal(lease, seal);
  await module.assertOwnedOciGenerationSeal(lease, seal);
});

test("chain seals reject rewritten or restored artifacts and moved directories across capture gaps", async (t) => {
  const module = await api();
  for (const kind of ["configFile", "rcFile", "privateKeyFile", "publicKeyFile", "tokenFile", "profileDir"] as const) {
    const lease = await module.createOwnedOciSession(await fixture(t), ATTEMPT, TARGET);
    await syntheticArtifacts(lease);
    const seal = await module.captureOwnedOciGenerationSeal(lease);
    if (kind === "profileDir") {
      const moved = `${lease.paths.profileDir}-moved`;
      await fs.rename(lease.paths.profileDir, moved); await fs.rename(moved, lease.paths.profileDir);
    } else {
      const bytes = await fs.readFile(lease.paths[kind]);
      // Rewriting the empty RC preserves its required empty contents but changes its generation.
      await fs.writeFile(lease.paths[kind], kind === "rcFile" ? bytes : Buffer.concat([bytes, Buffer.from("\n")]));
      await assert.rejects(module.assertOwnedOciGenerationSeal(lease, seal));
      await fs.writeFile(lease.paths[kind], bytes);
    }
    await assert.rejects(module.assertOwnedOciGenerationSeal(lease, seal), refused("artifact_changed"));
  }
});

test("forged, foreign and released session seals cannot authorize a verification chain", async (t) => {
  const module = await api();
  const lease = await module.createOwnedOciSession(await fixture(t), ATTEMPT, TARGET);
  const other = await module.createOwnedOciSession(await fixture(t), ATTEMPT, TARGET);
  await syntheticArtifacts(lease); await syntheticArtifacts(other);
  const seal = await module.captureOwnedOciGenerationSeal(lease);
  await assert.rejects(module.assertOwnedOciGenerationSeal(lease, {} as never), refused("invalid_seal"));
  await assert.rejects(module.assertOwnedOciGenerationSeal(other, seal), refused("invalid_seal"));
  await module.assertOwnedOciGenerationSeal(lease, seal);
  await module.releaseOwnedOciSession(lease);
  await assert.rejects(module.assertOwnedOciGenerationSeal(lease, seal), refused("invalid_lease"));
});
