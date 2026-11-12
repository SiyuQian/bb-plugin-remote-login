# Private browser fixture probe — RL01

This is a bounded, local experiment, not a production browser driver or a phone-control endpoint. It does not access the pairing page, credentials, an existing browser profile, Oracle, or any external service URL. The script uses only the installed public `puppeteer-core` package and Node APIs; it does not import another BB plugin or modify BB core.

## Run

From the repository, with the exact runtime dependency already installed:

```sh
node --import tsx scripts/probe-private-browser.ts --self-check
node --import tsx scripts/probe-private-browser.ts --run
```

`--self-check` starts no browser. It checks that the argument guard rejects a debugging port, missing pipe, sandbox-disable flags and a different profile. It also injects an evaluate rejection before the action starts into the acknowledgement path used by the actual vectors and verifies that the same error propagates; an absent acknowledgement must fail too. `--run` is deliberately limited to darwin/arm64 and the fixed executable `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. It does not download a browser or accept paths, URLs, scripts or browser arguments from the caller. Its overall browser abort deadline is 60 seconds. Output is one bounded JSON report containing counts, fixed outcome labels, booleans and version metadata; failures set exit code 1.

## Observed result

The revised run on 2026-11-11 passed with the versions below. This result supersedes the earlier six-vector run: that version swallowed evaluate/context-close errors and could mistake a failed action for a blocked request.

| Component | Version |
|---|---|
| Node used to run this script | v24.4.1 |
| Platform / architecture | darwin / arm64 |
| Local formal dependency | puppeteer-core 25.16.0 |
| Installed Chrome, from its Info.plist | 157.0.8103.50 |

Puppeteer's [supported-version table](https://pptr.dev/supported-browsers) maps 25.16.0 to Chrome for Testing 156.0.8078.47. The installed Chrome 157 combination passed this fixture experiment; this does not establish compatibility with every Puppeteer API or later Chrome updates.

Two independent browser processes used different newly created 0700 profiles. The first browser established that the loopback HTTP canary could observe every tested vector. The second received the restriction in `launch`, before the script created any test pages. Network probes had no CSP or page request interception, so those extra protections did not account for the restricted counts below.

| Local request vector | Baseline canary requests | Restricted canary requests |
|---|---:|---:|
| Public `page.goto` API | 1 | 0 |
| Renderer top-level navigation through `location.assign` | 1 | 0 |
| Image subresource | 1 | 0 |
| Fetch | 1 | 0 |
| Iframe navigation | 1 | 0 |
| Popup navigation | 1 | 0 |
| Blob worker performing fetch | 1 | 0 |

The canary bound only `127.0.0.1` on a kernel-selected port, used a fresh route namespace, and returned synthetic content with no-store headers. Each vector used a new browser context and had a bounded observation interval. A missing baseline request or any restricted canary request makes the run fail. Restricted counts are checked again after browser/context cleanup and canary shutdown, so late observations cannot produce a successful report.

The public `page.goto` restricted result was a Puppeteer-side refusal before CDP navigation. The script accepts only an `Error` whose complete message is `Navigation to <this exact local canary URL> is blocked by blocklist/allowlist rules`; other messages, timeouts, protocol failures and target failures fail the probe. This was observed locally and agrees with the installed 25.16.0 implementation of [Frame.goto](https://github.com/puppeteer/puppeteer/blob/puppeteer-v25.16.0/packages/puppeteer-core/src/cdp/Frame.ts). It is recorded separately as `goto_denied_by_allowlist`, not presented as browser-initiated network blocking.

The renderer navigation vector calls `location.assign` with its fixed local canary URL inside `page.evaluate`, then returns `vector_initiated`. The baseline returned that acknowledgement and reached the canary; the restricted run returned the same acknowledgement and reached no canary. There is no accepted execution-context-destruction exception: if the action acknowledgement is lost, the probe fails. Image, fetch, iframe and popup vectors likewise return `vector_initiated` only after initiating the action. A null popup fails. Any unexpected evaluate/script/renderer/protocol rejection propagates, and every context closure must succeed.

The blob worker first reports `worker_fetch_initiated`, then reports that its fetch settled, before the script terminates it. This avoids cancelling the baseline request before the canary can receive it. A worker script error, missing acknowledgement or unexpected worker message fails. Only a constructor-thrown DOMException with the exact name `SecurityError` may be returned as the fixed `worker_security_denied` outcome for a restricted attempt; no raw exception is echoed. In this revised run both workers instead returned `vector_initiated` with the full worker acknowledgements, and the baseline received its request.

The restricted browser then loaded a fixed `setContent` form with CSP and an abort-all request interceptor as additional restrictions. It verified:

- Synthetic Chinese text input, Backspace, and a coordinate click produced the expected form result.
- A bounded wheel event scrolled the page.
- The retained Page, Target and BrowserContext matched; the page stayed open at `about:blank`, had one frame and retained its per-run document marker before and after input and screenshot.
- The screenshot was an 800 × 600 PNG of 2,728 bytes, validated in memory, zeroed afterward and never written to disk or included in output. The fixture attempted zero network requests.

A third browser deliberately threw an error after launch to exercise the same cleanup path on failure. All three browser receipts confirmed:

- `--remote-debugging-pipe` and the exact fresh profile were present; no `--remote-debugging-port`, `--no-sandbox` or `--disable-setuid-sandbox` argument was present.
- `/usr/sbin/lsof`, filtered to the owned Chrome PID, found no TCP listeners. No unrelated process arguments or socket records were printed.
- `browser.close()` completed gracefully, the owned process exited, and the original owned profile directory was deleted. The script refuses to delete a replaced directory or a profile whose owned browser still runs.

The parameter-guard self-check was observed failing before the guard was implemented, then passing. The evaluate-rejection regression was also observed red with the old swallow-error behavior (exit 1, no browsers started), then green after requiring acknowledgements and propagating rejection. The completed script passed `npm run typecheck`, the no-browser self-check and the revised seven-vector real-browser assertions. This is experiment evidence, not an extension of the production control-route test claims.

## Restriction contract and limits

The launch restriction is the JavaScript source value `allowlist: ["about\\:blank"]`. The escaped colon is required by the URLPattern string grammar; `about:blank` without that escape is not the same pattern. An empty allowlist means no restriction. The browser remains managed by Puppeteer over its private pipe; the script never exposes a WebSocket/CDP endpoint.

[Puppeteer ConnectOptions](https://pptr.dev/api/puppeteer.connectoptions) describes allowlist as experimental, requiring Chrome 149+, and applying through Chrome's network service to navigation and subresource requests. It explicitly says this is an additional guardrail, not a complete network sandbox. The fixed-version implementation can swallow errors while installing network conditions, so a successful `launch` is insufficient evidence; this script's canary experiment is required. See [NetworkRestrictions](https://pptr.dev/api/puppeteer.networkrestrictions) and the [25.16.0 implementation](https://github.com/puppeteer/puppeteer/blob/puppeteer-v25.16.0/packages/puppeteer-core/src/cdp/TargetManager.ts).

This experiment does not prove OS-level egress isolation, absence of Chrome background traffic, isolation from arbitrary same-UID shell access or global administration, host-worker crash reconciliation, cleanup after launch failure, SIGKILL or machine failure, mobile frame/input delivery, control-token race handling, or production browser-lease behavior. The intentional failure is a caught callback error injected after a successful launch in a live process, not a launch failure or worker crash. The TCP check covers the owned browser PID during the probe, not every renderer/helper process. The 700 ms canary observation is bounded fixture evidence, not a claim about all possible request timing or browser features.

It also does not prove that any real IdP permits or supports this flow. [Chrome's unified headless implementation](https://developer.chrome.com/docs/automation-and-testing/headless) does not establish compatibility with every IdP, MFA method, WebAuthn device, anti-automation policy or native OS prompt. Real-phone pairing remains a separate gate; no page reload or real login was performed.

Public APIs used include [launch/pipe/profile options](https://pptr.dev/api/puppeteer.launchoptions), [isolated contexts](https://pptr.dev/api/puppeteer.browser.createbrowsercontext), [request interception](https://pptr.dev/api/puppeteer.page.setrequestinterception), [CSS-pixel mouse input](https://pptr.dev/api/puppeteer.mouse), [text input](https://pptr.dev/api/puppeteer.keyboard.sendcharacter), [in-memory screenshot](https://pptr.dev/api/puppeteer.page.screenshot), and [browser.close](https://pptr.dev/api/puppeteer.browser.close). `disconnect()` is not cleanup: it leaves the browser process running.
