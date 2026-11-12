# OCI child boundary and pinned bootstrap

The runtime contains an account-free synthetic fixture, a pre-key probe of the installed OCI bootstrap and an owned authentication implementation. The latter is now reached by the registered experimental OCI CLI host flow after independent control/target gates. A native request can queue without starting it. See [the host flow](oci-host-flow.md); source integration and a build do not establish live authentication or deployment. The current server remains loaded at `36b57ef`; this source has not been reloaded.

## Process and private channel

The parent requires its installed source pin, then spawns the fixed Python with `-I -S -c` and embedded plugin-owned source, no shell, a minimal environment and ignored standard streams. The wrapper suppresses descriptors 0–2 before dependency imports. Private descriptor 3 carries configuration, binding acknowledgement and cancellation; descriptor 4 carries strictly bounded attempt-scoped events. The parent enforces event order, version, UUID, exact child PID, address, port, at most three records, a total byte budget and fatal UTF-8 parsing. An ignored consumer cancellation cannot retain the child indefinitely.

A synthetic configuration permits only its fixed or ephemeral port selector and bounded lifetime. The pre-key probe has the same account-free configuration. The production entry instead accepts an authentic opaque owned-session lease and a trusted worker authorization callback. It rechecks that lease and callback before spawn, before acknowledging socket ownership, and before private browser delivery. Production uses only the reviewed Sydney region and fixed port 8181. A caller-supplied enable boolean, arbitrary executable, source, endpoint or callback port is not accepted. The registered BB host service also checks the private paired-control receipt and live attempt authority before and during this child's lifetime.

The wrapper replaces the already-defined `StoppableHttpServer` class; changing a base-class name after subclass construction would not work. It forces IPv4 `127.0.0.1` without address or port reuse. Before returning from the constructor it reports ownership privately and waits for the parent acknowledgement. The parent checks visible listeners through a fixed, bounded `lsof`, requiring the exact child PID and IPv4 endpoint; it repeats that check before browser delivery. Wildcard, IPv6, other-PID, absent or ambiguous records are refused. No existing listener is adopted or killed.

Browser hooks are replaced directly, with no `BROWSER` fallback. A capture error aborts rather than dispatching to the original browser. Fixture URLs are exact `.invalid` values. Production captures only the pinned Oracle Sydney authorization origin/path, exact query fields, localhost redirect, canonical nonce and strictly public 2048-bit RSA JWK. Both child and parent reject private-key fields, duplicate query selectors and other destinations. URL syntax alone proves neither ownership nor identity. URLs stay in the private consumer channel, outside process arguments, environment, result, ordinary streams and probe output.

Cancellation invalidates in-flight work and sends a private command. Escalation uses only the exact `ChildProcess` handle; process closure must be confirmed before retention release. Failed cleanup or retention release remains `cleanup_uncertain` and takes priority over an earlier error. The wrapper closes its own socket in `finally`. Its process deadline also interrupts an HTTP request that keeps trickling incomplete input.

## Actual module probe

The pre-key probe imports the installed OCI package under an audit policy, compiles checked critical source bytes and invokes actual `create_user_session`. The replaced real server constructor binds and receives acknowledgement, then exits before the authentication RSA key, authentication nonce, browser URL or session persistence can run. Unrelated SDK circuit-breaker UUIDs created during import are not authentication nonces.

Imports use fixed reviewed dependency roots without executing `.pth` or `sitecustomize`. The child fixes the supported developer-configuration selector to `/dev/null`, so it does not consult a default account directory. Audit policy forbids account-file access, subprocesses, network connections and unowned writes. Import-time IPv6 probing is disabled for this IPv4-only worker, and platform user-agent metadata is fixed rather than spawning `uname`. Reviewed CLI/SDK source hashes are checked before import; cached bytecode cannot substitute for those checked modules. This does not pin the complete dependency graph or native libraries.

Run the zero-argument probes:

```sh
node --import tsx scripts/probe-oci-child.ts
node --import tsx scripts/probe-real-oci-bootstrap.ts
```

The first is entirely synthetic. The second executes actual bootstrap initialization only through the owned server constructor, then reports `prekey_probe_complete`. Neither starts a login challenge or reports authentication success. Output is fixed non-secret facts only.

## Owned production layout and completion

`createOwnedOciSession` creates a fresh private root under an existing trusted canonical private directory, empty config and existing empty RC files, and a precreated private token/profile directory. Paths, expected identity and leases are worker-only and non-enumerable. Real production bootstrap configuration derives only these fixed paths and the generated profile. It imports the pinned module, calls its original session creation function, then persists through original `persist_user_session` with explicit config/profile/token location and session-auth options. `bootstrap_complete` means the owned process persisted its result; it is never a `verified` event.

An account-free test invokes the actual persistence function using disposable fixture RSA material and a non-redeemable token, replacing only session creation. Its artifacts are accepted by the Node owned-snapshot reader and have private modes. A separate signature-binding test checks production keyword arguments against the actual installed function signatures. Neither test runs authentication, opens a provider page or accepts an account.

`captureOwnedOciSnapshot` captures bounded no-follow file bytes, exact selectors, file generations and owned directory generations after writers stop. Getters return private copies; JSON contains no account data. A recheck rejects replacement, mutation or directory move-and-restore. A lease permits one active/in-flight capture; disposal clears captured buffers and revokes access without deleting retained session files. Explicit release deletes only recorded unchanged owned artifacts and refuses unknown files.

## Independent verification and remaining gates

`verifyOwnedOciSession` and its fixed Python source use one captured token/key snapshot, the real SDK signer and fixed reviewed service endpoint, TLS verification, no inherited config/proxies and no retries. The same accepted snapshot's identity is compared with independently selected expectations. After the child closes, the parent reauthorizes the attempt, rechecks artifact generations and disposes private capture buffers. Only bounded match facts return. See [the verifier contract](oci-cli-verification-contract.md).

Tests replace the external HTTP response only; they verify the actual signed request and forbid real DNS/connect calls. Thus they prove implementation behavior, not acceptance by OCI. The registered host job now runs guarded official `session validate` before the independent verifier, with one generation seal checked across both stages. A private live-lease proof rechecks that seal before gateway/native completion. Process completion, callback arrival, parsed claims and a matching input schema cannot substitute for real service acceptance.

The BB host job/coordinator and restricted provider browser are integrated in source. Exact owned-resource journals and two bounded `accountRef` reads are connected; uncertain-orphan recovery and actual phone/cloud acceptance remain incomplete. Console has a separately gated [browser flow](console-protocol.md); phone callback forwarding remains unavailable; the Oracle-only browser excludes external federated SSO. `lsof` visibility is limited by OS permissions; the real browser must route its fixed localhost callback to the intended IPv4 endpoint. These checks do not establish OS-wide or hostile same-user isolation. Actual authentication, cloud validation and production task-result delivery remain unverified. Console identity uses its own independent verifier; phone callback forwarding remains disabled. No real owner fingerprint/key or account authentication was used for this work.
