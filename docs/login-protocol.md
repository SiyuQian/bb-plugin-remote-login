# Non-secret login attempt protocol

This protocol defines a strict durable record and a pure transition function. It does not launch a browser, authenticate an account, persist a transaction, send a continuation, or enable an OCI provider. The coordinator must provide those boundaries separately. Real provider gates remain off until the actual phone pairing and private-control gates have evidence.

`synthetic`, `oci_cli` and `oci_web` are distinct verification kinds. A synthetic result never proves either OCI mode. The schema can represent future OCI evidence; accepting the mode name does not make its provider available.

## Record and binding

`loginAttemptSchema` accepts version 1 only. Records contain bounded identifiers, mode, phase, revision, timestamps, a fixed failure code, a bounded verification receipt and resume bookkeeping. Every object is strict, including nested objects. Identifiers contain 1–200 ASCII letters, digits, underscores, hyphens, periods or colons, and start with a letter or digit. Producers should generate attempt, browser-context, verification and delivery identifiers with `randomUUID()`.

Credentials, control keys, grants, cookies, URLs, HTML, input, images, filesystem paths and freeform logs are excluded. Do not put those values into identifier fields. The schema restricts shape and syntax; trusted producers remain responsible for the meaning of an identifier.

Every event supplies `expected` with the complete current binding:

- `attemptId`, `projectId`, `threadId`, `environmentId`, `hostId`;
- `browserContextId`, `generation`, `principalId`.

Every event also supplies `expectedRevision`. The environment binding matters even when two environments use the same host. The coordinator must resolve the thread's actual environment and host from trusted SDK state. UI-selected flags and generic client identity do not establish those facts.

`principalId` is null in `awaiting_pairing`. The trusted host establishes the principal before producing `paired`; that event changes the binding to a non-null principal. Subsequent control and verification phases require that principal. A terminal attempt that ended before pairing may retain null. Failed, cancelled or expired records can retain historical verification only with a non-null principal.

`reduceAttempt(attempt, event, now)` validates the record, command, full identity and revision before applying an event. Its third argument is the sole trusted event timestamp. It rejects unsafe timestamps and time before `updatedAt`. Each accepted transition increments the revision and sets `updatedAt`; it does not mutate either input. Persistence, compare-and-swap and worker-owner fencing belong to the coordinator, not this pure function.

## Transitions

| Current state | Trusted event | Result |
|---|---|---|
| `awaiting_pairing` | `paired(principalId)` | `awaiting_control`, principal bound |
| `awaiting_control` | `check_existing` | `checking_existing` |
| `checking_existing` | `login_required` | `awaiting_control`, no verification or resume |
| `awaiting_control` | `start` | `starting` |
| `starting` | `ready` | `user_control` |
| `user_control` | `handback` | `verifying` |
| `verifying` | `verification_retry` from the restricted verifier | `user_control`, no verification or resume |
| `checking_existing` or `verifying` | `verified(verificationId, kind)` with kind equal to mode | `verified`, verification receipt, resume `pending` |
| Any unfinished phase, including verified with unresolved resume | `cancel` | `cancelled` |
| Any unfinished phase at or after the deadline | `expire` | `expired` |
| Any unfinished phase before the deadline | `worker_lost` | `failed`, failure `worker_lost` |
| Any unfinished phase before the deadline | `reject(code)` | `unsupported` for code `unsupported`; otherwise `failed` |
| Verified with resume `pending`, before deadline | `resume_claim(deliveryId)` | Same phase, resume `claimed` |
| Resume `claimed`, with verification | `resume_uncertain` | Same phase, resume `uncertain` |
| Resume `claimed` or `uncertain`, with verification | Future trusted `resume_delivered` acknowledgement | Same phase, resume `delivered` |

A paired attempt can enter `checking_existing` for a limited trusted provider probe. Reusable existing authorization can produce matching-kind verification directly, without inventing `start`, `ready` or `handback` events. A missing or nonreusable session produces `login_required` and returns to manual waiting without success evidence or a pending resume. The probe is not a client-supplied success boolean. The actual OCI probe producer remains disabled. The same full binding, principal, revision and deadline checks apply to this branch.

Cancellation, expiry and failure preserve an existing verification as historical evidence. They clear a `pending` resume to `none`. If a delivery was already claimed or uncertain, they preserve its delivery identifier and set resume to `uncertain`; the protocol cannot infer that nothing was sent.

`verified` is therefore not a completed delivery. Claiming records one attempted delivery, not acknowledgement. A second claim is refused. Uncertainty does not authorize a retry. Once delivery is recorded, new cancellation, rejection and worker-loss events are refused. Duplicate `cancel` on `cancelled` and duplicate `expire` on `expired` are no-ops only with the current full binding and revision; they do not advance timestamps or revision.

## Deadline and restart behavior

At `now >= expiresAt`, progress, verification and resume claims are refused with `deadline_expired`. The coordinator must persist an explicit `expire` transition before further work. Verification obtained after the deadline must not trigger resumption. `expire` before the deadline is refused.

A late `resume_uncertain` or trusted delivery acknowledgement may record what happened to an already claimed delivery after the deadline. These events preserve the current phase and failure. For example, an expired attempt can gain a historical `delivered` receipt; it remains expired and cannot claim another delivery. A well-bound duplicate terminal cancel or expiry remains a no-op.

On startup or worker replacement, unfinished work must not become verified merely because a browser disappeared, a form was submitted or a previous worker stopped. A `worker_lost` transition before the deadline records failure and preserves any claimed delivery as uncertain. Work past the deadline must be expired. The record alone does not prove a current browser, a still-valid grant, OCI authentication or successful continuation.

## Trusted producers and current limits

Events are internal commands, not an authorization API. The coordinator must authenticate current proof and verify host, environment, thread, generation and principal before producing them. A frontend `success` flag cannot produce `paired`, `verified` or `resume_delivered`. Only the matching provider may produce verification, based on its own trusted success evidence.

There is no current SDK delivery acknowledgement for the intended continuation path. `resume_delivered` is reserved for a future trusted transport acknowledgement and must not be exposed through the current UI, form submission, public RPC or ordinary API producer. The current integration can record a claim and uncertainty; neither proves delivery or exactly-once execution.

Fixed failure values are `unsupported`, `control_refused`, `provider_failed`, `worker_lost`, `deadline_expired`, `cancelled`, `pairing_required`, `host_changed`, `verification_failed` and `internal_error`. Protocol refusals use `LoginProtocolError` with fixed code and message, without submitted data or backend exceptions. Pure tests establish transition and schema behavior only; they do not prove phone transport, provider authentication or continuation delivery.
