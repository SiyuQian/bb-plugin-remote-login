import { generateKeyPairSync } from "node:crypto";

export const fixtureTarget = { mode: "oci_cli", tenancyOcid: "ocid1.tenancy.oc1..fixturetenancy", userOcid: "ocid1.user.oc1..fixtureuser", region: "ap-sydney-1", realm: "oc1" } as const;
export const { privateKey: fixturePrivateKey, publicKey: fixturePublicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" },
});
export const fixtureToken = (claims: unknown = { sub: fixtureTarget.userOcid, tenant: fixtureTarget.tenancyOcid, exp: 0 }) => `${Buffer.from('{"alg":"RS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.bm9uLXJlZGVlbWFibGU`;

// Only the external HTTP boundary is replaced. The SDK still constructs/signs
// its real request from the supplied key and exact non-redeemable JWT bytes.
export type TransportBehavior = "accept" | "reject" | "delay" | "header_error" | "redirect";
export function transportFixture(snapshotToken: string, behavior: TransportBehavior = "accept") {
  return String.raw`import builtins, sys
_original_import = builtins.__import__
_fixture_patched = False
_fixture_calls = 0
def _no_external_activity(event, args):
    if event in ("socket.connect", "socket.getaddrinfo"):
        os._exit(97)
sys.addaudithook(_no_external_activity)
def _fixture_send(self, request, **kwargs):
    global _fixture_calls
    _fixture_calls += 1
    import base64, json, re, time
    from cryptography.hazmat.primitives import serialization, hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    from oci._vendor.requests import Response
    assert request.method == "GET"
    assert request.url == "https://identity.ap-sydney-1.oci.oraclecloud.com/20160918/regions"
    assert self.trust_env is False and self.proxies == {} and self.verify is True and self.cert is None
    assert self.max_redirects == 0 and kwargs.get("verify") is True and kwargs.get("proxies") == {}
    assert len(kwargs["timeout"]) == 2 and all(0 < value <= 3 for value in kwargs["timeout"])
    auth = request.headers["authorization"]
    fields = dict(re.findall(r'(\w+)="([^"]*)"', auth))
    assert fields["keyId"] == "ST$" + ${JSON.stringify(snapshotToken)}
    assert fields["algorithm"] == "rsa-sha256" and fields["headers"] == "date (request-target) host"
    message = ("date: " + request.headers["date"] + "\n(request-target): get /20160918/regions\nhost: identity.ap-sydney-1.oci.oraclecloud.com").encode("ascii")
    fixture_public = serialization.load_pem_public_key(${JSON.stringify(fixturePublicKey)}.encode("ascii"))
    fixture_public.verify(base64.b64decode(fields["signature"]), message, padding.PKCS1v15(), hashes.SHA256())
    if ${JSON.stringify(behavior)} == "delay":
        time.sleep(60)
    if ${JSON.stringify(behavior)} == "header_error" and _fixture_calls == 1:
        from urllib3.exceptions import HeaderParsingError
        raise HeaderParsingError([], "private backend detail")
    response = Response()
    response.status_code = 401 if ${JSON.stringify(behavior)} == "reject" else 200
    if ${JSON.stringify(behavior)} == "redirect" and _fixture_calls == 1:
        response.status_code = 302
        response.headers["location"] = request.url
    response._content = b'{"code":"NotAuthenticated","message":"private backend detail"}' if response.status_code == 401 else b'[]'
    response.headers["content-type"] = "application/json"
    response.headers["opc-request-id"] = "fixture-private-request"
    response.request = request
    response.url = request.url
    return response
def _fixture_import(name, globals=None, locals=None, fromlist=(), level=0):
    global _fixture_patched
    result = _original_import(name, globals, locals, fromlist, level)
    if name == "oci.identity" and not _fixture_patched:
        _fixture_patched = True
        sys.modules["oci._vendor.requests"].Session.send = _fixture_send
    return result
builtins.__import__ = _fixture_import
`;
}
