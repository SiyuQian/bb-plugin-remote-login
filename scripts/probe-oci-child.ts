import { randomUUID } from "node:crypto";
import { startOciFixtureChild } from "../oci-child-job.ts";

// An account-free private-channel fixture; never invokes the installed OCI command.
if (process.argv.length !== 2) {
  process.stderr.write("oci_child_fixture_accepts_no_arguments\n");
  process.exitCode = 1;
} else {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  let retained = false, consumed = false;
  try {
    const job = await startOciFixtureChild({ attemptId: randomUUID(), callbackPort: "ephemeral", lifetimeMs: 5000,
      signal: controller.signal, lifecycle: controller.signal,
      retainWorker: () => { retained = true; return () => { retained = false; }; },
      consumeBrowser: async (_privateUrl, signal) => { signal.throwIfAborted(); consumed = true; },
    });
    try {
      await job.completeFixture();
      const result = await job.result;
      process.stdout.write(`${JSON.stringify({ kind: "oci_child_fixture", ...result, privateCapture: consumed,
        retentionReleased: !retained, accountAuthenticationAttempted: false })}\n`);
    } finally { await job.cancel(); }
  } catch {
    process.stderr.write("oci_child_fixture_unavailable\n");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
  }
}
