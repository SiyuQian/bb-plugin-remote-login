import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Duplex, Readable } from "node:stream";
import test from "node:test";
import { fixturePrivateKey as privateKey, fixtureTarget as target, fixtureToken as token, transportFixture, type TransportBehavior } from "./oci-verifier-fixture.ts";

const supported = process.platform === "darwin" && process.arch === "arm64";
const python = "/opt/homebrew/Cellar/oci-cli/3.88.0/libexec/bin/python";
const matchingToken = token();

async function runVerifier(options: { token?: string; key?: string; expected?: unknown; behavior?: TransportBehavior; timeoutMs?: number; extra?: Record<string, unknown>; cancel?: boolean; prelude?: string; raw?: string } = {}) {
  const { OCI_VERIFIER_SOURCE } = await import("../oci-verifier-source.ts");
  const attemptId = randomUUID();
  const snapshotToken = options.token ?? matchingToken;
  const child = spawn(python, ["-I", "-S", "-c", transportFixture(snapshotToken, options.behavior) + (options.prelude ?? "") + OCI_VERIFIER_SOURCE], {
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", OCI_CLI_AUTH: "instance_principal", OCI_REGION_METADATA: "private poison", HTTP_PROXY: "http://127.0.0.1:1", REQUESTS_CA_BUNDLE: "/nonexistent/private" },
  });
  const commands = child.stdio[3] as Duplex;
  commands.on("error", () => {});
  let output = "", stdout = "", stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  (child.stdio[4] as Readable).on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const complete = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject); child.once("close", resolve);
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 6000);
  commands.write(options.raw ?? JSON.stringify({ version: 1, type: "verify", attemptId, timeoutMs: options.timeoutMs ?? 4000, expected: options.expected ?? target,
    token: Buffer.from(snapshotToken).toString("base64"), key: Buffer.from(options.key ?? privateKey).toString("base64"), ...options.extra }) + "\n");
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  if (options.cancel) cancelTimer = setTimeout(() => commands.write(JSON.stringify({ version: 1, type: "cancel", attemptId }) + "\n"), 600);
  const code = await complete.finally(() => { clearTimeout(deadline); clearTimeout(cancelTimer); });
  assert.equal(stdout, ""); assert.equal(stderr, "");
  assert.ok(Buffer.byteLength(output) < 1024);
  const records = output.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(records.length, 1);
  const result = records[0]!;
  assert.deepEqual(Object.keys(result).sort(), ["attemptId", "match", "reason", "type", "version"]);
  assert.equal(result.attemptId, attemptId); assert.equal(result.type, "result"); assert.equal(result.version, 1);
  assert.equal(code, 0);
  return result;
}

test("fixed verifier accepts only the same snapshot signed by the real SDK and accepted at its HTTP boundary", { skip: !supported }, async () => {
  const result = await runVerifier();
  assert.equal(result.match, true); assert.equal(result.reason, "matched");
});

test("matching local claims cannot verify a request the service rejected", { skip: !supported }, async () => {
  const result = await runVerifier({ behavior: "reject" });
  assert.equal(result.match, false); assert.equal(result.reason, "rejected");
});

test("an accepted snapshot must match both independently selected OCIDs", { skip: !supported }, async () => {
  for (const claims of [{ sub: "ocid1.user.oc1..other", tenant: target.tenancyOcid }, { sub: target.userOcid, tenant: "ocid1.tenancy.oc1..other" }, { sub: target.userOcid }]) {
    const result = await runVerifier({ token: token(claims) });
    assert.equal(result.match, false); assert.equal(result.reason, "identity_mismatch");
  }
});

test("caller endpoint, acceptance flags and unsupported regions cannot enter the SDK request", { skip: !supported }, async () => {
  for (const extra of [{ endpoint: "https://fixture.invalid" }, { onlineAccepted: true }]) {
    const result = await runVerifier({ extra });
    assert.equal(result.match, false); assert.equal(result.reason, "configuration");
  }
  const result = await runVerifier({ expected: { ...target, region: "us-ashburn-1" } });
  assert.equal(result.match, false); assert.equal(result.reason, "unsupported_region");
});

test("invalid and encrypted in-memory keys fail without prompting or exposing backend detail", { skip: !supported }, async () => {
  const { privateKey: encrypted } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "invented-fixture-only" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  for (const key of ["not a private key", encrypted]) {
    const result = await runVerifier({ key });
    assert.equal(result.match, false); assert.equal(result.reason, "key");
  }
});

test("malformed or duplicate accepted JWT claims fail closed", { skip: !supported }, async () => {
  const duplicate = `${matchingToken.split(".")[0]}.${Buffer.from(`{"sub":"${target.userOcid}","sub":"${target.userOcid}","tenant":"${target.tenancyOcid}"}`).toString("base64url")}.bm9uLXJlZGVlbWFibGU`;
  for (const value of ["not-a-jwt", duplicate, token({ sub: [target.userOcid], tenant: target.tenancyOcid })]) {
    const result = await runVerifier({ token: value });
    assert.equal(result.match, false); assert.ok(["token", "identity_mismatch"].includes(result.reason as string));
  }
});

test("deadline and cancellation terminate a blocked SDK transport with fixed private results", { skip: !supported }, async () => {
  for (const options of [{ timeoutMs: 800 }, { cancel: true }]) {
    const started = Date.now();
    const result = await runVerifier({ behavior: "delay", ...options });
    assert.equal(result.match, false); assert.equal(result.reason, "cancel" in options ? "cancelled" : "deadline");
    assert.ok(Date.now() - started < 3000);
  }
});

test("SDK import and request cannot read account files or spawn another process", { skip: !supported }, async () => {
  const prelude = String.raw`def _guard_import(name, globals=None, locals=None, fromlist=(), level=0):
    if name == "oci.identity":
        try:
            open("/nonexistent/fixture-account", "rb")
        except PermissionError:
            pass
        else:
            os._exit(96)
        try:
            open("/opt/homebrew/Cellar/oci-cli/3.88.0/libexec/lib/python3.14/site-packages/oci/__pycache__/__init__.cpython-314.pyc", "rb")
        except PermissionError:
            pass
        else:
            os._exit(96)
        for operation in (lambda: os.system("exit 0"), lambda: input("private prompt"), lambda: _original_import("oci_cli")):
            try:
                operation()
            except PermissionError:
                pass
            else:
                os._exit(96)
    return _fixture_import(name, globals, locals, fromlist, level)
builtins.__import__ = _guard_import
`;
  const result = await runVerifier({ prelude });
  assert.equal(result.match, true);
});

test("header parsing errors do not retry into a second accepted request", { skip: !supported }, async () => {
  const result = await runVerifier({ behavior: "header_error" });
  assert.equal(result.match, false); assert.equal(result.reason, "rejected");
});

test("redirects cannot turn the fixed validation request into a second accepted operation", { skip: !supported }, async () => {
  const result = await runVerifier({ behavior: "redirect" });
  assert.equal(result.match, false); assert.equal(result.reason, "rejected");
});

test("private request bounds and canonical base64 are enforced before SDK key parsing", { skip: !supported }, async () => {
  for (const extra of [{ timeoutMs: true }, { token: "invalid!" }, { key: "YQ" }, { key: Buffer.alloc(16385).toString("base64") }, { token: Buffer.alloc(65537).toString("base64") }]) {
    const result = await runVerifier({ extra });
    assert.equal(result.match, false); assert.equal(result.reason, "configuration");
  }
});
