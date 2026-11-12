import assert from "node:assert/strict";
import { constants, type PathLike } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assessOciCompatibility, inspectInstalledOciCompatibility, type OciCompatibilityEvidence } from "../oci-compatibility.ts";

// These are independently measured public source digests, never account fixtures.
const matching: OciCompatibilityEvidence = {
  version: "3.88.0",
  launcher: "6196509b5e1e1cbbd8421fc72f49be22b2f46f4ad9b4e28bc49dbf9bd1dfa366",
  bootstrap: "2e9002445a6380fcc308f802b9a68ab42bd6e0aafcc557750dbf9efb4d507f83",
  session: "4cba34c8fb2ba49b8b648c89131a559acfe2912b0662d2b28da2344a6d962de0",
  pythonBrowser: "893c86950a76b187b6a84e65bde03572e4179733f667b32880f866ce9a1a92f3",
};

test("recognized installed sources do not authorize either real login adapter", () => {
  const result = assessOciCompatibility(matching);
  assert.equal(result.sourceCompatibility, "matched");
  assert.deepEqual(result.hostBrowser, {
    enabled: false,
    reason: "runtime_ownership_and_identity_unverified",
  });
  assert.deepEqual(result.phoneCallback, {
    enabled: false,
    reason: "no_supported_redirect_override_or_bound_callback_bridge",
  });
  assert.equal(result.protocol?.callbackBind, "0.0.0.0:8181");
  assert.equal(result.protocol?.callbackAttemptBinding, false);
  assert.equal(result.protocol?.browserHelperFallback, true);
});

test("a version match cannot bypass one changed or missing source fingerprint", () => {
  for (const key of ["launcher", "bootstrap", "session", "pythonBrowser"] as const) {
    for (const replacement of [null, "0".repeat(64)]) {
      const result = assessOciCompatibility({ ...matching, [key]: replacement });
      assert.equal(result.sourceCompatibility, "unrecognized", key);
      assert.equal(result.fingerprints[key], false, key);
      assert.equal(result.protocol, null, key);
      assert.equal(result.hostBrowser.enabled, false, key);
      assert.equal(result.phoneCallback.enabled, false, key);
    }
  }
});

test("unknown versions and raw diagnostic strings stay out of the bounded report", () => {
  for (const version of [null, "3.88.1", "3.88.0\nUNTRUSTED_DIAGNOSTIC"]) {
    const result = assessOciCompatibility({ ...matching, version });
    assert.equal(result.sourceCompatibility, "unrecognized");
    assert.equal(result.versionMatches, false);
    assert.equal(result.protocol, null);
    assert.equal(JSON.stringify(result).includes("UNTRUSTED_DIAGNOSTIC"), false);
  }
});

test("fixed inventory refuses symlinks, oversized and nonregular source files before reading", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "oci-public-source-fixture-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const regular = join(root, "regular-source");
  const oversized = join(root, "oversized-source");
  const link = join(root, "symlink-source");
  await fs.writeFile(regular, "non-secret public-source fixture");
  await fs.writeFile(oversized, Buffer.alloc(300_001));
  await fs.symlink(regular, link);
  const installation = "/opt/homebrew/Cellar/oci-cli/3.88.0";
  const packages = `${installation}/libexec/lib/python3.14/site-packages`;
  const metadataPath = `${packages}/oci_cli-3.88.0.dist-info/METADATA`;
  const browserPath = "/opt/homebrew/opt/python@3.14/Frameworks/Python.framework/Versions/3.14/lib/python3.14/webbrowser.py";
  const sources = new Map([
    [metadataPath, regular],
    [`${installation}/libexec/bin/oci`, root],
    [`${packages}/oci_cli/cli_setup_bootstrap.py`, oversized],
    [`${packages}/oci_cli/cli_session.py`, link],
    [browserPath, regular],
  ]);
  const readPaths: string[] = [];
  const closed: string[] = [];
  const open = fs.open.bind(fs);
  t.mock.method(fs, "realpath", async (path: PathLike) => {
    assert.equal(path, "/opt/homebrew/bin/oci");
    return `${installation}/libexec/bin/oci`;
  });
  t.mock.method(fs, "open", async (path: PathLike, flags: string | number) => {
    const selected = sources.get(String(path));
    assert.ok(selected, "only fixed public installation paths may be opened");
    assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = await open(selected, flags);
    t.mock.method(file, "read", async () => {
      readPaths.push(String(path));
      throw new Error("synthetic_read_failure");
    });
    const close = file.close.bind(file);
    t.mock.method(file, "close", async () => { await close(); closed.push(String(path)); });
    return file;
  });
  const result = await inspectInstalledOciCompatibility();
  assert.equal(result.sourceCompatibility, "unrecognized");
  assert.equal(result.protocol, null);
  assert.deepEqual(readPaths.sort(), [metadataPath, browserPath].sort());
  assert.equal(closed.length, 4);
  assert.equal(JSON.stringify(result).includes(root), false);
});
