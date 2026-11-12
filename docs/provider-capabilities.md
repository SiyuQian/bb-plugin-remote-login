# Login methods and runtime eligibility

`bb remote-login probe-methods <host-id> --json` and `loginCapabilities({hostId})` return a fixed, non-secret method registry for the explicitly selected host. The phone diagnostics page presents the same report. No input can add an issuer, endpoint, method, credential or enabled flag.

| Method | Runtime eligibility | Remaining authorization and acceptance |
| --- | --- | --- |
| OCI CLI through host browser | macOS arm64, exact Chrome 157.0.8103.51, working process-ownership inspection, matching fixed CLI 3.88.0/Python 3.14.6 source inventory | Owner root, live scoped proof, recent paired-control receipt, private expected identity, owned child/browser and independent CLI/service verification |
| OCI Console through host browser | Same platform/browser/process inspection; CLI source match is not required for Console | Separate private expected user/tenancy/domain/origin, paired control, pinned Console source delivery and current-browser identity verification |
| Identity Domains device grant | Unavailable: no official application/client is configured in this plugin | Internal protocol client has fixtures only; it is not an OCI CLI security-token or Console-cookie adapter |
| Phone-local callback forwarding | Unavailable: reviewed OCI callback override/bridge is absent | No callback exposure or forwarding is provided |

`candidate` means only that the fixed runtime checks allow an attempt to queue. It grants no browser, account or session authority. All entries currently carry `acceptance:"not_accepted"`: actual iPhone/Oracle acceptance is pending. A source hash match cannot change that status. Unsupported methods stay unavailable even when the host runtime matches.

The host performs independent fixed-install checks in parallel with a shared five-second deadline: Chrome executable metadata, the current process's exact PID/UID/start-identity observation, and the existing public CLI source inventory. It does not launch Chrome, open sockets, import an account, read account configuration or authenticate. The Chrome metadata child is bounded, uses a minimal environment and is killed on deadline. Cancelled/late observations cannot publish affirmative facts; failed probes return non-secret reasons. Parent task binding is rechecked after host observation.

The macOS process observer still needs `/opt/homebrew/Cellar/oci-cli/3.88.0/libexec/bin/python`. Console does not use CLI credentials or require its source-inventory match, but it currently needs this interpreter installation for ownership checks. Missing or unusable inspection now prevents queuing, rather than waiting for the actual browser opener to fail. Independent packaging/discovery of an ownership inspector remains a deployment limitation.

The report is a bounded observation, not a lease or durable compatibility claim. Real startup independently rechecks exact runtime, source, ownership, target and lifecycle requirements. Updating Chrome, CLI, Console scripts or permissions after a report can make startup or verification fail. The supported browser flow remains Sydney/oc1, Puppeteer 25.16.0 and the reviewed Oracle origins; arbitrary browsers, external federated SSO, popups and OS dialogs are not supported.

The internal official device-grant interface and its disabled configuration policy are described in [device-grant protocol](official-device-flow.md). No public RPC, CLI argument, settings value, ordinary native tool or returned capability report can configure or start it. Its protocol fixtures do not prove account authorization, expected-user identity or production task delivery.
