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
  /ipv6_literal_resolution_works\(\)/,
  "emulator wrapper must probe whether literal ::1 resolution actually works for qemu instead of assuming loopback alone is enough"
);
assert.match(
  emulatorTurnWrapper,
  /ensure_ipv6_addrconfig_interface\(\)/,
  "emulator wrapper must provide an IPv6 addrconfig helper path for namespaces where ::1 still fails to resolve"
);
assert.match(
  emulatorTurnWrapper,
  /ip link add dummy0 type dummy/,
  "emulator wrapper must be able to provision a dummy interface when AI_ADDRCONFIG still rejects the ::1 modem socket address"
);
assert.match(
  emulatorTurnWrapper,
  /ip -6 addr add fd00::1\/128 dev dummy0/,
  "emulator wrapper must add a non-loopback IPv6 address so ::1 can resolve in IPv6-restricted namespaces"
);
assert.match(
  emulatorTurnWrapper,
  /Verified IPv6 literal ::1 resolves for qemu modem sockets\./,
  "emulator wrapper must log when the IPv6 modem-resolution preflight succeeds"
);
assert.match(
  emulatorTurnWrapper,
  /Provisioned dummy IPv6 interface to satisfy AI_ADDRCONFIG for ::1 modem socket resolution\./,
  "emulator wrapper must log when it had to provision an IPv6 addrconfig helper interface"
);
assert.match(
  emulatorTurnWrapper,
  /WARNING: IPv6 literal ::1 still does not resolve after provisioning dummy IPv6 interface/,
  "emulator wrapper must log a clear warning if the IPv6 addrconfig helper still fails"
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
  /DIRECT_EMULATOR_VERSION="\$\{_emulator_version\}"/,
  "emulator wrapper must persist the detected emulator version for later direct-launch decisions instead of unsetting it"
);
assert.match(
  emulatorTurnWrapper,
  /supports_direct_radio_override\(\)/,
  "emulator wrapper must decide whether a radio override is safe for the bundled emulator version"
);
assert.match(
  emulatorTurnWrapper,
  /_emulator_version_for_launch="\$\{DIRECT_EMULATOR_VERSION:-unknown\}"/,
  "emulator wrapper must read the cached emulator version through a safe default inside the radio-override gate"
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
  /Direct emulator radio override: disabled for emulator '\$\{DIRECT_EMULATOR_VERSION:-unknown\}'/,
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
const emulatorHealthcheck = readRepoFile("emulator/healthcheck-adb-bridge.sh");
assert.match(
  emulatorDockerfile,
  /ARG EMULATOR_PACKAGE_VERSION=36\.5\.10[\s\S]*ARG EMULATOR_PACKAGE_URL=https:\/\/dl\.google\.com\/android\/repository\/emulator-linux_x64-15081367\.zip[\s\S]*ARG EMULATOR_PACKAGE_SHA1=9f03296214df837c608d0d101e5e03ebcebb4343/m,
  "emulator Dockerfile must pin the official stable emulator archive metadata so the stale base-image emulator binary is replaced deterministically"
);
assert.match(
  emulatorDockerfile,
  /"\$\{SDKMANAGER_BIN\}" --channel=0 "platform-tools" "\$\{EMULATOR_SYSTEM_IMAGE\}" "\$\{EMULATOR_PLATFORM\}"/,
  "emulator Dockerfile must still install platform-tools and the API 34 guest packages through sdkmanager"
);
assert.match(
  emulatorDockerfile,
  /curl -fsSL "\$\{EMULATOR_PACKAGE_URL\}" -o "\$\{TMP_ZIP\}"[\s\S]*sha1sum -c -[\s\S]*mv "\$\{TMP_DIR\}\/emulator" "\$\{ANDROID_SDK_ROOT\}\/emulator"/,
  "emulator Dockerfile must manually install the pinned emulator archive into /android/sdk/emulator so the stale base-image binary is fully replaced"
);
assert.match(
  emulatorDockerfile,
  /Installed emulator binary version:[\s\S]*Expected manual emulator archive install to replace the stale 30\.x base-image emulator binary/,
  "emulator Dockerfile must verify during build that the manual emulator install replaced the stale 30.x binary"
);
assert.match(
  emulatorDockerfile,
  /cp "\$\{_emulator_pkg_xml_old\}" "\$\{TMP_DIR\}\/emulator\/package\.xml"[\s\S]*<major>36<\/major>[\s\S]*<minor>5<\/minor>[\s\S]*<micro>10<\/micro>/,
  "emulator Dockerfile must preserve package.xml metadata while updating it to the pinned manual emulator version"
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
  /COPY healthcheck-adb-bridge\.sh \/usr\/local\/bin\/healthcheck-adb-bridge\.sh/,
  "emulator Dockerfile must install the custom adb-bridge healthcheck instead of inheriting the stale base-image healthcheck"
);
assert.match(
  emulatorDockerfile,
  /HEALTHCHECK --interval=30s --timeout=30s --start-period=180s --retries=10 CMD \["\/usr\/local\/bin\/healthcheck-adb-bridge\.sh"\]/,
  "emulator Dockerfile must override the inherited healthcheck with the adb-bridge-aware healthcheck script"
);
assert.match(
  emulatorHealthcheck,
  /resolve_container_ipv4\(\)/,
  "emulator adb-bridge healthcheck must derive a non-loopback container IPv4 for the bridge probe"
);
assert.match(
  emulatorHealthcheck,
  /adb_target="\$\{EMULATOR_HEALTHCHECK_ADB_TARGET:-\}"/,
  "emulator adb-bridge healthcheck must allow an explicit ADB target override"
);
assert.match(
  emulatorHealthcheck,
  /adb_target="\$\{container_ipv4\}:5555"/,
  "emulator adb-bridge healthcheck must default to probing the non-loopback adb bridge target on port 5555"
);
assert.match(
  emulatorHealthcheck,
  /"\$\{ADB_BIN\}" connect "\$\{adb_target\}"/,
  "emulator adb-bridge healthcheck must explicitly connect to the selected adb bridge target before checking state"
);
assert.match(
  emulatorHealthcheck,
  /"\$\{ADB_BIN\}" -s "\$\{adb_target\}" get-state/,
  "emulator adb-bridge healthcheck must check a specific adb serial so it cannot fail with 'more than one device/emulator'"
);
assert.match(
  emulatorDockerfile,
  /ln -s "\$\{_avd_dir\}" \/Pixel2\.avd[\s\S]*ln -s "\$\{_avd_ini\}" \/Pixel2\.ini/,
  "emulator Dockerfile must replace legacy /Pixel2 metadata with links to the canonical rebuilt AVD"
);

const logAnalyzer = readRepoFile("scripts/analyze-emulator-log.mjs");
const startupSmokeTest = readRepoFile("scripts/test-emulator-startup.sh");
assert.match(
  startupSmokeTest,
  /DEFAULT_CONTAINER_NAME="emu-smoke-test-\$\(date \+%s\)-\$\$"/,
  "startup smoke test must default to a unique container name so repeated remote runs cannot collide with stale containers"
);
assert.match(
  startupSmokeTest,
  /if docker inspect "\$\{CONTAINER_NAME\}" >\/dev\/null 2>&1; then[\s\S]*Removing stale test container \${CONTAINER_NAME} before startup[\s\S]*docker rm -f "\$\{CONTAINER_NAME\}"/,
  "startup smoke test must pre-clean a reused container name before docker run so reruns cannot fail on stale containers"
);
assert.match(
  startupSmokeTest,
  /probe_local_tcp_port\(\)/,
  "startup smoke test must use an internal TCP probe helper rather than assuming netcat is installed in the runtime image"
);
assert.match(
  startupSmokeTest,
  /timeout 15 docker exec "\$\{CONTAINER_NAME\}" python3 - "\$port"/,
  "startup smoke test must bound the host-side gRPC\/ADB port probe so docker exec cannot hang indefinitely"
);
assert.match(
  startupSmokeTest,
  /timeout 15 python3 - "\$host" "\$port"/,
  "startup smoke test must also support non-loopback TCP probes from the host for the exported adb bridge path"
);
assert.match(
  startupSmokeTest,
  /socket\.socket\(socket\.AF_INET, socket\.SOCK_STREAM\)/,
  "startup smoke test must use a Python socket probe for container-local readiness checks"
);
assert.match(
  startupSmokeTest,
  /REQUIRE_ADB_BRIDGE="\$\{REQUIRE_ADB_BRIDGE:-1\}"/,
  "startup smoke test must require the adb bridge by default so it cannot report success while emulator:5555 is still unusable"
);
assert.match(
  startupSmokeTest,
  /REQUIRE_HEALTHY_CONTAINER="\$\{REQUIRE_HEALTHY_CONTAINER:-1\}"/,
  "startup smoke test must require Docker health to become healthy by default"
);
assert.match(
  startupSmokeTest,
  /HEALTH_READY_TIMEOUT="\$\{HEALTH_READY_TIMEOUT:-240\}"/,
  "startup smoke test must wait for the container healthcheck to turn healthy after bridge validation"
);
assert.match(
  startupSmokeTest,
  /EMULATOR_ADB_SERIAL="\$\{EMULATOR_ADB_SERIAL:-emulator-\$\{EMULATOR_CONSOLE_PORT\}\}"/,
  "startup smoke test must probe the internal emulator transport by explicit serial instead of creating duplicate localhost adb transports"
);
assert.match(
  startupSmokeTest,
  /probe_external_adb_bridge_state\(\)/,
  "startup smoke test must verify adb connectivity from the non-loopback bridge path"
);
assert.match(
  startupSmokeTest,
  /--add-host "emulator:\$\{container_ip\}"/,
  "startup smoke test must simulate the sibling-container adb target name emulator:5555 during the bridge probe"
);
assert.match(
  startupSmokeTest,
  /adb connect emulator:5555/,
  "startup smoke test must explicitly verify that a non-loopback adb client can connect to emulator:5555"
);
assert.match(
  startupSmokeTest,
  /adb -s emulator:5555 get-state/,
  "startup smoke test must require the external adb bridge target to report a usable device transport"
);
assert.match(
  startupSmokeTest,
  /PASSIVE_API_PROBE_TIMEOUT="\$\{PASSIVE_API_PROBE_TIMEOUT:-60\}"/,
  "startup smoke test must keep passive guest-state probing short enough that slow adb responses do not stall the whole remote testbed"
);
assert.match(
  startupSmokeTest,
  /WARNING: external adb target emulator:5555 did not report device within .* Treating startup as healthy because the emulator runtime is still up\./,
  "startup smoke test must explicitly describe passive failures in terms of the real external adb bridge target"
);
assert.match(
  startupSmokeTest,
  /ADB bridge probe mode:/,
  "startup smoke test output must report whether the ADB bridge check ran in strict or passive mode"
);
assert.match(
  startupSmokeTest,
  /Waiting up to .* for external adb target emulator:5555 to report device/,
  "startup smoke test must wait for a usable adb transport on the non-loopback bridge path"
);
assert.match(
  startupSmokeTest,
  /stale emulator 30\.x binary with the API 34 guest image/,
  "startup smoke test must reject the stale emulator 30.x binary when validating the API 34 guest path"
);
assert.match(
  startupSmokeTest,
  /emulator binary is still outdated for the installed guest image/,
  "startup smoke test must also reject the emulator's own out-of-date warning when validating the API 34 guest path"
);
assert.match(
  startupSmokeTest,
  /Waiting up to \$\{HEALTH_READY_TIMEOUT\}s for container health status to become healthy/,
  "startup smoke test must explicitly wait for Docker health status after bridge validation"
);
assert.match(
  startupSmokeTest,
  /Container health status is healthy\./,
  "startup smoke test must report a healthy container once the custom healthcheck succeeds"
);
assert.match(
  startupSmokeTest,
  /WARNING: guest ADB state is still pending after \$\{guest_probe_timeout\}s/,
  "startup smoke test must report the actual passive guest-probe timeout instead of the strict timeout when guest ADB stays pending"
);
assert.match(
  startupSmokeTest,
  /Guest probe pending:/,
  "startup smoke test must emit periodic guest-probe progress so remote workflow runs do not look hung"
);
assert.doesNotMatch(
  startupSmokeTest,
  /-p 18554:8554[\s\S]*-p 15555:5555/,
  "startup smoke test must not bind fixed host ports because the remote testbed can already have the production emulator stack using those ports"
);
assert.doesNotMatch(
  startupSmokeTest,
  /adb connect 127\.0\.0\.1:5555/,
  "startup smoke test must not create duplicate localhost network transports inside the emulator container while probing guest state"
);
assert.match(
  logAnalyzer,
  /likelyHealthyLongRunningRuntime/,
  "emulator log analyzer must surface when a log shows a stable long-running runtime rather than a restart loop"
);
assert.match(
  logAnalyzer,
  /adbPortGuardHeartbeatCount/,
  "emulator log analyzer must count adb-port-guard heartbeats so long-running startup logs can be recognized as healthy"
);
assert.match(
  logAnalyzer,
  /adbPortGuardHeartbeatCount >= 3/,
  "emulator log analyzer must treat a few sustained adb-port-guard heartbeats as sufficient evidence of a healthy long-running runtime"
);
assert.match(
  logAnalyzer,
  /legacy-launcher-overrode-patched-avd/,
  "emulator log analyzer must still classify the known legacy-launcher restart loop"
);
assert.match(
  logAnalyzer,
  /direct-launch-ipv6-addrconfig-unavailable/,
  "emulator log analyzer must classify direct-launch restart loops caused by literal ::1 resolution still failing in the container namespace"
);
assert.match(
  logAnalyzer,
  /direct-launch-left-internal-modem-enabled/,
  "emulator log analyzer must classify the direct-launch restart loop caused by the internal modem backend"
);
assert.match(
  logAnalyzer,
  /container namespace still could not resolve the literal ::1 modem socket address for QEMU/i,
  "emulator log analyzer must explain the IPv6 addrconfig restart loop clearly"
);
assert.match(
  logAnalyzer,
  /unsupported-radio-override/,
  "emulator log analyzer must classify emulator builds that reject the direct-launch -radio override"
);
assert.match(
  logAnalyzer,
  /direct-launch-unset-version-variable/,
  "emulator log analyzer must classify wrapper crashes caused by unsetting the cached emulator version too early"
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
assert.match(
  logAnalyzer,
  /wrapper unset the cached emulator version before the radio-override gate referenced it under set -u/i,
  "emulator log analyzer must explain the unset-version shell crash clearly"
);

console.log("[native-webrtc-test] Native WebRTC routing + frontend defaults verified.");
