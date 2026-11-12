import assert from "node:assert/strict";
import cp, { type ChildProcess, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { constants, type PathLike, type Stats } from "node:fs";
import fs from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { assessOciCompatibility } from "../oci-compatibility.ts";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
type MetadataCallback = (error: Error | null, stdout: string, stderr: string) => void;
const identity = { pid: process.pid, uid: process.getuid!(), started: "100:200", executableId: "a".repeat(64) };
const matchingSources = assessOciCompatibility({
  version: "3.88.0",
  launcher: "6196509b5e1e1cbbd8421fc72f49be22b2f46f4ad9b4e28bc49dbf9bd1dfa366",
  bootstrap: "2e9002445a6380fcc308f802b9a68ab42bd6e0aafcc557750dbf9efb4d507f83",
  session: "4cba34c8fb2ba49b8b648c89131a559acfe2912b0662d2b28da2344a6d962de0",
  pythonBrowser: "893c86950a76b187b6a84e65bde03572e4179733f667b32880f866ce9a1a92f3",
});

async function api() {
  const runtime = await import("../login-runtime-capabilities.ts").catch(() => null);
  assert.ok(runtime, "read-only runtime capability inspection must exist");
  return runtime;
}

function processValue(t: TestContext, key: "platform" | "arch", value: string) {
  const original = Object.getOwnPropertyDescriptor(process, key)!;
  Object.defineProperty(process, key, { ...original, value });
  t.after(() => Object.defineProperty(process, key, original));
}

async function fixture(t: TestContext) {
  const runtime = await api();
  processValue(t, "platform", "darwin");
  processValue(t, "arch", "arm64");
  t.mock.method(fs, "lstat", async (path: PathLike) => {
    assert.equal(path, chromePath);
    return { isFile: () => true, isSymbolicLink: () => false } as Stats;
  });
  t.mock.method(fs, "access", async (path: PathLike, mode?: number) => {
    assert.equal(path, chromePath);
    assert.equal(mode, constants.X_OK);
  });
  t.mock.method(cp, "execFile", (_file: string, _args: string[], _options: ExecFileOptionsWithStringEncoding, callback: MetadataCallback) => {
    callback(null, "157.0.8103.51\n", "");
    return {} as ChildProcess;
  });
  t.mock.method(runtime.runtimeCapabilityDependencies, "inspectOwnedProcess", async (pid: number) => {
    assert.equal(pid, process.pid);
    return identity;
  });
  t.mock.method(runtime.runtimeCapabilityDependencies, "inspectInstalledOciCompatibility", async () => matchingSources);
  return runtime;
}

test("preflight reads fixed Chrome metadata and reports only runtime capability facts", async (t) => {
  const runtime = await fixture(t);
  t.mock.method(cp, "execFile", (file: string, args: string[], options: ExecFileOptionsWithStringEncoding, callback: MetadataCallback) => {
    assert.equal(file, "/usr/libexec/PlistBuddy");
    assert.deepEqual(args, ["-c", "Print :CFBundleShortVersionString", "/Applications/Google Chrome.app/Contents/Info.plist"]);
    assert.equal(options?.timeout, 2000);
    assert.equal(options?.maxBuffer, 128);
    assert.equal(options?.killSignal, "SIGKILL");
    assert.ok(options?.signal instanceof AbortSignal);
    assert.deepEqual(options?.env, { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });
    callback(null, "157.0.8103.51\n", "");
    return {} as ChildProcess;
  });
  assert.deepEqual(await runtime.inspectLoginRuntimeCapabilities(new AbortController().signal), {
    platform: "darwin", architecture: "arm64", chromeVersion: "157.0.8103.51", processInspection: true, cliSourceMatched: true,
  });
});

test("missing Chrome executable does not suppress independent process or source evidence", async (t) => {
  const runtime = await fixture(t);
  t.mock.method(fs, "lstat", async () => { throw new Error("/private/untrusted-path"); });
  const child = t.mock.method(cp, "execFile", () => { throw new Error("unexpected_child"); });
  const result = await runtime.inspectLoginRuntimeCapabilities(new AbortController().signal);
  assert.equal(result.chromeVersion, null);
  assert.equal(result.processInspection, true);
  assert.equal(result.cliSourceMatched, true);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(child.mock.callCount(), 0, "missing Chrome must not launch any executable");
});

test("a different valid Chrome version remains observable for the caller's pin gate", async (t) => {
  const runtime = await fixture(t);
  t.mock.method(cp, "execFile", (_file: string, _args: string[], _options: ExecFileOptionsWithStringEncoding, callback: MetadataCallback) => {
    callback(null, "158.0.8103.50\n", "");
    return {} as ChildProcess;
  });
  assert.equal((await runtime.inspectLoginRuntimeCapabilities(new AbortController().signal)).chromeVersion, "158.0.8103.50");
});

test("Chrome errors and malformed metadata cannot leak child diagnostics", async (t) => {
  const runtime = await fixture(t);
  for (const [error, output, stderr] of [
    [new Error("sensitive-child-error"), "157.0.8103.51", ""],
    [null, "157.0.8103.51", "sensitive-stderr"],
    [null, "157.0.8103.51\nsensitive-output", ""],
    [null, "", ""],
  ] as const) {
    t.mock.method(cp, "execFile", (_file: string, _args: string[], _options: ExecFileOptionsWithStringEncoding, callback: MetadataCallback) => {
      callback(error, output, stderr);
      return {} as ChildProcess;
    });
    const result = await runtime.inspectLoginRuntimeCapabilities(new AbortController().signal);
    assert.equal(result.chromeVersion, null);
    assert.equal(JSON.stringify(result).includes("sensitive"), false);
    assert.equal(result.processInspection, true);
    assert.equal(result.cliSourceMatched, true);
  }
});

test("process inspection requires a strict schema and the exact current PID and UID", async (t) => {
  const runtime = await fixture(t);
  for (const result of [null, {}, { ...identity, pid: process.pid + 1 }, { ...identity, uid: identity.uid + 1 },
    { ...identity, started: "unknown" }, { ...identity, executableId: "bad" }, { ...identity, command: "private" }]) {
    t.mock.method(runtime.runtimeCapabilityDependencies, "inspectOwnedProcess", async () => result);
    const capabilities = await runtime.inspectLoginRuntimeCapabilities(new AbortController().signal);
    assert.equal(capabilities.processInspection, false);
    assert.equal(capabilities.chromeVersion, "157.0.8103.51");
    assert.equal(capabilities.cliSourceMatched, true);
  }
});

test("missing pinned Python or libproc returns unavailable without blocking other probes", async (t) => {
  const runtime = await fixture(t);
  t.mock.method(runtime.runtimeCapabilityDependencies, "inspectOwnedProcess", async () => { throw new Error("private-process-diagnostic"); });
  assert.deepEqual(await runtime.inspectLoginRuntimeCapabilities(new AbortController().signal), {
    platform: "darwin", architecture: "arm64", chromeVersion: "157.0.8103.51", processInspection: false, cliSourceMatched: true,
  });
});

test("source mismatch, source read failure and malformed source reports fail independently", async (t) => {
  const runtime = await fixture(t);
  for (const report of [assessOciCompatibility({ version: null, launcher: null, bootstrap: null, session: null, pythonBrowser: null }),
    { sourceCompatibility: "matched" }, { ...matchingSources, versionMatches: false }]) {
    t.mock.method(runtime.runtimeCapabilityDependencies, "inspectInstalledOciCompatibility", async () => report);
    const result = await runtime.inspectLoginRuntimeCapabilities(new AbortController().signal);
    assert.equal(result.cliSourceMatched, false);
    assert.equal(result.processInspection, true);
    assert.equal(result.chromeVersion, "157.0.8103.51");
  }
  t.mock.method(runtime.runtimeCapabilityDependencies, "inspectInstalledOciCompatibility", async () => { throw new Error("private-source-diagnostic"); });
  assert.equal((await runtime.inspectLoginRuntimeCapabilities(new AbortController().signal)).cliSourceMatched, false);
});

test("unsupported platform and architecture return facts without macOS probes", async (t) => {
  const runtime = await fixture(t);
  const chrome = t.mock.method(fs, "lstat", async () => { throw new Error("unexpected_lookup"); });
  const ownedProcess = t.mock.method(runtime.runtimeCapabilityDependencies, "inspectOwnedProcess", async () => null);
  const oci = t.mock.method(runtime.runtimeCapabilityDependencies, "inspectInstalledOciCompatibility", async () => null);
  for (const [platform, architecture] of [["linux", "arm64"], ["darwin", "x64"], ["win32", "x64"]]) {
    Object.defineProperty(process, "platform", { value: platform });
    Object.defineProperty(process, "arch", { value: architecture });
    assert.deepEqual(await runtime.inspectLoginRuntimeCapabilities(new AbortController().signal), {
      platform, architecture, chromeVersion: null, processInspection: false, cliSourceMatched: false,
    });
  }
  assert.equal(chrome.mock.callCount(), 0);
  assert.equal(ownedProcess.mock.callCount(), 0);
  assert.equal(oci.mock.callCount(), 0);
});

test("a pre-aborted call performs no probes and returns a fixed private error", async (t) => {
  const runtime = await fixture(t);
  const controller = new AbortController();
  controller.abort(new Error("private-abort-reason"));
  const chrome = t.mock.method(fs, "lstat", async () => { throw new Error("unexpected_lookup"); });
  const ownedProcess = t.mock.method(runtime.runtimeCapabilityDependencies, "inspectOwnedProcess", async () => null);
  const oci = t.mock.method(runtime.runtimeCapabilityDependencies, "inspectInstalledOciCompatibility", async () => null);
  await assert.rejects(runtime.inspectLoginRuntimeCapabilities(controller.signal), { message: "login_runtime_cancelled" });
  assert.equal(chrome.mock.callCount(), 0);
  assert.equal(ownedProcess.mock.callCount(), 0);
  assert.equal(oci.mock.callCount(), 0);
});

test("abort settles ignored external waits and late successful probes cannot escape cancellation", async (t) => {
  const runtime = await fixture(t);
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => { finish = resolve; });
  t.mock.method(runtime.runtimeCapabilityDependencies, "inspectOwnedProcess", () => pending);
  t.mock.method(runtime.runtimeCapabilityDependencies, "inspectInstalledOciCompatibility", () => pending);
  const controller = new AbortController();
  const result = runtime.inspectLoginRuntimeCapabilities(controller.signal);
  const rejected = assert.rejects(result, { message: "login_runtime_cancelled" });
  await setImmediate();
  controller.abort(new Error("private-abort-reason"));
  await rejected;
  finish(identity);
  await setImmediate();
});

test("abort reaches the fixed metadata child even if its callback ignores cancellation", async (t) => {
  const runtime = await fixture(t);
  let childSignal: AbortSignal | undefined;
  t.mock.method(cp, "execFile", (_file: string, _args: string[], options: ExecFileOptionsWithStringEncoding) => {
    childSignal = options?.signal;
    return {} as ChildProcess;
  });
  const controller = new AbortController();
  const result = runtime.inspectLoginRuntimeCapabilities(controller.signal);
  const rejected = assert.rejects(result, { message: "login_runtime_cancelled" });
  await setImmediate();
  assert.ok(childSignal);
  controller.abort();
  await rejected;
  assert.equal(childSignal.aborted, true);
});

test("one shared deadline bounds ignored probe waits below six seconds and preserves completed evidence", async (t) => {
  const runtime = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(runtime.runtimeCapabilityDependencies, "inspectOwnedProcess", () => new Promise(() => {}));
  t.mock.method(runtime.runtimeCapabilityDependencies, "inspectInstalledOciCompatibility", () => new Promise(() => {}));
  const controller = new AbortController();
  const result = runtime.inspectLoginRuntimeCapabilities(controller.signal);
  let completed = false;
  void result.then(() => { completed = true; }, () => {});
  await setImmediate();
  t.mock.timers.tick(5999);
  await setImmediate();
  try { assert.equal(completed, true, "preflight must settle before the six-second outer RPC budget"); }
  finally { controller.abort(); }
  assert.deepEqual(await result, {
    platform: "darwin", architecture: "arm64", chromeVersion: "157.0.8103.51", processInspection: false, cliSourceMatched: false,
  });
});

test("an executable lookup that completes after abort cannot start the metadata child", async (t) => {
  const runtime = await fixture(t);
  let finish!: (stats: Stats) => void;
  t.mock.method(fs, "lstat", () => new Promise<Stats>((resolve) => { finish = resolve; }));
  const child = t.mock.method(cp, "execFile", () => { throw new Error("unexpected_child"); });
  const controller = new AbortController();
  const result = runtime.inspectLoginRuntimeCapabilities(controller.signal);
  const rejected = assert.rejects(result, { message: "login_runtime_cancelled" });
  await setImmediate();
  controller.abort();
  await rejected;
  finish({ isFile: () => true, isSymbolicLink: () => false } as Stats);
  await setImmediate();
  assert.equal(child.mock.callCount(), 0, "cancelled lookup must not start a child later");
});
