# Bounded reads through an owned OCI CLI session

`remote_login_oci_read` uses the authenticated CLI session retained on the original selected host. It accepts only an `attemptId`, the opaque `accountRef` returned by the original completed login call, and one typed request. Ordinary injected threads can select this tool; selection does not grant login or account authority.

```ts
{ attemptId, accountRef, request: { operation: "list_compartments" } }
{ attemptId, accountRef, request: { operation: "list_instances", compartmentRef? } }
```

`accountRef` identifies a live worker lease. It is not a bearer credential and cannot recreate a session after worker replacement. The native tool requires the same injected thread/project/environment and host binding, current control root, matching verified OCI receipt, original resume state `uncertain`, and an unexpired private lease. It checks these again after the host request and obtains a fresh internal resume proof before publishing rows. There is no public success flag or session adoption API.

## Supported requests and results

| Operation | Fixed service request | Published data |
| --- | --- | --- |
| `list_compartments` | Identity `GET /20160918/compartments`; verified tenancy; `accessLevel=ACCESSIBLE`, `compartmentIdInSubtree=true`, `lifecycleState=ACTIVE`, `limit=25` | Root compartment reference and up to 25 `{compartmentRef, name}` rows |
| `list_instances` | Compute `GET /20160918/instances`; privately mapped compartment; `limit=25` | Up to 25 `{id, displayName, lifecycleState, shape, availabilityDomain}` rows |

Both endpoints are fixed to `ap-sydney-1`: `identity.ap-sydney-1.oci.oraclecloud.com` and `iaas.ap-sydney-1.oraclecloud.com`. Instance identifiers must also identify that region. Requests fetch one page and never follow a page token. `truncated` is true if the response has a next-page marker or more than 25 rows; it does not promise a complete inventory or a stable ordering.

A supplied `compartmentRef` must have been returned for this same account lease. The host maps it to a compartment OCID privately. Omitting the reference selects the verified tenancy's root compartment, without first requiring permission to list compartments. Stable reference mappings are limited to 256 entries per lease. Raw tenancy/user identifiers and compartment OCIDs are not returned.

Resource labels are projected from selected fields, stripped of control and bidi override/isolate characters, and bounded by UTF-8 bytes. Exact captured token/key values, private-key markers, and the privately selected user/tenancy identifiers are redacted before truncation. Instance IDs and the selected resource labels are permitted account data. Raw models, metadata, tags, descriptions, HTTP headers, page tokens and service error bodies are not returned.

## Signer, artifact and process boundaries

The host reserves the session's busy slot and cleanup tracker before its first awaited precheck. It requires current private control authority, the paired-control receipt, and the same artifact generation seal used across handback verification. Each task captures a coherent private token/key snapshot and uses the pinned installed SDK's actual `SecurityTokenSigner` with `BaseClient.call_api`. The source bootstrap and audit policy are shared with the independent verifier; the read program adds only the fixed GET route and result projection.

Success requires an actual accepted task response and exact user/tenancy claims from that same captured token. Parsed claims, metadata or a local success boolean cannot substitute for the service response. The parent rechecks snapshot generations and authority; the host rechecks its retained seal and receipt before publishing mapped results.

The isolated child receives configuration only over private pipes. Its process arguments contain the static program, and ordinary stdio is ignored. The environment is scrubbed; prompts, reauthentication, subprocesses, arbitrary file reads/writes, environment proxies, redirects and retries are refused. TLS validation remains enabled. The response is streamed through a 1 MiB bound before SDK parsing and reduced to at most 25 rows. There is no shell, arbitrary CLI argument, endpoint, raw compartment selector, default-config mutation, credential export or cloud-write interface.

Before spawn, the host durably records a task writer. Configuration waits for observation of the exact child process. Completion and retention release wait for exact child closure and durable writer closure. Cancellation during a pending journal write abandons that exact late pre-spawn intent when it settles; unknown cleanup retains ownership and reports uncertainty. See [resource recovery](owned-resource-recovery.md) for the conservative restart behavior.

The task child has a 5.5-second parent deadline, a 5-second configured runtime bound, and bounded shutdown escalation. Host/native requests retain their existing shorter-lived request, proof, attempt and fifteen-minute ceiling checks. A read does not extend these authorities. Cancellation, expiry, root/host replacement, artifact mutation or uncertain cleanup discards rows. Generic original tasks and writes remain unsupported.

## Evidence and limits

Tests run the actual pinned SDK signer and verify a disposable RSA signature at an external mocked HTTP boundary. They cover fixed paths/query, one-page projection, truncation, wrong identities, invalid regions, bounded responses, credential-label redaction, late authority/artifact changes, cancellation, journal preparation and cleanup failures. Joined native/host fixtures test scope, receipt, reference and final-proof checks.

These tests perform no real Oracle DNS, authentication or cloud request. Real paired-phone control, account acceptance and production native-result delivery still require live evidence. Source pins cover reviewed critical files, not the complete dependency graph. Same-user hostile processes and privileged filesystem administration remain outside the API isolation claim. Worker restart supports conservative resource cleanup, not authenticated session or native-call reattachment.
