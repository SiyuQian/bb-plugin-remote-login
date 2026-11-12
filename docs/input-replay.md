# Displayed-frame input, replay and uncertain acknowledgement

One application `fetch()` is not proof of one HTTP request. In the actual local Chrome transport probe, dropping the first prepared POST response before headers produced two HTTP requests from one fetch, without application retry code. Before this fix, the joined Console test applied its fabricated text twice and remained in `user_control`.

The input boundary spends an operation identity before any browser effect. It refuses a repeated request instead of returning a cached success. This prevents a transparent retry from applying the same operation twice; it does not prove that the controller received an acknowledgement. The current contract also requires the reference belonging to the displayed frame. These two identities have separate purposes.

## Wire contract

- Every private fixture, CLI and Console input request requires outer `inputId` and `frameRef` fields, separate from the unchanged `FixtureInput` event and from control authority.
- The accepted encoding is a canonical lowercase UUIDv4: `xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx`, with hexadecimal digits only. Whitespace, uppercase, other versions and encoded alternatives are refused without normalization.
- The client validates its strict caller payload, including the displayed `frameRef`, generates `crypto.randomUUID()` exactly once for that input call, then serializes the complete body once before fetch. A transparent browser retry therefore carries the same identities and event. Caller-supplied `inputId` is refused; non-input calls do not generate an input identity.
- The browser owner issues `frameRef` as an opaque canonical UUIDv4 only after its screenshot and normal post-operation ownership checks succeed. The viewer supplies the reference from the image being acted on; the client cannot mint a replacement or look up a newer reference for an older event.
- The server and host contracts require and forward both identities unchanged. Missing or malformed fields return HTTP 400 before host dispatch. A reference is private correlation data, not a capability, account credential or verification producer. Current private authorization remains mandatory.

This intentionally rejects older input clients. App, server and host builds must support the same contract; the server never fills in a missing identity or displayed-frame reference. References stay on the private frame/input channel and are not durable/public status or log fields.

## Current displayed observation

Each owned browser keeps one in-memory observation. Starting a newer capture revokes the previous reference; a superseded or invalidated capture cannot issue a reference when it settles late. A matching input consumes its observation once. Known page/frame-tree changes, control-proof replacement, verification, closure and invalidation revoke the observation. Departing from the fixed 800×600/DPR1 host viewport is refused; this does not add a host resize API.

The guarantee covers issued observations and known changes. It does not make the screenshot and input an atomic transaction over arbitrary DOM updates, animation, layout shifts or navigation beginning after the last check. A UUID, frame sequence or short expiry cannot prove that pixels stayed unchanged. Existing page/context/target, capability, root, scope, generation, deadline and post-operation checks still apply.

## Owned-run guard

Each synthetic lease, CLI job and Console job owns a private spent-ID set, capped at 4096 claimed input identities. Existing authorization, live-run and operation-barrier checks remain mandatory. A required worker-private synchronous callback claims `inputId` after the driver's final asynchronous ownership preparation, immediately before comparing/consuming `frameRef` and dispatching input, with no intervening await. This callback is not a wire argument or a public success flag.

The spent-ID check precedes stale-frame classification. A transparent retry after a lost ACK must not become a harmless stale-frame refusal merely because its first execution consumed that frame. A newly claimed ID can remain spent even when its stale reference is refused before input.

The guard retains only opaque identities, not events, event hashes, credentials or responses. It never evicts an identity, rolls back a claim after a failed or uncertain driver call, or memoizes a successful acknowledgement. Duplicate identities are refused even when the repeated request changes its event. A full set refuses further input through the existing conservative run-stop path.

Renewal, trusted Console reauthentication and another start of the same live run retain its guard. Proof changes invalidate displayed observations instead of refreshing an old event's reference. Closed-scope tombstones prevent starting a replacement run in the same scope to obtain an empty set. Worker replacement invalidates the original run and grants; this is not durable authenticated-session recovery.

## Controller behavior and evidence

Only an exact, bounded, no-store HTTP409 response with the strict private `{"error":"stale_frame"}` body and a still-live request receives the recoverable classification. An arbitrary transport exception with the same name, an extra response field, abort or another error cannot impersonate it.

| Operation and client error | Meaning and controller behavior |
| --- | --- |
| Input: `StaleFrameError` | Trusted refusal before this input's browser effect. Clear the image, preserve the unsent text when applicable, obtain a fresh observation through the existing bounded read/poll or refresh button, and require another user action. Never resend the rejected event automatically. |
| Frame read: `FrameChangedError` | A known change prevented this read from publishing its captured image. Clear the image and refresh the read. If an input ACK preceded that read, the input was already acknowledged: do not restore it as unsent, claim zero effects, or replay it. The viewer uses a separate changed-read message. |
| Missing/uncertain ACK, duplicate ID or generic failure | Clear the frame, stop control and request owned cleanup. Input may already have executed and must not be directly resent. Cleanup remains unconfirmed until its protected acknowledgement. |

The same wire refusal is interpreted according to the operation that received it. Safe refresh performs reads only; it does not reauthenticate, restart, extend a deadline or retry input. Neither a refusal nor a read refresh authorizes handback or native completion. Console verification-only rejoin remains input-disabled.

The CLI's [callback document barrier](mobile-browser-acceptance.md) waits for the same owned callback before its first screenshot; its controlled green used one capture and one input effect. The separately retained exact-error path may retry a read once, never an input. The one-second marker wait, cancellation/supersession checks and explicitly pinned Puppeteer vendor option do not change input identities or the no-resend policy. Controlled recovery is separate from ordinary/global stability evidence.

| Evidence | What is asserted |
| --- | --- |
| [Wire](../tests/fixture-wire.test.ts), [contracts](../tests/host-contract.test.ts), [fixture client](../tests/fixture-client.test.ts), [login client](../tests/login-client.test.ts), [HTTP boundary](../tests/input-boundary.test.ts) | Strict UUID encoding, one client-generated identity per valid input, no caller override, required outer field, legacy 400 and authorization still required. |
| [Observation](../tests/frame-observation.test.ts), [provider driver](../tests/oci-provider-browser.test.ts), [synthetic driver](../tests/fixture-browser.test.ts), [Console driver](../tests/oci-console-browser.test.ts), [viewer](../tests/fixture-controls.test.tsx) | Current frame-binding cases target superseded/consumed/foreign references, known document or capture changes, fresh-frame usability, callback ordering and separate changed-read handling. The parent observed a joined source run of 13/13, with 0 skips, in 41.834 seconds (`frame-joined-tests.txt`, session 53690), including genuine 390px stale Console 409 followed by explicit fresh 200/200 with no rejected keyboard effect. Actual ACK loss still produced two HTTP requests with the same inputId/frameRef, one delegated effect and generic uncertainty. Global/compiled verdicts and revision are recorded separately in external `frame-evidence.json`; the historical counts below do not certify the changed frame contract. |
| [Guard](../tests/input-replay.test.ts), [synthetic lease](../tests/fixture-lease.test.ts), [CLI jobs](../tests/oci-host-job.test.ts), [Console jobs](../tests/oci-console-host-job.test.ts) | Repeat and changed-event refusal, no unauthorized claim, renewal/rejoin continuity, uncertain-effect claims retained, capacity without eviction and closed-scope refusal. The observed direct run passed 102 tests. |
| [390px Console](../tests/mobile-console-flow.test.ts), joined with [registered Console flow](../tests/console-flow-integration.test.ts) | Drop one successful input response after confirming one actual browser effect. Chrome sends two HTTP requests and two host RPCs with one identity; the browser effect occurs once. The retry is refused with 403 or 409, the UI shows uncertainty/no-resend, cleanup closes the browser and removes its profile, and the original native wait returns no verified result or resume claim. The observed joined run passed 6 tests; both frontend cases passed again in the current post-barrier 8-case source-frontend run. |

These are local browser and injected-service assertions. They do not establish physical-phone transport behavior, Oracle account acceptance, exactly-once delivery or native-result consumption. See [mobile acceptance](mobile-browser-acceptance.md) and the [fault matrix](fault-matrix.md).
