# Web-based Android Emulator (Pixel approximation)
Designed for app development without the need for Android Studio or similar to be installed. Can be incorporated into AI/vibe-coding workflows.

Based on a self-hosted dockerised solution using the depreciated (Jan 2026) Google emulator docker image with a bespoke frontend pasted on top.

Default emulator base image is now Android 14 / API 34 (`34-google-x64-no-metrics:34.1.19`) because the older Android 11 API 30 image has been observed to trigger framework-level native crashes in modern Google apps (for example `com.google.android.gm` crashing in `android.os.CancellationSignal.createTransport`).

NOTE: The emulator's native WebRTC stream is the default low-latency path. PNG remains available as a slower fallback for comparison and recovery.

The emulator container generates short-lived coturn REST credentials at startup from the shared `TURN_KEY` secret. The browser receives an ephemeral TURN username/password pair, not the long-lived shared secret.

Those credentials are minted when the emulator container starts, so `TURN_TTL` must be longer than your expected emulator uptime between restarts. If the emulator stays up past that TTL, new native WebRTC sessions can still complete signaling but fail to allocate relay media, which shows up as zero inbound RTP followed by an early disconnect.

The stack now defaults `TURN_TTL` to 30 days (`2592000`) so long-lived deployments do not silently age out native TURN credentials after 24 hours.

## Native WebRTC path

This fork uses the emulator's built-in WebRTC implementation through the existing gRPC-Web endpoints exposed via Envoy.

The frontend uses the native emulator WebRTC stream by default, while `apkbridge` continues to handle APK install/build helpers, device info, raw frame inspection, input helper endpoints, and log access.

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
EMULATOR_IMAGE=us-docker.pkg.dev/android-emulator-268719/images/34-google-x64-no-metrics:34.1.19 docker compose build emulator
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

This repository now defaults the bridge service to an internal TURN route:

```bash
TURN_BRIDGE_HOST=192.168.1.152
TURN_BRIDGE_SCHEME=turn
TURN_BRIDGE_PORT=3478
```

If you need to change that default, override with your own LAN address:

```bash
export TURN_BRIDGE_HOST=192.168.1.152
export TURN_BRIDGE_SCHEME=turn
export TURN_BRIDGE_PORT=3478
docker compose up --build
```

`TURN_BRIDGE_*` only changes how the `bridge-webrtc` service reaches TURN. The
browser and emulator still advertise/use `TURN_HOST` (for example
`turn.corsicanescape.com`).

To disable the internal bridge override and use the public TURN hostname for
the bridge too, clear `TURN_BRIDGE_HOST` in your environment before startup.

Then browse to:

```
http://YOUR_HOST:18080
```

Native WebRTC should be the primary experience. PNG mode remains available as a fallback if you need to compare behavior or recover while debugging.

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
version: "3.8"

services:
  coturn:
    image: coturn/coturn:4.6.3
    container_name: coturn
    network_mode: host
    volumes:
      - /opt/coturn/turnserver.conf:/etc/coturn/turnserver.conf:ro
      - /opt/coturn/certs:/certs:ro
    command: ["-c", "/etc/coturn/turnserver.conf"]
    restart: unless-stopped
```

Coturn is the standard self-hosted TURN option, and its Docker guidance commonly uses host networking because TURN needs relay ports.

/opt/coturn/turnserver.conf
```
listening-port=3478
tls-listening-port=443

realm=turn.yourdomain.com
server-name=turn.yourdomain.com

use-auth-secret
static-auth-secret=REPLACE_WITH_A_LONG_RANDOM_SECRET
fingerprint

cert=/certs/fullchain.pem
pkey=/certs/privkey.pem

external-ip=YOUR_PUBLIC_IP

# Firewall-friendly bias
no-udp
no-dtls

min-port=49160
max-port=49200

simple-log
no-cli
```

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

Replace:

REPLACE_WITH_A_LONG_RANDOM_SECRET

YOUR_PUBLIC_IP

Then start it:

```
cd /opt/coturn
docker compose up -d
```
