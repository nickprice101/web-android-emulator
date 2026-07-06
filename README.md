# Web-based Android Emulator

Designed for app development without requiring Android Studio locally. The stack runs a Dockerized Android emulator, a small APK/ADB bridge API, Envoy, and a React frontend.

The display path is a Guacamole-style HTTP tunnel: the server stays close to the emulator and streams scrcpy-captured video to the browser as fragmented MP4 over ordinary HTTP(S). Input goes back through normal HTTP API calls. No browser WebRTC, emulator gRPC-Web, or relay negotiation is used.

## Default Video Path

The frontend defaults to `Guacamole HTTP (30fps)` at `720p`. A toolbar quality selector can switch the scrcpy stream between `720p` and `1080p`.

`apkbridge` runs scrcpy against the emulator, records a low-latency Matroska stream into a FIFO, and ffmpeg remuxes it into fragmented MP4 for browser MediaSource playback. The default stream target is:

* `SCRCPY_MAX_FPS=30`
* `SCRCPY_VIDEO_BIT_RATE=6000000`
* `SCRCPY_MAX_SIZE=720`
* `SCRCPY_PORT_RANGE=27183:27283`

The emulator container defaults to `EMULATOR_GPU_MODE=swiftshader_indirect` for
stable headless rendering across container hosts. It still maps `/dev/dri`, so
deployments with a known-good render device can opt into host acceleration with
`EMULATOR_GPU_MODE=host`. Startup also passes `-no-metrics` and runs the AVD in
read-only mode by default to avoid metrics prompts and duplicate-AVD lock
failures during container restarts.

If scrcpy cannot start before video bytes are produced, `apkbridge` falls back
to remuxing `adb exec-out screenrecord --output-format=h264 -` into the same
fragmented MP4 response. PNG preview remains available for inspection or
recovery.

The old WebRTC/STUN/TURN implementation has been removed. The stack no longer mints relay credentials, generates emulator `-turncfg`, runs a TURN connectivity harness, exposes emulator gRPC-Web, or depends on a public relay route.

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

The stack uses an `x86_64` guest image because the Linux x64 emulator cannot boot an `arm64-v8a` system image on an x86_64 host. Modern Google APIs x86_64 images advertise ARM64 native binary translation, so ARM64-only app libraries can still be tested without trying to boot an ARM64 guest. `apkbridge` defaults `ADB_INSTALL_ABI=arm64-v8a`, which makes installs use `adb install --abi arm64-v8a` for apps such as StarbuckNoteTaker whose Llama/MLC runtime artifacts are ARM64-only. Set `ADB_INSTALL_ABI=auto` or leave it empty if you want Android to choose the default ABI for a different app.

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
