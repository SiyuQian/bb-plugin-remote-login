/** Reviewed public runtime files; these pins do not cover the complete dependency graph. */
export const OCI_VERIFIER_SDK_SOURCE_PINS = {
  "oci/__init__.py": "add3ef3c63597f30d5fd5e11316d378318d907fbdbd5bdc2fedf881a5ded4814",
  "oci/version.py": "76806291a38284732d3648cc1a99cab66d10117e94d37271986e4b1ffa96e547",
  "oci/signer.py": "325faa41fe9c326d1ecdf96b8a99549c00509d7f2322e843be0b083e978988aa",
  "oci/auth/signers/security_token_signer.py": "b8181717f87a4638c3fe424fcd9733849feadfc2c9aa802a45f17c06fd30eb91",
  "oci/identity/identity_client.py": "a472016e2fb9babb1355ec70ac2c40d55dee24dcb9e3305e53ada13bdd59d227",
  "oci/base_client.py": "5977c0bfc6683442de03fe46dcdb5a37384574f1050ec8f92820a1bd77e77ee0",
  "oci/config.py": "f4fe4aaa2184f152901621a3d7e0896076c4927fd4a6447e1661e38f72474d37",
  "oci/regions_definitions.py": "be7b03cbbedc4d21de7e6bc402a89733e941886ab39a14e92b7f74c619773709",
  "oci/developer_tool_configuration.py": "cc33bba51a38edbac114ff730f98e06af2682925b730dea33ea426740b792bfa",
  "oci/retry/__init__.py": "a68b51415ae2cc5b32ceb45127bb8804d42e06fd8ef759ce4bdbefb1e197f13d",
  "oci/retry/retry.py": "d1405b4c7caff635dc540b119009c30a50b48ac37091a2e9cbd775cf904d36c9",
  "oci/_vendor/requests/sessions.py": "b5339d0afd9d1a0af5e1b7d79ac965d83086de28dd85111696d047a8dae51988",
  "oci/_vendor/requests/adapters.py": "ff07111376e6221b6e4d5b640f1f7b682d527e1b69c556feeee935bd246e1bfa",
  "urllib3/connectionpool.py": "b0616775d5d8c25c7b282e0908fd602af74d18b34af984c22437460021a3dd8f",
  "urllib3/util/connection.py": "2633bbdb69731e5ccb5cf4e4afd65605d86c7979cc5633126f50c92d5ad74a74",
} as const;

/** Shared inert SDK bootstrap, audit policy and private protocol; fixed worker programs append their entry. */
export const OCI_SDK_RUNTIME_SOURCE = String.raw`
import os
import sys

_null = os.open(os.devnull, os.O_RDWR)
for _fd in (0, 1, 2):
    os.dup2(_null, _fd)
if _null > 4:
    os.close(_null)
os.environ.clear()
os.environ.update({
    "OCI_DEVELOPER_TOOL_CONFIGURATION_FILE_PATH": "/dev/null",
    "OCI_PYTHON_SDK_NO_SERVICE_IMPORTS": "true",
    "OCI_HEADER_PARSING_ERROR_MAX_RETRIES": "0",
})
sys.dont_write_bytecode = True

import base64
import hashlib
import importlib.machinery
import json
import logging
import re
import select
import socket
import stat
import threading
import time

logging.disable(logging.CRITICAL)

_PACKAGES = "/opt/homebrew/Cellar/oci-cli/3.88.0/libexec/lib/python3.14/site-packages"
_STDLIB = "/opt/homebrew/Cellar/python@3.14/3.14.6/Frameworks/Python.framework/Versions/3.14/lib/python3.14"
_DEPENDENCIES = (
    "/opt/homebrew/Cellar/certifi/2026.10.23/lib/python3.15/site-packages",
    "/opt/homebrew/Cellar/cryptography/50.0.2_2/lib/python3.14/site-packages",
    "/opt/homebrew/Cellar/cffi/2.1.1_1/lib/python3.14/site-packages",
    "/opt/homebrew/Cellar/pycparser/3.12/lib/python3.15/site-packages",
)
_CA = "/opt/homebrew/etc/ca-certificates/cert.pem"
_CA_SHA256 = "f356a97fb33148de963979b5b164c0b8de13c5bfe0ffe913ef68208d6364a419"
_PINS = ${JSON.stringify(OCI_VERIFIER_SDK_SOURCE_PINS)}
_HOST = "identity.ap-sydney-1.oci.oraclecloud.com"
_ENDPOINT = "https://" + _HOST
_PUBLIC_ROOTS = (_PACKAGES, _STDLIB) + _DEPENDENCIES
_PUBLIC_FILES = (_CA, "/System/Library/CoreServices/SystemVersion.plist")
_phase = "imports"
_addresses = set()

def _audit(event, args):
    if event == "import" and args[0].split(".")[0] == "oci_cli":
        raise PermissionError()
    if event == "open":
        path, mode, flags = args
        if type(path) not in (str, bytes) or flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
            raise PermissionError()
        resolved = os.path.realpath(os.fsdecode(path))
        # Import source rather than an unchecked timestamp-valid bytecode cache.
        if resolved.endswith((".pyc", ".pyo")):
            raise PermissionError()
        if resolved not in _PUBLIC_FILES and not any(resolved.startswith(root + "/") for root in _PUBLIC_ROOTS):
            raise PermissionError()
    if event in ("subprocess.Popen", "os.system", "os.posix_spawn", "os.fork", "os.forkpty", "os.exec", "builtins.input", "ctypes.dlopen"):
        # ctypes.util imports the fixed macOS C library; inherited crypto-library overrides are excluded.
        if event != "ctypes.dlopen" or args[0] not in (None, "/usr/lib/libc.dylib"):
            raise PermissionError()
    if event == "socket.getaddrinfo":
        if _phase != "online" or args[0] != _HOST or args[1] != 443:
            raise PermissionError()
    elif event == "socket.connect":
        address = args[1]
        if _phase != "online" or type(address) is not tuple or (address[0], address[1]) not in _addresses:
            raise PermissionError()
    elif event.startswith("socket.") and event not in ("socket.__new__", "socket.gethostname"):
        raise PermissionError()
    elif event == "socket.__new__" and _phase != "online":
        raise PermissionError()

# Policy precedes every installed SDK/dependency import and every public pin read.
sys.addaudithook(_audit)
sys.path[:] = [_PACKAGES, *_DEPENDENCIES, _STDLIB, _STDLIB + "/lib-dynload"]

_getaddrinfo = socket.getaddrinfo
def _fixed_getaddrinfo(host, port, *args, **kwargs):
    if host != _HOST or port != 443:
        raise PermissionError()
    answers = _getaddrinfo(host, port, *args, **kwargs)
    for answer in answers:
        _addresses.add((answer[4][0], answer[4][1]))
    return answers
socket.getaddrinfo = _fixed_getaddrinfo

class Refused(Exception):
    def __init__(self, reason):
        self.reason = reason

def _strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result

def _invalid_constant(value):
    raise ValueError()

def _json(raw):
    return json.loads(raw, object_pairs_hook=_strict_object, parse_constant=_invalid_constant)

class Runtime:
    def __init__(self):
        self.attempt = None
        self.buffer = b""
        self.deadline = time.monotonic() + 8.0
        self.finished = False
        self.lock = threading.Lock()
        for fd in (3, 4):
            mode = os.fstat(fd).st_mode
            if not (stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode)):
                raise Refused("private_channel")
            os.set_blocking(fd, False)

    def packet(self, match, reason):
        return {"version": 1, "type": "result", "attemptId": self.attempt, "match": match, "reason": reason}

    def finish(self, match, reason):
        with self.lock:
            if self.finished:
                return
            self.finished = True
            if match and time.monotonic() >= self.deadline:
                match, reason = False, "deadline"
            data = (json.dumps(self.packet(match, reason), separators=(",", ":")) + "\n").encode("ascii")
            end = time.monotonic() + 0.25
            try:
                while data:
                    remaining = end - time.monotonic()
                    if remaining <= 0 or not select.select([], [4], [], remaining)[1]:
                        break
                    count = os.write(4, data)
                    if count <= 0:
                        break
                    data = data[count:]
            except (OSError, ValueError):
                pass
        os._exit(0)

    def line(self, limit):
        while b"\n" not in self.buffer:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise Refused("deadline")
            if not select.select([3], [], [], min(remaining, 0.05))[0]:
                continue
            data = os.read(3, min(limit + 1, 65536))
            if not data:
                raise Refused("private_channel")
            self.buffer += data
            if len(self.buffer.split(b"\n", 1)[0]) > limit:
                raise Refused("configuration")
        raw, self.buffer = self.buffer.split(b"\n", 1)
        if len(raw) > limit:
            raise Refused("configuration")
        try:
            result = _json(raw.decode("utf-8"))
        except (ValueError, UnicodeError, RecursionError):
            raise Refused("configuration")
        if type(result) is not dict:
            raise Refused("configuration")
        return result

    def configure(self, config=None):
        if config is None:
            config = self.line(4 * 1024 * 1024)
        attempt = config.get("attemptId")
        if type(attempt) is str and re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", attempt):
            self.attempt = attempt
        if set(config) != {"version", "type", "attemptId", "timeoutMs", "expected", "token", "key"} or self.attempt is None or type(config["version"]) is not int or config["version"] != 1 or config["type"] != "verify":
            raise Refused("configuration")
        timeout = config["timeoutMs"]
        if type(timeout) is not int or not 100 <= timeout <= 30000:
            raise Refused("configuration")
        self.deadline = time.monotonic() + timeout / 1000
        expected = config["expected"]
        if type(expected) is not dict or set(expected) != {"mode", "tenancyOcid", "userOcid", "region", "realm"}:
            raise Refused("configuration")
        for name, kind in (("tenancyOcid", "tenancy"), ("userOcid", "user")):
            value = expected[name]
            if type(value) is not str or len(value) > 512 or not re.fullmatch(r"ocid1\." + kind + r"\.oc1\.\.[a-z0-9]+", value):
                raise Refused("configuration")
        if expected["mode"] != "oci_cli" or expected["realm"] != "oc1" or type(expected["region"]) is not str or len(expected["region"]) > 64 or not re.fullmatch(r"[a-z]{2}-[a-z0-9]+-[1-9][0-9]*", expected["region"]):
            raise Refused("configuration")
        if expected["region"] != "ap-sydney-1":
            raise Refused("unsupported_region")
        snapshots = []
        for name, bound in (("token", 65536), ("key", 16384)):
            value = config[name]
            if type(value) is not str or len(value) > ((bound + 2) // 3) * 4:
                raise Refused("configuration")
            try:
                decoded = base64.b64decode(value, validate=True)
            except (ValueError, UnicodeError):
                raise Refused("configuration")
            if not 0 < len(decoded) <= bound or base64.b64encode(decoded).decode("ascii") != value:
                raise Refused("configuration")
            snapshots.append(decoded)
        threading.Thread(target=self.watch, daemon=True).start()
        return expected, snapshots[0], snapshots[1]

    def watch(self):
        try:
            command = self.line(512)
            if command != {"version": 1, "type": "cancel", "attemptId": self.attempt} or type(command["version"]) is not int:
                raise Refused("configuration")
            self.finish(False, "cancelled")
        except Refused as error:
            self.finish(False, error.reason)
        except BaseException:
            self.finish(False, "private_channel")

def _pin(path, expected):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 2 * 1024 * 1024:
            raise Refused("sdk")
        data = bytearray()
        while len(data) <= 2 * 1024 * 1024:
            part = os.read(fd, min(65536, 2 * 1024 * 1024 + 1 - len(data)))
            if not part:
                break
            data.extend(part)
        if len(data) > 2 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != expected:
            raise Refused("sdk")
        return bytes(data)
    finally:
        os.close(fd)

def _claims(token):
    try:
        parts = token.split(".")
        if len(parts) != 3 or any(not re.fullmatch(r"[A-Za-z0-9_-]+", part) for part in parts):
            raise ValueError()
        raw = base64.b64decode(parts[1] + "=" * (-len(parts[1]) % 4), altchars=b"-_", validate=True)
        value = _json(raw.decode("utf-8"))
        if type(value) is not dict:
            raise ValueError()
        return value
    except (ValueError, UnicodeError, RecursionError):
        raise Refused("token")

def _sdk_signer(token_bytes, key_bytes):
    try:
        sources = {_PACKAGES + "/" + path: _pin(_PACKAGES + "/" + path, digest) for path, digest in _PINS.items()}
        _pin(_CA, _CA_SHA256)
        original_get_code = importlib.machinery.SourceFileLoader.get_code
        def source_code(loader, fullname):
            if loader.path in sources:
                return compile(sources[loader.path], loader.path, "exec", dont_inherit=True)
            return original_get_code(loader, fullname)
        importlib.machinery.SourceFileLoader.get_code = source_code
        import oci
        from oci.signer import load_private_key
        from oci.auth.signers import SecurityTokenSigner
        if oci.__version__ != "2.180.0":
            raise Refused("sdk")
    except BaseException:
        raise Refused("sdk")
    try:
        key = load_private_key(key_bytes, pass_phrase=None)
        from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey
        if not isinstance(key, RSAPrivateKey) or not 2048 <= key.key_size <= 8192:
            raise ValueError()
    except BaseException:
        raise Refused("key")
    try:
        token = token_bytes.decode("ascii")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", token):
            raise ValueError()
    except (ValueError, UnicodeError):
        raise Refused("token")
    return token, SecurityTokenSigner(token, key)
`;

/** Inert source asset. Only a separately gated, fenced private worker may run it. */
export const OCI_VERIFIER_SOURCE = OCI_SDK_RUNTIME_SOURCE + String.raw`
def verify(runtime):
    global _phase
    expected, token_bytes, key_bytes = runtime.configure()
    token, signer = _sdk_signer(token_bytes, key_bytes)
    from oci.identity import IdentityClient
    from oci.retry import NoneRetryStrategy
    from oci.circuit_breaker import NoCircuitBreakerStrategy
    try:
        remaining = runtime.deadline - time.monotonic()
        if remaining <= 0:
            raise Refused("deadline")
        timeout = max(0.001, min(3.0, remaining))
        client = IdentityClient({"region": "ap-sydney-1", "log_requests": False}, signer=signer,
            service_endpoint=_ENDPOINT, timeout=(timeout, timeout), retry_strategy=NoneRetryStrategy(),
            circuit_breaker_strategy=NoCircuitBreakerStrategy(), client_level_realm_specific_endpoint_template_enabled=False,
            client_level_dualstack_endpoints_enabled=False)
        session = client.base_client.session
        session.trust_env = False
        session.proxies = {}
        session.verify = True
        session.cert = None
        session.max_redirects = 0
        _phase = "online"
        try:
            response = client.list_regions(retry_strategy=NoneRetryStrategy())
        finally:
            _phase = "complete"
            session.close()
        if not 200 <= response.status <= 299:
            raise Refused("rejected")
    except Refused:
        raise
    except BaseException:
        raise Refused("rejected")
    # Decode only the exact token already accepted by the service. Claims alone confer no authority.
    claims = _claims(token)
    if type(claims.get("sub")) is not str or type(claims.get("tenant")) is not str or claims["sub"] != expected["userOcid"] or claims["tenant"] != expected["tenancyOcid"]:
        raise Refused("identity_mismatch")
    if time.monotonic() >= runtime.deadline:
        raise Refused("deadline")
    runtime.finish(True, "matched")

_runtime = None
try:
    _runtime = Runtime()
    verify(_runtime)
except Refused as _error:
    if _runtime is not None:
        _runtime.finish(False, _error.reason)
except BaseException:
    if _runtime is not None:
        _runtime.finish(False, "sdk")
os._exit(0)
`;
