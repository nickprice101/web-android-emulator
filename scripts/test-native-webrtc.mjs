import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function readRepoFile(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

const envoyConfig = readRepoFile("envoy.yaml");
assert.match(
  envoyConfig,
  /prefix:\s*"\/android\.emulation\.control\.Rtc"[\s\S]*?cluster:\s*emulator_service_grpc/m,
  "envoy.yaml must route /android.emulation.control.Rtc to emulator_service_grpc for native WebRTC signaling"
);
assert.match(
  envoyConfig,
  /prefix:\s*"\/android\.emulation\.control\.EmulatorController"[\s\S]*?cluster:\s*emulator_service_grpc/m,
  "envoy.yaml must route /android.emulation.control.EmulatorController to emulator_service_grpc"
);

const frontendMain = readRepoFile("frontend/src/main.jsx");
assert.match(
  frontendMain,
  /const \[streamMode, setStreamMode\] = useState\("native-webrtc"\);/,
  "frontend must default streamMode to native-webrtc"
);
assert.match(
  frontendMain,
  /value: "native-webrtc", label: "WebRTC \(native emulator\)"/,
  "frontend stream selector options must expose the native WebRTC mode"
);
assert.match(
  frontendMain,
  /value: "custom-webrtc", label: "WebRTC \(custom bridge\)"/,
  "frontend stream selector options must expose the custom bridge recovery mode"
);
assert.match(
  frontendMain,
  /jsep\._handleStart = \(signal\) => \{/,
  "native JSEP start patch must stay synchronous so SDP/candidate handling cannot race ahead of peer construction"
);
assert.doesNotMatch(
  frontendMain,
  /jsep\._handleStart = async \(signal\) => \{/,
  "native JSEP start patch must not be async because async start can drop first-offer signaling"
);
assert.match(
  frontendMain,
  /startMissingIce[\s\S]*\[\{ urls: FALLBACK_STUN_URL \}\]/m,
  "native JSEP patch must inject a fallback STUN server when emulator start signal lacks ICE servers"
);
assert.match(
  frontendMain,
  /const shouldPreferRelay = startSummary\.hasTurn && nativeIceTransportMode === "relay";/,
  "relay-only policy should only be forced when the emulator itself advertised TURN and the browser is still in relay mode"
);
assert.match(
  frontendMain,
  /fallbackSummary\.hasTurn && !fallbackSummary\.hasStun[\s\S]*FALLBACK_STUN_URL/m,
  "bridge TURN fallback should also inject STUN to avoid single-path TURN failures"
);

const composeConfig = readRepoFile("docker-compose.yml");
assert.match(
  composeConfig,
  /EMULATOR_PARAMS:\s*".*-gpu swiftshader_indirect.*"/m,
  "docker-compose emulator params must force swiftshader for stable native WebRTC video production in headless deployments"
);
assert.match(
  composeConfig,
  /EMULATOR_PARAMS:\s*".*-camera-back none.*-camera-front none.*"/m,
  "docker-compose emulator params must disable virtual cameras to avoid unstable media extractor startup paths"
);

const emulatorTurnWrapper = readRepoFile("emulator/start-emulator-with-turn.sh");
assert.match(
  emulatorTurnWrapper,
  /append_param_if_missing "-no-sim"/,
  "emulator wrapper must disable SIM/modem startup by default to avoid ::1 modem socket startup failures on IPv6-restricted container hosts"
);
assert.match(
  emulatorTurnWrapper,
  /ensure_ipv6_loopback_interface\(\)/,
  "emulator wrapper must proactively restore IPv6 loopback so qemu modem chardev host=::1 can resolve in restricted container namespaces"
);
assert.match(
  emulatorTurnWrapper,
  /ip -6 addr add ::1\/128 dev lo/,
  "emulator wrapper must attempt to re-add ::1 to loopback when the container runtime has IPv6 disabled"
);
assert.match(
  emulatorTurnWrapper,
  /TURNCFG_URLS_FORMAT="\$\{TURNCFG_URLS_FORMAT:-array\}"/,
  "emulator TURN wrapper must default TURN cfg urls to array form while keeping TURNCFG_URLS_FORMAT override support"
);
assert.match(
  emulatorTurnWrapper,
  /"iceServers":\[\{"urls":\["%s"\],"username":"%s","credential":"%s"\}\]/,
  "emulator TURN wrapper must support urls as an array for emulator builds that reject string form"
);
assert.match(
  emulatorTurnWrapper,
  /"iceServers":\[\{"urls":"%s","username":"%s","credential":"%s"\}\]/,
  "emulator TURN wrapper must retain urls string mode for backward compatibility"
);
assert.match(
  emulatorTurnWrapper,
  /turncfg hexdump preview command:/,
  "emulator TURN wrapper must log a hexdump-style preview command for turncfg output diagnostics"
);
assert.match(
  emulatorTurnWrapper,
  /turncfg jq preview command: TURNCFG_DEBUG=0/,
  "emulator TURN wrapper must log a jq-style preview command for turncfg output diagnostics"
);
assert.match(
  emulatorTurnWrapper,
  /chmod 755 "\$\{turn_cfg_script\}"/,
  "emulator TURN wrapper must keep the generated turncfg script executable by non-root emulator users"
);
assert.match(
  emulatorTurnWrapper,
  /export ANDROID_AVD_HOME="\$\{ANDROID_AVD_HOME:-\$\{ANDROID_EMULATOR_HOME\}\/avd\}"/,
  "emulator wrapper must export a canonical ANDROID_AVD_HOME so emulator -avd Pixel2 resolves the rebuilt API 34 AVD first"
);
assert.match(
  emulatorTurnWrapper,
  /ensure_pixel2_avd_aliases\(\)/,
  "emulator wrapper must canonicalize legacy Pixel2 AVD paths before launch so the base image cannot silently fall back to a stale API 30 AVD"
);
assert.match(
  emulatorTurnWrapper,
  /ln -s "\$\{_canonical_avd_dir\}" "\$\{_compat_avd_dir\}"/,
  "emulator wrapper must alias compatibility AVD directories back to the canonical Pixel2 AVD"
);
assert.match(
  emulatorTurnWrapper,
  /iptables-legacy|nft/,
  "emulator wrapper must keep the ADB port guard covering both iptables and nftables backends"
);
assert.match(
  emulatorTurnWrapper,
  /Copied Pixel2 AVD into canonical home:/,
  "emulator wrapper must log when it has to copy a discovered Pixel2 AVD into the canonical AVD home"
);
assert.match(
  emulatorTurnWrapper,
  /EMULATOR_LAUNCH_MODE="\$\{EMULATOR_LAUNCH_MODE:-direct\}"/,
  "emulator wrapper must default to direct launch mode so the wrapper controls the final emulator argv"
);
assert.match(
  emulatorTurnWrapper,
  /EMULATOR_RADIO_DEVICE="\$\{EMULATOR_RADIO_DEVICE:-null\}"/,
  "emulator wrapper must default the direct-launch radio backend to null so QEMU does not recreate the modem ::1 failure"
);
assert.match(
  emulatorTurnWrapper,
  /launch_direct_emulator\(\)/,
  "emulator wrapper must provide a direct emulator launch path under our control"
);
assert.match(
  emulatorTurnWrapper,
  /resolve_adb_bin\(\)/,
  "emulator wrapper must resolve adb from the SDK instead of assuming it is already on PATH"
);
assert.match(
  emulatorTurnWrapper,
  /ERROR: adb binary unavailable for direct launch/,
  "emulator wrapper must fail fast with an explicit message if platform-tools\/adb is missing"
);
assert.match(
  emulatorTurnWrapper,
  /supports_direct_radio_override\(\)/,
  "emulator wrapper must decide whether a radio override is safe for the bundled emulator version"
);
assert.match(
  emulatorTurnWrapper,
  /Android emulator version 30\./,
  "emulator wrapper must explicitly treat emulator 30.x as not supporting the direct-launch radio override"
);
assert.match(
  emulatorTurnWrapper,
  /EMULATOR_USE_RADIO_OVERRIDE/,
  "emulator wrapper must allow explicit opt-in or opt-out of the radio override when needed"
);
assert.match(
  emulatorTurnWrapper,
  /set -- "\$@" -radio "\$\{EMULATOR_RADIO_DEVICE\}"/,
  "emulator wrapper must still be able to pass -radio when the emulator version supports it"
);
assert.match(
  emulatorTurnWrapper,
  /Direct emulator radio override: disabled for emulator/,
  "emulator wrapper must log when it skips the radio override for unsupported emulator builds"
);
assert.match(
  emulatorTurnWrapper,
  /Direct emulator radio override: \$\{EMULATOR_RADIO_DEVICE\}/,
  "emulator wrapper must log the configured radio override when it is applied"
);
assert.match(
  emulatorTurnWrapper,
  /ADB server is running on port 5037 for direct emulator launch/,
  "emulator wrapper must pre-start adb in direct mode so the emulator does not race a missing adb daemon on port 5037"
);
assert.match(
  emulatorTurnWrapper,
  /elif \[ "\$\{EMULATOR_LAUNCH_MODE\}" = "legacy" \]; then[\s\S]*ADB_PORT="5557"[\s\S]*ADB_PORT="5555"/,
  "emulator wrapper must guard the correct internal ADB port for both legacy and direct launch modes"
);
assert.match(
  emulatorTurnWrapper,
  /ADB_PORT_GUARD_INTERVAL/,
  "emulator wrapper must expose ADB_PORT_GUARD_INTERVAL so the iptables polling cadence is configurable"
);

const emulatorDockerfile = readRepoFile("emulator/Dockerfile");
assert.doesNotMatch(
  emulatorDockerfile,
  /sdkmanager.*"emulator"/,
  "emulator Dockerfile must NOT update the emulator binary via sdkmanager; the base image bundles a compatible version and newer sdkmanager builds add iptables ADB-port restrictions that break socat forwarding"
);
assert.match(
  emulatorDockerfile,
  /ENV ANDROID_USER_HOME=\/root\/\.android[\s\S]*ANDROID_AVD_HOME=\/root\/\.android\/avd/,
  "emulator Dockerfile must pin the canonical Android user and AVD homes so the rebuilt Pixel2 AVD wins over any base-image metadata"
);
assert.match(
  emulatorDockerfile,
  /PATH=\/android\/sdk\/platform-tools:\/android\/sdk\/emulator:\$\{PATH\}/,
  "emulator Dockerfile must expose platform-tools and emulator binaries on PATH at runtime"
);
assert.match(
  emulatorDockerfile,
  /"platform-tools"/,
  "emulator Dockerfile must install Android SDK Platform-Tools so adb is available in the runtime image"
);
assert.match(
  emulatorDockerfile,
  /Expected adb at \$\{ANDROID_SDK_ROOT\}\/platform-tools\/adb after installing platform-tools/,
  "emulator Dockerfile must fail the build if adb is still missing after installing platform-tools"
);
assert.match(
  emulatorDockerfile,
  /ln -s "\$\{_avd_dir\}" \/Pixel2\.avd[\s\S]*ln -s "\$\{_avd_ini\}" \/Pixel2\.ini/,
  "emulator Dockerfile must replace legacy /Pixel2 metadata with links to the canonical rebuilt AVD"
);

const logAnalyzer = readRepoFile("scripts/analyze-emulator-log.mjs");
assert.match(
  logAnalyzer,
  /legacy-launcher-overrode-patched-avd/,
  "emulator log analyzer must still classify the known legacy-launcher restart loop"
);
assert.match(
  logAnalyzer,
  /direct-launch-left-internal-modem-enabled/,
  "emulator log analyzer must classify the direct-launch restart loop caused by the internal modem backend"
);
assert.match(
  logAnalyzer,
  /unsupported-radio-override/,
  "emulator log analyzer must classify emulator builds that reject the direct-launch -radio override"
);
assert.match(
  logAnalyzer,
  /direct-launch-missing-adb-host-server/,
  "emulator log analyzer must still classify the direct-launch restart loop caused by a missing adb host server"
);
assert.match(
  logAnalyzer,
  /Direct launch attempted to force a radio override, but the bundled emulator build rejected -radio entirely/i,
  "emulator log analyzer must explain the unsupported-radio restart loop clearly"
);

console.log("[native-webrtc-test] Native WebRTC routing + frontend defaults verified.");
