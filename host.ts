import fs from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import type { ExperimentalHostRpcContext } from "@get-bb/plugin-sdk/host";
import { hostContract, type RuntimeInspection } from "./host-contract.ts";
import { ControlAuthority, ControlAuthError, inspectControlRoot } from "./control-authority.ts";
import { StaleFrameError } from "./frame-error.ts";
import { openFixtureBrowser } from "./fixture-browser.ts";
import { FixtureLease, FixtureLeaseError } from "./fixture-lease.ts";
import { inspectInstalledOciCompatibility } from "./oci-compatibility.ts";
import { PairedControlGate, PairedControlGateError } from "./paired-control-gate.ts";
import { OciHostJobs, OciHostJobError } from "./oci-host-job.ts";
import { recoverOwnedOciSession } from "./oci-owned-session.ts";
import { ConsoleHostJobs, ConsoleHostJobError } from "./oci-console-host-job.ts";
import { OwnedResourceLedger } from "./owned-resource-ledger.ts";
import { inspectLoginRuntimeCapabilities } from "./login-runtime-capabilities.ts";
import { assessLoginCapabilities } from "./provider-registry.ts";

const authorities = new WeakMap<AbortSignal, ControlAuthority>();
const fixtures = new WeakMap<AbortSignal, FixtureLease>();
const fixtureWorkers = new Set<{ signal: AbortSignal; lease: FixtureLease }>();
const controlGates = new WeakMap<AbortSignal, PairedControlGate>();
const ociJobs = new WeakMap<AbortSignal, OciHostJobs>();
const ociWorkers = new Set<{ signal: AbortSignal; jobs: OciHostJobs }>();
const consoleJobs = new WeakMap<AbortSignal, ConsoleHostJobs>();
const consoleWorkers = new Set<{ signal: AbortSignal; jobs: ConsoleHostJobs }>();
function control(context: ExperimentalHostRpcContext) {
  let authority = authorities.get(context.lifecycle.signal);
  if (!authority) {
    authority = new ControlAuthority(context.experimental_paths.dataDir);
    authorities.set(context.lifecycle.signal, authority);
  }
  return authority;
}
function fixture(context: ExperimentalHostRpcContext) {
  let lease = fixtures.get(context.lifecycle.signal);
  if (!lease) {
    lease = new FixtureLease({
      authorize: (capability, scope) => control(context).authorize(capability, scope),
      open: (signal) => openFixtureBrowser(context.experimental_paths.dataDir, signal),
      lifecycle: context.lifecycle.signal,
    });
    fixtures.set(context.lifecycle.signal, lease);
    fixtureWorkers.add({ signal: context.lifecycle.signal, lease });
  }
  return lease;
}
function pairedGate(context: ExperimentalHostRpcContext) {
  let gate = controlGates.get(context.lifecycle.signal);
  if (!gate) { gate = new PairedControlGate(context.experimental_paths.dataDir, control(context)); controlGates.set(context.lifecycle.signal, gate); }
  return gate;
}
function oci(context: ExperimentalHostRpcContext) {
  let jobs = ociJobs.get(context.lifecycle.signal);
  if (!jobs) {
    jobs = new OciHostJobs({ dataDir: context.experimental_paths.dataDir, lifecycle: context.lifecycle.signal,
      authorize: (capability, scope) => control(context).authorize(capability, scope), requirePhoneGate: () => pairedGate(context).require(),
    });
    ociJobs.set(context.lifecycle.signal, jobs); ociWorkers.add({ signal: context.lifecycle.signal, jobs });
  }
  return jobs;
}
function consoleJob(context: ExperimentalHostRpcContext) {
  let jobs = consoleJobs.get(context.lifecycle.signal);
  if (!jobs) {
    jobs = new ConsoleHostJobs({ dataDir: context.experimental_paths.dataDir, lifecycle: context.lifecycle.signal,
      authorize: (capability, scope) => control(context).authorize(capability, scope), requirePhoneGate: () => pairedGate(context).require(),
    });
    consoleJobs.set(context.lifecycle.signal, jobs); consoleWorkers.add({ signal: context.lifecycle.signal, jobs });
  }
  return jobs;
}
async function checked<T>(context: ExperimentalHostRpcContext, operation: () => Promise<T>) {
  try {
    context.signal.throwIfAborted();
    const value = await operation();
    context.signal.throwIfAborted();
    return { ok: true as const, value };
  } catch (error) {
    const reason = error instanceof ControlAuthError || error instanceof FixtureLeaseError || error instanceof PairedControlGateError || error instanceof OciHostJobError || error instanceof ConsoleHostJobError || error instanceof StaleFrameError ? error.code : "control_unavailable";
    return { ok: false as const, reason: reason === "stale_frame" && context.signal.aborted ? "control_unavailable" : reason };
  }
}

type BrowserCandidate = readonly ["Google Chrome" | "Chromium", string];

const commonBrowserPaths: Partial<Record<NodeJS.Platform, readonly BrowserCandidate[]>> = {
  darwin: [
    ["Google Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    ["Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
  ],
  linux: [
    ["Google Chrome", "/usr/bin/google-chrome"],
    ["Google Chrome", "/opt/google/chrome/chrome"],
    ["Chromium", "/usr/bin/chromium"],
    ["Chromium", "/usr/bin/chromium-browser"],
    ["Chromium", "/snap/bin/chromium"],
  ],
  win32: [
    ["Google Chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe"],
    ["Google Chrome", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"],
    ["Chromium", "C:/Program Files/Chromium/Application/chrome.exe"],
  ],
};

function inspectBrowser(): RuntimeInspection["browser"] {
  const commands: readonly BrowserCandidate[] = process.platform === "win32"
    ? [["Google Chrome", "chrome.exe"], ["Chromium", "chromium.exe"]]
    : [["Google Chrome", "google-chrome"], ["Google Chrome", "google-chrome-stable"],
      ["Chromium", "chromium"], ["Chromium", "chromium-browser"]];
  const candidates: BrowserCandidate[] = [...(commonBrowserPaths[process.platform] ?? [])];
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(isAbsolute)) {
    for (const [name, command] of commands) candidates.push([name, join(directory, command)]);
  }
  for (const [name, executable] of candidates) {
    try {
      fs.accessSync(executable, fs.constants.X_OK);
      if (fs.statSync(executable).isFile()) return { available: true, name };
    } catch {
      // Missing or inaccessible executables are unavailable, not probe failures.
    }
  }
  return { available: false, name: null };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  dispose: async () => {
    await Promise.all([...fixtureWorkers].filter(({ signal }) => signal.aborted).map(async (entry) => {
      await entry.lease.dispose();
      fixtureWorkers.delete(entry);
    }));
    await Promise.all([...ociWorkers].filter(({ signal }) => signal.aborted).map(async (entry) => {
      await entry.jobs.dispose(); ociWorkers.delete(entry);
    }));
    await Promise.all([...consoleWorkers].filter(({ signal }) => signal.aborted).map(async (entry) => {
      await entry.jobs.dispose(); consoleWorkers.delete(entry);
    }));
  },
  handlers: {
    inspectLoginCapabilities: async (_input, context) => {
      const runtime = await inspectLoginRuntimeCapabilities(context.signal);
      context.signal.throwIfAborted();
      return assessLoginCapabilities(runtime);
    },
    inspectOciCompatibility: async (_input, context) => {
      context.signal.throwIfAborted();
      const report = await inspectInstalledOciCompatibility();
      context.signal.throwIfAborted();
      return report;
    },
    controlInfo: async (_input, context) => ({
      ...(await inspectControlRoot(context.experimental_paths.dataDir)),
      provisioningDirectory: context.experimental_paths.dataDir,
    }),
    authenticateControl: async ({ key, scope, deadline }, context) => {
      const result = await checked(context, async () => {
        const grant = await control(context).authenticate(key, scope, deadline, (grant) => {
          consoleJobs.get(context.lifecycle.signal)?.observeAuthenticatedGrant(scope, grant);
        });
        await fixtures.get(context.lifecycle.signal)?.refreshProof(grant.capability, scope);
        const jobs = ociJobs.get(context.lifecycle.signal);
        if (jobs?.hasScope(scope)) await jobs.refreshProof(grant.capability, scope);
        return grant;
      });
      return result.ok ? { ok: true as const, grant: result.value } : result;
    },
    authorizeControl: async ({ capability, scope }, context) => {
      const result = await checked(context, () => control(context).authorize(capability, scope));
      return result.ok ? { ok: true as const } : result;
    },
    renewControl: async ({ capability, scope, deadline }, context) => {
      const result = await checked(context, async () => {
        const issue = () => control(context).renew(capability, scope, deadline);
        const jobs = ociJobs.get(context.lifecycle.signal);
        if (jobs?.hasScope(scope)) return jobs.renewProof(capability, scope, context.signal, issue);
        const console = consoleJobs.get(context.lifecycle.signal);
        if (console?.hasScope(scope)) return console.renewProof(capability, scope, context.signal, issue);
        const lease = fixtures.get(context.lifecycle.signal);
        return lease ? lease.renewProof(capability, scope, context.signal, issue) : issue();
      });
      return result.ok ? { ok: true as const, grant: result.value } : result;
    },
    revokeControl: async ({ capability, scope }, context) => {
      const result = await checked(context, async () => {
        await control(context).revoke(capability, scope);
        await fixtures.get(context.lifecycle.signal)?.stopForScope(scope);
        const cli = ociJobs.get(context.lifecycle.signal), console = consoleJobs.get(context.lifecycle.signal);
        if (cli?.hasScope(scope)) await cli.stopForScope(scope);
        if (console?.hasScope(scope)) await console.stopForScope(scope);
      });
      return result.ok ? { ok: true as const } : result;
    },
    startFixture: async ({ capability, scope }, context) => {
      const result = await checked(context, () => fixture(context).start(capability, scope, context.signal, () => context.experimental_retainWorker()));
      return result.ok ? { ok: true as const, viewport: result.value } : result;
    },
    frameFixture: async ({ capability, scope }, context) => {
      const result = await checked(context, () => fixture(context).frame(capability, scope, context.signal));
      return result.ok ? { ok: true as const, frame: result.value } : result;
    },
    verifyFixture: async ({ capability, scope }, context) => {
      const result = await checked(context, () => fixture(context).verify(capability, scope, context.signal));
      return result.ok ? { ok: true as const, verified: result.value } : result;
    },
    completePhoneFixture: async ({ capability, scope }, context) => {
      const result = await checked(context, () => pairedGate(context).acceptClosedFixture(capability, scope, context.signal, async () => {
        if (!await fixture(context).verify(capability, scope, context.signal)) return false;
        await fixture(context).close(capability, scope, context.signal);
        return true;
      }));
      return result.ok ? { ok: true as const, verified: result.value } : result;
    },
    ociStatus: async ({ capability, scope }, context) => {
      const result = await checked(context, () => oci(context).status(capability, scope, context.signal));
      return result.ok ? { ok: true as const, status: result.value } : result;
    },
    configureOci: async ({ capability, scope, expected }, context) => {
      const result = await checked(context, () => oci(context).configure(capability, scope, expected, context.signal));
      return result.ok ? { ok: true as const } : result;
    },
    startOci: async ({ capability, scope }, context) => {
      const result = await checked(context, () => oci(context).start(capability, scope, context.signal, () => context.experimental_retainWorker()));
      return result.ok ? { ok: true as const, viewport: result.value } : result;
    },
    frameOci: async ({ capability, scope }, context) => {
      const result = await checked(context, () => oci(context).frame(capability, scope, context.signal));
      return result.ok ? { ok: true as const, frame: result.value } : result;
    },
    inputOci: async ({ capability, scope, event, inputId, frameRef }, context) => {
      const result = await checked(context, () => oci(context).input(capability, scope, event, context.signal, inputId, frameRef));
      return result.ok ? { ok: true as const } : result;
    },
    handbackOci: async ({ capability, scope }, context) => {
      const result = await checked(context, () => oci(context).handback(capability, scope, context.signal));
      return result.ok ? { ok: true as const, result: result.value } : result;
    },
    closeOci: async ({ capability, scope }, context) => {
      const result = await checked(context, () => oci(context).close(capability, scope, context.signal));
      return result.ok ? { ok: true as const } : result;
    },
    ociResumeProof: async ({ scope, receipt }, context) => {
      const result = await checked(context, () => oci(context).resumeProof(scope, receipt));
      return result.ok ? { ok: true as const, ...result.value } : result;
    },
    readOciTask: async ({ request, ...selection }, context) => {
      const result = await checked(context, () => oci(context).readTask(selection, request, context.signal));
      return result.ok ? { ok: true as const, ...result.value } : result;
    },
    consoleStatus: async ({ capability, scope }, context) => {
      const result = await checked(context, () => consoleJob(context).status(capability, scope, context.signal));
      return result.ok ? { ok: true as const, status: result.value } : result;
    },
    configureConsole: async ({ capability, scope, expected }, context) => {
      const result = await checked(context, () => consoleJob(context).configure(capability, scope, expected, context.signal));
      return result.ok ? { ok: true as const } : result;
    },
    startConsole: async ({ capability, scope }, context) => {
      const result = await checked(context, () => consoleJob(context).start(capability, scope, context.signal, () => context.experimental_retainWorker()));
      return result.ok ? { ok: true as const, viewport: result.value } : result;
    },
    frameConsole: async ({ capability, scope }, context) => {
      const result = await checked(context, () => consoleJob(context).frame(capability, scope, context.signal));
      return result.ok ? { ok: true as const, frame: result.value } : result;
    },
    inputConsole: async ({ capability, scope, event, inputId, frameRef }, context) => {
      const result = await checked(context, () => consoleJob(context).input(capability, scope, event, context.signal, inputId, frameRef));
      return result.ok ? { ok: true as const } : result;
    },
    handbackConsole: async ({ capability, scope }, context) => {
      const result = await checked(context, () => consoleJob(context).handback(capability, scope, context.signal));
      return result.ok ? { ok: true as const, result: result.value } : result;
    },
    closeConsole: async ({ capability, scope }, context) => {
      const result = await checked(context, () => consoleJob(context).close(capability, scope, context.signal));
      return result.ok ? { ok: true as const } : result;
    },
    consoleResumeProof: async ({ scope, receipt }, context) => {
      const result = await checked(context, () => consoleJob(context).resumeProof(scope, receipt));
      return result.ok ? { ok: true as const, ...result.value } : result;
    },
    readConsoleTask: async ({ request, ...selection }, context) => {
      const result = await checked(context, () => consoleJob(context).readTask(selection, request, context.signal));
      return result.ok ? { ok: true as const, ...result.value } : result;
    },
    inputFixture: async ({ capability, scope, event, inputId, frameRef }, context) => {
      const result = await checked(context, () => fixture(context).input(capability, scope, event, context.signal, inputId, frameRef));
      return result.ok ? { ok: true as const } : result;
    },
    closeFixture: async ({ capability, scope }, context) => {
      const result = await checked(context, () => fixture(context).close(capability, scope, context.signal));
      return result.ok ? { ok: true as const } : result;
    },
    stopAttempt: async ({ scope }, context) => {
      const result = await checked(context, async () => {
        const fixtureStopped = await fixtures.get(context.lifecycle.signal)?.stopForScope(scope);
        const jobs = ociJobs.get(context.lifecycle.signal);
        const ociStopped = jobs?.hasScope(scope) && await jobs.stopForScope(scope);
        const console = consoleJobs.get(context.lifecycle.signal);
        const consoleStopped = console?.hasScope(scope) && await console.stopForScope(scope);
        // Each known owner has awaited its actual owned cleanup; do not initialize
        // an unrelated OCI journal for a synthetic-only scope.
        if (fixtureStopped || ociStopped || consoleStopped) return true;
        const ledger = new OwnedResourceLedger(context.experimental_paths.dataDir);
        const cliRecovery = await recoverOwnedOciSession(context.experimental_paths.dataDir, scope);
        const consoleRecovery = await ledger.recover(scope, "browser_profile");
        if (cliRecovery === "uncertain" || consoleRecovery === "uncertain") return false;
        return Boolean(fixtureStopped || cliRecovery === "recovered" || consoleRecovery === "recovered");
      });
      return result.ok ? (result.value ? { ok: true as const } : { ok: false as const, reason: "cleanup_uncertain" }) : result;
    },
    inspectRuntime: (_input, context) => {
      context.signal.throwIfAborted();
      return {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
        browser: inspectBrowser(),
      };
    },
  },
});
