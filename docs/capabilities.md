# Public SDK capabilities and current gates

SDK: 0.6.132. Checked against the installed public declarations under `node_modules/@get-bb/plugin-sdk/bundled-types/` and official plugin harness. This document records evidence, not assumed product support.

## Supported building blocks

| Capability | Public contract | Evidence / remaining work |
|---|---|---|
| Explicit host worker | `experimental_defineHostEntry`, `bb.hosts.experimental_client` | Compile and official host/server harness cover inspectRuntime on an explicit host; live daemon probe recorded separately. |
| Host lifecycle | `context.signal`, `context.lifecycle.signal`, `experimental_retainWorker` | Available by public type. Synthetic and OCI workers retain owned jobs and children; exact journaled CLI cleanup can reconcile after owner exit; durable session reattachment and uncertain browser-orphan reconciliation remain incomplete. |
| Native tool thread binding | `PluginAgentToolContext.threadId/projectId/signal` | Fixture tool uses host-injected thread ID; it accepts no model-selected thread. |
| Wait and continue | `bb.ui.requestInput`, pendingInteraction slot | Public fixture verifies submitted, rejected and cancelled outcomes in the harness. Production waiting notice and system-message delivery still require a live probe. |
| Mobile-facing UI | navPanel and pendingInteraction slots | App bundle builds. Native mobile rendering and actual phone UX remain unverified. |
| Tool selection | synchronous `bb.agents.configure` | Ordinary login tools use the injected thread; only the diagnostic wait probe is opted into a configured thread. Selection is not authorization. |

## Human-control gate: SDK identity alone is insufficient

The public SDK does not currently establish a trusted human UI identity:

- `bb-plugin-sdk.d.ts:154–175`: `ExperimentalPluginRpcCaller` distinguishes a verified loaded plugin from `client`. App, CLI and agents are all client; the context has no verified human/user-device field.
- `:20444–20478`: HTTP handler receives Hono Context and local/token/none auth modes; there is no public verified human identity. Origin and arbitrary headers cannot substitute for one.
- `:20516–20523`: realtime broadcasts to connected clients; it is not a private capability or frame channel.
- `:20565–20608`, `:19147–19199`: requestInput does not persist raw form values, but SDK interaction get/list/respond remain available. Do not put a control secret in a payload or treat submitted as proof of a human.
- `bb-plugin-sdk-app.d.ts:20598–20604`: frontend SDK calls use the logged-in user's authority, without a narrower plugin principal.

Private worker ownership does not itself establish authority. Registered synthetic control requires independent key possession. The experimental OCI CLI worker additionally requires the private paired-control receipt and independently selected target described in [the host flow](oci-host-flow.md).

### Separately trusted pairing and control acceptance

Require the independently provisioned control key before issuing a short-lived capability. Bootstrap, credential replacement and recovery must also require independent authorization; a generic client must not obtain or mint a valid control capability merely by calling RPC. A hidden route, frontend-generated random value, Origin check or ordinary confirmation form is insufficient.

The owner-only importer and protected control routes now have fixture, filesystem, HTTP and frontend-harness evidence. Initial root trust still requires the owner-approved fingerprint and offline provisioning. Real iPhone pairing is pending. These checks do not prove private browser isolation or OCI login; the complete goal remains active.

## Privacy and scheduling boundaries

`message.dispatch` coordinates future dispatches. The current declarations at `bb-plugin-sdk.d.ts:20264–20277` explicitly exclude user Send-now, compaction and edited-message resend; older skill prose differs. No dispatch hook or thread lifecycle event is used as a browser privacy barrier.

`requestInput` inside a native tool detaches the call and later delivers the result as a system message according to `PluginAgentToolContext` at `:20678`. This avoids an extra manual threads.send, but is not a global pause and does not prove exactly-once delivery through restart. Keep resume_uncertain handling in the implementation plan.

The browser barrier lives in the private worker and fences supported plugin operations, including in-flight results. It cannot claim to isolate arbitrary processes running under the same OS user. Raw CDP, cookie export and browser profile inspection are not exposed by the diagnostic probes.

## Evidence classification

- Baseline: generated scaffold typecheck passed before replacement.
- Tests: public SDK fake-host and host-entry harness; no actual user authentication.
- Build: public plugin app/server/host artifacts; not proof of runtime mobile support.
- The [private fixture control path](private-fixture.md) has source and compiled-host harness evidence with real local Chrome and temporary synthetic roots. This does not establish installed-daemon parity or real iPhone transport. The separate local [private-browser fixture probe](private-browser-probe.md) also launches fresh owned Chrome profiles with synthetic content only. No existing user profile, real account, cookie, token, password or MFA was read.

## Live diagnostic run

Historical probes of the persistent-path installation on branch `feat/remote-login`: `bb remote-login probe-host <explicit-host-id> --json` reached the enrolled host worker: darwin / arm64 / Node v24.22.2, Google Chrome executable available. No browser was started. A missing explicit host exited 1. `bb plugin rpc call remote-login callerInfo --json` returned client with no human verification.

The last explicitly loaded revision was `36b57ef`; checkout/installed parity is currently unverified. The latest read-only selected-host check (2026-11-10 UTC) found plugin `0.1.0` enabled and running on BB `0.49.0`, Node v24.22.2 and Chrome available. The host reported `provisioned:false` and `rootId:null`; installed help exposed only `probe-host`, `provisioning-info` and `check-channel`.

The historical and latest diagnostics do not establish actual mobile control, OCI login or production result delivery. No install, reload, root write, browser launch or account authentication was performed by the latest check.

## Registered OCI CLI boundary

Matched source inventory allows a queued CLI attempt. Startup still requires the provisioned root, live private proof, a 24-hour verified-and-closed synthetic control receipt matching root generation and browser pin, and a private expected identity. Startup and verification use pending HTTP responses and bounded polling. The owned host flow runs guarded official validation plus an independent SDK identity/resource check over sealed artifacts; native completion requires a current live lease. The inventory's static `enabled:false` fields do not grant or revoke runtime authority. Console has its own gated experimental browser/identity/retained-read flow; phone callback forwarding and external federated SSO remain unavailable. The original thread can consume its verified reference through two bounded read tasks; conservative journals can reconcile exact stopped CLI files. Actual phone/cloud acceptance, arbitrary task operations, uncertain browser-orphan recovery and production delivery remain incomplete. See [runtime pins and flow](oci-host-flow.md).

## Method registry

The registered [method preflight](provider-capabilities.md) now checks exact Chrome metadata, observable current-process ownership and fixed CLI public-source compatibility on the selected host before native OCI queuing. Console does not require the CLI source match, but still requires its shared inspector interpreter. Diagnostics expose four fixed method decisions; device grants without a configured official app and phone callback forwarding remain unavailable. These are read-only eligibility facts and do not satisfy real phone/account acceptance.
