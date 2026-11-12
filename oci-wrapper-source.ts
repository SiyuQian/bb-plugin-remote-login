import { OCI_VERIFIER_SDK_SOURCE_PINS } from "./oci-verifier-source.ts";

/** Locally reviewed CLI import-chain pins; dependencies outside these lists remain installed-code trust. */
export const OCI_CHILD_CLI_SOURCE_PINS = {
  "oci_cli/__init__.py": "38f89c228e930c0d6dd6944770a719c639ec7880739dbccd5cb12603bba1d3a6",
  "oci_cli/cli_root.py": "f3e861c840ff516e82eb1ba12a89e5e14f0879f51e5ba9858ee3dc5cdd4a0f92",
  "oci_cli/cli_setup.py": "fbe53a3634e012685207343e79b409e4e1bcac27ecb3ae0829d1ba30d483e5ef",
  "oci_cli/cli_util.py": "8a649b409c17f85432867aa2746428acdb67ad79bea9e4c3442e296f3cf5e30f",
  "oci_cli/dynamic_loader.py": "d591465e18f7054395db21e525381c03bbe4db9ef8c7f5904bc84fadd65bcd5f",
  "oci_cli/final_command_processor.py": "f3987eaa409610b218294179f0e95e0bc64889e507f3479ee3e711061870739a",
  "oci_cli/cli_session.py": "4cba34c8fb2ba49b8b648c89131a559acfe2912b0662d2b28da2344a6d962de0",
  "oci_cli/cli_setup_bootstrap.py": "2e9002445a6380fcc308f802b9a68ab42bd6e0aafcc557750dbf9efb4d507f83",
} as const;

export const OCI_CHILD_OUTCOMES = ["fixture_complete", "prekey_probe_complete", "bootstrap_complete", "refused", "cancelled"] as const;
export const OCI_CHILD_EXIT_REASONS = ["fixture_complete", "prekey_probe_complete", "bootstrap_complete", "fixture_failure", "bootstrap_failure", "source_mismatch", "audit_file", "audit_operation", "configuration", "unsupported_mode", "private_channel", "binding_ack", "binding_invalid", "binding_conflict", "browser_capture", "cancelled", "deadline"] as const;

/** Bundled with the host entry; no runtime Python asset is required. */
export const OCI_CHILD_WRAPPER_SOURCE = String.raw`
import os
import sys

# Suppress even direct writes made by a future CLI import, before other imports.
_null = os.open(os.devnull, os.O_RDWR)
for _fd in (0, 1, 2):
    os.dup2(_null, _fd)
if _null > 4:
    os.close(_null)
os.environ.clear()
os.environ["PATH"] = "/usr/bin:/bin"
os.environ["OCI_DEVELOPER_TOOL_CONFIGURATION_FILE_PATH"] = "/dev/null"
sys.dont_write_bytecode = True
os.umask(0o077)

import errno
import base64
import json
import re
import select
import signal
import socket
import socketserver
import stat
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
import webbrowser
import hashlib
import importlib.machinery
import platform
from urllib.parse import urlparse, parse_qs

OCI_SITE_PACKAGES = "/opt/homebrew/Cellar/oci-cli/3.88.0/libexec/lib/python3.14/site-packages"
OCI_BOOTSTRAP_PATH = OCI_SITE_PACKAGES + "/oci_cli/cli_setup_bootstrap.py"
OCI_SOURCE_PINS = ${JSON.stringify({ ...OCI_CHILD_CLI_SOURCE_PINS, ...OCI_VERIFIER_SDK_SOURCE_PINS })}
PYTHON_LIBRARY = "/opt/homebrew/Cellar/python@3.14/3.14.6/Frameworks/Python.framework/Versions/3.14/lib"
OCI_DEPENDENCY_PATHS = (
    "/opt/homebrew/Cellar/cryptography/50.0.2_2/lib/python3.14/site-packages",
    "/opt/homebrew/Cellar/cffi/2.1.1_1/lib/python3.14/site-packages",
    "/opt/homebrew/Cellar/pycparser/3.12/lib/python3.15/site-packages",
    "/opt/homebrew/Cellar/certifi/2026.10.23/lib/python3.15/site-packages",
)

class ChildStop(BaseException):
    def __init__(self, reason, outcome="refused"):
        self.reason = reason
        self.outcome = outcome

def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result

def reject_constant(value):
    raise ValueError()

class PrivateRuntime:
    def __init__(self):
        self.attempt = None
        self.buffer = b""
        self.deadline = time.monotonic() + 8.0
        self.server = None
        self.captured = False
        self.event_failed = False
        self.mode = None
        self.session_root = None
        self.profile = None
        self.region = "ap-sydney-1"
        self.persisting = False
        self.owned_files = set()
        self.binding = False
        for fd in (3, 4):
            mode = os.fstat(fd).st_mode
            if not (stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode)):
                raise ChildStop("private_channel")
            os.set_blocking(fd, False)

    def emit(self, kind, **fields):
        record = {"version": 1, "attemptId": self.attempt, "type": kind, **fields}
        data = (json.dumps(record, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")
        if len(data) >= 16384:
            raise ChildStop("private_channel")
        end = min(self.deadline, time.monotonic() + 0.25)
        try:
            while data:
                remaining = end - time.monotonic()
                if remaining <= 0 or not select.select([], [4], [], remaining)[1]:
                    raise OSError()
                written = os.write(4, data)
                if written <= 0:
                    raise OSError()
                data = data[written:]
        except (OSError, ValueError):
            self.event_failed = True
            raise ChildStop("private_channel")

    def line(self, end, timeout_reason):
        while b"\n" not in self.buffer:
            remaining = min(end, self.deadline) - time.monotonic()
            if remaining <= 0:
                raise ChildStop(timeout_reason)
            try:
                if not select.select([3], [], [], remaining)[0]:
                    raise ChildStop(timeout_reason)
                part = os.read(3, 4097)
            except (OSError, ValueError):
                raise ChildStop("private_channel")
            if not part:
                raise ChildStop("private_channel")
            self.buffer += part
            if len(self.buffer.split(b"\n", 1)[0]) > 4096:
                raise ChildStop("configuration")
        raw, self.buffer = self.buffer.split(b"\n", 1)
        if len(raw) > 4096:
            raise ChildStop("configuration")
        try:
            value = json.loads(raw.decode("utf-8"), object_pairs_hook=strict_object, parse_constant=reject_constant)
        except (ValueError, UnicodeError, RecursionError):
            raise ChildStop("configuration")
        if type(value) is not dict:
            raise ChildStop("configuration")
        return value

    def configure(self):
        config = self.line(self.deadline, "configuration")
        attempt = config.get("attemptId")
        if type(attempt) is str and re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", attempt):
            self.attempt = attempt
        fields = {"version", "attemptId", "mode", "callbackPort", "lifetimeMs"}
        authenticating = config.get("mode") == "authenticate"
        if authenticating:
            fields |= {"sessionRoot", "profileName", "region"}
        if (set(config) != fields
            or type(config["version"]) is not int or config["version"] != 1
            or self.attempt is None
            or config["callbackPort"] not in ("fixed", "ephemeral")
            or type(config["lifetimeMs"]) is not int
            or not 100 <= config["lifetimeMs"] <= (900000 if authenticating else 60000)
            or self.buffer):
            raise ChildStop("configuration")
        if config["mode"] not in ("fixture", "prekey_probe", "authenticate"):
            raise ChildStop("unsupported_mode")
        self.mode = config["mode"]
        if authenticating:
            root, profile = config["sessionRoot"], config["profileName"]
            if (config["callbackPort"] != "fixed" or config["region"] != self.region
                or type(root) is not str or not 1 <= len(root) <= 2048
                or not os.path.isabs(root) or os.path.realpath(root) != root
                or os.path.basename(root) != "oci-session-" + self.attempt
                or profile != "BB_REMOTE_" + self.attempt.replace("-", "")):
                raise ChildStop("configuration")
            self.session_root, self.profile = root, profile
            profile_dir = root + "/tokens/" + profile
            try:
                for path in (root, root + "/tokens", profile_dir):
                    entry = os.lstat(path)
                    if not stat.S_ISDIR(entry.st_mode) or stat.S_IMODE(entry.st_mode) != 0o700 or entry.st_uid != os.getuid():
                        raise ChildStop("configuration")
                if set(os.listdir(root)) != {"tokens", "config", "oci_cli_rc"}:
                    raise ChildStop("configuration")
                if set(os.listdir(profile_dir)) != {"oci_api_key.pem", "oci_api_key_public.pem", "token"} or os.listdir(root + "/tokens") != [profile]:
                    raise ChildStop("configuration")
                for path in (root + "/config", root + "/oci_cli_rc", profile_dir + "/oci_api_key.pem", profile_dir + "/oci_api_key_public.pem", profile_dir + "/token"):
                    entry = os.lstat(path)
                    if (not stat.S_ISREG(entry.st_mode) or stat.S_IMODE(entry.st_mode) != 0o600
                        or entry.st_uid != os.getuid() or entry.st_nlink != 1 or entry.st_size != 0):
                        raise ChildStop("configuration")
            except OSError:
                raise ChildStop("configuration")
            self.owned_files = {root + "/config", profile_dir + "/oci_api_key.pem", profile_dir + "/oci_api_key_public.pem", profile_dir + "/token"}
        self.deadline = time.monotonic() + config["lifetimeMs"] / 1000.0
        self.port = 8181 if config["callbackPort"] == "fixed" else 0

    def command(self, end, accepting):
        command = self.line(end, "binding_ack" if accepting else "deadline")
        if (set(command) != {"version", "attemptId", "type"}
            or type(command["version"]) is not int or command["version"] != 1
            or command["attemptId"] != self.attempt):
            raise ChildStop("binding_ack" if accepting else "configuration")
        if command["type"] == "cancel":
            raise ChildStop("cancelled", "cancelled")
        if accepting and command["type"] == "accept_binding" and not self.buffer:
            return
        raise ChildStop("binding_ack" if accepting else "configuration")

    def capture_browser(self, url, *args, **kwargs):
        expected = ("https://login.fixture.invalid/v1/oauth2/authorize?nonce=" + self.attempt
                    + "&redirect_uri=http%3A%2F%2Flocalhost%3A8181")
        if self.captured or type(url) is not str or len(url) > 8192:
            raise ChildStop("browser_capture")
        if self.mode == "fixture":
            if url != expected:
                raise ChildStop("browser_capture")
        elif self.mode == "authenticate":
            validate_authorization_url(url)
        else:
            raise ChildStop("browser_capture")
        self.captured = True
        self.emit("browser", url=url)
        return True

    def disable_browser_dispatch(self, *args, **kwargs):
        raise ChildStop("browser_capture")

def validate_authorization_url(url):
    try:
        parsed = urlparse(url)
        query = parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True, max_num_fields=8)
        expected = {"action": "login", "client_id": "iaas_console", "response_type": "token id_token", "scope": "openid", "redirect_uri": "http://localhost:8181"}
        if (parsed.scheme != "https" or parsed.netloc != "login.ap-sydney-1.oraclecloud.com"
            or parsed.path != "/v1/oauth2/authorize" or parsed.params or parsed.fragment
            or set(query) != set(expected) | {"nonce", "public_key"}
            or any(len(values) != 1 for values in query.values())
            or any(query[key] != [value] for key, value in expected.items())
            or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", query["nonce"][0])):
            raise ValueError()
        encoded = query["public_key"][0]
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,4096}={0,2}", encoded):
            raise ValueError()
        raw = base64.b64decode(encoded, altchars=b"-_", validate=True)
        if base64.urlsafe_b64encode(raw).decode("ascii") != encoded:
            raise ValueError()
        jwk = json.loads(raw.decode("utf-8"), object_pairs_hook=strict_object, parse_constant=reject_constant)
        if (type(jwk) is not dict or set(jwk) != {"kty", "n", "e", "kid"}
            or jwk["kty"] != "RSA" or jwk["e"] != "AQAB" or jwk["kid"] != "Ignored"
            or type(jwk["n"]) is not str or not re.fullmatch(r"[A-Za-z0-9_-]{342}", jwk["n"])):
            raise ValueError()
        modulus = base64.b64decode(jwk["n"] + "==", altchars=b"-_", validate=True)
        if len(modulus) != 256 or modulus[0] < 128 or base64.urlsafe_b64encode(modulus).decode("ascii").rstrip("=") != jwk["n"]:
            raise ValueError()
    except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
        raise ChildStop("browser_capture")

def owned_server_class(original, runtime):
    # Replace the actual bootstrap class and bound both callback IO and private cancellation.
    class OwnedServer(original):
        allow_reuse_address = False
        allow_reuse_port = False

        def __init__(self, address, handler):
            if address != ("", 8181) or runtime.server is not None:
                raise ChildStop("binding_invalid")
            runtime.binding = True
            try:
                super().__init__(("127.0.0.1", runtime.port), handler)
            except OSError as error:
                if error.errno == errno.EADDRINUSE:
                    raise ChildStop("binding_conflict")
                raise
            finally:
                runtime.binding = False
            runtime.server = self
            bound = self.socket.getsockname()
            if (bound[0] != "127.0.0.1" or not 1 <= bound[1] <= 65535
                or self.socket.getsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR) != 0
                or (hasattr(socket, "SO_REUSEPORT") and self.socket.getsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT) != 0)
                or (runtime.port != 0 and bound[1] != 8181)):
                raise ChildStop("binding_invalid")
            runtime.emit("ready", pid=os.getpid(), host=bound[0], port=bound[1])
            runtime.command(min(runtime.deadline, time.monotonic() + 8.0), True)
            if runtime.mode == "prekey_probe":
                raise ChildStop("prekey_probe_complete", "prekey_probe_complete")

        def server_bind(self):
            socketserver.TCPServer.server_bind(self)
            self.server_name = "localhost"
            self.server_port = self.socket.getsockname()[1]

        def get_request(self):
            request, address = super().get_request()
            request.settimeout(min(0.2, max(0.001, runtime.deadline - time.monotonic())))
            return request, address

        def serve_forever(self):
            self.stop, self.ret_value = False, None
            while not self.stop:
                remaining = runtime.deadline - time.monotonic()
                if remaining <= 0:
                    raise ChildStop("deadline")
                readable = select.select([self.socket, 3], [], [], remaining)[0]
                if not readable:
                    raise ChildStop("deadline")
                if 3 in readable or runtime.buffer:
                    runtime.command(runtime.deadline, False)
                if self.socket in readable:
                    self.handle_request()
            self.server_close()
            return self.ret_value

    return OwnedServer

def import_bootstrap(runtime):
    # Installed imports may inspect defaults; deny account IO before loading OCI.
    # urllib3 otherwise probes IPv6 with a bind during import; this child is IPv4 only.
    socket.has_ipv6 = False
    # OCI error metadata otherwise launches uname -p on this pinned Darwin runtime.
    platform.platform = lambda *args, **kwargs: "Darwin-arm64"
    approved_roots = (OCI_SITE_PACKAGES, PYTHON_LIBRARY) + OCI_DEPENDENCY_PATHS
    null_stat = os.stat("/dev/null")
    def installation_path(path):
        if type(path) is not str or not os.path.isabs(path):
            return False
        canonical = os.path.realpath(path)
        return any(canonical == root or canonical.startswith(root + "/") for root in approved_roots)
    def audit(event, args):
        if event == "open":
            path, mode, flags = args
            if path == "/dev/null":
                return
            if type(path) is int:
                descriptor = os.fstat(path)
                if stat.S_ISCHR(descriptor.st_mode) and descriptor.st_rdev == null_stat.st_rdev:
                    return
            if runtime.persisting and path in runtime.owned_files:
                if os.path.realpath(path) != path:
                    raise ChildStop("audit_file")
                if os.path.lexists(path):
                    entry = os.lstat(path)
                    if not stat.S_ISREG(entry.st_mode) or entry.st_uid != os.getuid() or entry.st_nlink != 1 or stat.S_IMODE(entry.st_mode) != 0o600:
                        raise ChildStop("audit_file")
                return
            if ((not installation_path(path) and path != "/System/Library/CoreServices/SystemVersion.plist")
                or type(flags) is not int
                or flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)):
                raise ChildStop("audit_file")
        elif event in ("subprocess.Popen", "os.system", "os.posix_spawn", "os.exec", "os.fork", "os.forkpty", "builtins.input",
                       "socket.connect", "socket.connect_ex", "socket.sendto", "socket.getaddrinfo",
                       "os.mkdir", "os.remove", "os.rename", "os.rmdir", "os.chmod", "os.chown",
                       "os.link", "os.symlink", "os.truncate", "os.listdir", "os.scandir"):
            # Import discovery may list only reviewed installation directories.
            if (event == "os.chmod" and runtime.persisting and args[0] in runtime.owned_files
                and args[1] == 0o600 and os.path.realpath(args[0]) == args[0]):
                return
            if event not in ("os.listdir", "os.scandir") or not installation_path(args[0]):
                raise ChildStop("audit_operation")
        elif event == "socket.bind":
            if not runtime.binding or args[0].family != socket.AF_INET or args[1] != ("127.0.0.1", runtime.port):
                raise ChildStop("binding_invalid")
        elif event.startswith("socket.") and event != "socket.gethostname":
            if (event != "socket.__new__" or args[1] != socket.AF_INET
                or not (runtime.binding or (runtime.server is not None and runtime.captured))):
                raise ChildStop("audit_operation")
        elif event == "ctypes.dlopen" and args[0] not in (None, "/usr/lib/libc.dylib"):
            raise ChildStop("audit_operation")
    sys.addaudithook(audit)
    sys.path.extend((OCI_SITE_PACKAGES,) + OCI_DEPENDENCY_PATHS)
    pinned_sources = {}
    for relative, expected in OCI_SOURCE_PINS.items():
        path = OCI_SITE_PACKAGES + "/" + relative
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            entry = os.fstat(descriptor)
            limit = 2097152 if relative == "oci/identity/identity_client.py" else 300000
            if not stat.S_ISREG(entry.st_mode) or not 1 <= entry.st_size <= limit:
                raise ChildStop("source_mismatch")
            source = b""
            while len(source) <= limit:
                part = os.read(descriptor, limit + 1 - len(source))
                if not part:
                    break
                source += part
        finally:
            os.close(descriptor)
        if hashlib.sha256(source).hexdigest() != expected:
            raise ChildStop("source_mismatch")
        pinned_sources[path] = source
    original_get_code = importlib.machinery.SourceFileLoader.get_code
    def source_code(loader, fullname):
        if fullname == "oci_cli.cli_setup_bootstrap" and loader.path != OCI_BOOTSTRAP_PATH:
            raise ChildStop("source_mismatch")
        if loader.path in pinned_sources:
            return compile(pinned_sources[loader.path], loader.path, "exec", dont_inherit=True)
        return original_get_code(loader, fullname)
    importlib.machinery.SourceFileLoader.get_code = source_code
    try:
        from oci_cli import cli_setup_bootstrap as bootstrap
    finally:
        importlib.machinery.SourceFileLoader.get_code = original_get_code
    if (bootstrap.__file__ != OCI_BOOTSTRAP_PATH
        or bootstrap.StoppableHttpServer.__module__ != "oci_cli.cli_setup_bootstrap"
        or bootstrap.create_user_session.__globals__ is not bootstrap.__dict__):
        raise ChildStop("source_mismatch")
    return bootstrap

def installed_bootstrap(runtime):
    bootstrap = import_bootstrap(runtime)
    bootstrap.StoppableHttpServer = owned_server_class(bootstrap.StoppableHttpServer, runtime)
    webbrowser.open = runtime.disable_browser_dispatch
    webbrowser.open_new = runtime.capture_browser
    webbrowser.open_new_tab = runtime.disable_browser_dispatch
    webbrowser.get = runtime.disable_browser_dispatch
    webbrowser.register = runtime.disable_browser_dispatch
    if runtime.mode == "prekey_probe":
        # A source reorder must fail before producing any auth key, nonce or session.
        bootstrap.cli_util.generate_key = runtime.disable_browser_dispatch
        bootstrap.uuid.uuid4 = runtime.disable_browser_dispatch
        bootstrap.persist_user_session = runtime.disable_browser_dispatch
    session = bootstrap.create_user_session(region=runtime.region)
    if runtime.mode != "authenticate" or not runtime.captured:
        raise ChildStop("bootstrap_failure")
    runtime.persisting = True
    try:
        profile, config = bootstrap.persist_user_session(session, profile_name=runtime.profile,
            config=runtime.session_root + "/config", token_location=runtime.session_root + "/tokens",
            persist_token=True, session_auth=True, use_passphrase=False)
        if profile != runtime.profile or config != runtime.session_root + "/config":
            raise ChildStop("bootstrap_failure")
    finally:
        runtime.persisting = False
    return

def synthetic_bootstrap(runtime):
    class StoppableHttpRequestHandler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            complete = self.path == "/fixture-complete"
            body = b"Synthetic fixture complete." if complete else b"Synthetic fixture only."
            self.send_response(200 if complete else 404)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.close_connection = True
            self.server.stop = complete

    class StoppableHttpServer(HTTPServer):
        pass

    # This is the upstream constructor/browser ordering, without keygen or OCI imports.
    StoppableHttpServer = owned_server_class(StoppableHttpServer, runtime)
    server = StoppableHttpServer(("", 8181), StoppableHttpRequestHandler)
    url = ("https://login.fixture.invalid/v1/oauth2/authorize?nonce=" + runtime.attempt
           + "&redirect_uri=http%3A%2F%2Flocalhost%3A8181")
    webbrowser.open = runtime.capture_browser
    webbrowser.open_new = runtime.capture_browser
    webbrowser.open_new_tab = runtime.capture_browser
    webbrowser.get = runtime.disable_browser_dispatch
    webbrowser.register = runtime.disable_browser_dispatch
    if not webbrowser.open_new(url):
        raise ChildStop("browser_capture")
    # Deliberately emulate upstream URL output, including writes bypassing Python streams.
    print(url)
    print("SYNTHETIC_PRIVATE_STDERR " + url, file=sys.stderr)
    os.write(1, b"SYNTHETIC_PRIVATE_STDOUT\n")
    os.write(2, b"SYNTHETIC_PRIVATE_STDERR\n")
    server.serve_forever()

def main():
    runtime = None
    outcome, reason = "refused", "fixture_failure"
    try:
        if sys.version_info[:3] != (3, 14, 6) or not sys.flags.isolated or not sys.flags.no_site:
            raise ChildStop("configuration")
        runtime = PrivateRuntime()
        runtime.configure()
        def stop(signum, frame):
            raise ChildStop("cancelled", "cancelled")
        def expire(signum, frame):
            raise ChildStop("deadline")
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        signal.signal(signal.SIGALRM, expire)
        signal.setitimer(signal.ITIMER_REAL, max(0.001, runtime.deadline - time.monotonic()))
        if runtime.mode == "fixture":
            synthetic_bootstrap(runtime)
            outcome, reason = "fixture_complete", "fixture_complete"
        else:
            installed_bootstrap(runtime)
            outcome, reason = "bootstrap_complete", "bootstrap_complete"
    except ChildStop as stopped:
        outcome, reason = stopped.outcome, stopped.reason
    except OSError as error:
        reason = "binding_conflict" if error.errno == errno.EADDRINUSE else ("fixture_failure" if runtime is None or runtime.mode == "fixture" else "bootstrap_failure")
    except BaseException:
        reason = "fixture_failure" if runtime is None or runtime.mode == "fixture" else "bootstrap_failure"
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        if runtime is not None and runtime.server is not None:
            runtime.server.server_close()
    if runtime is not None and runtime.attempt is not None and not runtime.event_failed:
        try:
            # Cleanup reports remain bounded even when the fixture deadline elapsed.
            runtime.deadline = time.monotonic() + 0.25
            runtime.emit("exit", outcome=outcome, reason=reason)
        except BaseException:
            return 1
    return 0 if outcome in ("fixture_complete", "prekey_probe_complete", "bootstrap_complete") else 1

raise SystemExit(main())
`;
