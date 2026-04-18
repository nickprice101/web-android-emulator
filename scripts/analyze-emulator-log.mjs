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
  directModeEnabled: /\[start-emulator-with-turn\] Using direct emulator mode; legacy launcher bypassed\./.test(logText),
  directLaunchReportedApi34:
    /\[start-emulator-with-turn\]\s+Pkg\.Dependencies=emulator#34\./.test(logText) ||
    /\[start-emulator-with-turn\]\s+AndroidVersion\.ApiLevel=34/.test(logText),
  directLaunchLoggedRadioNull:
    /\[start-emulator-with-turn\] Direct emulator radio device: null/.test(logText) ||
    /\[start-emulator-with-turn\] Direct emulator radio override: null/.test(logText) ||
    /-radio null/.test(logText),
  directLaunchRadioOverrideDisabled:
    /\[start-emulator-with-turn\] Direct emulator radio override: disabled/.test(logText),
  missingAdbBinary:
    /\[start-emulator-with-turn\] (WARNING|ERROR): adb binary unavailable/.test(logText) ||
    /\[start-emulator-with-turn\] WARNING: adb command unavailable/.test(logText),
  adbHostServerFailure: /AdbHostServer\.cpp:102: Unable to connect to adb daemon on port: 5037/.test(logText),
  modemIpv6Failure: /qemu-system-x86_64-headless: .*id=modem: address resolution failed for ::1/.test(logText),
  invalidRadioOption: /qemu-system-x86_64-headless: -radio: invalid option/.test(logText),
  repeatedRestartLoop:
    (logText.match(/Using direct emulator launch: \/android\/sdk\/emulator\/emulator/g) || []).length > 1 ||
    (logText.match(/COMMAND: exec emulator\/emulator -avd Pixel2/g) || []).length > 1,
};

let rootCause = "unclassified";
let explanation = "No known emulator restart-loop signature matched this log.";

if (
  findings.directWrapperPatchedApi34 &&
  findings.wrapperSelectedLegacyLauncher &&
  findings.legacyLauncherReportedApi30 &&
  findings.modemIpv6Failure
) {
  rootCause = "legacy-launcher-overrode-patched-avd";
  explanation =
    "The wrapper patched API 34 AVD configs, then /android/sdk/launch-emulator.sh still resolved API 30 and hit the modem ::1 crash.";
} else if (
  findings.directWrapperPatchedApi34 &&
  findings.directModeEnabled &&
  findings.directLaunchReportedApi34 &&
  findings.modemIpv6Failure &&
  !findings.directLaunchLoggedRadioNull
) {
  rootCause = "direct-launch-left-internal-modem-enabled";
  explanation =
    "Direct launch reached API 34, but the wrapper still left the internal modem backend enabled, so QEMU created id=modem on ::1 and the container restarted.";
} else if (
  findings.directWrapperPatchedApi34 &&
  findings.directModeEnabled &&
  findings.directLaunchReportedApi34 &&
  findings.directLaunchLoggedRadioNull &&
  findings.invalidRadioOption
) {
  rootCause = "unsupported-radio-override";
  explanation =
    "Direct launch attempted to force a radio override, but the bundled emulator build rejected -radio entirely, so QEMU exited before the guest could boot.";
} else if (
  findings.directWrapperPatchedApi34 &&
  findings.directModeEnabled &&
  findings.directLaunchReportedApi34 &&
  findings.directLaunchLoggedRadioNull &&
  findings.adbHostServerFailure &&
  findings.missingAdbBinary
) {
  rootCause = "direct-launch-missing-adb-host-server";
  explanation =
    "Direct launch reached API 34 and disabled the modem backend, but the runtime lacked a usable adb binary, so the emulator could not connect to the host adb server on port 5037 and the container restarted.";
}

const summary = {
  file: basename(absolutePath),
  rootCause,
  explanation,
  findings,
};

console.log(JSON.stringify(summary, null, 2));

if (rootCause !== "unclassified") {
  console.error(explanation);
  process.exit(1);
}

if (findings.modemIpv6Failure || findings.invalidRadioOption || findings.repeatedRestartLoop) {
  console.error("Detected an emulator restart loop, but the exact signature was not classified.");
  process.exit(1);
}
