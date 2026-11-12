import childProcess from "node:child_process";

const maxOutputBytes = 8192;
const failure = () => new Error("oci_listener_ownership_unverified");

/** Visible listeners only; this does not isolate another process running as the same user. */
export async function assertOwnedLoopbackListener(pid: number, port: number, signal: AbortSignal): Promise<void> {
  try {
    if (process.platform !== "darwin" || signal.aborted
      || !Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647
      || !Number.isInteger(port) || port <= 0 || port > 65_535) throw failure();

    const stdout = await new Promise<string>((resolve, reject) => {
      childProcess.execFile("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"], {
        encoding: "utf8", maxBuffer: maxOutputBytes, timeout: 2000, killSignal: "SIGKILL", signal,
        env: { LANG: "C", LC_ALL: "C" },
      }, (error, output, stderr) => {
        if (error || stderr !== "") reject(failure());
        else resolve(output);
      });
    });

    const fields = stdout.split("\n");
    if (signal.aborted || Buffer.byteLength(stdout, "utf8") > maxOutputBytes
      || fields.pop() !== "" || fields.shift() !== `p${pid}` || fields.length === 0
      || fields.length % 2 !== 0) throw failure();
    const descriptors = new Set<string>();
    for (let index = 0; index < fields.length; index += 2) {
      const descriptor = fields[index]!;
      if (!/^f(?:0|[1-9][0-9]*)$/.test(descriptor) || descriptors.has(descriptor)
        || !Number.isSafeInteger(Number(descriptor.slice(1)))
        || fields[index + 1] !== `n127.0.0.1:${port}`) throw failure();
      descriptors.add(descriptor);
    }
  } catch {
    throw failure();
  }
}
