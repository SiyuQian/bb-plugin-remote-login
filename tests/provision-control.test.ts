import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/provision-control.ts", import.meta.url));
const fixtureKey = Buffer.alloc(32, 0x37).toString("base64url");
const fixtureFingerprint = createHash("sha256")
  .update("bb-remote-login pairing root v1\0", "utf8")
  .update(Buffer.alloc(32, 0x37)).digest("hex");

async function fixture(t: TestContext, content = `REMOTE_LOGIN_CONTROL_KEY=${fixtureKey}\n`) {
  const directory = await mkdtemp(join(tmpdir(), "remote-login-owner-fixture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDir = join(directory, "data");
  const secretFile = join(directory, "private-control-key.env");
  await mkdir(dataDir, { mode: 0o700 });
  await writeFile(secretFile, content, { mode: 0o600 });
  return { directory, dataDir, secretFile };
}

function provision(dataDir: string, secretFile: string, fingerprint = fixtureFingerprint, extra: string[] = [], nodeArgs: string[] = []) {
  return spawnSync(process.execPath, [
    ...nodeArgs, "--experimental-strip-types", script,
    "--data-dir", dataDir, "--secret-file", secretFile,
    "--expected-fingerprint", fingerprint, ...extra,
  ], { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 });
}

function assertFailure(result: ReturnType<typeof provision>) {
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { provisioned: false, reason: "provision_failed" });
  assert.equal(result.stdout.includes(fixtureKey), false);
}

async function assertRemoved(path: string) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

async function mutateAfterRead(directory: string, secretFile: string, mutation: string): Promise<string[]> {
  const preload = join(directory, "staging-race.mjs");
  await writeFile(preload, `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const originalOpen = fs.open;
    fs.open = async (...args) => {
      const file = await originalOpen(...args);
      if (args[0] === ${JSON.stringify(secretFile)}) {
        const originalRead = file.read.bind(file);
        file.read = async (...readArgs) => {
          const result = await originalRead(...readArgs);
          ${mutation}
          return result;
        };
      }
      return file;
    };
    syncBuiltinESMExports();
  `, { mode: 0o600 });
  return ["--import", preload];
}

test("owner provisioning accepts the three BB secrets assignment encodings", async (t) => {
  for (const value of [fixtureKey, `'${fixtureKey}'`, JSON.stringify(fixtureKey)]) {
    await t.test(value.startsWith("'") ? "single quoted" : value.startsWith('"') ? "JSON quoted" : "raw", async (t) => {
      const { dataDir, secretFile } = await fixture(t, `REMOTE_LOGIN_CONTROL_KEY=${value}\n`);
      const result = provision(dataDir, secretFile);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const output = JSON.parse(result.stdout);
      assert.deepEqual(Object.keys(output).sort(), ["provisioned", "rootId"]);
      assert.equal(output.provisioned, true);
      assert.equal(typeof output.rootId, "string");
      assert.ok(output.rootId.length > 0);
      const saved = await readFile(join(dataDir, "control-root.json"), "utf8");
      assert.equal(saved.includes(fixtureKey), false);
      await assertRemoved(secretFile);
    });
  }
});

test("owner provisioning accepts the BB secrets Windows line ending", async (t) => {
  const { dataDir, secretFile } = await fixture(t, `REMOTE_LOGIN_CONTROL_KEY=${fixtureKey}\r\n`);
  const result = provision(dataDir, secretFile);
  assert.equal(result.status, 0, result.stderr);
  await assertRemoved(secretFile);
});

test("a fingerprint mismatch cannot create a root and removes the owned staging file", async (t) => {
  const { dataDir, secretFile } = await fixture(t);
  assertFailure(provision(dataDir, secretFile, "0".repeat(64)));
  await assertRemoved(join(dataDir, "control-root.json"));
  await assertRemoved(secretFile);
});

test("an existing root is never replaced and the owned staging file is removed", async (t) => {
  const { dataDir, secretFile } = await fixture(t);
  const rootPath = join(dataDir, "control-root.json");
  const existingRoot = '{"fixture":"preexisting-root"}\n';
  await writeFile(rootPath, existingRoot, { mode: 0o600 });
  assertFailure(provision(dataDir, secretFile));
  assert.equal(await readFile(rootPath, "utf8"), existingRoot);
  await assertRemoved(secretFile);
});

test("authority storage cannot be consumed as a staging file", async (t) => {
  for (const name of ["control-root.json", "control-budget.json"]) {
    await t.test(name, async (t) => {
      const { dataDir } = await fixture(t);
      const protectedFile = join(dataDir, name);
      const saved = '{"fixture":"existing-authority-storage"}\n';
      await writeFile(protectedFile, saved, { mode: 0o600 });
      assertFailure(provision(dataDir, protectedFile));
      assert.equal(await readFile(protectedFile, "utf8"), saved);
    });
  }
});

test("a directory alias cannot cause cleanup to delete authority storage", async (t) => {
  const { directory, dataDir } = await fixture(t);
  const alias = join(directory, "data-alias");
  const rootPath = join(dataDir, "control-root.json");
  const saved = '{"fixture":"existing-root-through-alias"}\n';
  await writeFile(rootPath, saved, { mode: 0o600 });
  await symlink(dataDir, alias);
  assertFailure(provision(dataDir, join(alias, "control-root.json")));
  assert.equal(await readFile(rootPath, "utf8"), saved);
});

test("all persistent data paths and directory aliases are excluded from staging", async (t) => {
  for (const alias of ["direct", "staging-parent", "data-dir"]) {
    await t.test(alias, async (t) => {
      const { directory, dataDir } = await fixture(t);
      const nested = join(dataDir, "persistent-state");
      await mkdir(nested, { mode: 0o700 });
      const internalFile = join(nested, "attempt.lock");
      const content = `REMOTE_LOGIN_CONTROL_KEY=${fixtureKey}\n`;
      await writeFile(internalFile, content, { mode: 0o600 });
      let selectedDataDir = dataDir;
      let selectedFile = internalFile;
      if (alias === "staging-parent") {
        const linkedParent = join(directory, "staging-alias");
        await symlink(nested, linkedParent);
        selectedFile = join(linkedParent, "attempt.lock");
      }
      if (alias === "data-dir") {
        selectedDataDir = join(directory, "data-alias");
        await symlink(dataDir, selectedDataDir);
      }
      assertFailure(provision(selectedDataDir, selectedFile));
      assert.equal(await readFile(internalFile, "utf8"), content);
      await assertRemoved(join(dataDir, "control-root.json"));
    });
  }
});

test("unsafe permissions do not permit reading or deleting the staging file", async (t) => {
  const { dataDir, secretFile } = await fixture(t);
  await chmod(secretFile, 0o644);
  assertFailure(provision(dataDir, secretFile));
  assert.equal((await lstat(secretFile)).mode & 0o777, 0o644);
  await assertRemoved(join(dataDir, "control-root.json"));
});

test("a staging symlink is neither followed nor deleted", async (t) => {
  const { directory, dataDir, secretFile } = await fixture(t);
  const symlinkPath = join(directory, "control-link.env");
  await symlink(secretFile, symlinkPath);
  assertFailure(provision(dataDir, symlinkPath));
  assert.equal((await lstat(symlinkPath)).isSymbolicLink(), true);
  assert.equal(await readFile(secretFile, "utf8"), `REMOTE_LOGIN_CONTROL_KEY=${fixtureKey}\n`);
});

test("a multiply linked staging file is not consumed or deleted", async (t) => {
  const { directory, dataDir, secretFile } = await fixture(t);
  const otherLink = join(directory, "other-link.env");
  await link(secretFile, otherLink);
  assertFailure(provision(dataDir, secretFile));
  assert.equal((await lstat(secretFile)).nlink, 2);
  assert.equal((await lstat(otherLink)).nlink, 2);
});

test("an oversized staging file is rejected without deleting unsafe input", async (t) => {
  const { dataDir, secretFile } = await fixture(t, "X".repeat(4097));
  assertFailure(provision(dataDir, secretFile));
  assert.equal((await lstat(secretFile)).size, 4097);
});

test("a safely opened staging inode is removed even if its content grows during the read", async (t) => {
  const { directory, dataDir, secretFile } = await fixture(t);
  const nodeArgs = await mutateAfterRead(directory, secretFile,
    `await fs.appendFile(${JSON.stringify(secretFile)}, "x".repeat(4096));`);
  assertFailure(provision(dataDir, secretFile, fixtureFingerprint, [], nodeArgs));
  await assertRemoved(secretFile);
  await assertRemoved(join(dataDir, "control-root.json"));
});

test("cleanup never deletes a replacement inode at the staging path", async (t) => {
  const { directory, dataDir, secretFile } = await fixture(t);
  const original = join(directory, "renamed-original.env");
  const nodeArgs = await mutateAfterRead(directory, secretFile, `
    await fs.rename(${JSON.stringify(secretFile)}, ${JSON.stringify(original)});
    await fs.writeFile(${JSON.stringify(secretFile)}, "unrelated replacement fixture\\n", { mode: 0o600 });
  `);
  assertFailure(provision(dataDir, secretFile, fixtureFingerprint, [], nodeArgs));
  assert.equal(await readFile(secretFile, "utf8"), "unrelated replacement fixture\n");
  assert.equal(await readFile(original, "utf8"), `REMOTE_LOGIN_CONTROL_KEY=${fixtureKey}\n`);
});

test("a directory cannot be consumed or deleted as a staging file", async (t) => {
  const { dataDir } = await fixture(t);
  assertFailure(provision(dataDir, dataDir));
  assert.equal((await lstat(dataDir)).isDirectory(), true);
});

test("invalid assignments are rejected without echoing content and consumed safely", async (t) => {
  const assignments = [
    `REMOTE_LOGIN_CONTROL_KEY=${fixtureKey}\nREMOTE_LOGIN_CONTROL_KEY=${fixtureKey}\n`,
    `REMOTE_LOGIN_CONTROL_KEY=${fixtureKey}\nUNEXPECTED=private-fixture-value\n`,
    `export REMOTE_LOGIN_CONTROL_KEY=${fixtureKey}\n`,
    `REMOTE_LOGIN_CONTROL_KEY=${fixtureKey}`,
    `REMOTE_LOGIN_CONTROL_KEY=${fixtureKey}\n\n`,
    `REMOTE_LOGIN_CONTROL_KEY=${"A".repeat(42)}B\n`,
    `REMOTE_LOGIN_CONTROL_KEY=$(private_fixture_command)\n`,
    `WRONG_NAME=${fixtureKey}\n`,
  ];
  for (const [index, content] of assignments.entries()) {
    await t.test(`invalid assignment ${index + 1}`, async (t) => {
      const { dataDir, secretFile } = await fixture(t, content);
      const result = provision(dataDir, secretFile);
      assertFailure(result);
      assert.equal(result.stdout.includes("private-fixture-value"), false);
      assert.equal(result.stdout.includes("private_fixture_command"), false);
      await assertRemoved(secretFile);
      await assertRemoved(join(dataDir, "control-root.json"));
    });
  }
});

test("filesystem failures are redacted and still remove safely opened staging", async (t) => {
  const { directory, secretFile } = await fixture(t);
  const invalidDataDir = join(directory, "private-filesystem-error-fixture");
  await writeFile(invalidDataDir, "not a directory", { mode: 0o600 });
  const result = provision(invalidDataDir, secretFile);
  assertFailure(result);
  assert.equal(result.stdout.includes(invalidDataDir), false);
  await assertRemoved(secretFile);
});

test("owner provisioning rejects unknown secret arguments and relative paths", async (t) => {
  for (const extra of [["--key", "not-a-real-key"], ["--replace"], ["--data-dir", "relative"]]) {
    await t.test(extra[0]!, async (t) => {
      const { dataDir, secretFile } = await fixture(t);
      assertFailure(provision(dataDir, secretFile, fixtureFingerprint, extra));
      assert.ok((await lstat(secretFile)).isFile());
      await assertRemoved(join(dataDir, "control-root.json"));
    });
  }
  const { dataDir, secretFile } = await fixture(t);
  assertFailure(provision("relative", secretFile));
  assertFailure(provision(dataDir, "relative.env"));
  assertFailure(provision(dataDir, secretFile, "not-a-fingerprint"));
  assert.ok((await lstat(secretFile)).isFile());
});
