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
  directWrapperPatchedSelectedImage: /\[start-emulator\]\s+\[avd-patch\].*system-images\/android-\d+\/google_apis\/[^/\s]+\//.test(logText),
  wrapperSelectedLegacyLauncher: /\[start-emulator\] Using emulator launcher: \/android\/sdk\/launch-emulator\.sh/.test(logText),
  legacyLauncherReportedApi30:
    /version: AndroidVersion\.ApiLevel=30/.test(logText) ||
    /version: Pkg\.Dependencies=emulator#30\.0\.4/.test(logText),
  directModeEnabled: /\[start-emulator\] Using direct emulator mode; legacy launcher bypassed\./.test(logText),
  directLaunchReportedSelectedApi:
    /\[start-emulator\]\s+Pkg\.Dependencies=emulator#35\./.test(logText) ||
    /\[start-emulator\]\s+AndroidVersion\.ApiLevel=35/.test(logText),
  directLaunchLoggedRadioNull:
    /\[start-emulator\] Direct emulator radio device: null/.test(logText) ||
    /\[start-emulator\] Direct emulator radio override: null/.test(logText) ||
    /-radio null/.test(logText),
  directLaunchRadioOverrideDisabled:
    /\[start-emulator\] Direct emulator radio override: disabled/.test(logText),
  directLaunchAdbServerStarted:
    /\[start-emulator\] ADB server is running on port 5037 for direct emulator launch/.test(logText),
  metricsPromptWarning: /WARNING - ACTION REQUIRED/.test(logText),
  unsupportedHostGpu: /Your GPU cannot be used for hardware rendering/.test(logText),
  vulkanIncompatibleDriver: /VK_ERROR_INCOMPATIBLE_DRIVER/.test(logText),
  duplicateAvdLockFatal: /Running multiple emulators with the same AVD is an experimental feature/.test(logText),
  ipv6LiteralResolutionVerified:
    /\[start-emulator\] Verified IPv6 literal ::1 resolves for qemu modem sockets\./.test(logText) ||
    /\[start-emulator\] Provisioned dummy IPv6 interface to satisfy AI_ADDRCONFIG for ::1 modem socket resolution\./.test(logText),
  ipv6LiteralResolutionFailed:
    /\[start-emulator\] WARNING: IPv6 literal ::1 still does not resolve after provisioning dummy IPv6 interface/.test(logText),
  missingAdbBinary:
    /\[start-emulator\] (WARNING|ERROR): adb binary unavailable/.test(logText) ||
    /\[start-emulator\] WARNING: adb command unavailable/.test(logText),
  adbHostServerFailure: /AdbHostServer\.cpp:102: Unable to connect to adb daemon on port: 5037/.test(logText),
  shellUnsetVariableCrash: /start-emulator\.sh:\s*\d+:\s*_emulator_version: parameter not set/.test(logText),
  modemIpv6Failure: /qemu-system-[^:\s]+: .*id=modem: address resolution failed for ::1/.test(logText),
  invalidRadioOption: /qemu-system-[^:\s]+: -radio: invalid option/.test(logText),
  directAdbBridgeForwarderStarted: /\[start-emulator\] Started direct adb bridge forwarder on .*:5555 -> 127\.0\.0\.1:5555\./.test(logText),
  adbPortGuardHeartbeatCount: (logText.match(/\[adb-port-guard\] alive: iter=/g) || []).length,
  repeatedRestartLoop:
    (logText.match(/Using direct emulator launch: \/android\/sdk\/emulator\/emulator/g) || []).length > 1 ||
    (logText.match(/COMMAND: exec emulator\/emulator -avd Pixel2/g) || []).length > 1,
};

let rootCause = "unclassified";
let explanation = "No known emulator restart-loop signature matched this log.";

if (
  findings.directWrapperPatchedSelectedImage &&
  findings.wrapperSelectedLegacyLauncher &&
  findings.legacyLauncherReportedApi30 &&
  findings.modemIpv6Failure
) {
  rootCause = "legacy-launcher-overrode-patched-avd";
  explanation =
    "The wrapper patched the selected AVD system image, then /android/sdk/launch-emulator.sh still resolved API 30 and hit the modem ::1 crash.";
} else if (
  findings.directWrapperPatchedSelectedImage &&
  findings.directModeEnabled &&
  findings.directLaunchReportedSelectedApi &&
  findings.directLaunchRadioOverrideDisabled &&
  findings.modemIpv6Failure &&
  !findings.ipv6LiteralResolutionVerified
) {
  rootCause = "direct-launch-ipv6-addrconfig-unavailable";
  explanation =
    "Direct launch was configured correctly, but the container namespace still could not resolve the literal ::1 modem socket address for QEMU, so the emulator crashed in the IPv6 addrconfig path and restarted.";
} else if (
  findings.directWrapperPatchedSelectedImage &&
  findings.directModeEnabled &&
  findings.directLaunchReportedSelectedApi &&
  findings.modemIpv6Failure &&
  !findings.directLaunchLoggedRadioNull
) {
  rootCause = "direct-launch-left-internal-modem-enabled";
  explanation =
    "Direct launch reached the selected API level, but the wrapper still left the internal modem backend enabled, so QEMU created id=modem on ::1 and the container restarted.";
} else if (
  findings.directWrapperPatchedSelectedImage &&
  findings.directModeEnabled &&
  findings.directLaunchReportedSelectedApi &&
  findings.directLaunchLoggedRadioNull &&
  findings.invalidRadioOption
) {
  rootCause = "unsupported-radio-override";
  explanation =
    "Direct launch attempted to force a radio override, but the bundled emulator build rejected -radio entirely, so QEMU exited before the guest could boot.";
} else if (
  findings.directWrapperPatchedSelectedImage &&
  findings.directLaunchAdbServerStarted &&
  findings.directLaunchReportedSelectedApi &&
  findings.shellUnsetVariableCrash
) {
  rootCause = "direct-launch-unset-version-variable";
  explanation =
    "Direct launch was selected correctly, but the wrapper unset the cached emulator version before the radio-override gate referenced it under set -u, so the shell exited and the container restarted.";
} else if (
  findings.directWrapperPatchedSelectedImage &&
  findings.directModeEnabled &&
  findings.directLaunchReportedSelectedApi &&
  findings.directLaunchLoggedRadioNull &&
  findings.adbHostServerFailure &&
  findings.missingAdbBinary
) {
  rootCause = "direct-launch-missing-adb-host-server";
  explanation =
    "Direct launch reached the selected API level and disabled the modem backend, but the runtime lacked a usable adb binary, so the emulator could not connect to the host adb server on port 5037 and the container restarted.";
} else if (findings.duplicateAvdLockFatal) {
  rootCause = "duplicate-avd-lock";
  explanation =
    "The emulator refused to start because Pixel2 still had an AVD lock or another instance was using it. Start with read-only AVD mode and clear stale lock files before launch.";
} else if (findings.unsupportedHostGpu || findings.vulkanIncompatibleDriver) {
  rootCause = "unsupported-host-gpu-rendering";
  explanation =
    "The emulator tried to use host GPU rendering, but the container host did not expose a compatible GLES/Vulkan driver. Use swiftshader_indirect for container video streaming.";
}

const summary = {
  file: basename(absolutePath),
  rootCause,
  explanation,
  likelyHealthyLongRunningRuntime:
    findings.directAdbBridgeForwarderStarted &&
    findings.adbPortGuardHeartbeatCount >= 3 &&
    !findings.modemIpv6Failure &&
    !findings.invalidRadioOption &&
    !findings.shellUnsetVariableCrash &&
    !findings.adbHostServerFailure &&
    !findings.missingAdbBinary &&
    !findings.duplicateAvdLockFatal &&
    !findings.unsupportedHostGpu &&
    !findings.vulkanIncompatibleDriver &&
    !findings.repeatedRestartLoop,
  findings,
};

console.log(JSON.stringify(summary, null, 2));

if (rootCause !== "unclassified") {
  console.error(explanation);
  process.exit(1);
}

if (
  findings.modemIpv6Failure ||
  findings.invalidRadioOption ||
  findings.shellUnsetVariableCrash ||
  findings.ipv6LiteralResolutionFailed ||
  findings.duplicateAvdLockFatal ||
  findings.unsupportedHostGpu ||
  findings.vulkanIncompatibleDriver ||
  findings.repeatedRestartLoop
) {
  console.error("Detected an emulator restart loop, but the exact signature was not classified.");
  process.exit(1);
}
