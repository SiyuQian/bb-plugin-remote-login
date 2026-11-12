import assert from "node:assert/strict";
import test from "node:test";
import { createPairingKey, pairingFingerprint } from "../pairing-key.ts";

test("phone pairing fingerprint matches the domain-separated owner fixture", async () => {
  assert.equal(await pairingFingerprint("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    "a9c4f1b05534fc01b30a65ef34a7bf09500d112aaf4e7169647049640365a7d9");
});

test("phone generates independent canonical 32-byte control keys", async () => {
  const first = await createPairingKey();
  const second = await createPairingKey();
  for (const value of [first, second]) {
    assert.match(value.key, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(value.key, "base64url").length, 32);
    assert.equal(value.fingerprint, await pairingFingerprint(value.key));
  }
  assert.notEqual(first.key, second.key);
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test("phone rejects malformed and noncanonical pairing keys", async () => {
  for (const value of ["", "short", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", " AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]) {
    await assert.rejects(pairingFingerprint(value), /Invalid pairing key/);
  }
});
