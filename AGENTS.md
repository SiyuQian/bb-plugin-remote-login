# Remote Login plugin

Scope: independent BB plugin, public SDK only. Do not modify BB core, installed app files, or builtin plugins.

- Read README.md and docs/capabilities.md before implementation. P0 is a probe, not a working login product.
- Keep CLI tokens and browser cookies separate. Never put credentials or authentication screenshots in logs, tools, fixtures, or metadata.
- Client RPC identity does not prove a human. Do not enable sensitive input until the human-control gate has evidence.
- Use host RPC with an explicit hostId for host operations. Do not default to the server machine.
- Build: npm run typecheck; npm test; npm run build. Runtime SDK version is pinned in package.json.
- Tests use Node's test runner and the public SDK harness. Fake-host success is not evidence of real mobile login or production resume delivery.
- Public documentation is indexed in README.md. Keep evidence and limitations accurate.
- LoginCoordinator construction must remain inert; activate only after plugin commit. Keep SQL and cleanup outbox atomic, fence old owners, and never accept public verification/delivery flags. Read docs/login-coordinator.md before changing job or resume behavior.
