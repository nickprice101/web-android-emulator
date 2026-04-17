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
  /iptables -[CI] INPUT.*--dport.*"\$\{ADB_PORT\}".*-j ACCEPT/,
  "emulator wrapper must maintain an iptables ACCEPT rule for the ADB port on loopback so socat forwarding is not blocked by emulator-added DROP rules"
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

console.log("[native-webrtc-test] Native WebRTC routing + frontend defaults verified.");
