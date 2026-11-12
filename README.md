# Remote Login for BB

Independent BB plugin for the mobile-to-host login goal. Current source connects protected synthetic control and separately gated experimental OCI CLI and Console flows to durable coordination and the original native-tool wait/result path. OCI CLI can queue after a matched source inventory; real startup requires owner provisioning, a private verified-and-closed synthetic control receipt and an independently selected private target. After verified handback, the original thread can use an opaque session reference for bounded compartment and Sydney instance reads. Private resource journals support conservative cleanup after a worker exits. Console uses a fresh owned browser, exact user/tenancy/domain verification and a retained browser reference for identity or current title/headings reads. The optional phone callback bridge remains unavailable. Actual iPhone control, OCI/cloud acceptance and production result delivery are unverified.

## Status

This is an **experimental source snapshot**, not a completed real-device or Oracle acceptance release. Local automated checks exercise real Chrome with synthetic provider/service responses. Actual iPhone control, separate real OCI CLI and Console identity checks, and production continuation still require live acceptance.

See the [architecture diagrams](docs/architecture.md) and [publication scope](PUBLICATION.md).

## Scope

Use public SDK 0.6.132 only. Do not modify BB core, installed app files, or builtin plugins. The eventual first release targets plugin-managed host browser sessions; arbitrary system browsers and OS dialogs are not implicitly supported.

Generic RPC `client` identity includes UI, CLI and agents. An independent owner-provisioned control key now protects control-session routes; this proves key possession, not physical human identity. The OCI worker additionally requires a private paired-control receipt bound to the current root generation and browser pin. That control-path check is not physical phone attestation. See [the gated OCI flow](docs/oci-host-flow.md).

## Commands

```sh
npm ci
npm run typecheck
npm test
bb plugin types --check
npm run build
bb plugin install .
bb remote-login probe-methods <explicit-host-id> --json
bb remote-login probe-host <explicit-host-id> --json
bb remote-login probe-oci <explicit-host-id> --json
bb remote-login check-channel <explicit-host-id> --json
bb remote-login provisioning-info <explicit-host-id> --json
```

`probe-methods` reports each implemented or disabled login method, exact runtime requirements and explicit failure reasons. An eligible host still requires owner pairing and independent identity verification.

`probe-host` checks runtime facts and browser executable availability on an explicit enrolled host. It does not inspect profiles or return control endpoints.

`probe-oci` checks only fixed public installed source files on that explicit host. Its static `enabled:false` inventory fields are not runtime permission. A match permits queuing, while separate private gates authorize the registered host browser and verifier. The phone callback bridge remains disabled.

The plugin adds a diagnostics page with the same read-only probes. `remote_login_wait_probe` is exposed only when the `probeThreadId` setting exactly matches the host-injected thread ID. It opens a public fixture form to test BB's waiting/result path. Neither its submission nor its completion proves human identity or account authentication.

## Documentation

- [Login methods, runtime eligibility and disabled device grant](docs/provider-capabilities.md)
- [Capabilities and P0 decisions](docs/capabilities.md)
- [Phone pairing, trusted owner setup and limitations](docs/control-pairing.md)
- [Local private-browser fixture evidence and limits](docs/private-browser-probe.md)
- [Protected synthetic browser protocol and lifecycle limits](docs/private-fixture.md)
- [Typed login attempt protocol](docs/login-protocol.md)
- [Cross-flow fault assertions, evidence levels and remaining acceptance](docs/fault-matrix.md)
- [Input operation identities and transparent browser retry refusal](docs/input-replay.md)
- [390px browser integration evidence and its mobile acceptance limits](docs/mobile-browser-acceptance.md)
- [Durable coordination, target binding and recovery limits](docs/login-coordinator.md)
- [Protected takeover, handback and original-call integration](docs/login-flow.md)
- [Registered experimental OCI CLI flow and runtime limits](docs/oci-host-flow.md)
- [Owned resource journals and conservative restart cleanup](docs/owned-resource-recovery.md)
- [Bounded OCI read tasks through the original session](docs/oci-read-tasks.md)
- [Gated Console browser, self-identity and retained-context reads](docs/console-protocol.md)
- [OCI capability inventory and verification requirements](docs/oci-auth-inventory.md)
- [Pinned OCI source compatibility probe and disabled callback decision](docs/oci-compatibility.md)
- [Account-free OCI child boundary fixture](docs/oci-child-wrapper.md)
- [CLI expected identity and integrated verifier contract](docs/oci-cli-verification-contract.md)
- [Agent constraints](AGENTS.md)

The last explicitly loaded revision was `36b57ef`; checkout/installed parity is currently unverified. The latest read-only selected-host check (2026-11-10 UTC) found plugin `0.1.0` running on BB `0.49.0`, Chrome available, `provisioned:false` and `rootId:null`. Installed help exposes the older three-command surface: `probe-host`, `provisioning-info` and `check-channel`.

No real owner fingerprint/key or OCI account was used for these probes. Automated fixtures and read-only diagnostics do not establish actual phone/cloud acceptance or production result delivery.

`npm test` limits test-file concurrency to two because the suite runs actual private Chrome processes and durable filesystem operations. This changes test scheduling, not production authorization or timeout bounds.

Its pretest step runs the public plugin build to generate the actual stylesheet used by browser tests. It does not install or reload the plugin. Input commands require matching app, server and host builds; legacy input messages without an operation identity and the displayed frame reference fail closed. Each input consumes that private frame reference after UUID replay checks. Known stale input is refused before any browser effect; a changed read has a separate neutral refresh path and never implies an acknowledged input was unsent. See [the input contract](docs/input-replay.md).
