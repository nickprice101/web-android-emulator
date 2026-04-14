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
  /const STREAM_MODE_OPTIONS = \[\{ value: "native-webrtc", label: "WebRTC \(native emulator\)" \}\];/,
  "frontend stream selector options must expose the native WebRTC mode"
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

console.log("[native-webrtc-test] Native WebRTC routing + frontend defaults verified.");
