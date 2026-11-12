import type { BbPluginApi, PluginAgentToolContext } from "@get-bb/plugin-sdk";

export type LoginBinding = { projectId: string; threadId: string; environmentId: string; hostId: string };
export type LoginContextErrorCode = "aborted" | "invalid_context" | "thread_unavailable" | "environment_unavailable" | "binding_mismatch" | "host_unavailable";

export class LoginContextError extends Error {
  readonly code: LoginContextErrorCode;
  constructor(code: LoginContextErrorCode) {
    super("Login context unavailable.");
    this.name = "LoginContextError";
    this.code = code;
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

/** Re-resolve before each sensitive step; this snapshot grants no browser or resource access. */
export async function resolveLoginContext(bb: Pick<BbPluginApi, "sdk">, context: PluginAgentToolContext): Promise<LoginBinding> {
  const { projectId, threadId, signal } = context;
  const checkAbort = () => { if (signal.aborted) throw new LoginContextError("aborted"); };
  checkAbort();
  if (!validId(projectId) || !validId(threadId)) throw new LoginContextError("invalid_context");
  const read = async <T>(operation: () => Promise<T>, code: "thread_unavailable" | "environment_unavailable"): Promise<T> => {
    checkAbort();
    let value: T;
    try { value = await operation(); }
    catch { checkAbort(); throw new LoginContextError(code); }
    checkAbort();
    return value;
  };
  const thread = await read(() => bb.sdk.threads.get({ threadId, signal }), "thread_unavailable");
  if (!thread) throw new LoginContextError("thread_unavailable");
  if (thread.id !== threadId || thread.projectId !== projectId) throw new LoginContextError("binding_mismatch");
  if (thread.deletedAt !== null || thread.archivedAt !== null) throw new LoginContextError("thread_unavailable");
  const environmentId = thread.environmentId;
  if (!validId(environmentId)) throw new LoginContextError("environment_unavailable");
  const environment = await read(() => bb.sdk.environments.get({ environmentId, signal }), "environment_unavailable");
  if (!environment) throw new LoginContextError("environment_unavailable");
  if (environment.id !== environmentId || environment.projectId !== projectId) throw new LoginContextError("binding_mismatch");
  if (environment.status !== "ready" || environment.lifecycle?.phase !== "active") throw new LoginContextError("environment_unavailable");
  if (!validId(environment.hostId) || environment.hostLifecycle !== "active") throw new LoginContextError("host_unavailable");
  checkAbort();
  return { projectId, threadId, environmentId, hostId: environment.hostId };
}

export function matchesBinding(bound: LoginBinding, observed: LoginBinding): boolean {
  return bound.projectId === observed.projectId && bound.threadId === observed.threadId
    && bound.environmentId === observed.environmentId && bound.hostId === observed.hostId;
}
