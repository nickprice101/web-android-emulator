import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function readRepoFile(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function assertNoActiveTurnConfig(name, text) {
  assert.doesNotMatch(text, /\bTURN_[A-Z0-9_]+\b/, `${name} must not expose TURN_* runtime configuration`);
  assert.doesNotMatch(text, /-turncfg\b/, `${name} must not pass emulator -turncfg`);
  assert.doesNotMatch(text, /turn-tls-shim|turn-connectivity-harness/i, `${name} must not reference removed TURN harnesses`);
}

function assertNoWebrtcRuntime(name, text) {
  assert.doesNotMatch(
    text,
    /android-emulator-webrtc|bridge-webrtc|custom-webrtc|native-webrtc|grpc-web|\/bridge\/|RTCPeerConnection|MediaStream|wrtc/i,
    `${name} must not contain the removed WebRTC runtime path`
  );
}

const frontendMain = readRepoFile("frontend/src/main.jsx");
assert.match(
  frontendMain,
  /const \[streamMode, setStreamMode\] = useState\(DISPLAY_HTTP_MODE\);/,
  "frontend must default to the Guacamole-style HTTP tunnel"
);
assert.match(
  frontendMain,
  /const DISPLAY_HTTP_MODE = "display-http";/,
  "frontend must name the FFmpeg display transport explicitly"
);
assert.match(
  frontendMain,
  /value: DISPLAY_HTTP_MODE, label: "Guacamole HTTP \(30fps\)"/,
  "stream selector must expose the 30fps HTTP tunnel as the primary mode"
);
const streamModeOptions = frontendMain.match(/const STREAM_MODE_OPTIONS = \[[\s\S]*?\];/)?.[0] || "";
assert.ok(streamModeOptions, "frontend must define stream mode options");
assert.match(streamModeOptions, /value: "png", label: "PNG preview"/, "stream selector must retain PNG preview");
assertNoWebrtcRuntime("frontend/src/main.jsx", frontendMain);
assert.match(
  frontendMain,
  /'video\/mp4; codecs="avc1\.42C029"'/,
  "frontend must prefer the API 36-compatible AVC codec string seen in emulator logs"
);
assert.match(
  frontendMain,
  /max_fps: String\(GUACAMOLE_HTTP_TARGET_FPS\)/,
  "frontend must request the configured 30fps target from the display video endpoint"
);
assert.match(
  frontendMain,
  /\/api\/display-video\?/,
  "frontend must stream video from the FFmpeg X display endpoint"
);
assert.match(
  frontendMain,
  /FFmpeg X display diagnostics/,
  "frontend diagnostics must describe the FFmpeg X display capture path"
);
assert.match(
  frontendMain,
  /Sent \$\{name\} through Guacamole-style HTTP input/,
  "toolbar keys must route through HTTP input"
);

const frontendPackage = readRepoFile("frontend/package.json");
const frontendViteConfig = readRepoFile("frontend/vite.config.js");
assertNoWebrtcRuntime("frontend/package.json", frontendPackage);
assertNoWebrtcRuntime("frontend/vite.config.js", frontendViteConfig);

const frontendNginx = readRepoFile("frontend/nginx.conf");
assert.match(frontendNginx, /location \/api\/ \{[\s\S]*proxy_pass http:\/\/apkbridge:5000\//, "frontend Nginx must proxy /api to apkbridge");
assert.match(frontendNginx, /proxy_buffering off;/, "frontend Nginx must not buffer the live display stream");
assert.match(frontendNginx, /proxy_read_timeout 1h;/, "frontend Nginx must allow long-lived display video responses");

const apkbridgeApp = readRepoFile("apkbridge/app.py");
const apkbridgeDockerfile = readRepoFile("apkbridge/Dockerfile");
assert.match(apkbridgeApp, /VIDEO_MAX_FPS = .*"30"/, "apkbridge must default HTTP video to 30fps");
assert.match(apkbridgeApp, /VIDEO_BIT_RATE = [\s\S]*?"6000000"/, "apkbridge must default to a tunnel-friendly bitrate");
assert.match(apkbridgeApp, /X11_DISPLAY = .*"emulator:99\.0"/, "apkbridge must default to the emulator container X display");
assert.match(apkbridgeApp, /def schedule_video_startup_nudge/, "apkbridge must nudge the display when starting video capture");
const x11FfmpegCommand = apkbridgeApp.match(/def x11_ffmpeg_command[\s\S]*?\n\n/)?.[0] || "";
assert.ok(x11FfmpegCommand, "apkbridge must define an FFmpeg X display command for the HTTP tunnel");
assert.match(x11FfmpegCommand, /"x11grab"/, "apkbridge must capture the emulator virtual display with FFmpeg x11grab");
assert.match(x11FfmpegCommand, /"libx264"/, "apkbridge must encode X display frames as browser-compatible H.264");
assert.match(x11FfmpegCommand, /"zerolatency"/, "apkbridge must tune the encoder for live streaming");
assert.match(x11FfmpegCommand, /X11_VIDEO_SIZE/, "apkbridge must capture the configured X display rectangle");
assert.match(apkbridgeApp, /@app\.get\("\/display-video"\)/, "apkbridge must expose the new display video endpoint");
assert.match(apkbridgeApp, /@app\.get\("\/scrcpy-video"\)/, "apkbridge must keep the old endpoint as a compatibility alias");
assert.doesNotMatch(
  apkbridgeApp,
  /scrcpy_cmd = \[/,
  "apkbridge must not construct a scrcpy recording command"
);
assert.doesNotMatch(apkbridgeDockerfile, /\bscrcpy\b/, "apkbridge image must not install scrcpy");
assert.match(apkbridgeApp, /generate_screenrecord_mp4/, "apkbridge must retain an adb screenrecord MP4 fallback");
assert.match(
  apkbridgeApp,
  /"screenrecord",\s*"--bugreport",\s*"--output-format=h264"/,
  "apkbridge screenrecord fallback must use --bugreport so API 34+ stdout capture emits frames"
);
assert.match(
  apkbridgeApp,
  /"-f",\s*"x11grab"[\s\S]*?"-i",\s*X11_DISPLAY/,
  "apkbridge ffmpeg input must capture the configured X display"
);
assert.match(
  apkbridgeApp,
  /"-probesize",\s*"65536"[\s\S]*?"-analyzeduration",\s*"1000000"[\s\S]*?"-f",\s*"h264"/,
  "apkbridge ffmpeg fallback must probe sparse screenrecord H.264 enough to emit video fragments"
);
assert.doesNotMatch(apkbridgeApp, /\+genpts\+nobuffer/, "apkbridge fallback must not drop sparse startup frames with ffmpeg nobuffer");
assert.match(
  apkbridgeApp,
  /empty_moov\+default_base_moof\+separate_moof\+omit_tfhd_offset/,
  "apkbridge ffmpeg muxing must use low-latency fragmented MP4 flags"
);
assert.match(apkbridgeApp, /-flush_packets/, "apkbridge ffmpeg muxing must flush live fragments");

const composeConfig = readRepoFile("docker-compose.yml");
assertNoActiveTurnConfig("docker-compose.yml", composeConfig);
assertNoWebrtcRuntime("docker-compose.yml", composeConfig);
assert.match(composeConfig, /EMULATOR_GPU_MODE:\s*"\$\{EMULATOR_GPU_MODE:-swiftshader_indirect\}"/, "compose must default the emulator to container-safe software GPU rendering");
assert.match(composeConfig, /EMULATOR_AVD_READ_ONLY:\s*"\$\{EMULATOR_AVD_READ_ONLY:-1\}"/, "compose must default the emulator AVD to read-only startup for duplicate-lock tolerance");
assert.match(composeConfig, /EMULATOR_SYSTEM_IMAGE:\s*"\$\{EMULATOR_SYSTEM_IMAGE:-system-images;android-36;google_apis;x86_64\}"/, "compose must default to the API 36 Google APIs x86_64 system image");
assert.match(composeConfig, /EMULATOR_PLATFORM:\s*"\$\{EMULATOR_PLATFORM:-platforms;android-36\}"/, "compose must default to the Android 36 platform package");
assert.match(composeConfig, /shm_size:\s*"6gb"/, "compose must provide more than 4GB of shared memory for the AI-capable emulator");
assert.match(composeConfig, /EMULATOR_RAM_SIZE_MB:\s*"\$\{EMULATOR_RAM_SIZE_MB:-6144\}"/, "compose must default the emulator guest RAM above 4GB");
assert.match(composeConfig, /EMULATOR_VIRTUAL_DISPLAY:\s*"\$\{EMULATOR_VIRTUAL_DISPLAY:-1\}"/, "compose must enable the virtual X display by default");
assert.match(composeConfig, /EMULATOR_X_DISPLAY:\s*"\$\{EMULATOR_X_DISPLAY:-:99\}"/, "compose must pin the emulator X display");
assert.match(composeConfig, /EMULATOR_X_CAPTURE_SIZE:\s*"\$\{EMULATOR_X_CAPTURE_SIZE:-1080x1920\}"/, "compose must align the emulator window with the FFmpeg capture size");
assert.match(composeConfig, /EMULATOR_PARAMS:.*-no-metrics/, "compose must opt the emulator out of metrics prompts");
assert.match(composeConfig, /VIDEO_MAX_FPS:\s*"\$\{VIDEO_MAX_FPS:-30\}"/, "compose must pin HTTP video max fps to 30");
assert.match(composeConfig, /VIDEO_BIT_RATE:/, "compose must expose FFmpeg video bitrate tuning");
assert.match(composeConfig, /X11_DISPLAY:\s*"\$\{X11_DISPLAY:-emulator:99\.0\}"/, "compose must point apkbridge at the emulator X display");
assert.match(composeConfig, /X11_VIDEO_SIZE:\s*"\$\{X11_VIDEO_SIZE:-1080x1920\}"/, "compose must pass the FFmpeg capture rectangle");
assert.doesNotMatch(composeConfig, /SCRCPY_PORT_RANGE:/, "compose must not expose scrcpy tunnel port tuning");
assert.match(composeConfig, /ADB_INSTALL_ABI:\s*"\$\{ADB_INSTALL_ABI:-auto-ai\}"/, "compose must default to AI-aware ABI selection while preserving Android auto-selection for non-AI APKs");
assert.match(composeConfig, /18080:80/, "frontend must own the public UI/API entrypoint");
assert.doesNotMatch(composeConfig, /envoyproxy\/envoy|container_name:\s*google-emu-envoy/, "compose must not start the removed Envoy container");
assert.doesNotMatch(composeConfig, /-grpc\s+8554|emu-grpc-token|8554/, "compose must not expose emulator gRPC for the HTTP-only path");

const emulatorDockerfile = readRepoFile("emulator/Dockerfile");
const emulatorWrapper = readRepoFile("emulator/start-emulator.sh");
assertNoActiveTurnConfig("emulator/Dockerfile", emulatorDockerfile);
assertNoActiveTurnConfig("emulator/start-emulator.sh", emulatorWrapper);
assert.match(emulatorDockerfile, /COPY start-emulator\.sh \/usr\/local\/bin\/start-emulator\.sh/, "emulator Dockerfile must install the wrapper");
assert.match(emulatorDockerfile, /\bxvfb\b/, "emulator Dockerfile must install Xvfb for virtual display capture");
assert.match(emulatorDockerfile, /ARG EMULATOR_SYSTEM_IMAGE=system-images;android-36;google_apis;x86_64/, "emulator Dockerfile must default to the API 36 Google APIs x86_64 system image");
assert.match(emulatorDockerfile, /ARG EMULATOR_PLATFORM=platforms;android-36/, "emulator Dockerfile must default to the Android 36 platform package");
assert.match(emulatorDockerfile, /EMULATOR_SYSTEM_IMAGE=\$\{EMULATOR_SYSTEM_IMAGE\}/, "emulator Dockerfile must pass the selected system image into runtime");
assert.match(emulatorDockerfile, /EMULATOR_PLATFORM=\$\{EMULATOR_PLATFORM\}/, "emulator Dockerfile must pass the selected platform into runtime");
assert.match(emulatorDockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/start-emulator\.sh"\]/, "emulator Dockerfile must run the wrapper");
assert.match(emulatorWrapper, /\[start-emulator\]/, "emulator wrapper logs must use the non-TURN prefix");
assert.match(emulatorWrapper, /EMULATOR_LAUNCH_MODE="\$\{EMULATOR_LAUNCH_MODE:-direct\}"/, "emulator wrapper must keep direct launch as the default");
assert.match(emulatorWrapper, /start_direct_adb_bridge_forwarder\(\)/, "emulator wrapper must keep the sibling-container ADB bridge");
assert.match(emulatorWrapper, /start_virtual_x_display\(\)/, "emulator wrapper must start Xvfb for direct launch");
assert.match(emulatorWrapper, /Xvfb "\$\{EMULATOR_X_DISPLAY\}"/, "emulator wrapper must launch the configured virtual X display");
assert.match(emulatorWrapper, /append_param_if_missing "-no-skin"/, "emulator wrapper must remove the emulator skin for aligned X display capture");
assert.match(emulatorWrapper, /-fixed-scale/, "emulator wrapper must keep the emulator window at a stable 1:1 scale");
assert.match(emulatorWrapper, /append_param_if_missing "-no-metrics"/, "emulator wrapper must suppress emulator metrics prompts by default");
assert.match(emulatorWrapper, /EMULATOR_AVD_READ_ONLY="\$\{EMULATOR_AVD_READ_ONLY:-1\}"/, "emulator wrapper must default to duplicate-lock-tolerant read-only AVD startup");
assert.match(emulatorWrapper, /EMULATOR_SYSTEM_IMAGE="\$\{EMULATOR_SYSTEM_IMAGE:-system-images;android-36;google_apis;x86_64\}"/, "emulator wrapper must default to the API 36 Google APIs x86_64 system image");
assert.match(emulatorWrapper, /EMULATOR_PLATFORM="\$\{EMULATOR_PLATFORM:-platforms;android-36\}"/, "emulator wrapper must default to the Android 36 platform package");
assert.match(emulatorWrapper, /tr ';' '\/'/, "emulator wrapper must derive image.sysdir.1 from EMULATOR_SYSTEM_IMAGE");
assert.match(emulatorWrapper, /EMULATOR_RAM_SIZE_MB="\$\{EMULATOR_RAM_SIZE_MB:-6144\}"/, "emulator wrapper must default guest RAM above 4GB");
assert.match(emulatorWrapper, /append_param_value_if_flag_missing "-memory" "\$\{EMULATOR_RAM_SIZE_MB\}"/, "emulator wrapper must pass the configured RAM to the emulator process");
assert.match(emulatorWrapper, /hw\.ramSize=\$\{EMULATOR_RAM_SIZE_MB\}/, "emulator wrapper must keep the AVD config RAM above 4GB");
assert.match(emulatorWrapper, /remove_stale_pixel2_avd_locks\(\)/, "emulator wrapper must clear stale Pixel2 AVD lock files before launch");
assert.doesNotMatch(emulatorWrapper, /-grpc|emu-grpc-token|TOKEN_WATCHER|gRPC-Web|bridge-webrtc/, "emulator wrapper must not start gRPC/token support for removed WebRTC");

const testbedSh = readRepoFile("scripts/testbed.sh");
const testbedPs1 = readRepoFile("scripts/testbed.ps1");
assertNoActiveTurnConfig("scripts/testbed.sh", testbedSh);
assertNoActiveTurnConfig("scripts/testbed.ps1", testbedPs1);
assertNoWebrtcRuntime("scripts/testbed.sh", testbedSh);
assertNoWebrtcRuntime("scripts/testbed.ps1", testbedPs1);
assert.match(testbedSh, /test-guacamole-http\.mjs/, "bash testbed must run the HTTP tunnel configuration guard");
assert.match(testbedPs1, /test-guacamole-http\.mjs/, "PowerShell testbed must run the HTTP tunnel configuration guard");
assert.match(testbedSh, /test:e2e:guacamole-http/, "bash testbed must run the Guacamole HTTP E2E when deployed validation is enabled");

assert.equal(existsSync(resolve(repoRoot, "bridge-webrtc")), false, "bridge-webrtc directory must be removed");
assert.equal(existsSync(resolve(repoRoot, "envoy.yaml")), false, "envoy config must be removed after frontend Nginx owns /api proxying");

console.log("[guacamole-http-test] HTTP-only Guacamole-style tunnel defaults verified.");
