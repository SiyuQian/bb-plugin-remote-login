# OCI 3.88.0 compatibility decision

Reviewed on 2026-11-11. The installed public sources are recognized. The source inventory still reports static `hostBrowser.enabled:false` and `phoneCallback.enabled:false` fields: these record unvalidated inventory capabilities, not runtime permission. A separate registered experimental OCI CLI host flow now applies private control/target gates, owned browser/child handling and independent verification. The phone callback bridge remains unavailable. Console has its own separately gated [experimental flow](console-protocol.md). See [the current runtime flow](oci-host-flow.md).

## Reviewed helper and actual probe

The reviewed helper is `scripts/probe-oci-compatibility.ts`, backed by `inspectInstalledOciCompatibility()` in `oci-compatibility.ts`. It accepts no arguments, opens only fixed public Homebrew installation files, limits each regular file to 300,000 bytes, refuses final-component symlinks and returns match booleans. It executes no OCI command, imports no installed Python package, starts no listener/browser, and reads no account configuration, private control root, cookie, key or token. Its public schema is browser-safe `oci-compatibility-wire.ts`; raw paths, source text, unrecognized hashes and arbitrary diagnostic output are absent.

Executed against the actual installation:

```sh
node --import tsx scripts/probe-oci-compatibility.ts
```

Result: exit 0; `sourceCompatibility: "matched"`; launcher, bootstrap, session and Python browser fingerprints all `true`; both static inventory `enabled` fields `false`. Exit 0 means the source inventory matched. A registered CLI request may then queue, but the inventory itself authorizes no browser or account action. Unknown installations exit 2 with bounded facts and no protocol assertion. Separately, only `/opt/homebrew/bin/oci --version` and `oci session authenticate --help` were executed; they reported 3.88.0 and no redirect/callback-port option.

The plugin exposes the same fixed helper through `inspectOciCompatibility(null)` on the selected host, public `ociCompatibility({hostId})`, and `bb remote-login probe-oci <explicit-host-id> --json`. No caller may choose a source path, executable, command, URL or callback port. The inventory route remains read-only. The integrated source has not been reloaded; the last loaded server is `36b57ef`.

## Installed source evidence

The launcher chain is `/opt/homebrew/bin/oci` → `Cellar/oci-cli/3.88.0/bin/oci` → `../libexec/bin/oci`. Its shebang selects the installation's private Python launcher. `libexec/pyvenv.cfg` records Python 3.14.6; its `webbrowser.py` matches CPython 3.14.6 exactly.

| Public installed file | SHA-256 | Independent comparison |
| --- | --- | --- |
| `libexec/bin/oci` | `6196509b5e1e1cbbd8421fc72f49be22b2f46f4ad9b4e28bc49dbf9bd1dfa366` | Locally measured launcher; imports `oci_cli.cli` |
| `oci_cli/cli_setup_bootstrap.py` | `2e9002445a6380fcc308f802b9a68ab42bd6e0aafcc557750dbf9efb4d507f83` | Byte-for-byte hash match to Oracle v3.88.0 |
| `oci_cli/cli_session.py` | `4cba34c8fb2ba49b8b648c89131a559acfe2912b0662d2b28da2344a6d962de0` | Byte-for-byte hash match to Oracle v3.88.0 |
| Python 3.14 `webbrowser.py` | `893c86950a76b187b6a84e65bde03572e4179733f667b32880f866ce9a1a92f3` | Byte-for-byte hash match to CPython v3.14.6 |

The two OCI modules live under `/opt/homebrew/Cellar/oci-cli/3.88.0/libexec/lib/python3.14/site-packages/`. The Python module is `/opt/homebrew/opt/python@3.14/Frameworks/Python.framework/Versions/3.14/lib/python3.14/webbrowser.py`. The inspector recognizes precisely these reviewed files, not the complete Python dependency graph or a future Homebrew upgrade.

Retrieval verification used `curl -fsSL <pinned-raw-source-url> | shasum -a 256` and compared each digest with `shasum -a 256 <installed-public-source>`. Primary URLs fetched and inspected were [Oracle bootstrap v3.88.0](https://raw.githubusercontent.com/oracle/oci-cli/v3.88.0/src/oci_cli/cli_setup_bootstrap.py), [Oracle session v3.88.0](https://raw.githubusercontent.com/oracle/oci-cli/v3.88.0/src/oci_cli/cli_session.py), and [CPython browser v3.14.6](https://raw.githubusercontent.com/python/cpython/v3.14.6/Lib/webbrowser.py). The moving Oracle command reference currently reports 3.96.0, so it is not the installed-source pin.

## Browser launch and process ownership

Installed bootstrap binds its HTTP server before generating its session key. It generates a fresh RSA pair in the CLI process and puts its encoded public JWK and UUID nonce in an authorization URL. The endpoint is derived from the selected region/realm, with fixed `/v1/oauth2/authorize`, `client_id=iaas_console`, response type and localhost redirect. The process holds the private key and eventually writes the CLI session; the browser receives no private key. The receiver does not retain or compare the nonce and accepts a security token on any non-root GET path. Thus a nonce-shaped value in a captured URL is not callback ownership evidence. See the pinned bootstrap source above.

The fixed launch hook is `webbrowser.open_new(url)`. Installed CPython honors `BROWSER` before its standard choices, splits a command with `shlex`, substitutes the URL into `%s`, starts a subprocess without a shell and waits for its exit code. **A failed helper can fall through to the user's system browser.** A candidate capture helper must be plugin-owned, accept exactly one URL from the owned child, communicate through private per-attempt IPC and consume/cancel the request without permitting fallback. `BROWSER` alone does not prove fail-closed isolation if the helper cannot spawn. That source investigation did not run authentication. The current owned child instead replaces the browser hooks directly, with a private consumer channel and no system-browser fallback; see [the child boundary](oci-child-wrapper.md). This behavior comes from the matching installed module and the pinned CPython source above.

Upstream prints the full authorization URL to stdout whether browser launch succeeds or fails. Callback page JavaScript also logs its fragment in the browser console. The current owned adapter discards raw child stdout/stderr and browser console/network logging; neither can be copied into BB logs, interaction data, screenshots, command history or public status. Helper argv may contain the authorization URL and is visible to same-user process inspection, which remains outside the plugin's isolation boundary.

## Callback decision: disabled

The installed server binds IPv4 `0.0.0.0:8181`, while its fixed redirect is `http://localhost:8181`. The response fragment is read by page JavaScript and sent as a GET query to the receiver. There is no application callback timeout, attempt-state check, Origin/Host check or receiver-side nonce check. A phone's localhost identifies the phone; the stock URL cannot directly deliver its callback to the host. No documented CLI redirect or callback-port override exists.

Decision code: `no_supported_redirect_override_or_bound_callback_bridge`. Do not expose port 8181 through BB Connect or forward arbitrary callback query data. The plugin has no reviewed bridge that owns a request across phone, host and CLI process, rejects replay/cross-attempt responses, hides response material and confirms cleanup. No callback support is enabled by a matching source hash. This is the explicit disabled branch for the optional RLOGIN-13 bridge investigation; it does not complete the broader working OCI login goal.

The static inventory retains `runtime_ownership_and_identity_unverified` because it does not inspect runtime ownership or authenticate an account. The registered host path separately replaces the listener with IPv4 loopback, checks the exact child's exclusive port ownership, captures the URL privately and opens a restricted owned browser. It requires the provisioned root, current private control proof, a 24-hour verified-and-closed synthetic control receipt bound to root generation/browser pin, and an independent expected target. An existing listener causes refusal; it is never killed or adopted. Those checks are outside this read-only source probe and still need actual phone/cloud acceptance.

## Expected identity verification

The registered CLI flow uses a fresh plugin-owned session directory, explicit new profile/config location and fixed Sydney/oc1 target. It does not merge into the owner's default config. Expected tenancy and subject OCIDs are selected privately before starting; tenant labels, config `user`, a URL, callback arrival or process exit cannot establish the expected account. Browser Console identity is a separate context; no Console verifier or login mode is enabled.

Installed `session validate` without `--local` sends an Identity `list_regions` request. Local validation only checks expiration. The installed SDK token container decodes claims with signature verification disabled, so parsing `sub` and `tenant` alone proves nothing. See [pinned session validation](https://raw.githubusercontent.com/oracle/oci-cli/v3.88.0/src/oci_cli/cli_session.py) and [OCI SDK 2.180.0 token container](https://raw.githubusercontent.com/oracle/oci-python-sdk/v2.180.0/src/oci/auth/security_token_container.py).

The integrated host job requires guarded official `session validate` and an independent SDK request using exact captured key/token bytes. A common artifact generation seal fences both stages; accepted snapshot claims are compared privately with the independent target only after service acceptance. Calls are bounded, prompts/reauthentication and inherited account configuration are refused, and raw streams are discarded. Authentication persistence alone does not verify identity. These paths are fixture verified; no actual account validation or cloud request was performed for this work.

## Verification scope

Focused tests cover per-source mismatch/missing data, unknown version, strict output privacy, disabled-provider invariants, filesystem size/type/symlink refusal and handle closure, null-only host input, explicit host routing and argument rejection. Temporary fixtures contain synthetic public-source strings only. Source typecheck passed. The registered CLI controller/host/coordinator chain also has fixture coverage. Actual phone transport/control acceptance, live account/cloud acceptance and production native-result delivery remain untested. The fixed runtime is macOS arm64, Chrome `157.0.8103.50`, Puppeteer `25.16.0`, CLI `3.88.0`/Python `3.14.6`, SDK `2.180.0`, Sydney/oc1. External federated SSO and the phone callback bridge are unsupported; Console support is separately pinned and experimental. No real owner fingerprint/key or OCI authentication was used; this source was not reloaded.
