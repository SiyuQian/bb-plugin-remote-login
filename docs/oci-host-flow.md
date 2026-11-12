# Experimental gated OCI CLI host flow

The registered plugin now connects `oci_cli` requests, private phone controls, the owned authentication child, a restricted host browser, verification and the original native result. This is source and fixture integration, not a completed live phone or OCI login. The last explicitly loaded local diagnostic revision was `36b57ef`; current installed/source parity has not been verified. No real owner fingerprint/key, account authentication or cloud validation was used for this work.

## Supported target and gates

The current runtime is restricted to macOS arm64, Google Chrome `157.0.8103.50`, Puppeteer `25.16.0`, OCI CLI `3.88.0` with Python `3.14.6`, OCI Python SDK `2.180.0`, region `ap-sydney-1` and realm `oc1`. A browser update or incompatible reviewed source fails closed. Source fingerprints do not pin the complete dependency graph.

A native `remote_login_request({mode:"oci_cli",wait:true})` can queue only when the selected host's fixed source inventory reports `matched`. The inventory's `hostBrowser.enabled:false` and `phoneCallback.enabled:false` are static, unvalidated inventory facts; they are not runtime authorization switches. Actual startup separately requires:

1. An owner-provisioned control root and a live capability bound to the stored host/attempt/scope.
2. A private paired-control acceptance receipt, produced only after the host verifies its owned synthetic fixture and confirms that exact browser's closure. The receipt lasts 24 hours and matches the current control-root generation and exact `private-fixture/Chrome-157.0.8103.50/v1` pin. It is checked from safe private host storage; a public success flag, ordinary `/control/check` history or UI checkbox cannot create it. This proves the paired control path, not a physical iPhone or human identity.
3. An independently selected expected user OCID, tenancy OCID, region and realm. The controller sends these only through bearer-protected `/login/oci-target`, before startup, and clears the raw inputs immediately. The host keeps the target immutable for that scope. It never derives expected identity from the resulting config, token or browser display name.

The public interaction contains only `{attemptId}`. Native tools cannot select an account, host, URL, executable, profile, script or verifier.

## Browser and handback lifecycle

`/login/start` records `starting` and returns HTTP 202 `{pending:true}` while the worker launches its owned child and fresh browser profile. The controller calls start once, then polls protected `/login/oci-status` in its operation slot. Each request has an eight-second bound; startup can span multiple requests. No frame or input request is sent until fresh host/root/binding checks allow the coordinator to record `user_control`. Stop and manual renewal remain available during startup.

The child captures the pinned authorization URL privately. Its exact process owns IPv4 `127.0.0.1:8181`; no existing listener is adopted or killed. The browser uses a private debugging pipe, fresh owned profile, direct connections and an Oracle-only navigation policy, with localhost explicitly routed to IPv4. The phone receives bounded frames and sends bounded input over the private capability channel. External federated SSO providers are unsupported. This is not a general browser or a Console-login adapter.

Handback records `verifying` synchronously and pauses ordinary frame polling and input. HTTP 202 `{pending:true}` keeps the controller polling protected handback; it does not mark success. The worker then:

1. Waits for normal completion of the owned authentication child and confirms private browser closure.
2. Captures an owned artifact generation seal, runs guarded official `session validate`, and rechecks the seal and current control authority.
3. Runs an independent SDK request with the exact captured token/key bytes at the fixed Identity endpoint. It requires service acceptance before comparing that same snapshot's user/tenancy claims with the preselected identity. It rechecks authorization and the same generation seal across both verification stages.
4. Produces a worker-local verification receipt and opaque `accountRef`, retaining the owned CLI session lease. Before persisting `verified`, the gateway rechecks control, binding/root and the internal live resume proof, including expiry and artifact seal.

The official diagnostic alone, callback arrival, a process exit, a parsed claim or a public submission cannot verify the job. Only protected handback returning `{verified:true}` lets the UI submit `{attemptId}` to wake the original native call. That call independently rechecks the durable binding, root, deadline, matching receipt, live private lease and sealed artifacts before `prepareResume()` records `uncertain`. Its bounded result may include the opaque `accountRef`; it exports no credentials or raw account identifiers. The original injected thread can then call `remote_login_oci_read` with that attempt/reference to list accessible compartments or Sydney instances. Each operation rechecks current authority, the original receipt, artifact generation and final expiry. Compartment identifiers stay private behind stable opaque references; omitting a compartment reference selects the verified tenancy root. Each response contains at most 25 projected rows and an explicit truncation flag. Arbitrary commands, endpoints and cloud writes are unavailable.

## Renewal, cancellation and limits

Manual renewal replaces the proof in the same viewer slot without restarting the browser or child. It is available while starting, controlling or verifying. Grants remain bounded by their five-minute lifetime, original fifteen-minute ceiling and attempt deadline. Uncertain rotation terminates the matching controller; a late replacement proof is usable only for cleanup.

Protected stop records cancellation before closing owned resources and settles the original waiting card after confirmed closure. Before OCI startup, stop revokes the capability through `revokeControl`, so cancellation also succeeds when no target or browser lease exists. Leaving a view performs best-effort closure. Expiry, worker replacement, root/host changes and stale revisions cannot promote late startup or verification evidence. Unknown cleanup remains pending; a replacement worker does not infer that an absent lease was removed.

Frames, input, expected OCIDs, provider URLs, raw claims, keys/tokens and owned paths stay out of public interaction payloads, ordinary tool metadata, logs and durable attempt records. A non-secret verification receipt identifier may be recorded durably; `accountRef` remains an opaque live-worker reference. Same-UID processes, BB administrators and fully trusted plugin replacement remain outside this API isolation boundary.

The session consumer is limited to the two fixed read operations above. There is no arbitrary CLI/shell consumer or durable session reattachment. [Conservative resource journals](owned-resource-recovery.md) can remove exact recorded CLI files after the old owner/writers are absent and browser cleanup is already confirmed; live/unknown browser orphans and interrupted ownership gaps remain pending. Console has its own separately gated [browser/identity/read flow](console-protocol.md); a phone-local callback bridge and external federated SSO are unavailable. Real phone/control acceptance, actual OCI/cloud acceptance and production native-result delivery still need live verification. SDK 0.6.132 supplies no durable native-call reattachment or delivery acknowledgement; the plugin does not resend through `threads.send` or claim `delivered`.

## Fixed callback retry limitation

The guarded callback keeps port8181 and disables address/port reuse. After a real callback connection closes, the OS may keep that port unavailable in TIME_WAIT even when no active listener or owned PID remains. A new attempt then fails rather than adopting or terminating another process. On the measured Mac, the observed TCP MSL was15seconds (a normal TIME_WAIT interval is about30seconds); this is an observation, not a portable retry guarantee. Wait for natural release before a new owner-controlled attempt. The current public status is still the bounded generic child_failed/provider_failed failure; a more actionable callback diagnostic remains follow-up work. No runtime path changes ports, enables reuse, kills an unrelated listener or retries authentication automatically. Composed tests serialize fixture users and wait for an actual no-reuse bind-only probe before beginning authentication; this is test scheduling, not an authentication retry.
