# Protected synthetic browser control

This stage tests a phone-to-host control path with a fixed synthetic page. It does not navigate to OCI or any service, import an existing profile, expose a debugging endpoint, or permit arbitrary HTML, JavaScript, selectors or URLs. Source and build checks are separate from deployment and actual iPhone validation.

## Private protocol

All requests are POST below `/api/v1/plugins/remote-login/http`, keep BB local/app authentication, and additionally require an independent control grant in the Authorization bearer header. The JSON body always contains explicit `hostId` and the exact control scope (`threadId`, `attemptId`, `browserContextId`, `generation`). Proof is never a URL parameter. There is no corresponding public server RPC or agent tool for frames or input.

| Route | Additional body | Successful response |
|---|---|---|
| `/fixture/start` | None | Fixed 800 × 600 viewport |
| `/fixture/frame` | None | Bounded PNG base64 and viewport, in this response only |
| `/fixture/input` | A validated literal `event` | `accepted:true` |
| `/fixture/close` | None | `closed:true` after confirmed cleanup |

Bodies are limited to 4096 bytes; private responses use no-store. Errors are fixed and do not echo browser errors, input, paths or proof. Input is limited to viewport coordinates, 256 characters, five special keys and a bounded vertical wheel event. Input is not automatically retried. The `accepted` response confirms that the synthetic input operation completed with authorization checks; it is not a login result.

These diagnostic routes now reject any scope belonging to a persisted login attempt. The job-scoped channel derives its host and scope server-side and has a fixed host verifier; see [synthetic takeover and handback](login-flow.md). Its verifier returns only whether non-whitespace synthetic text was committed by the fixed page's button, then requires confirmed closure before recording success. This predicate is not a provider verifier.

## Phone test controls

The pairing page exposes the fixture controls only after a protected control check succeeds. Tap coordinates are converted from the displayed image's CSS dimensions to the fixed viewport. Text requires an explicit send action, and read-only polling does not disable the local draft field or dismiss its keyboard. Frame polling skips busy and background periods; requests have an eight-second deadline and there is no unbounded click queue.

Images and drafts stay in component memory. A scope/proof change or unmount hides old state and cancels reads/input; late frames are discarded. Explicit stop keeps its own bounded cleanup request alive even if the panel is immediately left. Stop is terminal for that scope: use **撤销本次授权** and verify again to obtain a fresh attempt. Failed/aborted input is not replayed. A network failure can prevent close delivery; server expiry remains the fallback, and disconnect reconciliation is unfinished.

## Ownership and authorization

One lease owns one browser per host worker. The worker reserves the lease before launch and retains itself from the current start RPC until confirmed cleanup. A completed RPC context cannot be reused to acquire a later retention lease. Different scopes and generations cannot control an existing browser. Competing work is refused rather than accumulated in an unbounded operation queue.

Authorization and actual Page/Target/BrowserContext identity are checked before and after browser work. Closing, cancellation, expiry and worker lifecycle invalidation reject in-flight results before waiting for cleanup. A cancelled read holds its operation slot until the underlying call settles; it cannot expose a late frame. An uncertain input cancels the lease. The driver invalidates on unexpected navigation, target creation, popup, dialog, worker or frame changes.

Grant expiry is supplied by the host authority, never accepted from request metadata. Renewal marks a verified proof transition before consuming the old token, verifies the replacement and updates the actual expiry. A frame authorized by the consumed proof is discarded without destroying a successfully refreshed lease. Closed scopes remain closed for the entire worker lifetime, including separately issued or renewed proofs. The ledger holds at most 256 closed scopes; it never prunes or evicts them to admit another lease. At capacity new starts fail closed. A replacement worker is the reset boundary and also invalidates all existing control grants. Root replacement is checked on access; prompt idle cleanup on root replacement remains unverified.

The job viewer offers explicit private renewal in the same operation slot as its input and handback. Its stable transport replaces the in-memory proof without recreating the viewer or lease. Initial and renewed job proofs have a host-enforced ceiling at the durable attempt deadline. The standalone pairing fixture retains its existing proof-sensitive lifecycle and does not gain this job renewal interface.

Control release invalidates its owned browser lease and waits for cleanup before acknowledgment. Browser close alone does not revoke the paired control token. Worker disposal also awaits its own aborted lifecycle's leases. Another host's worker is not selected implicitly.

## Browser boundary and limits

The current fixture driver supports only the tested darwin/arm64 Chrome 157.0.8103.50 combination. Both the executable metadata and launched version are checked. A Chrome update is unsupported until the browser probe is rerun and the support gate is deliberately updated. The formal `puppeteer-core` dependency is pinned to 25.16.0.

Each browser uses a new private 0700 profile in the verified plugin-owned directory, its private debugging pipe, and default Chrome sandbox settings. Network rules, CSP and abort-all interception constrain this fixed fixture. These are not a complete OS network sandbox. They do not isolate a hostile same-UID process, global administrator or hostile trusted same-origin plugin.

Cleanup closes the owned browser and confirms process exit before deleting its unchanged owned profile. If launch fails before Puppeteer returns a process handle, or cleanup cannot be confirmed, the profile is preserved, the lease is poisoned and retention is kept. There is no automatic recovery for that uncertain state yet. Launch failures, hard crashes, SIGKILL, machine failure and stale-profile reconciliation remain reliability work; normal release and lifecycle tests do not prove those cases.

This stage does not prove actual iPhone transport, mobile app rendering, IdP or MFA compatibility, user-input privacy across a future agent-control mode, OCI authentication or task resumption. Real credentials remain disabled until the phone pairing and private control gates have live evidence.
