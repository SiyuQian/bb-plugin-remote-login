# Official device flow: internal and unconfigured

`official-device-flow.ts` contains a host-only device-grant executor. The current host, server and app entrypoints do not import it; it is not included in their runtime bundles. No official client application, identity domain, scopes or provider is configured in production. There is no public start handler, setting, endpoint override or token export for this module. Its account-free fixtures do not establish actual authentication or phone acceptance.

An Identity Domains OAuth token is not an OCI CLI security-token session or a Console browser session. `consumed` means only that a private host callback returned; it does not establish account identity, OCI resource permission, browser authentication, verified login, durable credential storage or native-tool completion. Neither existing OCI mode calls this executor or substitutes its tokens for its own verifier.

## Reviewed host contract

A future caller needs a separately reviewed public-client application with Device Code enabled and client authentication `none`. The caller must supply a fixed identity-domain HTTPS origin, client ID and finite reviewed scope list through private host code. The current module accepts commercial `*.identity.oraclecloud.com` origins only and derives the exact `/oauth2/v1/device` and `/oauth2/v1/token` paths. It accepts no secret, discovery document, arbitrary endpoint, query, port, alternate realm or public configuration input.

The caller must bind `assertOwned(signal)` to a current private host lease. It runs before and after HTTP requests, presentation and token consumption; ownership loss fails closed. It does not itself prove a physical human, an independently selected account or the expected user's identity. Callbacks must honor cancellation and keep their own effects fenced: JavaScript cannot undo effects performed by a trusted callback before it returns.

Only the exact issuer `/ui/v1/device` URL and the separate user code reach `present`. `verification_uri_complete` is discarded. Device codes, token responses and refresh/ID tokens remain on the host. `consumeToken` borrows an access-token byte buffer for immediate private host use; it must not copy, persist, log, return, or send that buffer to a browser, native tool or model. The executor erases that buffer and HTTP buffers, clears parsed fields and drops references on every outcome. Immutable JavaScript strings and copies made by trusted code cannot be reliably zeroed.

## Protocol and limits

Requests use direct native HTTPS, normal certificate/hostname verification, TLS 1.2 or newer and no proxy agent or redirects. DNS answers must all be public addresses; local, mapped, mixed and unsupported address ranges fail closed. Requests are capped at 8 KiB, response bodies at 16 KiB and headers at 8 KiB. Only bounded, flat UTF-8 JSON with unique keys and known fields is accepted.

The first poll waits for the interval; an absent interval means five seconds. Pending responses retain it, each slow-down adds five seconds and connection timeouts double it. Other errors stop polling. There is one sequential attempt, with no automatic restart. Monotonic expiry includes request time, limits device lifetime to 15 minutes and caps each HTTP request at 10 seconds. Consumption also respects token expiry, conservatively measured from the token request's start. Cancellation and deadlines settle the caller even when a dependency ignores its signal; late response buffers are erased. An early-resolving wait cannot trigger an immediate poll.

Additional accepted bounds are 1–300 seconds for an initial interval, 4–32 ASCII letters/digits/hyphens for the human code and one day for token lifetime. Unsupported shapes fail closed; these limits are not claims about every Identity Domains deployment.

## Primary sources and verification

Oracle's [Identity Domains Device Code Grant Type](https://docs.oracle.com/en-us/iaas/Content/Identity/api-getstarted/DCGT.htm) documents app registration, the two fixed endpoints and public-client forms. Its example includes insecure `curl -k` and an HTTP verification URL; this implementation requires HTTPS with certificate verification instead. [RFC 8628, sections 3.2–3.5](https://www.rfc-editor.org/rfc/rfc8628.html#section-3.2) defines user-code presentation, polling, errors and backoff. Sources checked 2026-11-11.

`node --import tsx --test tests/official-device-flow.test.ts` passes 82 account-free tests. Every execution uses injected HTTP fixtures or an in-memory HTTPS request/DNS stub; real HTTP and fetch are forbidden. The default adapter's TLS options, URL/form restrictions, DNS refusal, stream limits and request cancellation/deadline behavior are covered. These tests do not exercise real DNS, TLS, Oracle endpoints, account credentials, mobile input or cloud authorization. Strict project typechecking also passes. No real provider has been enabled and the plugin has not been reloaded for this change.
