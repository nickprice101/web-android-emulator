Repostiory with the files needed to create a self-hosted web-based android emulator. Based on the depreciated (Jan 2026) Google docker image. 

Example Architecture with Cloudflare

Server
Google Android emulator container
Envoy proxy
tiny frontend container
tiny APK bridge API container

Raspberry Pi (or other device)
self-hosted coturn TURN server on public 443/tcp
cloudflared

Cloudflare
emu.yourdomain.com published through Cloudflare Tunnel
turn.yourdomain.com as a normal DNS-only A record

This matches Google’s own WebRTC sample expectations: a webserver, a gRPC web proxy, and either open WebRTC UDP ports or a configured TURN service.

The docker files are included in this repository, for the TURN server install...

TURN server

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

Replace:

REPLACE_WITH_A_LONG_RANDOM_SECRET

YOUR_PUBLIC_IP

Then start it:

```
cd /opt/coturn
docker compose up -d
```
