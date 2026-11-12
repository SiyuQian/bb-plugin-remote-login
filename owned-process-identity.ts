import cp from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { z } from "zod";

export const ownedProcessIdentitySchema = z.object({
  pid: z.number().int().positive().max(2_147_483_647), uid: z.number().int().nonnegative(),
  started: z.string().max(160).regex(/^[0-9]+:[0-9]+(?::[a-f0-9-]+)?$/), executableId: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type OwnedProcessIdentity = z.infer<typeof ownedProcessIdentitySchema>;
export type OwnedProcessBoundary = { self(): Promise<OwnedProcessIdentity>; inspect(pid: number): Promise<OwnedProcessIdentity | null> };

// Public macOS SDK proc_bsdinfo layout; no arguments, environment or account files are inspected.
const source = String.raw`
import ctypes, errno, hashlib, json, os, sys
class BSD(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in ("flags", "status", "xstatus", "pid", "ppid", "uid", "gid", "ruid", "rgid", "svuid", "svgid", "reserved")] + [("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32)] + [(name, ctypes.c_uint32) for name in ("nfiles", "pgid", "jobc", "tdev", "tpgid")] + [("nice", ctypes.c_int32), ("sec", ctypes.c_uint64), ("usec", ctypes.c_uint64)]
pid = int(sys.argv[1])
lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
lib.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
info = BSD()
count = lib.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
if count == 0 and ctypes.get_errno() == errno.ESRCH:
    print("null")
elif count != ctypes.sizeof(info) or info.pid != pid:
    sys.exit(2)
else:
    path = ctypes.create_string_buffer(4096)
    if lib.proc_pidpath(pid, path, len(path)) <= 0:
        sys.exit(2)
    print(json.dumps({"pid":pid,"uid":info.uid,"started":str(info.sec)+":"+str(info.usec),"executableId":hashlib.sha256(path.value).hexdigest()}, separators=(",", ":")))
`;

/** Observation only. Restart recovery never signals an observed PID, even when identities match. */
export async function inspectOwnedProcess(pid: number): Promise<OwnedProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) throw new Error("owned_process_unavailable");
  if (process.platform === "darwin") {
    const result = await new Promise<string>((resolve, reject) => {
      cp.execFile("/opt/homebrew/Cellar/oci-cli/3.88.0/libexec/bin/python", ["-I", "-S", "-c", source, String(pid)], {
        timeout: 2000, maxBuffer: 2048, encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      }, (error, output, stderr) => error || stderr ? reject(new Error("owned_process_unavailable")) : resolve(output));
    });
    const parsed = ownedProcessIdentitySchema.nullable().parse(JSON.parse(result));
    if (parsed && parsed.pid !== pid) throw new Error("owned_process_unavailable");
    return parsed;
  }
  if (process.platform === "linux") {
    try {
      const [stat, metadata, executable, boot] = await Promise.all([
        fs.readFile(`/proc/${pid}/stat`, "utf8"), fs.stat(`/proc/${pid}`), fs.readlink(`/proc/${pid}/exe`), fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      return ownedProcessIdentitySchema.parse({ pid, uid: metadata.uid, started: `${fields[19]}:0:${boot.trim()}`,
        executableId: createHash("sha256").update(executable).digest("hex") });
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("owned_process_unavailable"); }
  }
  throw new Error("owned_process_unavailable");
}
export const nativeOwnedProcesses: OwnedProcessBoundary = {
  inspect: inspectOwnedProcess,
  self: async () => { const identity = await inspectOwnedProcess(process.pid); if (!identity) throw new Error("owned_process_unavailable"); return identity; },
};
