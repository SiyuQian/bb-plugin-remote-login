import { randomUUID } from "node:crypto";
import { probeOciBootstrapBeforeKey } from "../oci-child-job.ts";

// Imports the pinned real bootstrap, then aborts inside its socket constructor before key generation.
if (process.argv.length !== 2) {
  process.stderr.write("oci_prekey_probe_accepts_no_arguments\n");
  process.exitCode = 1;
} else {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  let retained = false;
  try {
    const result = await probeOciBootstrapBeforeKey({ attemptId: randomUUID(), callbackPort: "ephemeral", lifetimeMs: 5000,
      signal: controller.signal, lifecycle: controller.signal,
      retainWorker: () => { retained = true; return () => { retained = false; }; },
    });
    process.stdout.write(`${JSON.stringify({ kind: "oci_bootstrap_prekey_probe", ...result,
      retentionReleased: !retained, realBootstrapModule: true, stoppedBeforeKeyGeneration: true })}\n`);
  } catch {
    process.stderr.write("oci_prekey_probe_unavailable\n");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
  }
}
