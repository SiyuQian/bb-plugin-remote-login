import assert from "node:assert/strict";
import test from "node:test";
import { cliExpectedIdentitySchema } from "../oci-cli-protocol.ts";

// Independently invented identifiers; no account configuration is used by these tests.
const EXPECTED = {
  mode: "oci_cli", tenancyOcid: "ocid1.tenancy.oc1..fixturetenancy", userOcid: "ocid1.user.oc1..fixtureuser",
  region: "ap-auckland-1", realm: "oc1",
};

test("CLI expectations preserve independently selected account and region values", () => {
  assert.deepEqual(cliExpectedIdentitySchema.parse(EXPECTED), EXPECTED);
  const other = { ...EXPECTED, tenancyOcid: "ocid1.tenancy.oc1..otherfixture", userOcid: "ocid1.user.oc1..otherfixture" };
  assert.deepEqual(cliExpectedIdentitySchema.parse(other), other);
  assert.notDeepEqual(cliExpectedIdentitySchema.parse(other), cliExpectedIdentitySchema.parse(EXPECTED));
});

test("tenancy and user fields reject swapped or unrelated OCID resource types", () => {
  for (const changed of [
    { tenancyOcid: EXPECTED.userOcid }, { userOcid: EXPECTED.tenancyOcid },
    { tenancyOcid: "ocid1.compartment.oc1..fixture" }, { userOcid: "ocid1.instance.oc1.ap-auckland-1.fixture" },
    { userOcid: "fixtureuser" }, { tenancyOcid: "fixturetenancy" },
  ]) assert.equal(cliExpectedIdentitySchema.safeParse({ ...EXPECTED, ...changed }).success, false);
});

test("CLI expectations cannot stand in for Console or synthetic identity", () => {
  for (const mode of ["oci_web", "synthetic", "OCI_CLI", undefined]) {
    assert.equal(cliExpectedIdentitySchema.safeParse({ ...EXPECTED, mode }).success, false);
  }
});

test("unreviewed realms and noncanonical values fail without normalization", () => {
  for (const changed of [
    { realm: "oc2" }, { realm: "OC1" }, { userOcid: "ocid1.user.oc2..fixtureuser" },
    { tenancyOcid: "ocid1.tenancy.oc2..fixturetenancy" }, { userOcid: ` ${EXPECTED.userOcid}` },
    { tenancyOcid: `${EXPECTED.tenancyOcid}\n` }, { region: "AP-AUCKLAND-1" },
    { region: "https://fixture.invalid" }, { region: "ap-auckland-1\n" },
    { userOcid: `ocid1.user.oc1..${"a".repeat(513)}` }, { region: "a".repeat(65) },
  ]) assert.equal(cliExpectedIdentitySchema.safeParse({ ...EXPECTED, ...changed }).success, false);
});

test("expectations admit no credentials, artifact selectors, claims or success flags", () => {
  for (const field of [
    "token", "privateKey", "cookie", "configFile", "profile", "url", "subject", "tenant",
  ]) {
    assert.equal(cliExpectedIdentitySchema.safeParse({ ...EXPECTED, [field]: "fixture" }).success, false, field);
  }
  for (const field of ["onlineAccepted", "verified"]) {
    assert.equal(cliExpectedIdentitySchema.safeParse({ ...EXPECTED, [field]: true }).success, false, field);
  }
});
