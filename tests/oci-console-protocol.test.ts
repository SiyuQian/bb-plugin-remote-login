import assert from "node:assert/strict";
import test from "node:test";
import { consoleExpectedIdentitySchema, consoleSourcePins, consoleBuild } from "../oci-console-protocol.ts";

const expected = { mode: "oci_web", userOcid: "ocid1.user.oc1..fixtureuser", tenancyOcid: "ocid1.tenancy.oc1..fixturetenancy", domainOcid: "ocid1.domain.oc1..fixturedomain", domainOrigin: "https://idcs-fixture.identity.oraclecloud.com", region: "ap-sydney-1", realm: "oc1" } as const;

test("Console target requires independently selected canonical identity and one exact reviewed domain origin", () => {
  assert.deepEqual(consoleExpectedIdentitySchema.parse(expected), expected);
  for (const patch of [
    { domainOrigin: "https://evil.invalid" }, { domainOrigin: "https://idcs-fixture.identity.oraclecloud.com/path" },
    { domainOrigin: "https://idcs-fixture.identity.oraclecloud.com:8443" }, { domainOrigin: "https://user:pass@idcs-fixture.identity.oraclecloud.com" },
    { domainOrigin: "http://idcs-fixture.identity.oraclecloud.com" }, { domainOrigin: "https://a.b.identity.oraclecloud.com" },
    { userOcid: "fixtureuser" }, { tenancyOcid: expected.userOcid }, { domainOcid: expected.tenancyOcid },
    { region: "us-phoenix-1" }, { realm: "oc2" }, { mode: "oci_cli" }, { verified: true },
  ]) assert.equal(consoleExpectedIdentitySchema.safeParse({ ...expected, ...patch }).success, false);
});

test("Console source inventory pins four public scripts from one shell build without account endpoints", () => {
  assert.equal(consoleBuild, "4.26.2hotfix.2");
  assert.equal(consoleSourcePins.length, 4);
  for (const source of consoleSourcePins) {
    const url = new URL(source.url);
    assert.equal(url.origin, "https://cloud.oracle.com");
    assert.ok(url.pathname.startsWith("/plugins/console/4.26.2hotfix.2/js/"));
    assert.equal(url.search, "");
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Object.isFrozen(source));
  }
  assert.ok(Object.isFrozen(consoleSourcePins));
});
