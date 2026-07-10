# Web-based Android Emulator

Designed for app development without requiring Android Studio locally. The stack runs a Dockerized Android emulator, a small APK/ADB bridge API, and a React frontend.

The display path is a Guacamole-style HTTP tunnel: the emulator runs in a virtual X display, the bridge records that display with FFmpeg, and the browser receives fragmented MP4 over ordinary HTTP(S). Input goes back through normal HTTP API calls. No browser WebRTC, emulator gRPC-Web, scrcpy tunnel, or relay negotiation is used.

## Default Video Path

The frontend defaults to `Guacamole HTTP (30fps)` at `720p`. A toolbar quality selector can switch the FFmpeg display stream between `720p` and `1080p`.

The emulator container starts Xvfb on `:99`, launches the Android emulator into a framebuffer-sized window, and exposes that X display only on the internal Docker network. `apkbridge` records the phone viewport at `emulator:99.0+100,100` with FFmpeg `x11grab`, encodes low-latency H.264, and muxes fragmented MP4 for browser MediaSource playback. The default stream target is:

* `VIDEO_MAX_FPS=30`
* `VIDEO_BIT_RATE=6000000`
* `VIDEO_MAX_SIZE=720`
* `X11_DISPLAY=emulator:99.0+100,100`
* `X11_VIDEO_SIZE=1080x2340`

The emulator container defaults to `EMULATOR_GPU_MODE=swiftshader_indirect` for
stable headless rendering across container hosts. It still maps `/dev/dri`, so
deployments with a known-good render device can opt into host acceleration with
`EMULATOR_GPU_MODE=host`. Startup also passes `-no-metrics` and runs the AVD in
read-only mode by default to avoid metrics prompts and duplicate-AVD lock
failures during container restarts. `EMULATOR_VIRTUAL_DISPLAY=1` is enabled by
default; set it to `0` only when deliberately returning to the old `-no-window`
emulator launch.

When each video capture starts, `apkbridge` sends a tiny top-left tap nudge to
force the Android compositor to emit initial frames even when the display is
otherwise idle. If FFmpeg cannot capture the virtual display before video bytes are produced,
`apkbridge` falls back to remuxing `adb exec-out screenrecord --output-format=h264 -`
into the same fragmented MP4 response. PNG preview remains available for
inspection or recovery.

The old WebRTC/STUN/TURN implementation has been removed. The stack no longer mints relay credentials, generates emulator `-turncfg`, runs a TURN connectivity harness, exposes emulator gRPC-Web, or depends on a public relay route.

## Phone and TV Testing

The toolbar includes a `Device` selector for switching the connected emulator between `Phone` and `TV` test profiles without rebuilding the stack. `Phone` uses a tall `1080x2340` viewport for normal launcher apps. `TV` changes the emulator to a `1920x1080` landscape viewport and makes app launch prefer `android.intent.category.LEANBACK_LAUNCHER`, falling back to the normal launcher category when needed.

Set `EMULATOR_DEVICE_PROFILE=tv` before `docker compose up` to make TV the default profile for a deployment. The profile can still be changed from the UI while the bridge is running.

## Minimal Exposed Ports

The default stack exposes only:

* `18080` -> frontend Nginx entrypoint for the UI and `/api/*` APK bridge proxy
* `15555` -> optional host ADB access to the emulator

Everything else stays internal on the Docker network:

* `frontend` on port `80`
* `apkbridge` on port `5000`

Start the stack with:

```bash
docker compose up --build
```

Then browse to:

```text
http://YOUR_HOST:18080
```

## Emulator Image

The default emulator build uses Google's public emulator base image and then installs the pinned Android emulator package plus an Android 16 (API 36) Google APIs `x86_64` system image during build. The default platform package is `platforms;android-36`. The Dockerfile creates a `Pixel2` AVD backed by the `pixel_5` profile and starts the emulator through `emulator/start-emulator.sh`.

The stack uses an `x86_64` guest image because the Linux x64 emulator cannot boot an `arm64-v8a` system image on an x86_64 host. AI APKs that include real `x86_64` model/runtime libraries can run on the default API 36 image.

`apkbridge` defaults `ADB_INSTALL_ABI=auto-ai`. In this mode the bridge inspects the APK's native libraries and the connected device ABI list before install:

* If the APK has AI native libraries for `x86_64` and the device supports `x86_64`, the bridge installs the x86 build.
* If the APK has AI native libraries only for `arm64-v8a` and the selected emulator image exposes translated `arm64-v8a`, the bridge installs with `--abi arm64-v8a`.
* If no AI native libraries match, the bridge falls back to Android's normal package-manager ABI choice.
* If the APK contains AI libraries but none match the device ABI list, the install fails early with a diagnostic instead of silently launching without AI support.

The AI library detector matches `libLlama-*.so`, `libmlc*.so`, and `libtvm4j_runtime_packed.so` by default. Override `AI_NATIVE_LIB_PATTERNS` with a comma-separated pattern list for other AI runtimes. Set `ADB_INSTALL_ABI=auto` to restore plain Android ABI selection or set an explicit ABI such as `arm64-v8a` for manual testing.

For ARM64-only AI APKs on the hosted x86 emulator, opt into a translated image explicitly:

```bash
EMULATOR_SYSTEM_IMAGE=system-images\;android-36\;google_apis\;x86_64 \
EMULATOR_PLATFORM=platforms\;android-36 \
ADB_INSTALL_ABI=auto-ai \
docker compose up --build
```

The selected `EMULATOR_SYSTEM_IMAGE` and `EMULATOR_PLATFORM` are passed into the runtime container too. At startup, `emulator/start-emulator.sh` derives the AVD `image.sysdir.1` path from `EMULATOR_SYSTEM_IMAGE`, so custom SDK packages do not need a hard-coded AVD sysdir patch.

The emulator defaults to `EMULATOR_RAM_SIZE_MB=6144`, and compose gives the emulator service `shm_size: "6gb"`, so memory-heavy AI apps have more than 4GB of Android guest RAM available. Set `EMULATOR_RAM_SIZE_MB` to a higher value before `docker compose up` if a test app needs more.

To pin a different emulator base image or SDK package, build with:

```bash
EMULATOR_IMAGE=us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:7148297 \
EMULATOR_SYSTEM_IMAGE=system-images\;android-36\;google_apis\;x86_64 \
EMULATOR_PLATFORM=platforms\;android-36 \
docker compose build emulator
```

## Testbed

The repository testbed bootstraps dependencies and runs backend, bridge, frontend, and configuration checks.

```bash
bash scripts/testbed.sh
```

On Windows PowerShell:

```powershell
.\scripts\testbed.ps1
```

What it runs:

1. Frontend dependency install
2. Python virtualenv bootstrap with `apkbridge/requirements.txt`
3. `python -m unittest discover -s apkbridge/tests -v`
4. `node scripts/test-guacamole-http.mjs`
5. `npm --prefix frontend run build`
6. Optional emulator container startup smoke test when `RUN_EMULATOR_STARTUP_TEST=1`
7. Optional deployed HTTP video validation when `RUN_EMULATOR_STREAM_TEST=1` or `E2E_BASE_URL` is set

## Internet Access Defaults

The Docker compose config pins public DNS resolvers (`1.1.1.1`, `8.8.8.8`) on all services and starts the emulator with an explicit `-dns-server` list. This keeps both Linux containers and the Android guest able to resolve external hosts for realistic app testing.
