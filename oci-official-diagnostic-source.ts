import { OCI_VERIFIER_SDK_SOURCE_PINS } from "./oci-verifier-source.ts";

/** Reviewed CLI entry and credential-loading code, in addition to the SDK pins. */
export const OCI_DIAGNOSTIC_SOURCE_PINS = {
  ...OCI_VERIFIER_SDK_SOURCE_PINS,
  "oci_cli/__init__.py": "38f89c228e930c0d6dd6944770a719c639ec7880739dbccd5cb12603bba1d3a6",
  "oci_cli/version.py": "1ca8e3c34f799645e448d38e47978849730f5a3980e2f47b339db9322fbcd6ce",
  "oci_cli/cli_root.py": "f3e861c840ff516e82eb1ba12a89e5e14f0879f51e5ba9858ee3dc5cdd4a0f92",
  "oci_cli/cli_session.py": "4cba34c8fb2ba49b8b648c89131a559acfe2912b0662d2b28da2344a6d962de0",
  "oci_cli/cli_util.py": "8a649b409c17f85432867aa2746428acdb67ad79bea9e4c3442e296f3cf5e30f",
  "oci_cli/cli_setup.py": "fbe53a3634e012685207343e79b409e4e1bcac27ecb3ae0829d1ba30d483e5ef",
  "oci_cli/cli_setup_bootstrap.py": "2e9002445a6380fcc308f802b9a68ab42bd6e0aafcc557750dbf9efb4d507f83",
  "oci_cli/cli_constants.py": "6868821b764875cfefdfa1a510af499fec2577bdde273824e5f63a1aa9ff1c40",
  "oci_cli/cli_clients.py": "37697b0ec852896bb9bac459f8e5f1d314a2c81689ebdff26bf2cd25165468ad",
  "oci_cli/cli_metrics.py": "27a1af0179a12482ac6090466cb5cfb5a3dbef5f23e7cec4d036c8469fa65cd7",
} as const;

/** Inert, worker-only source. Official CLI output is discarded; only bounded completion facts leave it. */
export const OCI_DIAGNOSTIC_SOURCE = String.raw`
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

import builtins
import hashlib
import importlib.machinery
import json
import logging
import platform
import re
import select
import socket
import stat
import threading
import time

logging.disable(logging.CRITICAL)
socket.has_ipv6 = False
platform.platform = lambda *args, **kwargs: "Darwin-arm64"

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
_PINS = ${JSON.stringify(OCI_DIAGNOSTIC_SOURCE_PINS)}
_HOST = "identity.ap-sydney-1.oci.oraclecloud.com"
_ENDPOINT = "https://" + _HOST
_PUBLIC_ROOTS = (_PACKAGES, _STDLIB) + _DEPENDENCIES
_PUBLIC_FILES = (_CA, "/System/Library/CoreServices/SystemVersion.plist", "/dev/null")
_owned = {}
_phase = "imports"
_addresses = set()

class Refused(BaseException):
    def __init__(self, reason):
        self.reason = reason

def _installation(path):
    return path in _PUBLIC_FILES or any(path == root or path.startswith(root + "/") for root in _PUBLIC_ROOTS)

def _audit(event, args):
    if event == "open":
        path, mode, flags = args
        if type(path) not in (str, bytes) or type(flags) is not int:
            raise Refused("configuration")
        path = os.fsdecode(path)
        resolved = os.path.realpath(path)
        if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
            raise Refused("configuration")
        if resolved.endswith((".pyc", ".pyo")):
            raise PermissionError()
        if path in _owned and resolved == path:
            info = os.lstat(path)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > _owned[path]:
                raise Refused("configuration")
        elif not _installation(resolved):
            raise Refused("configuration")
    elif event in ("os.listdir", "os.scandir"):
        if type(args[0]) is not str or not _installation(os.path.realpath(args[0])):
            raise Refused("configuration")
    elif event in ("subprocess.Popen", "os.system", "os.posix_spawn", "os.fork", "os.forkpty", "os.exec", "builtins.input",
                   "os.mkdir", "os.remove", "os.rename", "os.rmdir", "os.chmod", "os.chown", "os.link", "os.symlink", "os.truncate", "os.utime"):
        raise Refused("configuration")
    elif event == "ctypes.dlopen" and args[0] not in (None, "/usr/lib/libc.dylib"):
        raise Refused("configuration")
    elif event == "socket.getaddrinfo":
        if _phase != "online" or args[0] != _HOST or args[1] != 443:
            raise Refused("rejected")
    elif event == "socket.connect":
        address = args[1]
        if _phase != "online" or type(address) is not tuple or (address[0], address[1]) not in _addresses:
            raise Refused("rejected")
    elif event.startswith("socket.") and event not in ("socket.__new__", "socket.gethostname"):
        raise Refused("rejected")
    elif event == "socket.__new__" and _phase != "online":
        raise Refused("rejected")

# This policy precedes every installed CLI/SDK import and every public source pin read.
sys.addaudithook(_audit)
sys.path[:] = [_PACKAGES, *_DEPENDENCIES, _STDLIB, _STDLIB + "/lib-dynload"]
_getaddrinfo = socket.getaddrinfo
def _fixed_getaddrinfo(host, port, *args, **kwargs):
    if host != _HOST or port != 443:
        raise Refused("rejected")
    answers = _getaddrinfo(host, port, *args, **kwargs)
    for answer in answers:
        _addresses.add((answer[4][0], answer[4][1]))
    return answers
socket.getaddrinfo = _fixed_getaddrinfo

def _strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result

class Runtime:
    def __init__(self):
        self.attempt = None
        self.buffer = b""
        self.deadline = time.monotonic() + 8.0
        self.finished = False
        self.lock = threading.Lock()
        for fd in (3, 4):
            if not (stat.S_ISFIFO(os.fstat(fd).st_mode) or stat.S_ISSOCK(os.fstat(fd).st_mode)):
                raise Refused("private_channel")
            os.set_blocking(fd, False)

    def finish(self, ok, reason):
        with self.lock:
            if self.finished:
                return
            self.finished = True
            if ok and time.monotonic() >= self.deadline:
                ok, reason = False, "deadline"
            data = (json.dumps({"version": 1, "type": "result", "attemptId": self.attempt, "ok": ok, "reason": reason}, separators=(",", ":")) + "\n").encode("ascii")
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
            value = json.loads(raw.decode("utf-8"), object_pairs_hook=_strict_object)
        except (ValueError, UnicodeError, RecursionError):
            raise Refused("configuration")
        if type(value) is not dict:
            raise Refused("configuration")
        return value

    def configure(self):
        value = self.line(8192)
        attempt = value.get("attemptId")
        if type(attempt) is str and re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", attempt):
            self.attempt = attempt
        if set(value) != {"version", "type", "attemptId", "root"} or self.attempt is None or type(value["version"]) is not int or value["version"] != 1 or value["type"] != "diagnostic":
            raise Refused("configuration")
        root = value["root"]
        if type(root) is not str or not 1 <= len(root) <= 4096 or any(ord(c) < 32 or ord(c) == 127 for c in root) or not os.path.isabs(root) or os.path.realpath(root) != root or os.path.basename(root) != "oci-session-" + self.attempt:
            raise Refused("configuration")
        self.root = root
        self.profile = "BB_REMOTE_" + self.attempt.replace("-", "")
        profile_dir = root + "/tokens/" + self.profile
        for path in (os.path.dirname(root), root, root + "/tokens", profile_dir):
            info = os.lstat(path)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700 or os.path.realpath(path) != path:
                raise Refused("configuration")
        _owned.update({root + "/config": 16384, root + "/oci_cli_rc": 0,
            profile_dir + "/oci_api_key.pem": 32768, profile_dir + "/oci_api_key_public.pem": 32768, profile_dir + "/token": 65536})
        for path, limit in _owned.items():
            info = os.lstat(path)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > limit or os.path.realpath(path) != path:
                raise Refused("configuration")
        os.environ["HOME"] = root
        self.deadline = time.monotonic() + 6.0
        threading.Thread(target=self.watch, daemon=True).start()

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

def diagnostic(runtime):
    global _phase
    runtime.configure()
    arguments = ["--config-file", runtime.root + "/config", "--profile", runtime.profile,
        "--cli-rc-file", runtime.root + "/oci_cli_rc", "--region", "ap-sydney-1", "--auth", "security_token",
        "--endpoint", _ENDPOINT, "--no-retry", "--connection-timeout", "3", "--read-timeout", "3", "session", "validate"]
    sys.argv[:] = ["oci", *arguments]
    sources = {_PACKAGES + "/" + relative: _pin(_PACKAGES + "/" + relative, digest) for relative, digest in _PINS.items()}
    _pin(_CA, _CA_SHA256)
    original_get_code = importlib.machinery.SourceFileLoader.get_code
    def source_code(loader, fullname):
        if loader.path in sources:
            return compile(sources[loader.path], loader.path, "exec", dont_inherit=True)
        return original_get_code(loader, fullname)
    importlib.machinery.SourceFileLoader.get_code = source_code
    import oci
    from oci.identity import IdentityClient
    from oci_cli import cli_root, cli_session, cli_util, cli_setup, cli_setup_bootstrap
    import click
    import click.termui
    import getpass
    import webbrowser
    if oci.__version__ != "2.180.0" or cli_root.__version__ != "3.88.0" or cli_session.__file__ != _PACKAGES + "/oci_cli/cli_session.py":
        raise Refused("sdk")

    def no_prompt(*args, **kwargs):
        raise Refused("prompt")
    def no_auth(*args, **kwargs):
        raise Refused("reauth")
    builtins.input = no_prompt
    getpass.getpass = no_prompt
    click.prompt = click.confirm = click.termui.prompt = click.termui.confirm = no_prompt
    cli_util.prompt_for_passphrase = no_prompt
    for name in ("authenticate", "refresh", "terminate"):
        getattr(cli_session, name).callback = no_auth
    cli_setup.generate_oci_config.callback = no_auth
    cli_setup_bootstrap.bootstrap_oci_cli = cli_setup_bootstrap.create_user_session = cli_setup_bootstrap.persist_user_session = no_auth
    webbrowser.open = webbrowser.open_new = webbrowser.open_new_tab = webbrowser.get = no_auth

    entered = completed = accepted = 0
    original_validate = cli_session.validate.callback
    def guarded_validate(*args, **kwargs):
        nonlocal entered, completed
        if entered or kwargs.get("local") is not False:
            raise Refused("configuration")
        entered += 1
        value = original_validate(*args, **kwargs)
        completed += 1
        return value
    cli_session.validate.callback = guarded_validate
    original_build_client = cli_util.build_client
    def guarded_client(spec_name, service_name, context):
        if spec_name != "identity" or service_name != "identity" or context.obj["config_file"] != runtime.root + "/config" or context.obj["profile"] != runtime.profile or context.obj["cli_rc_file"] != runtime.root + "/oci_cli_rc" or context.obj["auth"] != "security_token" or context.obj["region"] != "ap-sydney-1" or context.obj["endpoint"] != _ENDPOINT or context.obj["no_retry"] is not True:
            raise Refused("configuration")
        client = original_build_client(spec_name, service_name, context)
        session = client.base_client.session
        session.trust_env = False
        session.proxies = {}
        session.verify = True
        session.cert = None
        session.max_redirects = 0
        original_list_regions = client.list_regions
        def guarded_regions(*args, **kwargs):
            global _phase
            nonlocal accepted
            if not entered or accepted or client.base_client.endpoint != _ENDPOINT + "/20160918":
                raise Refused("configuration")
            _phase = "online"
            try:
                response = original_list_regions(*args, **kwargs)
                if not 200 <= response.status <= 299:
                    raise Refused("rejected")
                accepted += 1
                return response
            finally:
                _phase = "complete"
                session.close()
        client.list_regions = guarded_regions
        return client
    cli_util.build_client = guarded_client
    cli_root.cli.main(args=arguments, prog_name="oci", standalone_mode=False)
    if entered != 1 or completed != 1 or accepted != 1:
        raise Refused("rejected")
    runtime.finish(True, "complete")

_runtime = None
try:
    _runtime = Runtime()
    diagnostic(_runtime)
except Refused as _error:
    if _runtime is not None:
        _runtime.finish(False, _error.reason)
except BaseException:
    if _runtime is not None:
        _runtime.finish(False, "rejected")
os._exit(0)
`;
