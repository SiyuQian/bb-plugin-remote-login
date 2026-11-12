# OCI CLI expected identity and verifier contract

Reviewed against installed public source on 2026-11-11. This records the target contract and integrated experimental OCI CLI verifier. The registered host job runs guarded official validation plus an independent SDK check, but actual OCI service acceptance has not been tested. Console uses its own separately gated verifier and browser flow; phone callback forwarding remains disabled. No real owner fingerprint/key, OCI authentication or cloud validation was used; the current source has not been reloaded from the last loaded server `36b57ef`.

## Independent target input

`oci-cli-protocol.ts` exports the browser-importable `cliExpectedIdentitySchema` and `CliExpectedIdentity` type. Its only accepted fields are:

| Field | Contract |
| --- | --- |
| `mode` | Exactly `oci_cli`; Console and synthetic targets are separate kinds. |
| `tenancyOcid` | Bounded canonical `ocid1.tenancy.oc1..…` identifier. |
| `userOcid` | Bounded canonical `ocid1.user.oc1..…` identifier. |
| `region` | Bounded lowercase region-name syntax, without normalization. |
| `realm` | Exactly `oc1`; other realms require a separate reviewed implementation. |

These values must be selected independently before authentication begins. Copying `user` or `tenancy` from the resulting config, decoding the resulting token, looking at the authorization URL, or accepting a Console display label cannot establish the expected account. The schema does not establish where the selection came from. Do not log or include these identifiers in the existing durable attempt record.

Region syntax is not endpoint authorization. The current host worker accepts only `ap-sydney-1` in `oc1` and uses the fixed reviewed Identity endpoint. It refuses other regions, caller-provided endpoints and runtime metadata overrides. Parsing a target is never evidence that login succeeded. This schema exposes no lifecycle, success setter or provider activation. The expected identity is sent by the private controller through bearer-protected `/login/oci-target` and its raw inputs are cleared immediately; no public native input selects it. Existing `LoginAttempt` owns lifecycle and resume state.

## Why `session validate` exit status is insufficient

The installed `oci_cli/cli_session.py:166–203` implements `session validate` as follows:

1. Force `security_token` auth and load config.
2. Read the selected `security_token_file` into a `SecurityTokenContainer`.
3. With `--local`, check only token expiry. Otherwise construct an Identity client and call `list_regions()`.
4. Print the expiry decoded from the token read in step 2.

The online call uses `cli_util.build_client()`, which loads config again and calls `get_session_token_signer()` to read the token again. A changed token or config can therefore make the decoded claims refer to a different artifact than the online request. The token container uses `jwt.decode(..., options={"verify_signature": False})`; local `sub`, `tenant` or expiry values do not authenticate anything.

`get_session_token_signer()` also prompts for an encrypted-key passphrase. For an expired token it offers to run `authenticate()`, and successful reauthentication exits zero before a retry of the original request. Config absence can trigger a similar setup prompt in the client builder. The reviewed `validate` and global options contain no no-prompt switch. Closing stdin and imposing a deadline reduce exposure but do not make an exit-zero result prove that the intended online request accepted the intended artifacts.

Explicit config arguments alone do not isolate the CLI. `build_config()` skips file loading when the required OCI environment variables are complete, and overlays OCI credential environment variables even when it loaded the file. The root command also reads an OCI CLI RC file for defaults and aliases. A nonexistent explicit RC path falls back through the environment, default and legacy locations.

## Current internal implementation

`oci-owned-session.ts` captures one coherent private file/directory generation and exposes only worker-local byte copies. `oci-owned-verifier.ts` sends that snapshot over a private descriptor to `oci-verifier-source.ts`. The fixed child constructs the real SDK signer/client and compares the same snapshot claims only after service acceptance. Parent authorization and final artifact checks fence the return, and snapshot disposal prevents retained-capture growth. The registered host job invokes this chain only after its private control and expected-target gates. There is no public success setter.

Tests use generated fixture RSA and non-redeemable JWTs. They replace only vendored requests' external HTTP boundary, validate the actual signed request, and explicitly forbid DNS/network activity. They cover rejection, wrong identity, malformed input, key failures, cancellation, deadlines, retries/redirects and artifact changes during final authorization. They do not establish actual service acceptance. The host/coordinator/browser flow and guarded official diagnostic are integrated in source. The real phone gate has not been accepted and no actual OCI service acceptance has been demonstrated; see [runtime gates and limits](oci-host-flow.md).

## Reviewed noninteractive primitive

The independent fixed verifier uses SDK primitives directly, with the exact captured bytes and no CLI Click/config-building path:

- `oci.signer.load_private_key(captured_key_bytes, pass_phrase=None)` loads an in-memory key. Do not call the file-loading variant, prompt or accept a passphrase through public input.
- `oci.auth.signers.SecurityTokenSigner(captured_token, captured_key)` uses the provided token and key. Do not substitute the federation/refreshing signer.
- Construct `oci.identity.IdentityClient` from a minimal worker-owned config and this signer, with reviewed fixed endpoint selection, a bounded `(connection, read)` timeout and `oci.retry.NoneRetryStrategy()`.
- Call `client.list_regions(retry_strategy=oci.retry.NoneRetryStrategy())`. In the installed SDK this is `GET /20160918/regions`; without an explicit strategy it otherwise selects the default retry strategy.

This is the installed CLI's online validation operation, not tested account evidence. Before granting it authority, separately demonstrate that the selected service endpoint rejects invalid or absent credentials and accepts the exact intended session. Retain TLS verification; exclude inherited proxy, certificate, endpoint, SDK region-metadata and OCI credential overrides. Discard response data and all raw stdout/stderr, HTTP diagnostics and backend exceptions. A hard worker deadline and cancellation fence must bound the entire operation, including DNS, key parsing and response handling.

Oracle documents `ListRegions` as requiring `TENANCY_INSPECT` and explicitly recommends a session-token-authenticated region list to verify token authentication. This supports the chosen operation. The negative public-service controls below now confirm rejection of two inputs; actual expected-session acceptance remains untested. Accounts without that permission cannot pass this adapter's validation. See [IAM permissions](https://docs.oracle.com/en-us/iaas/Content/Identity/policyreference/iampolicyreference.htm) and [CLI session-token verification](https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/clitoken.htm).

The host job requires normal completion of the authentication child, confirmed browser closure, guarded official `session validate` and the independent read-only request. A generation seal captured before the diagnostic is rechecked after it and after independent verification, so changing artifacts between two individually valid checks cannot verify the job. The official path refuses prompts/reauthentication and inherited account configuration; its exit status is not the independent identity authority.

For that guarded CLI diagnostic, the reviewed global flags are `--config-file`, `--profile`, `--cli-rc-file`, `--region`, `--auth security_token`, `--no-retry`, `--connection-timeout` and `--read-timeout`, followed by `session validate` without `--local`. It needs an existing empty owned RC file, a scrubbed environment, closed stdin and a hard deadline. These flags still do not repair its reread, prompt or identity-binding gaps, and do not authorize a verified event. The private snapshot-based online check is required in addition to the integrated diagnostic.

## Artifact and attempt fencing required before success

The registered chain enforces the following inside the restricted worker. A boolean such as `onlineAccepted` supplied to a pure function, form, RPC or agent is not trusted evidence.

1. Capture the expected identity before starting the owned authentication child. Bind it to the full current attempt identity, revision, owner epoch, child/profile generation and deadline. Do not let a later form submission replace that target.
2. Wait for the owned authentication child to exit and stop writers before verification. Use a fresh owned session root, explicit config and generated profile; never inspect or merge the owner's default config. Resolve only plugin-generated paths under that root. Refuse symlinked, nonregular, oversized or unexpected files, path escapes and config/profile ambiguity.
3. Open the exact owned config, key and token without following links; capture bounded bytes and file identities privately. Read config selectors once, require the expected generated profile and paths, and load the signer from the captured key/token bytes. Parse claims from that same token snapshot, never from a second path read. Keep snapshots, digests, inode information and claims out of public status and durable metadata.
4. Require successful service acceptance using that in-memory signer at the reviewed endpoint. Compare that accepted snapshot's `sub` and `tenant` exactly with the independently selected user and tenancy; missing, malformed or different claims fail. Require exact region/realm selection. Config `user` and `tenancy` may be consistency checks, never the source of expected identity.
5. After the await, recheck the complete attempt binding, owner epoch, revision, generation, current phase, cancellation and deadline. Confirm the owned artifact generation has not changed, including the config selectors. Refuse a replaced, modified or deleted artifact, superseded worker, changed environment/host or expired attempt. A valid old snapshot must not verify a new session at the same path.
6. Only this fixed verifier may produce the internal `verified` event with `kind: "oci_cli"`, a generated non-secret receipt ID and the exact expected binding/revision. Preserve the existing transaction and coordinator fences. Return fixed match facts or failure codes only; raw claims and account material do not cross the worker boundary. CLI evidence never produces `oci_web` verification or verifies Console identity.

File handles and permission checks do not isolate another process running as the same OS user. The required property is a coherent owned artifact generation that the worker can fence, not an unsupported claim of host-wide isolation. The retained CLI lease keeps these checks after verification. Gateway completion and the original native call obtain an internal live resume proof, recheck its expiry after awaits and fence the sealed artifacts before recording verification or claiming resume. Only the bounded native result may contain the opaque `accountRef`; the fixed read consumer can list compartments or Sydney instances after original-call handback; it exposes no credential export or arbitrary command API.

## Source evidence and remaining checks

All source paths below are relative to the fixed public installation directory `/opt/homebrew/Cellar/oci-cli/3.88.0/libexec/lib/python3.14/site-packages/`. Files were read as text; no installed Python module was imported. These additional files are not added to the current compatibility inspector's recognized source set.

| Public source | Inspected behavior | SHA-256 |
| --- | --- | --- |
| `oci_cli/cli_session.py` | `validate`, token read and online call | `4cba34c8fb2ba49b8b648c89131a559acfe2912b0662d2b28da2344a6d962de0` |
| `oci_cli/cli_util.py` | `get_session_token_signer`, `create_config_and_signer_based_on_click_context`, `build_client`, `build_config`, `is_config_valid_from_env` | `8a649b409c17f85432867aa2746428acdb67ad79bea9e4c3442e296f3cf5e30f` |
| `oci_cli/cli_root.py` | Global flags, RC fallback, profile/auth defaults | `f3e861c840ff516e82eb1ba12a89e5e14f0879f51e5ba9858ee3dc5cdd4a0f92` |
| `oci_cli/cli_constants.py` | Credential environment overlay and required environment keys | `6868821b764875cfefdfa1a510af499fec2577bdde273824e5f63a1aa9ff1c40` |
| `oci/auth/security_token_container.py` | Unsigned claim decoding and local expiry check | `aa7c59617c2a6c77d32f3dc2e05887d55d56270c0403d1359baf6276b22ec55e` |
| `oci/auth/signers/security_token_signer.py` | In-memory fixed token/key signer and separate refreshing signer | `b8181717f87a4638c3fe424fcd9733849feadfc2c9aa802a45f17c06fd30eb91` |
| `oci/identity/identity_client.py` | `IdentityClient`, `list_regions`, explicit retry override | `a472016e2fb9babb1355ec70ac2c40d55dee24dcb9e3305e53ada13bdd59d227` |
| `oci/signer.py` | In-memory versus file-loading private-key functions | `325faa41fe9c326d1ecdf96b8a99549c00509d7f2322e843be0b083e978988aa` |

Schema tests use invented identifiers and establish shape/privacy boundaries only. They do not compare an authenticated account. Fixture checks cover identity mismatch, region/realm rejection, delayed artifact changes, stale state, cancellation and expired/revoked final proofs. They do not establish live wrong-account or service-acceptance behavior. Actual phone/OCI acceptance, uncertain browser-orphan recovery, arbitrary task operations and production result delivery remain incomplete. The separate [Console self-identity and retained browser flow](console-protocol.md) is connected in source and local composed fixtures; CLI evidence cannot enable its authority. Conservative exact-file journal cleanup and the two fixed read tasks are implemented. No source reload or real validation was performed.

## Negative public-service control

On 2026-11-11 (Pacific/Auckland), two read-only requests to the fixed Sydney ListRegions endpoint were refused with HTTP 401 / NotAuthenticated: one unsigned request and one RSA-signed request using a fresh ephemeral key and an explicitly nonredeemable invalid token. Neither used a real account, account configuration or valid credential. The bounded sanitized record is `oci-public-negative-probe.json` in the thread evidence directory. This checks only two negative inputs against that public endpoint; it does not prove that any real user/token has been accepted, that all malformed credentials are rejected, or that the eventual expected account has permission. Actual authenticated acceptance remains required.
