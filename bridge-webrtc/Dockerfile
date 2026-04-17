FROM node:20-bookworm AS wrtc-builder

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        clang \
        cmake \
        curl \
        g++ \
        git \
        make \
        ninja-build \
        pkg-config \
        python3 \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

ARG WRTC_FORK_REPO=https://github.com/nickprice101/node-webrtc.git
ARG WRTC_FORK_REF=00ce1c2340477568d9ca76fd54659b666a69d767

COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev \
    && WRTC_FORK_REPO="$WRTC_FORK_REPO" WRTC_FORK_REF="$WRTC_FORK_REF" npm run build:wrtc-fork \
    && npm cache clean --force

COPY server.mjs ffmpeg-config.mjs native-rtc-frame-guard.mjs turn-tls-shim.mjs ./

FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=wrtc-builder /app/package.json /app/package-lock.json ./
COPY --from=wrtc-builder /app/node_modules ./node_modules
COPY --from=wrtc-builder /app/server.mjs /app/ffmpeg-config.mjs /app/native-rtc-frame-guard.mjs /app/turn-tls-shim.mjs ./

EXPOSE 8090

CMD ["node", "server.mjs"]
