import { inspectInstalledOciCompatibility } from "../oci-compatibility.ts";

// A fixed read-only inventory, not a general-purpose CLI runner or file reader.
if (process.argv.length !== 2) {
  process.stderr.write("oci_compatibility_probe_accepts_no_arguments\n");
  process.exitCode = 1;
} else {
  try {
    const report = await inspectInstalledOciCompatibility();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.sourceCompatibility !== "matched") process.exitCode = 2;
  } catch {
    process.stderr.write("oci_compatibility_probe_failed\n");
    process.exitCode = 1;
  }
}
