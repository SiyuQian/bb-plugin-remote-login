# Login directly on the target host

The protected controller offers two explicit presentation choices for synthetic,
OCI CLI and OCI Console attempts:

| Choice | Human interaction | Browser presentation |
|---|---|---|
| Remote takeover (`remote`) | The protected BB controller sends bounded input against its displayed frame | Private headless browser on the selected host |
| Login on host (`host`) | The person operates the plugin-owned Chrome window directly | Fresh visible private browser on the selected host |

The choice describes where the person will operate the browser. It does not
identify where the current BB client is running. An agent command always runs on
a host, including when the person uses an iPhone. No user agent, IP address,
localhost test or command location automatically selects or authorizes a mode.

## User flow

1. Open the pending login controller or the matching login-session entry. Check
   the bound host and environment.
2. Choose **在 host 上直接登录** when physically using that target host's graphical
   desktop. Otherwise choose **远程接管**.
3. Authenticate with the independently provisioned control key. Both choices
   require the same owner authorization. The pairing page can generate the key
   on a desktop; a phone is not required.
4. Complete a protected synthetic attempt in the chosen mode before OCI use.
   In host mode, type into the visible test page and press its apply button,
   then return to BB and hand back. The worker verifies and closes its exact
   browser before writing acceptance.
5. For OCI, supply the independently confirmed expected identity through the
   private controller, start, and complete login in the owned window. Return to
   BB and choose **交还并授权只读**.

Configuration fixes the OCI mode before startup and persists it in the durable
non-secret record. Reopening a configured controller restores that choice.
Synthetic mode is persisted at startup. A running or configured attempt cannot
switch mode; cancel and create another attempt to change it. Mode-bound private
worker state independently enforces the same rule.

## Control and handback boundaries

Host mode never requests a screenshot, issues a frame reference or enables the
remote input form. The private gateway, host managers and browser drivers refuse
remote frame/input operations for that run. Hiding frontend controls alone is
not the enforcement boundary.

CLI handback acknowledges a renderer input fence before waiting for the owned
CLI callback to finish. It closes the owned browser before official validation
and independent service identity verification. Console acknowledges the same
renderer input fence before draining existing network activity and beginning
its restricted signed identity read. Its retained browser keeps that input
fence. A failed fence cannot produce successful handback.

The implementation uses CDP
[`Input.setIgnoreInputEvents`](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-setIgnoreInputEvents).
The fence applies to page-content input. Browser toolbar operations and other
processes under the same OS user are outside that isolation boundary. Existing
navigation, target, document and ownership checks continue to refuse changed
browser resources; a retained Console window closed or navigated by the user
cannot provide a valid continuing session.

Control receipts bind the tested presentation mode, control-root generation,
exact browser pin and 24-hour lifetime. Host acceptance cannot unlock remote
startup, or vice versa. A fresh protected fixture can replace a recognized old
browser-pin receipt; the old receipt itself grants no current acceptance.

Original-call completion, bounded read tasks, cancellation and owned cleanup use
the existing verifier and coordinator paths. A control key or the `host` choice
never verifies an Oracle account. The public SDK still provides no production
delivery acknowledgement; resumed results retain the existing `uncertain`
delivery status.

## Supported scope and acceptance limits

Both modes currently require macOS arm64 and exactly Chrome `157.0.8103.51`,
Puppeteer `25.16.0` and the other provider-specific runtime pins documented in
[OCI host flow](oci-host-flow.md) and [Console protocol](console-protocol.md).
Host mode additionally requires an accessible graphical desktop on that exact
host. A failed visible-window launch does not silently switch to remote mode.
The plugin does not attach to personal browser profiles or arbitrary existing
tabs and does not cover OS dialogs or unsupported SSO providers.

Automated checks use real visible owned Chrome windows, synthetic pages and
loopback provider/service fixtures. Renderer input fencing is exercised with
CDP-dispatched keyboard and mouse events. These checks do not establish native
OS event acceptance, real Oracle authentication, actual iPhone transport or
production result delivery. Building this source does not install or reload the
running BB plugin.
