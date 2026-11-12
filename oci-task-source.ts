import { OCI_SDK_RUNTIME_SOURCE } from "./oci-verifier-source.ts";

/** Fixed read-only programs use the same reviewed SDK signer, audit policy and private pipe runtime. */
export const OCI_TASK_SOURCE = OCI_SDK_RUNTIME_SOURCE + String.raw`
class TaskRuntime(Runtime):
    def __init__(self):
        super().__init__()
        self.result = None

    def packet(self, match, reason):
        return {"version": 1, "type": "result", "attemptId": self.attempt, "ok": match, "reason": reason,
                "result": self.result if match else None}

    def configure(self):
        value = self.line(4 * 1024 * 1024)
        if value.get("type") != "task" or "request" not in value or value.get("timeoutMs") != 5000:
            raise Refused("configuration")
        request = value.pop("request")
        value["type"] = "verify"
        expected, token, key = super().configure(value)
        if type(request) is not dict:
            raise Refused("configuration")
        operation = request.get("operation")
        if operation == "list_compartments":
            if set(request) != {"operation"}:
                raise Refused("configuration")
        elif operation == "list_instances":
            compartment = request.get("compartmentOcid")
            if set(request) != {"operation", "compartmentOcid"} or type(compartment) is not str or len(compartment) > 512 or not re.fullmatch(r"ocid1\.(compartment|tenancy)\.oc1\.\.[a-z0-9]+", compartment):
                raise Refused("configuration")
            if compartment.startswith("ocid1.tenancy.") and compartment != expected["tenancyOcid"]:
                raise Refused("configuration")
        else:
            raise Refused("configuration")
        self.request = request
        return expected, token, key

def _text(value, limit, redactions):
    if value is None:
        return ""
    if type(value) is not str:
        raise Refused("response")
    for private, replacement in redactions:
        if private:
            value = value.replace(private, replacement)
    value = "".join(c for c in value if ord(c) >= 32 and not (127 <= ord(c) <= 159 or 0x202a <= ord(c) <= 0x202e or 0x2066 <= ord(c) <= 0x2069))
    if re.search(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----", value):
        return "[credential]"
    for private, replacement in redactions:
        if private:
            value = value.replace(private, replacement)
    return value.encode("utf-8")[:limit].decode("utf-8", errors="ignore")

def task(runtime):
    global _HOST, _ENDPOINT, _phase
    expected, token_bytes, key_bytes = runtime.configure()
    operation = runtime.request["operation"]
    instances = operation == "list_instances"
    _HOST = "iaas.ap-sydney-1.oraclecloud.com" if instances else "identity.ap-sydney-1.oci.oraclecloud.com"
    _ENDPOINT = "https://" + _HOST
    token, signer = _sdk_signer(token_bytes, key_bytes)
    redactions = ((token, "[credential]"), (key_bytes.decode("ascii", errors="ignore"), "[credential]"),
                  (expected["userOcid"], "[account]"), (expected["tenancyOcid"], "[account]"))
    from oci.base_client import BaseClient
    from oci.retry import NoneRetryStrategy
    from oci.circuit_breaker import NoCircuitBreakerStrategy
    from urllib.parse import urlparse, parse_qs
    remaining = runtime.deadline - time.monotonic()
    if remaining <= 0:
        raise Refused("deadline")
    timeout = max(0.001, min(2.5, remaining))
    client = BaseClient("compute" if instances else "identity", {"region": "ap-sydney-1", "log_requests": False}, signer, {},
        regional_client=True, service_endpoint=_ENDPOINT, base_path="/20160918", timeout=(timeout, timeout),
        circuit_breaker_strategy=NoCircuitBreakerStrategy(), client_level_realm_specific_endpoint_template_enabled=False,
        client_level_dualstack_endpoints_enabled=False)
    session = client.session
    session.trust_env = False
    session.proxies = {}
    session.verify = True
    session.cert = None
    session.max_redirects = 0
    resource = "/instances" if instances else "/compartments"
    query = {"compartmentId": runtime.request["compartmentOcid"] if instances else expected["tenancyOcid"]}
    if not instances:
        query.update({"accessLevel": "ACCESSIBLE", "compartmentIdInSubtree": "true", "lifecycleState": "ACTIVE"})
    query["limit"] = "25"
    original_send = session.send
    def bounded_send(request, **kwargs):
        parsed = urlparse(request.url)
        if request.method != "GET" or parsed.scheme != "https" or parsed.netloc != _HOST or parsed.path != "/20160918" + resource or parsed.fragment or parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True) != {key: [value] for key, value in query.items()}:
            raise Refused("configuration")
        kwargs["stream"] = True
        kwargs["allow_redirects"] = False
        response = original_send(request, **kwargs)
        try:
            content = bytearray()
            for chunk in response.iter_content(chunk_size=8192):
                if len(content) + len(chunk) > 1048576:
                    raise Refused("response")
                content.extend(chunk)
            response._content = bytes(content)
            response._content_consumed = True
            return response
        finally:
            response.close()
    session.send = bounded_send
    _phase = "online"
    try:
        response = NoneRetryStrategy().make_retrying_call(client.call_api, resource_path=resource, method="GET",
            query_params=query, header_params={"accept": "application/json"}, response_type="stream", required_arguments=["compartmentId"])
        if not 200 <= response.status <= 299:
            raise Refused("rejected")
        claims = _claims(token)
        if claims.get("sub") != expected["userOcid"] or claims.get("tenant") != expected["tenancyOcid"]:
            raise Refused("identity_mismatch")
        values = _json(response.data.content.decode("utf-8"))
        if type(values) is not list:
            raise Refused("response")
        rows = []
        for value in values[:25]:
            if type(value) is not dict:
                raise Refused("response")
            identifier = value.get("id")
            pattern = r"ocid1\.instance\.oc1\.ap-sydney-1\.[a-z0-9]+" if instances else r"ocid1\.compartment\.oc1\.\.[a-z0-9]+"
            if type(identifier) is not str or len(identifier) > 512 or not re.fullmatch(pattern, identifier):
                raise Refused("response")
            if instances:
                rows.append({"id": identifier, "displayName": _text(value.get("displayName"), 128, redactions),
                    "lifecycleState": _text(value.get("lifecycleState"), 32, redactions), "shape": _text(value.get("shape"), 64, redactions),
                    "availabilityDomain": _text(value.get("availabilityDomain"), 128, redactions)})
            else:
                rows.append({"ocid": identifier, "name": _text(value.get("name"), 128, redactions)})
        runtime.result = {"operation": operation, "rows": rows, "truncated": len(values) > 25 or bool(response.headers.get("opc-next-page"))}
        if len(json.dumps(runtime.result).encode("ascii")) > 32768:
            raise Refused("response")
    except Refused:
        raise
    except BaseException:
        raise Refused("rejected")
    finally:
        _phase = "complete"
        session.close()
    runtime.finish(True, "matched")

_runtime = None
try:
    _runtime = TaskRuntime()
    task(_runtime)
except Refused as _error:
    if _runtime is not None:
        _runtime.finish(False, _error.reason)
except BaseException:
    if _runtime is not None:
        _runtime.finish(False, "sdk")
os._exit(0)
`;
