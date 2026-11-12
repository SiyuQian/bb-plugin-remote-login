import cp from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { inspectInstalledOciCompatibility } from "./oci-compatibility.ts";
import { ociCompatibilityReportSchema } from "./oci-compatibility-wire.ts";
import { inspectOwnedProcess, ownedProcessIdentitySchema } from "./owned-process-identity.ts";

export type LoginRuntimeCapabilities = {
  platform: string;
  architecture: string;
  chromeVersion: string | null;
  processInspection: boolean;
  cliSourceMatched: boolean;
};

/** @internal Test boundary; production callers use the signal-only inspector below. */
export const runtimeCapabilityDependencies: {
  inspectOwnedProcess(pid: number): Promise<unknown>;
  inspectInstalledOciCompatibility(): Promise<unknown>;
} = { inspectOwnedProcess, inspectInstalledOciCompatibility };

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function inspectChromeVersion(signal: AbortSignal): Promise<string | null> {
  signal.throwIfAborted();
  const metadata = await fs.lstat(chromePath);
  signal.throwIfAborted();
  if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
  await fs.access(chromePath, constants.X_OK);
  signal.throwIfAborted();
  return new Promise((resolve) => {
    cp.execFile("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", "/Applications/Google Chrome.app/Contents/Info.plist"], {
      timeout: 2000, maxBuffer: 128, encoding: "utf8", killSignal: "SIGKILL", signal,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    }, (error, stdout, stderr) => {
      const version = stdout.trim();
      resolve(!signal.aborted && !error && !stderr && /^[0-9]{1,6}(?:\.[0-9]{1,6}){3}$/.test(version) ? version : null);
    });
  });
}

async function observe<T>(probe: () => Promise<T>, fallback: T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return fallback;
  let abort!: () => void;
  const cancelled = new Promise<T>((resolve) => {
    abort = () => resolve(fallback);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => {
      signal.throwIfAborted();
      return probe();
    }), cancelled]);
    return signal.aborted ? fallback : result;
  } catch {
    return fallback;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Read-only fixed-install probes; never starts a browser or reads account state. */
export async function inspectLoginRuntimeCapabilities(signal: AbortSignal): Promise<LoginRuntimeCapabilities> {
  if (signal.aborted) throw new Error("login_runtime_cancelled");
  const facts: LoginRuntimeCapabilities = {
    platform: process.platform, architecture: process.arch, chromeVersion: null, processInspection: false, cliSourceMatched: false,
  };
  if (facts.platform !== "darwin" || facts.architecture !== "arm64") return facts;
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), 5000);
  const boundedSignal = AbortSignal.any([signal, deadline.signal]);
  try {
    const [chromeVersion, processInspection, cliSourceMatched] = await Promise.all([
      observe(() => inspectChromeVersion(boundedSignal), null, boundedSignal),
      observe(async () => {
        const inspected = ownedProcessIdentitySchema.safeParse(await runtimeCapabilityDependencies.inspectOwnedProcess(process.pid));
        return inspected.success && inspected.data.pid === process.pid && inspected.data.uid === process.getuid?.();
      }, false, boundedSignal),
      observe(async () => {
        const report = ociCompatibilityReportSchema.safeParse(await runtimeCapabilityDependencies.inspectInstalledOciCompatibility());
        return report.success && report.data.sourceCompatibility === "matched";
      }, false, boundedSignal),
    ]);
    if (signal.aborted) throw new Error("login_runtime_cancelled");
    return { ...facts, chromeVersion, processInspection, cliSourceMatched };
  } finally {
    clearTimeout(timeout);
  }
}
