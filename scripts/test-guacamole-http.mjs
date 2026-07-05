import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function readRepoFile(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function assertNoActiveTurnConfig(name, text) {
  assert.doesNotMatch(text, /\bTURN_[A-Z0-9_]+\b/, `${name} must not expose TURN_* runtime configuration`);
  assert.doesNotMatch(text, /-turncfg\b/, `${name} must not pass emulator -turncfg`);
  assert.doesNotMatch(text, /turn-tls-shim|turn-connectivity-harness/i, `${name} must not reference removed TURN harnesses`);
}

const frontendMain = readRepoFile("frontend/src/main.jsx");
assert.match(
  frontendMain,
  /const \[streamMode, setStreamMode\] = useState\("scrcpy-http"\);/,
  "frontend must default to the Guacamole-style HTTP tunnel"
);
assert.match(
  frontendMain,
  /value: "scrcpy-http", label: "Guacamole HTTP \(24fps\)"/,
  "stream selector must expose the 24fps HTTP tunnel as the primary mode"
);
assert.doesNotMatch(
  frontendMain,
  /FALLBACK_STUN_URL|stun:stun\.l\.google\.com/,
  "frontend must not inject a public STUN server"
);
assert.match(
  frontendMain,
  /max_fps: String\(GUACAMOLE_HTTP_TARGET_FPS\)/,
  "frontend must request the configured 24fps target from the scrcpy endpoint"
);
assert.match(
  frontendMain,
  /Sent \$\{name\} through Guacamole-style HTTP input/,
  "toolbar keys must route through HTTP input when the HTTP tunnel is active"
);

const apkbridgeApp = readRepoFile("apkbridge/app.py");
assert.match(apkbridgeApp, /SCRCPY_MAX_FPS = .*"24"/, "apkbridge must default scrcpy to 24fps");
assert.match(apkbridgeApp, /SCRCPY_VIDEO_BIT_RATE = .*"6000000"/, "apkbridge must default to a tunnel-friendly bitrate");
const scrcpyCommand = apkbridgeApp.match(/scrcpy_cmd = \[[\s\S]*?\n            \]/)?.[0] || "";
assert.ok(scrcpyCommand, "apkbridge must define a scrcpy command for the HTTP tunnel");
assert.doesNotMatch(scrcpyCommand, /"--no-display"/, "apkbridge must use scrcpy 3.x --no-window instead of removed --no-display");
assert.doesNotMatch(scrcpyCommand, /"--bit-rate"/, "apkbridge must use scrcpy 3.x --video-bit-rate instead of removed --bit-rate");
assert.match(scrcpyCommand, /"--no-window"/, "apkbridge must run scrcpy headless with the current --no-window option");
assert.match(scrcpyCommand, /"--no-audio"/, "apkbridge must disable scrcpy audio in the headless HTTP tunnel");
assert.match(scrcpyCommand, /"--video-bit-rate"/, "apkbridge must configure scrcpy video bitrate with the current option name");
assert.match(
  apkbridgeApp,
  /empty_moov\+default_base_moof\+separate_moof\+omit_tfhd_offset/,
  "apkbridge ffmpeg muxing must use low-latency fragmented MP4 flags"
);
assert.match(apkbridgeApp, /-flush_packets/, "apkbridge ffmpeg muxing must flush live fragments");

const composeConfig = readRepoFile("docker-compose.yml");
assertNoActiveTurnConfig("docker-compose.yml", composeConfig);
assert.match(composeConfig, /SCRCPY_MAX_FPS:\s*"24"/, "compose must pin scrcpy max fps to 24");
assert.match(composeConfig, /SCRCPY_VIDEO_BIT_RATE:/, "compose must expose scrcpy bitrate tuning");
assert.match(composeConfig, /CAPTURE_FPS:\s*"\$\{CAPTURE_FPS:-24\}"/, "optional WebRTC bridge fallback must also default to 24fps");

const emulatorDockerfile = readRepoFile("emulator/Dockerfile");
const emulatorWrapper = readRepoFile("emulator/start-emulator.sh");
assertNoActiveTurnConfig("emulator/Dockerfile", emulatorDockerfile);
assertNoActiveTurnConfig("emulator/start-emulator.sh", emulatorWrapper);
assert.match(emulatorDockerfile, /COPY start-emulator\.sh \/usr\/local\/bin\/start-emulator\.sh/, "emulator Dockerfile must install the renamed wrapper");
assert.match(emulatorDockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/start-emulator\.sh"\]/, "emulator Dockerfile must run the renamed wrapper");
assert.match(emulatorWrapper, /\[start-emulator\]/, "emulator wrapper logs must use the non-TURN prefix");
assert.match(emulatorWrapper, /EMULATOR_LAUNCH_MODE="\$\{EMULATOR_LAUNCH_MODE:-direct\}"/, "emulator wrapper must keep direct launch as the default");
assert.match(emulatorWrapper, /start_direct_adb_bridge_forwarder\(\)/, "emulator wrapper must keep the sibling-container ADB bridge");

const bridgeServer = readRepoFile("bridge-webrtc/server.mjs");
assertNoActiveTurnConfig("bridge-webrtc/server.mjs", bridgeServer);
assert.doesNotMatch(bridgeServer, /prepareIceServersForNode|createHmac|turnConnectivity|turnPolicy/i, "bridge server must not contain TURN preparation or credential code");
assert.match(bridgeServer, /iceServers: buildIceServers\(\),[\s\S]*iceTransportPolicy: "all"/, "optional bridge WebRTC config must be local ICE only");
assert.equal(existsSync(resolve(repoRoot, "bridge-webrtc/turn-tls-shim.mjs")), false, "TURN TLS shim file must be removed");
assert.equal(existsSync(resolve(repoRoot, "bridge-webrtc/test/turn-connectivity-harness.mjs")), false, "TURN connectivity harness must be removed");

const testbedSh = readRepoFile("scripts/testbed.sh");
const testbedPs1 = readRepoFile("scripts/testbed.ps1");
assertNoActiveTurnConfig("scripts/testbed.sh", testbedSh);
assertNoActiveTurnConfig("scripts/testbed.ps1", testbedPs1);
assert.match(testbedSh, /test-guacamole-http\.mjs/, "bash testbed must run the HTTP tunnel configuration guard");
assert.match(testbedPs1, /test-guacamole-http\.mjs/, "PowerShell testbed must run the HTTP tunnel configuration guard");
assert.match(testbedSh, /test:e2e:guacamole-http/, "bash testbed must run the Guacamole HTTP E2E when deployed validation is enabled");

const envoyConfig = readRepoFile("envoy.yaml");
assert.match(
  envoyConfig,
  /prefix:\s*"\/api\/"[\s\S]*?cluster:\s*apkbridge[\s\S]*?timeout:\s*0s/m,
  "Envoy must keep /api routed to apkbridge with streaming timeouts disabled"
);

console.log("[guacamole-http-test] Guacamole-style HTTP tunnel defaults verified.");
