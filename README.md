# Web-based Android Emulator

Designed for app development without requiring Android Studio locally. The stack runs a Dockerized Android emulator, a small APK/ADB bridge API, Envoy, and a React frontend.

The primary display path is now a Guacamole-style HTTP tunnel: the server stays close to the emulator and streams scrcpy-captured video to the browser as fragmented MP4 over ordinary HTTP(S). Input goes back through normal HTTP API calls. This avoids browser WebRTC relay negotiation and works through corporate-firewall setups that already allow Guacamole-like traffic.

## Default Video Path

The frontend defaults to `Guacamole HTTP (24fps)`.

`apkbridge` runs scrcpy against the emulator, records a low-latency Matroska stream into a FIFO, and ffmpeg remuxes it into fragmented MP4 for browser MediaSource playback. The default stream target is:

* `SCRCPY_MAX_FPS=24`
* `SCRCPY_VIDEO_BIT_RATE=6000000`
* `SCRCPY_MAX_SIZE=1080`
* `SCRCPY_PORT_RANGE=27183:27283`

If scrcpy cannot start before video bytes are produced, `apkbridge` falls back
to remuxing `adb exec-out screenrecord --output-format=h264 -` into the same
fragmented MP4 response. PNG preview remains available for inspection or
recovery.

The old STUN/TURN server implementation has been removed. The stack no longer mints relay credentials, generates emulator `-turncfg`, runs a TURN connectivity harness, or depends on a public relay route.

## Minimal Exposed Ports

The default stack exposes only:

* `18080` -> Envoy entrypoint for the UI, APK bridge API, and emulator gRPC-Web endpoints
* `15555` -> optional host ADB access to the emulator

Everything else stays internal on the Docker network:

* `frontend` on port `80`
* `apkbridge` on port `5000`
* `bridge-webrtc` on port `8090` for optional local WebRTC debugging
* emulator gRPC on port `8554`

Start the stack with:

```bash
docker compose up --build
```

Then browse to:

```text
http://YOUR_HOST:18080
```

## Emulator Image

The default emulator build uses Google's public emulator base image and then installs the pinned Android emulator package plus Android 14 (API 34) platform/system image during build. The Dockerfile creates a `Pixel2` AVD backed by the `pixel_5` profile and starts the emulator through `emulator/start-emulator.sh`.

To pin a different emulator base image or SDK package, build with:

```bash
EMULATOR_IMAGE=us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:7148297 \
EMULATOR_SYSTEM_IMAGE=system-images\;android-34\;google_apis\;x86_64 \
EMULATOR_PLATFORM=platforms\;android-34 \
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
2. Bridge dependency install
3. Python virtualenv bootstrap with `apkbridge/requirements.txt`
4. `python -m unittest discover -s apkbridge/tests -v`
5. `node --test --test-force-exit bridge-webrtc/test/*.test.mjs`
6. `node scripts/test-guacamole-http.mjs`
7. `npm --prefix frontend run build`
8. Optional emulator container startup smoke test when `RUN_EMULATOR_STARTUP_TEST=1`
9. Optional deployed HTTP video validation when `RUN_EMULATOR_STREAM_TEST=1` or `E2E_BASE_URL` is set

## Internet Access Defaults

The Docker compose config pins public DNS resolvers (`1.1.1.1`, `8.8.8.8`) on all services and starts the emulator with an explicit `-dns-server` list. This keeps both Linux containers and the Android guest able to resolve external hosts for realistic app testing.
