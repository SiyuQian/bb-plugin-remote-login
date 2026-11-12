import assert from "node:assert/strict";
import cp, { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rename, rm, writeFile, mkdir, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { acquireCliFixtureLease } from "./cli-flow-lease.ts";

const runFile = promisify(execFile);

async function leaseOwner(t: TestContext, directory: string) {
  const source = `import { acquireCliFixtureLease } from ${JSON.stringify(new URL("./cli-flow-lease.ts", import.meta.url).href)};
const release = await acquireCliFixtureLease(${JSON.stringify(directory)});
process.stdout.write("ready\\n");
for await (const command of process.stdin) { if (command.toString().trim() === "release") await release(); break; }`;
  const child = cp.spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject); child.once("close", code => code === 0 ? resolve() : reject(new Error("owned lease process failed")));
  });
  void exited.catch(() => {});
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited.catch(() => {}); });
  let output = "";
  await Promise.race([new Promise<void>(resolve => child.stdout.on("data", chunk => { output += chunk.toString(); if (output === "ready\n") resolve(); })), exited.then(() => { throw new Error("owned lease process exited before readiness"); })]);
  return { child, finish: async (release: boolean) => { child.stdin.end(release ? "release\n" : "leave\n"); await exited; } };
}

// Delay only the native observation of this exact owned process. The original
// inspector still runs after the child has really released/exited.
function beforeOwnerInspection(t: TestContext, pid: number, action: () => Promise<void>) {
  const original = cp.execFile; let observations = 0;
  t.mock.method(cp, "execFile", ((...args: unknown[]) => {
    const argv = args[1];
    if (typeof args[0] === "string" && args[0].endsWith("/libexec/bin/python") && Array.isArray(argv)
      && argv.at(-1) === String(pid) && observations++ === 0) {
      void action().then(() => Reflect.apply(original, cp, args), error => {
        (args[3] as (error: Error, stdout: string, stderr: string) => void)(error, "", "");
      });
      return undefined;
    }
    return Reflect.apply(original, cp, args);
  }) as typeof cp.execFile);
  return () => observations;
}

test("a legitimate owner release and exit during identity inspection permits a fresh lease", { skip: process.platform !== "darwin", timeout: 10000 }, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "cli-lease-release-race-")), directory = join(root, "lease");
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = await leaseOwner(t, directory), previous = await readFile(join(directory, "owner.json"), "utf8");
  const observations = beforeOwnerInspection(t, owner.child.pid!, async () => {
    await owner.finish(true); await assert.rejects(lstat(directory), { code: "ENOENT" });
  });
  const release = await acquireCliFixtureLease(directory);
  try {
    assert.equal(observations(), 1);
    const current = await readFile(join(directory, "owner.json"), "utf8");
    assert.notEqual(current, previous); assert.equal(JSON.parse(current).owner.pid, process.pid);
  } finally { await release(); }
  await assert.rejects(lstat(directory), { code: "ENOENT" });
});

test("dead, mismatched or replaced unknown lease owners remain untouched", { skip: process.platform !== "darwin", timeout: 15000 }, async t => {
  for (const condition of ["dead", "mismatched", "replaced dead", "replaced malformed"] as const) {
    await t.test(condition, async t => {
      const root = await mkdtemp(join(await realpath(tmpdir()), "cli-lease-refusal-")), directory = join(root, "lease");
      t.after(() => rm(root, { recursive: true, force: true }));
      const owner = await leaseOwner(t, directory), path = join(directory, "owner.json");
      const receipt = await readFile(path, "utf8");
      let expected = receipt, preserved: Awaited<ReturnType<typeof lstat>> | undefined;
      if (condition === "dead") await owner.finish(false);
      if (condition === "mismatched") {
        const value = JSON.parse(receipt); value.owner.started = "0:0";
        expected = JSON.stringify(value); await writeFile(path, expected);
      }
      if (condition.startsWith("replaced")) beforeOwnerInspection(t, owner.child.pid!, async () => {
        await owner.finish(false); await rename(directory, join(root, "original-lease"));
        await mkdir(directory, { mode: 0o700 });
        expected = condition === "replaced malformed" ? "unrecognized owner" : receipt;
        await writeFile(path, expected, { mode: 0o600 }); preserved = await lstat(path);
      });
      else preserved = await lstat(path);
      try {
        const started = performance.now();
        await assert.rejects(acquireCliFixtureLease(directory), /manual inspection/);
        assert.ok(performance.now() - started < 3000, "unknown owners must be refused without using the 40-second wait");
        assert.equal((await lstat(path)).ino, preserved!.ino);
        assert.equal(await readFile(path, "utf8"), expected);
        if (condition.startsWith("replaced")) assert.equal(await readFile(join(root, "original-lease", "owner.json"), "utf8"), receipt);
      } finally { if (owner.child.exitCode === null && owner.child.signalCode === null) await owner.finish(false); }
    });
  }
});

test("CLI test lease preserves a replaced owner file even when its copied receipt matches", async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "cli-lease-ownership-")), directory = join(root, "lease");
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = await acquireCliFixtureLease(directory);
  const owner = join(directory, "owner.json"), receipt = await readFile(owner, "utf8");
  await rename(owner, join(root, "original-owner.json"));
  await writeFile(owner, receipt, { mode: 0o600 });
  const replacement = await lstat(owner, { bigint: true });
  await assert.rejects(release(), /manual inspection/);
  assert.equal((await lstat(owner, { bigint: true })).ino, replacement.ino);
  assert.equal(await readFile(owner, "utf8"), receipt);
});

test("CLI test lease preserves a replacement directory with the same receipt", async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "cli-lease-ownership-")), directory = join(root, "lease");
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = await acquireCliFixtureLease(directory);
  const receipt = await readFile(join(directory, "owner.json"), "utf8");
  await rename(directory, join(root, "original-directory"));
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "owner.json"), receipt, { mode: 0o600 });
  const replacement = await lstat(directory, { bigint: true });
  await assert.rejects(release(), /manual inspection/);
  assert.equal((await lstat(directory, { bigint: true })).ino, replacement.ino);
  assert.equal(await readFile(join(directory, "owner.json"), "utf8"), receipt);
});

test("CLI test lease releases only its original directory and owner file", async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "cli-lease-ownership-")), directory = join(root, "lease");
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = await acquireCliFixtureLease(directory);
  await release();
  await assert.rejects(lstat(directory), { code: "ENOENT" });
  await release();
});

test("an unknown FIFO owner receipt is refused without blocking the lease wait", async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "cli-lease-ownership-")), directory = join(root, "lease");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(directory, { mode: 0o700 });
  await runFile("/usr/bin/mkfifo", ["-m", "600", join(directory, "owner.json")]);
  const source = `import { acquireCliFixtureLease } from ${JSON.stringify(new URL("./cli-flow-lease.ts", import.meta.url).href)};
try { await acquireCliFixtureLease(${JSON.stringify(directory)}); throw new Error("unknown FIFO accepted"); }
catch (error) { if (!/manual inspection/.test(String(error))) throw error; process.stdout.write("refused"); }`;
  // A regression can block open() in libuv. Bound this owned probe process so
  // the regression fails without leaving a blocked test-runner worker behind.
  const result = await runFile(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    timeout: 1500, killSignal: "SIGKILL", maxBuffer: 1024,
  });
  assert.equal(result.stdout, "refused");
  assert.equal((await lstat(join(directory, "owner.json"))).isFIFO(), true);
});
