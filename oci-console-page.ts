/** Fixed private main-world code for the pinned Console build. No caller code or selector is accepted. */
export const OCI_CONSOLE_PAGE_SOURCE = String.raw`async (input) => {
  const world = globalThis;
  let requireModule;
  if (!world.webpackChunkoci_console) throw new Error("Console bridge unavailable");
  world.webpackChunkoci_console.push([["bb_remote_login_" + input.marker], {}, (require) => { requireModule = require; }]);
  if (!requireModule) throw new Error("Console bridge unavailable");
  const Auth = requireModule(30045).g;
  const authenticator = Auth.getAuthenticator(), authenticatedFetch = Auth.getFetchApi();
  const SelfServiceMeApi = requireModule(80002).SelfServiceMeApi;
  let disposed = false, active;
  const digest = async (value) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const snapshot = async () => {
    if (Auth.getAuthenticator() !== authenticator || Auth.getFetchApi() !== authenticatedFetch || await authenticator.getOverrideTenant()) throw new Error("Console context changed");
    const token = await authenticator.getIdentityToken();
    if (!token || typeof token !== "object" || typeof token.domain_stripe_url !== "string") throw new Error("Console context unavailable");
    const domain = new URL(token.domain_stripe_url);
    if (domain.origin !== input.origin || domain.pathname !== "/" || domain.search || domain.hash) throw new Error("Console domain changed");
    // These untrusted hints fence a changing context; the protected Me response establishes identity.
    const selected = ["sub", "tenant", "domain_ocid", "domain_stripe_url", "nonce", "sso_sess_exp"].map((field) => token[field] ?? null);
    if (selected.some((value) => value !== null && (typeof value !== "string" || value.length > 4096))) throw new Error("Console context unavailable");
    return digest(JSON.stringify(selected));
  };
  const restore = (entry) => {
    if (!entry || !entry.wrapper) return;
    if (globalThis.fetch === entry.wrapper) globalThis.fetch = entry.original;
    else if (globalThis.fetch !== entry.original) throw new Error("Console fetch ownership changed");
  };
  const initial = await snapshot();
  return {
    async check(stamp) { if (disposed || active || stamp !== initial || await snapshot() !== initial) throw new Error("Console context changed"); },
    async read(requestId, url) {
      if (disposed || active) throw new Error("Console bridge unavailable");
      let settle;
      const entry = { controller: new AbortController(), done: new Promise((resolve) => { settle = resolve; }) };
      active = entry;
      try {
        if (await snapshot() !== initial || disposed) throw new Error("Console context changed");
        entry.controller.signal.throwIfAborted();
        entry.original = globalThis.fetch;
        let requests = 0, authorizationDigest;
        entry.wrapper = async (resource, options) => {
          const request = new Request(resource, options);
          if (request.headers.get("opc-request-id") === requestId) {
            entry.controller.signal.throwIfAborted();
            if (++requests !== 1 || request.method !== "GET" || request.url !== url) throw new Error("Console request changed");
            const authorization = request.headers.get("authorization");
            if (!authorization || authorization.length > 65536) throw new Error("Console authorization unavailable");
            authorizationDigest = await digest(authorization);
          }
          return entry.original.call(globalThis, resource, options);
        };
        globalThis.fetch = entry.wrapper;
        const client = new SelfServiceMeApi(authenticatedFetch, input.origin);
        await client.getMe({ contentType: "application/json", attributes: "id,ocid,tenancyOcid,domainOcid,active" }, {
          headers: { "opc-request-id": requestId }, cache: "no-store", redirect: "error", credentials: "omit", signal: entry.controller.signal,
        });
        entry.controller.signal.throwIfAborted();
        if (disposed || requests !== 1 || !authorizationDigest || await snapshot() !== initial || globalThis.fetch !== entry.wrapper) throw new Error("Console context changed");
        return { authorizationDigest, stamp: initial };
      } finally {
        try { restore(entry); }
        finally { if (active === entry) active = undefined; settle(); }
      }
    },
    async dispose() {
      disposed = true;
      const entry = active;
      let restored = true;
      if (entry) {
        entry.controller.abort();
        try { restore(entry); } catch { restored = false; }
        await entry.done;
        if (!restored) throw new Error("Console fetch ownership changed");
        restore(entry);
      }
      if (await snapshot() !== initial) throw new Error("Console context changed");
      return input.marker;
    },
  };
}`;

export type ConsolePageBridge = {
  check(stamp: string): Promise<void>;
  read(requestId: string, url: string): Promise<{ authorizationDigest: string; stamp: string }>;
  dispose(): Promise<string>;
};
