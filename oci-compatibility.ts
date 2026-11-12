import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import type { OciCompatibilityReport } from "./oci-compatibility-wire.ts";

export type { OciCompatibilityReport } from "./oci-compatibility-wire.ts";

const expected = {
  launcher: "6196509b5e1e1cbbd8421fc72f49be22b2f46f4ad9b4e28bc49dbf9bd1dfa366",
  bootstrap: "2e9002445a6380fcc308f802b9a68ab42bd6e0aafcc557750dbf9efb4d507f83",
  session: "4cba34c8fb2ba49b8b648c89131a559acfe2912b0662d2b28da2344a6d962de0",
  pythonBrowser: "893c86950a76b187b6a84e65bde03572e4179733f667b32880f866ce9a1a92f3",
} as const;

export type OciCompatibilityEvidence = {
  version: string | null;
  launcher: string | null;
  bootstrap: string | null;
  session: string | null;
  pythonBrowser: string | null;
};

/** Source recognition is preparation, never permission to start a login. */
export function assessOciCompatibility(evidence: OciCompatibilityEvidence): OciCompatibilityReport {
  const fingerprints = {
    launcher: evidence.launcher === expected.launcher,
    bootstrap: evidence.bootstrap === expected.bootstrap,
    session: evidence.session === expected.session,
    pythonBrowser: evidence.pythonBrowser === expected.pythonBrowser,
  };
  const versionMatches = evidence.version === "3.88.0";
  const matched = versionMatches && Object.values(fingerprints).every(Boolean);
  return {
    pin: "oci-3.88.0/cpython-3.14.6" as const,
    sourceCompatibility: matched ? "matched" as const : "unrecognized" as const,
    versionMatches,
    fingerprints,
    protocol: matched ? {
      browserHook: "python_webbrowser_open_new" as const,
      browserHelperFallback: true as const,
      callbackBind: "0.0.0.0:8181" as const,
      callbackRedirect: "http://localhost:8181" as const,
      callbackAttemptBinding: false as const,
      callbackTimeout: false as const,
      authorizationUrlPrinted: true as const,
      callbackFragmentLoggedInBrowser: true as const,
    } : null,
    hostBrowser: {
      enabled: false as const,
      reason: "runtime_ownership_and_identity_unverified" as const,
    },
    phoneCallback: {
      enabled: false as const,
      reason: "no_supported_redirect_override_or_bound_callback_bridge" as const,
    },
  };
}

const installation = "/opt/homebrew/Cellar/oci-cli/3.88.0";
const packages = `${installation}/libexec/lib/python3.14/site-packages`;
const sourcePaths = {
  launcher: `${installation}/libexec/bin/oci`,
  bootstrap: `${packages}/oci_cli/cli_setup_bootstrap.py`,
  session: `${packages}/oci_cli/cli_session.py`,
  pythonBrowser: "/opt/homebrew/opt/python@3.14/Frameworks/Python.framework/Versions/3.14/lib/python3.14/webbrowser.py",
} as const;

async function readPublicSource(path: string): Promise<Buffer | null> {
  try {
    const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 300_000) return null;
      const bytes = Buffer.alloc(300_001);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, null);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      return length <= 300_000 ? bytes.subarray(0, length) : null;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

/** Fixed public install files only: no process, account config, socket or path argument. */
export async function inspectInstalledOciCompatibility(): Promise<OciCompatibilityReport> {
  const evidence: OciCompatibilityEvidence = {
    version: null, launcher: null, bootstrap: null, session: null, pythonBrowser: null,
  };
  if (process.platform !== "darwin" || process.arch !== "arm64") return assessOciCompatibility(evidence);
  try {
    if (await fs.realpath("/opt/homebrew/bin/oci") !== sourcePaths.launcher) return assessOciCompatibility(evidence);
  } catch {
    return assessOciCompatibility(evidence);
  }
  const metadata = await readPublicSource(`${packages}/oci_cli-3.88.0.dist-info/METADATA`);
  if (metadata && /^Name: oci-cli\r?$/m.test(metadata.toString("utf8"))
    && /^Version: 3\.88\.0\r?$/m.test(metadata.toString("utf8"))) evidence.version = "3.88.0";
  for (const name of Object.keys(sourcePaths) as (keyof typeof sourcePaths)[]) {
    const bytes = await readPublicSource(sourcePaths[name]);
    evidence[name] = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
  }
  return assessOciCompatibility(evidence);
}
