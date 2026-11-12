import assert from "node:assert/strict";
import test from "node:test";

test("the method registry separates Console readiness from CLI source recognition and never enables unconfigured device grants", async () => {
  const api = await import("../provider-registry.ts").catch(() => null);
  assert.ok(api, "provider/runtime decisions must have an implemented registry");
  const runtime = { platform: "darwin", architecture: "arm64", chromeVersion: "157.0.8103.51", processInspection: true, cliSourceMatched: false };
  const report = api.assessLoginCapabilities(runtime);
  assert.deepEqual(report.providers.map(p => p.id), ["oci_cli", "oci_web", "oci_identity_domain_device", "oci_phone_callback"]);
  assert.deepEqual(report.providers[0].reasons, ["cli_source_unmatched"]);
  assert.equal(report.providers[1].availability, "candidate");
  assert.equal(report.providers[2].availability, "unavailable");
  assert.deepEqual(report.providers[2].reasons, ["provider_not_configured"]);
  assert.deepEqual(report.providers[3].reasons, ["callback_not_supported"]);
  assert.ok(report.providers.every(p => p.acceptance === "not_accepted"));
});

test("runtime readiness requires the exact reviewed host/browser and observable process ownership", async () => {
  const api = await import("../provider-registry.ts").catch(() => null); assert.ok(api);
  const base = { platform: "darwin", architecture: "arm64", chromeVersion: "157.0.8103.51", processInspection: true, cliSourceMatched: true };
  for (const [change, reason] of [
    [{ platform: "linux" }, "platform_unsupported"], [{ architecture: "x64" }, "platform_unsupported"],
    [{ chromeVersion: "158.0.0.0" }, "browser_pin_unmatched"], [{ chromeVersion: null }, "browser_pin_unmatched"],
    [{ processInspection: false }, "process_inspection_unavailable"],
  ] as const) {
    const report = api.assessLoginCapabilities({ ...base, ...change });
    for (const provider of report.providers.slice(0,2)) { assert.equal(provider.availability, "unavailable"); assert.ok(provider.reasons.includes(reason)); }
  }
  assert.ok(api.assessLoginCapabilities(base).providers.slice(0,2).every(p => p.availability === "candidate"));
});

test("public reports cannot enable device/callback methods, swap methods or carry unknown fields", async () => {
  const { loginCapabilitiesSchema } = await import("../provider-wire.ts");
  const { assessLoginCapabilities } = await import("../provider-registry.ts");
  const base = assessLoginCapabilities({ platform: "darwin", architecture: "arm64", chromeVersion: "157.0.8103.51", processInspection: true, cliSourceMatched: true });
  for (const edit of [
    (p: typeof base) => { p.providers[2].availability = "candidate"; p.providers[2].reasons = []; },
    (p: typeof base) => { p.providers[0].method = "device_code"; },
    (p: typeof base) => { p.providers[1].reasons = ["browser_pin_unmatched"]; },
    (p: typeof base) => { (p.providers[0] as unknown as Record<string,unknown>).token = "fixture-private"; },
  ]) { const report = structuredClone(base); edit(report); assert.equal(loginCapabilitiesSchema.safeParse(report).success, false); }
});
