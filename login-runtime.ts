import { setTimeout as delay } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract } from "./host-contract.ts";
import type { LoginCoordinator } from "./login-coordinator.ts";

async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("Cleanup cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), cancelled]);
    signal.throwIfAborted();
    return result;
  } finally { signal.removeEventListener("abort", abort); }
}

/** Registration has no ownership side effects; services start only after plugin commit. */
export function registerLoginRuntime(bb: BbPluginApi, coordinator: LoginCoordinator): void {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  bb.background.service("login-coordinator", {
    async start(signal) {
      let cursor = "";
      try {
        signal.throwIfAborted();
        coordinator.activate();
        while (!signal.aborted) {
          coordinator.expireDue();
          let [job] = coordinator.pendingCleanup(cursor);
          if (!job) { cursor = ""; [job] = coordinator.pendingCleanup(); }
          if (job) {
            cursor = job.attemptId;
            let acknowledged = false;
            try {
              const cleanupSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
              const result = await bounded(() => host.call("stopAttempt", { scope: job.scope }, {
                hostId: job.hostId, signal: cleanupSignal,
              }), cleanupSignal);
              acknowledged = result.ok && !cleanupSignal.aborted;
            } catch { /* Keep the durable command for a later idempotent attempt. */ }
            if (signal.aborted) return;
            if (acknowledged) coordinator.acknowledgeCleanup(job.attemptId);
          }
          await delay(1000, undefined, { signal });
        }
      } catch {
        if (!signal.aborted) throw new Error("Login coordination unavailable.");
      }
    },
  });
}
