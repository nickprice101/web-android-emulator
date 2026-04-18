import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const inputPath = process.argv[2];

if (!inputPath) {
  console.error("Usage: node scripts/analyze-emulator-log.mjs <logfile>");
  process.exit(2);
}

const absolutePath = resolve(inputPath);
const logText = readFileSync(absolutePath, "utf8");

const findings = {
  directWrapperPatchedApi34: /\[start-emulator-with-turn\]\s+\[avd-patch\].*android-34\/google_apis\/x86_64\//.test(logText),
  wrapperSelectedLegacyLauncher: /\[start-emulator-with-turn\] Using emulator launcher: \/android\/sdk\/launch-emulator\.sh/.test(logText),
  legacyLauncherReportedApi30:
    /version: AndroidVersion\.ApiLevel=30/.test(logText) ||
    /version: Pkg\.Dependencies=emulator#30\.0\.4/.test(logText),
  modemIpv6Failure: /qemu-system-x86_64-headless: .*id=modem: address resolution failed for ::1/.test(logText),
  repeatedRestartLoop: (logText.match(/COMMAND: exec emulator\/emulator -avd Pixel2/g) || []).length > 1,
};

const rootCause =
  findings.directWrapperPatchedApi34 &&
  findings.wrapperSelectedLegacyLauncher &&
  findings.legacyLauncherReportedApi30 &&
  findings.modemIpv6Failure
    ? "legacy-launcher-overrode-patched-avd"
    : "unclassified";

const summary = {
  file: basename(absolutePath),
  rootCause,
  findings,
};

console.log(JSON.stringify(summary, null, 2));

if (rootCause === "legacy-launcher-overrode-patched-avd") {
  console.error(
    "Detected legacy launcher override: the wrapper patched API 34 AVD configs, then /android/sdk/launch-emulator.sh still resolved API 30 and hit the modem ::1 crash."
  );
  process.exit(1);
}
