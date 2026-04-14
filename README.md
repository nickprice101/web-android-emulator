# Web-based Android Emulator (Pixel approximation)
Designed for app development without the need for Android Studio or similar to be installed. Can be incorporated into AI/vibe-coding workflows.

Based on a self-hosted dockerised solution using the depreciated (Jan 2026) Google emulator docker image with a bespoke frontend pasted on top.

Default emulator build pulls the runtime base image from Google's Artifact Registry (`us-docker.pkg.dev/android-emulator-268719/images/...`) and then installs the Android 14 (API 34) SDK platform + system image via `sdkmanager` from Google's Android SDK repository (`https://dl.google.com/android/repository/`). This preserves the API 30 launch stack (`/android/sdk/launch-emulator.sh` + gRPC-Web endpoint behavior) while running an Android 14 guest image.

NOTE: The stack defaults to native WebRTC relay mode over emulator gRPC-Web endpoints.

The emulator container generates short-lived coturn REST credentials at startup from the shared `TURN_KEY` secret. The browser receives an ephemeral TURN username/password pair, not the long-lived shared secret.

Those credentials are minted when the emulator container starts, so `TURN_TTL` must be longer than your expected emulator uptime between restarts. If the emulator stays up past that TTL, new native WebRTC sessions can still complete signaling but fail to allocate relay media, which shows up as zero inbound RTP followed by an early disconnect.

The stack now defaults `TURN_TTL` to 30 days (`2592000`) so long-lived deployments do not silently age out native TURN credentials after 24 hours.

## Native WebRTC path

This fork uses the emulator's built-in WebRTC implementation through gRPC-Web endpoints exposed via Envoy.

The frontend uses native emulator WebRTC relay mode by default, while `apkbridge` continues to handle APK install/build helpers, device info, raw frame inspection, input helper endpoints, and log access.

### Minimal exposed ports

The default stack is now consolidated back to the minimum externally useful ports:

* `18080` -> Envoy entrypoint for the UI, emulator gRPC-Web endpoints, and APK bridge API
* `15555` -> ADB access to the emulator when you need direct debugging from the host

Everything else stays internal on the Docker network:

* `frontend` on port `80`
* `apkbridge` on port `5000`
* emulator gRPC on port `8554`

Start the stack with:

```
docker compose up --build
```

If you must pin a different emulator container image, build with:

```bash
EMULATOR_IMAGE=us-docker.pkg.dev/android-emulator-268719/images/30-google-x64-no-metrics:7148297 \
EMULATOR_SYSTEM_IMAGE=system-images\;android-34\;google_apis\;x86_64 \
EMULATOR_PLATFORM=platforms\;android-34 \
docker compose build emulator
```

To temporarily debug whether your network is blocking TURN-over-TLS on `443/tcp`,
override the TURN scheme/port before starting the stack:

```bash
export TURN_SCHEME=turn
export TURN_PORT=3478
docker compose up --build
```

This switches both the emulator and the bridge to non-TLS TURN for diagnostics.
Revert to `TURN_SCHEME=turns` and `TURN_PORT=443` after testing.

This repository now defaults the bridge service to the same public TURN route
as the browser and emulator, which is the safest default for Intel/Linux
deployments such as Unraid.

If you need an internal bridge-only TURN route to bypass hairpin NAT or debug a
client-specific `turns:` issue, set `TURN_BRIDGE_*` explicitly:

```bash
export TURN_BRIDGE_HOST=192.168.1.152
export TURN_BRIDGE_SCHEME=turn
export TURN_BRIDGE_PORT=3478
docker compose up --build
```

`TURN_BRIDGE_*` only changes how the `bridge-webrtc` service reaches TURN. The
browser and emulator still advertise/use `TURN_HOST` (for example
`turn.corsicanescape.com`).

Then browse to:

```
http://YOUR_HOST:18080
```

Native WebRTC should be the primary experience. PNG mode remains available as a fallback if you need to compare behavior or recover while debugging.

The `bridge-webrtc` Docker image now pins `@roamhq/wrtc` to the fork commit
that contains the native `turns:` investigation work and builds a Linux binary
from that fork during the image build. This keeps Intel/Linux deployments on
the same addon source tree we are using for native TURN debugging instead of
falling back to the upstream prebuilt `linux-x64` package.

If you need to test a newer addon commit, override the build args before
starting the stack:

```bash
export WRTC_FORK_REPO=https://github.com/nickprice101/node-webrtc.git
export WRTC_FORK_REF=00ce1c2340477568d9ca76fd54659b666a69d767
docker compose build bridge-webrtc
```

The `bridge-webrtc` image takes longer to build now because it compiles the
forked addon inside the Linux container before copying the resulting
`build-linux-x64/wrtc.node` into the final runtime image.

## Test framework testbed

To run the emulator applications under a repeatable test framework, use the repository testbed script. It bootstraps dependencies and executes backend + bridge + frontend checks in one pass.

```bash
bash scripts/testbed.sh
```

On Windows PowerShell, run:

```powershell
.\scripts\testbed.ps1
```

What the testbed runs:

1. `npm --prefix frontend ci`
2. `npm --prefix bridge-webrtc ci`
3. Python virtualenv bootstrap at `.venv-testbed` with `apkbridge/requirements.txt`
4. `python -m unittest discover -s apkbridge/tests -v`
5. `node --test bridge-webrtc/test/*.test.mjs`
6. `npm --prefix frontend run build`
7. Optional TURN harness (`node bridge-webrtc/test/turn-connectivity-harness.mjs`) when `TURN_HOST` and `TURN_KEY` are set.

To explicitly verify TURN reachability and REST-auth credential acceptance
using the same username/password shape that the emulator wrapper emits:

```bash
TURN_HOST=turn.example.com \
TURN_KEY='your-static-auth-secret' \
TURN_PORT=443 \
TURN_SCHEME=turns \
TURN_PROTOCOL=tcp \
node bridge-webrtc/test/turn-connectivity-harness.mjs
```

This is suitable for local smoke testing and CI pre-merge validation.

## Internet access defaults

The Docker compose config pins public DNS resolvers (`1.1.1.1`, `8.8.8.8`) on all services and starts the emulator with an explicit `-dns-server` list. This keeps both the Linux containers and the Android guest able to resolve and reach external hosts for realistic app testing.

## Example Architecture with Cloudflare

### Server
* Google Android emulator container
* Envoy proxy
* tiny frontend container
* tiny APK bridge API container

### Raspberry Pi (or other device)
* self-hosted coturn TURN server on public 443/tcp
* cloudflared

### Cloudflare
* emu.yourdomain.com published through Cloudflare Tunnel
* turn.yourdomain.com as a normal DNS-only A record

This repository is configured for TURN-over-TLS on `443/tcp` with coturn REST auth (`use-auth-secret`) and TCP relay ports on `49160-49200/tcp`.

This matches Google’s own WebRTC sample expectations: a webserver, a gRPC web proxy, and either open WebRTC UDP ports or a configured TURN service.

There is a workspace action script (deploy.yml) to support deployment. It needs the appropriate SECRETS (ADB, custom TURN secret, and server SSH credentials) to be set up (see the script to better understand).

## TURN server

TURN server files are not included in the repostiory, instead the instructoons are included below.

Create a folder on the Pi:

```
/opt/coturn/
  docker-compose.yml
  turnserver.conf
  certs/
    fullchain.pem
    privkey.pem
```

Put a valid certificate for turn.yourdomain.com in certs/.

/opt/coturn/docker-compose.yml
```
services:
  coturn:
    image: ghcr.io/coturn/coturn:4.9.0-r0-debian
    platform: linux/arm/v7
    container_name: coturn-turn
    restart: unless-stopped
    network_mode: host
    init: true
    privileged: true

    volumes:
      - /etc/turn-certs/fullchain.pem:/etc/turn-certs/fullchain.pem:ro
      - /etc/turn-certs/privkey.pem:/etc/turn-certs/privkey.pem:ro

    entrypoint:
      - turnserver

    command:
      - -n
      - --listening-port=3478
      - --tls-listening-port=443
      - --listening-ip=0.0.0.0
      - --relay-ip=<LOCAL_IP>
      - --external-ip=<WAN_IP>/<LOCAL_IP>
      - --allow-loopback-peers
      - --realm=turn.yourdomain.com
      - --server-name=turn.yourdomain.com
      - --use-auth-secret
      - --static-auth-secret=<YOUR_TURN_SECRET>
      - --fingerprint
      - --cert=/etc/turn-certs/fullchain.pem
      - --pkey=/etc/turn-certs/privkey.pem
      - --cli-password=password
      - --no-udp
      - --no-dtls
      - --min-port=49160
      - --max-port=49200
      - --verbose
      - --log-file=stdout
```

Coturn is the standard self-hosted TURN option, and its Docker guidance commonly uses host networking because TURN needs relay ports.

If your emulator stack runs on a Docker bridge network and the WebRTC bridge falls back to host candidates like `172.22.x.x`, coturn may reject browser permissions to those peers with `403 Forbidden IP`. In that case, either:

* fix relay allocation so the bridge returns relay candidates instead of private host candidates, or
* explicitly allow the private subnet that contains the bridge peer in `turnserver.conf`, for example:

```
allowed-peer-ip=172.16.0.0-172.31.255.255
allowed-peer-ip=192.168.0.0-192.168.255.255
allowed-peer-ip=10.0.0.0-10.255.255.255
```

Only allow the ranges you actually use. A narrower Docker subnet such as `172.22.0.0-172.22.255.255` is safer than opening all RFC1918 space.

The stack's `TURN_KEY` deployment secret must exactly match coturn's `static-auth-secret` value.

Router port forwarding is only one half of the path. If the Pi runs its own firewall (`ufw`, `iptables`, `nftables`, etc.), allow these inbound ports there too:

* `443/tcp`
* `49160-49200/tcp`

Then start it:

```
cd /opt/coturn
docker compose up -d
```
