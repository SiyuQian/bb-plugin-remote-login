import assert from "node:assert/strict";
import cp, { type ChildProcess } from "node:child_process";
import { lstat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type { TestContext } from "node:test";
import { startMobileBrowserFixture, type MobileBrowserOptions } from "./mobile-browser-fixture.ts";
import { mobileBackend } from "./mobile-flow-actions.ts";
import { context, eventually, fixtureKey, nativeValue, ownedConsoleFlow } from "./owned-console-flow-fixture.ts";

export { context, eventually, fixtureKey, nativeValue } from "./owned-console-flow-fixture.ts";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const resolver = "--host-resolver-rules=MAP localhost 127.0.0.1, MAP 127.0.0.1 127.0.0.1, MAP * ~NOTFOUND";

/** Test-only confinement for the frontend and the static synthetic browser. */
export function recoveryChromeGuard(t: TestContext) {
  const records: Array<{ child: ChildProcess; profile: string; kind: "frontend" | "host"; closed: boolean }> = [];
  const spawn = cp.spawn;
  t.mock.method(cp, "spawn", ((file: string, args: string[], options?: cp.SpawnOptions) => {
    if (file !== chrome) {
      assert.equal(/chrome|chromium/i.test(file), false, "Unreviewed browser executable.");
      return Reflect.apply(spawn, cp, [file, args, options]);
    }
    assert.ok(Array.isArray(args) && args.includes("--remote-debugging-pipe"), "Private browser pipe required.");
    assert.equal(args.some(arg => arg.startsWith("--remote-debugging-port") || arg.startsWith("--proxy-server")), false,
      "Unsupported browser transport.");
    assert.ok(options?.shell === undefined || options.shell === false, "Browser shell is unavailable.");
    const profiles = args.filter(arg => arg.startsWith("--user-data-dir="));
    assert.equal(profiles.length, 1, "One owned profile is required.");
    const profile = profiles[0]!.slice("--user-data-dir=".length);
    assert.ok(isAbsolute(profile), "Owned profile must be absolute.");
    const name = basename(profile), kind = name.startsWith("fixture-browser-") ? "host" : name === "profile" ? "frontend" : null;
    assert.ok(kind, "Only frontend and synthetic fixture profiles may launch.");
    const confined = [...args, "--disable-quic", "--no-proxy-server", resolver];
    const child = spawn(file, confined, { ...options, shell: false });
    const record: (typeof records)[number] = { child, profile, kind, closed: false }; records.push(record);
    child.once("close", () => { record.closed = true; });
    return child;
  }) as typeof cp.spawn);
  // Node runs these hooks in registration order. Register before fixture roots
  // so failure cleanup cannot remove a profile while its captured child lives.
  t.after(async () => {
    for (const record of records) {
      if (record.closed) continue;
      await new Promise<void>((resolve, reject) => {
        const finish = () => { clearTimeout(timer); record.child.off("close", finish); resolve(); };
        const timer = setTimeout(() => { record.child.off("close", finish); reject(new Error("Owned recovery browser closure unconfirmed.")); }, 1500);
        record.child.once("close", finish);
        if (record.child.exitCode === null && record.child.signalCode === null) record.child.kill("SIGKILL");
        if (record.closed) finish();
      });
    }
  });
  return {
    counts: () => ({ frontend: records.filter(r => r.kind === "frontend").length, host: records.filter(r => r.kind === "host").length,
      closed: records.filter(r => r.closed).length, total: records.length }),
    profilesRemoved: async (kind: "host" | "all") => (await Promise.all(records.filter(r => kind === "all" || r.kind === kind).map(async r => {
      try { await lstat(r.profile); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
    }))).every(Boolean),
    assertClosed: () => assert.ok(records.every(r => r.closed), "Normal cleanup must close all guarded children before fallback."),
  };
}

type Flow = Awaited<ReturnType<typeof ownedConsoleFlow>>;
type Waiting = Awaited<ReturnType<Flow["startNativeWait"]>>;
export type RecoveryController = {
  mobile: Awaited<ReturnType<typeof startMobileBrowserFixture>>;
  bridge: ReturnType<typeof mobileBackend>;
  replies: Array<{ action: string; status: number }>;
};

/** Registered common synthetic flow. No Console target, browser or verifier is used. */
export async function createRecoveryFixture(t: TestContext) {
  const guard = recoveryChromeGuard(t), flow = await ownedConsoleFlow(t), controllers: RecoveryController[] = [];
  const controller = async (waiting: Waiting, options: Pick<MobileBrowserOptions, "beforeSend"> = {}): Promise<RecoveryController> => {
    const bridge = mobileBackend(flow.harness.behavior), replies: RecoveryController["replies"] = [];
    const mobile = await startMobileBrowserFixture(t, { context, rpc: bridge.rpc, http: bridge.http,
      beforeSend(request, response) {
        replies.push({ action: new URL(request.url).pathname.split("/").at(-1)!, status: response.status });
        return options.beforeSend?.(request, response);
      },
    });
    const result = { mobile, bridge, replies }; controllers.push(result);
    await mobile.show("login-control", bridge.interaction(waiting));
    return result;
  };
  const cancelAttempt = async (attemptId: string) => {
    const service = flow.harness.behavior.runService("login-coordinator");
    try {
      const result = nativeValue(await flow.harness.behavior.callAgentTool("remote_login_cancel", { attemptId }, context));
      assert.equal(result.phase, "cancelled");
      await eventually(async () => flow.retained() === 0 && await guard.profilesRemoved("host"));
      await eventually(() => (flow.bb.storage.database().prepare("SELECT status FROM remote_login_cleanup_v1 WHERE attempt_id=?")
        .get(attemptId) as { status: string } | undefined)?.status === "acknowledged");
      return result;
    } finally { service.controller.abort(); await service.done; }
  };
  const assertPrivate = async (views: RecoveryController[], results: unknown[], values: string[] = []) => {
    const privateValues = [fixtureKey, flow.root, ...flow.capabilities, ...values].filter(Boolean);
    const publicState = JSON.stringify([flow.bb.storage.database().prepare("SELECT record FROM remote_login_attempts_v1").all(),
      await flow.bb.storage.kv.list(), flow.harness.inspection.pendingInteractions, flow.harness.logEntries, flow.harness.inspection.realtimeSignals]);
    const surfaces = [publicState, JSON.stringify(results)];
    for (const { mobile } of views) {
      assert.equal(mobile.page.isClosed(), false, "Inspect frontend storage before closing it.");
      surfaces.push(await mobile.page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])));
    }
    for (const value of privateValues) for (const surface of surfaces) {
      assert.equal(surface.includes(value), false, "Private recovery material must not reach public records, results or frontend storage.");
    }
  };
  const closeControllers = async () => { for (const { mobile } of controllers) await mobile.close(); };
  return { flow, guard, controller, cancelAttempt, assertPrivate, closeControllers };
}
