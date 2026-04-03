import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import wrtc from "@roamhq/wrtc";

const { RTCPeerConnection, RTCSessionDescription, nonstandard = {} } = wrtc;
const { RTCVideoSource } = nonstandard;

const port = Number.parseInt(process.env.PORT || "8090", 10);
const captureMode = process.env.CAPTURE_MODE || "adb-screencap";
const apkbridgeBaseUrl = process.env.APKBRIDGE_BASE_URL || "http://apkbridge:5000";
const apkbridgeFramePath = process.env.APKBRIDGE_FRAME_PATH || "/frame";
const apkbridgeInputPath = process.env.APKBRIDGE_INPUT_PATH || "/input-event";
const apkbridgeDeviceInfoPath = process.env.APKBRIDGE_DEVICE_INFO_PATH || "/device-info";
const captureFps = Math.max(1, Number.parseInt(process.env.CAPTURE_FPS || "6", 10));
const defaultScreenWidth = Math.max(1, Number.parseInt(process.env.CAPTURE_DEFAULT_WIDTH || "1080", 10));
const defaultScreenHeight = Math.max(1, Number.parseInt(process.env.CAPTURE_DEFAULT_HEIGHT || "1920", 10));
const turnSecret = process.env.TURN_SECRET || "";
const turnHost = process.env.TURN_HOST || "";
const turnPort = process.env.TURN_PORT || "443";
const turnProtocol = process.env.TURN_PROTOCOL || "tcp";
const turnScheme = process.env.TURN_SCHEME || "turns";
const turnTtl = Number.parseInt(process.env.TURN_TTL || "86400", 10);
const turnUsernameSuffix = process.env.TURN_USERNAME_SUFFIX || "emuuser";
const answerTimeoutMs = Number.parseInt(process.env.WEBRTC_ANSWER_TIMEOUT_MS || "10000", 10);
const sessionIdleTimeoutMs = Number.parseInt(process.env.WEBRTC_SESSION_IDLE_TIMEOUT_MS || "300000", 10);
const sessionRetentionMs = Number.parseInt(process.env.WEBRTC_SESSION_RETENTION_MS || "30000", 10);

const sessions = new Map();

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(payload));
}

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function buildIceServers() {
  if (!turnSecret || !turnHost) {
    return [];
  }

  const expiry = Math.floor(Date.now() / 1000) + turnTtl;
  const username = `${expiry}:${turnUsernameSuffix}`;
  const credential = createHmac("sha1", turnSecret).update(username).digest("base64");

  return [
    {
      urls: [`${turnScheme}:${turnHost}:${turnPort}?transport=${turnProtocol}`],
      username,
      credential,
    },
  ];
}

function toServiceUrl(path) {
  return new URL(path, apkbridgeBaseUrl).toString();
}

async function fetchServiceJson(path, options = {}) {
  const response = await fetch(toServiceUrl(path), {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Upstream ${path} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }

  if (!response.ok) {
    throw new Error(body.error || body.message || `Upstream ${path} failed (${response.status})`);
  }

  return body;
}

async function fetchFramePng() {
  const response = await fetch(toServiceUrl(apkbridgeFramePath), {
    headers: { Accept: "image/png" },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Frame fetch failed (${response.status}): ${text.slice(0, 200)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function parsePngDimensions(buffer) {
  const signature = "89504e470d0a1a0a";
  if (!buffer || buffer.length < 24 || buffer.subarray(0, 8).toString("hex") !== signature) {
    throw new Error("Frame source did not return a valid PNG image");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function writeToStream(stream, chunk) {
  return new Promise((resolve, reject) => {
    if (!stream || stream.destroyed) {
      reject(new Error("Capture pipeline is unavailable"));
      return;
    }

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onDrain = () => {
      cleanup();
      resolve();
    };

    function cleanup() {
      stream.off("error", onError);
      stream.off("drain", onDrain);
    }

    stream.on("error", onError);
    if (stream.write(chunk)) {
      cleanup();
      resolve();
      return;
    }

    stream.on("drain", onDrain);
  });
}

function sessionPayload(session) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastInputAt: session.lastInputAt,
    state: session.state,
    mode: session.mode,
    message: session.message,
    hasAnswer: Boolean(session.answer),
    peerConnectionState: session.peerConnectionState || "new",
    iceConnectionState: session.iceConnectionState || "new",
    iceGatheringState: session.iceGatheringState || "new",
    media: {
      source: session.media.source,
      width: session.media.width,
      height: session.media.height,
      firstFrameAt: session.media.firstFrameAt,
      lastFrameAt: session.media.lastFrameAt,
      framesDelivered: session.media.framesDelivered,
      framesPerSecond: session.media.framesPerSecond,
      trackAttached: session.media.trackAttached,
    },
    recentLogs: session.logs.slice(-10),
    eventStreamUrl: `/bridge/api/session/${session.id}/events`,
    deleteUrl: `/bridge/api/session/${session.id}`,
    inputUrl: `/bridge/api/session/${session.id}/input`,
  };
}

function broadcastSessionStatus(session) {
  const payload = sessionPayload(session);
  for (const listener of session.listeners) {
    sendSse(listener, "status", payload);
  }
}

function broadcastSessionLog(session, entry) {
  for (const listener of session.listeners) {
    sendSse(listener, "log", entry);
  }
}

function recordSessionLog(session, level, message, details) {
  const entry = {
    at: nowIso(),
    level,
    message,
    details: details || null,
  };
  session.logs.push(entry);
  if (session.logs.length > 100) {
    session.logs.shift();
  }
  broadcastSessionLog(session, entry);
  return entry;
}

function scheduleSessionExpiry(session, timeoutMs = sessionIdleTimeoutMs, reason = "Session expired due to inactivity.") {
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
  }

  session.cleanupTimer = setTimeout(() => {
    destroySession(session, "expired", reason);
  }, timeoutMs);
}

function touchSession(session, timeoutMs = sessionIdleTimeoutMs) {
  session.updatedAt = nowIso();
  scheduleSessionExpiry(session, timeoutMs);
}

function setSessionState(session, state, message, { level = "info", log = true, timeoutMs } = {}) {
  session.state = state;
  if (message) {
    session.message = message;
  }
  touchSession(session, timeoutMs);
  if (log) {
    recordSessionLog(session, level, session.message, { state });
  }
  broadcastSessionStatus(session);
}

function createSession(offer) {
  const id = randomUUID();
  const session = {
    id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastInputAt: null,
    state: "initializing",
    mode: captureMode,
    message:
      captureMode === "stub"
        ? "Negotiating WebRTC session in stub mode."
        : "Negotiating WebRTC session and preparing the emulator video source.",
    offer,
    answer: null,
    peer: null,
    capture: null,
    peerConnectionState: "new",
    iceConnectionState: "new",
    iceGatheringState: "new",
    media: {
      source: captureMode,
      width: null,
      height: null,
      firstFrameAt: null,
      lastFrameAt: null,
      framesDelivered: 0,
      framesPerSecond: captureFps,
      trackAttached: false,
    },
    logs: [],
    listeners: new Set(),
    cleanupTimer: null,
  };
  sessions.set(id, session);
  scheduleSessionExpiry(session);
  recordSessionLog(session, "info", "Session created", { state: session.state });
  return session;
}

function closeSessionResources(session) {
  if (session.capture) {
    session.capture.stop();
    session.capture = null;
  }

  if (session.peer) {
    session.peer.onconnectionstatechange = null;
    session.peer.oniceconnectionstatechange = null;
    session.peer.onicegatheringstatechange = null;
    session.peer.close();
    session.peer = null;
  }

  session.peerConnectionState = "closed";
  session.iceConnectionState = "closed";
  session.iceGatheringState = "complete";
}

function closeSession(session, state = "closed", message = "Session closed.") {
  if (!session) {
    return;
  }
  closeSessionResources(session);
  setSessionState(session, state, message, { timeoutMs: sessionRetentionMs });
}

function destroySession(session, state = "closed", message = "Session closed.") {
  if (!session || !sessions.has(session.id)) {
    return;
  }

  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
    session.cleanupTimer = null;
  }

  closeSessionResources(session);
  session.updatedAt = nowIso();
  session.state = state;
  session.message = message;
  recordSessionLog(session, "info", message, { state });
  broadcastSessionStatus(session);

  for (const listener of session.listeners) {
    sendSse(listener, "closed", { id: session.id, state, message });
    listener.end();
  }

  session.listeners.clear();
  sessions.delete(session.id);
}

function attachPeerObservers(session) {
  const { peer } = session;
  if (!peer) {
    return;
  }

  peer.onicegatheringstatechange = () => {
    session.iceGatheringState = peer.iceGatheringState || "unknown";
    broadcastSessionStatus(session);
  };

  peer.oniceconnectionstatechange = () => {
    session.iceConnectionState = peer.iceConnectionState || "unknown";
    broadcastSessionStatus(session);
  };

  peer.onconnectionstatechange = () => {
    session.peerConnectionState = peer.connectionState || "unknown";

    switch (peer.connectionState) {
      case "connecting":
        setSessionState(
          session,
          "connecting",
          "WebRTC answer applied. Waiting for DTLS and ICE to finish connecting.",
          { log: false }
        );
        break;
      case "connected":
        setSessionState(
          session,
          "connected",
          session.media.firstFrameAt
            ? "Peer connection established and emulator video frames are flowing."
            : "Peer connection established. Waiting for the first emulator frame.",
          { log: false }
        );
        break;
      case "failed":
        closeSession(session, "failed", "Peer connection failed after SDP negotiation.");
        break;
      case "disconnected":
        setSessionState(session, "disconnected", "Peer connection disconnected.", {
          timeoutMs: sessionRetentionMs,
          log: false,
        });
        break;
      case "closed":
        closeSession(session, "closed", "Peer connection closed.");
        break;
      default:
        broadcastSessionStatus(session);
        break;
    }
  };
}

function waitForIceGatheringComplete(peer, timeoutMs = answerTimeoutMs) {
  if (peer.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ICE gathering after ${timeoutMs}ms.`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", onChange);
    }

    function onChange() {
      if (peer.iceGatheringState === "complete") {
        cleanup();
        resolve();
      }
    }

    peer.addEventListener("icegatheringstatechange", onChange);
  });
}

class EmulatorVideoCapture {
  constructor(session) {
    this.session = session;
    this.frameIntervalMs = Math.max(50, Math.round(1000 / captureFps));
    this.rawBuffer = Buffer.alloc(0);
    this.consecutiveFailures = 0;
    this.running = false;
    this.ffmpeg = null;
    this.videoSource = null;
    this.track = null;
    this.width = defaultScreenWidth;
    this.height = defaultScreenHeight;
    this.frameSize = Math.floor((this.width * this.height * 3) / 2);
    this.ffmpegClosedUnexpectedly = false;
  }

  async start() {
    if (!RTCVideoSource) {
      throw new Error("This wrtc build does not expose RTCVideoSource");
    }

    const firstPng = await fetchFramePng();
    const dimensions = parsePngDimensions(firstPng);

    this.width = dimensions.width || defaultScreenWidth;
    this.height = dimensions.height || defaultScreenHeight;
    this.frameSize = Math.floor((this.width * this.height * 3) / 2);
    this.videoSource = new RTCVideoSource();
    this.track = this.videoSource.createTrack();

    this.session.media.width = this.width;
    this.session.media.height = this.height;
    this.session.media.trackAttached = true;
    recordSessionLog(this.session, "info", "Emulator capture initialized", {
      width: this.width,
      height: this.height,
      fps: captureFps,
    });

    await this.startFfmpeg();
    this.running = true;
    await writeToStream(this.ffmpeg.stdin, firstPng);
    this.loopPromise = this.captureLoop().catch((error) => {
      if (!this.running) {
        return;
      }
      closeSession(this.session, "media-failed", error.message);
    });
    return this.track;
  }

  async startFfmpeg() {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-fflags",
      "nobuffer",
      "-f",
      "image2pipe",
      "-codec:v",
      "png",
      "-i",
      "pipe:0",
      "-an",
      "-pix_fmt",
      "yuv420p",
      "-f",
      "rawvideo",
      "pipe:1",
    ];

    this.ffmpeg = spawn("ffmpeg", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.ffmpeg.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.ffmpeg.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        recordSessionLog(this.session, "warn", "ffmpeg stderr", { text });
      }
    });
    this.ffmpeg.on("error", (error) => {
      recordSessionLog(this.session, "error", "ffmpeg process error", { error: error.message });
    });
    this.ffmpeg.on("close", (code, signal) => {
      if (!this.running) {
        return;
      }
      this.ffmpegClosedUnexpectedly = true;
      closeSession(this.session, "media-failed", `Capture pipeline exited unexpectedly (code=${code}, signal=${signal}).`);
    });
  }

  handleStdout(chunk) {
    this.rawBuffer = Buffer.concat([this.rawBuffer, chunk]);

    while (this.rawBuffer.length >= this.frameSize) {
      const frame = this.rawBuffer.subarray(0, this.frameSize);
      this.rawBuffer = this.rawBuffer.subarray(this.frameSize);
      this.videoSource.onFrame({
        width: this.width,
        height: this.height,
        data: new Uint8ClampedArray(frame),
      });

      this.session.media.framesDelivered += 1;
      this.session.media.lastFrameAt = nowIso();
      if (!this.session.media.firstFrameAt) {
        this.session.media.firstFrameAt = this.session.media.lastFrameAt;
        setSessionState(this.session, "media-ready", "First emulator frame captured and attached to the WebRTC track.", {
          log: true,
        });
      } else if (this.session.media.framesDelivered % captureFps === 0) {
        broadcastSessionStatus(this.session);
      }
    }
  }

  async captureLoop() {
    while (this.running) {
      const startedAt = Date.now();
      try {
        const png = await fetchFramePng();
        await writeToStream(this.ffmpeg.stdin, png);
        this.consecutiveFailures = 0;
      } catch (error) {
        this.consecutiveFailures += 1;
        recordSessionLog(this.session, "warn", "Frame capture failed", {
          attempt: this.consecutiveFailures,
          error: error.message,
        });
        if (this.consecutiveFailures >= 3) {
          throw new Error(`Frame capture failed repeatedly: ${error.message}`);
        }
      }

      const waitMs = Math.max(0, this.frameIntervalMs - (Date.now() - startedAt));
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    }
  }

  stop() {
    this.running = false;
    if (this.track) {
      this.track.stop();
      this.track = null;
    }

    if (this.ffmpeg?.stdin && !this.ffmpeg.stdin.destroyed) {
      this.ffmpeg.stdin.end();
    }
    if (this.ffmpeg && !this.ffmpegClosedUnexpectedly) {
      this.ffmpeg.kill("SIGTERM");
    }
    this.ffmpeg = null;
    this.rawBuffer = Buffer.alloc(0);
  }
}

async function attachVideoSource(session, peer) {
  if (captureMode === "stub") {
    recordSessionLog(session, "warn", "Bridge is running in stub mode. No media track will be attached.");
    return;
  }

  const capture = new EmulatorVideoCapture(session);
  const track = await capture.start();
  peer.addTrack(track);
  session.capture = capture;
}

function resolvePixel(value, ratio, maxValue) {
  if (Number.isFinite(value)) {
    return clamp(Math.round(value), 0, Math.max(0, maxValue - 1));
  }
  if (Number.isFinite(ratio)) {
    return clamp(Math.round(ratio * maxValue), 0, Math.max(0, maxValue - 1));
  }
  return null;
}

function translateInputPayload(session, payload) {
  const type = String(payload.type || "").trim().toLowerCase();
  if (!type) {
    throw new Error("Input payload requires a type");
  }

  if (type === "key") {
    return { type: "key", key: payload.key };
  }

  const width = session.media.width || defaultScreenWidth;
  const height = session.media.height || defaultScreenHeight;

  if (type === "tap") {
    const x = resolvePixel(payload.x, payload.xRatio, width);
    const y = resolvePixel(payload.y, payload.yRatio, height);
    if (x === null || y === null) {
      throw new Error("Tap input requires x/y or xRatio/yRatio");
    }
    return { type: "tap", x, y };
  }

  if (type === "swipe") {
    const startX = resolvePixel(payload.startX, payload.startXRatio, width);
    const startY = resolvePixel(payload.startY, payload.startYRatio, height);
    const endX = resolvePixel(payload.endX, payload.endXRatio, width);
    const endY = resolvePixel(payload.endY, payload.endYRatio, height);
    if ([startX, startY, endX, endY].some((value) => value === null)) {
      throw new Error("Swipe input requires start/end coordinates or ratios");
    }
    return {
      type: "swipe",
      startX,
      startY,
      endX,
      endY,
      durationMs: clamp(Number.parseInt(payload.durationMs || "220", 10), 50, 5000),
    };
  }

  if (type === "text") {
    return { type: "text", text: payload.text || "" };
  }

  throw new Error(`Unsupported input type '${type}'`);
}

async function buildAnswer(session) {
  const peer = new RTCPeerConnection({
    iceServers: buildIceServers(),
    iceTransportPolicy: "all",
  });

  session.peer = peer;
  attachPeerObservers(session);

  setSessionState(
    session,
    "applying-offer",
    "Applying the browser SDP offer on the bridge peer connection.",
    { log: true }
  );

  await peer.setRemoteDescription(new RTCSessionDescription(session.offer));

  setSessionState(
    session,
    "starting-media",
    captureMode === "stub"
      ? "Bridge is in stub mode, so media attachment is skipped."
      : "Starting the emulator capture pipeline and attaching a video track.",
    { log: true }
  );

  await attachVideoSource(session, peer);

  setSessionState(session, "creating-answer", "Creating the SDP answer for the browser peer.", { log: true });
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);

  setSessionState(
    session,
    "gathering-ice",
    "Collecting ICE candidates before returning the non-trickle SDP answer.",
    { log: true }
  );
  await waitForIceGatheringComplete(peer);

  session.answer = {
    type: peer.localDescription?.type || answer.type,
    sdp: peer.localDescription?.sdp || answer.sdp,
  };

  setSessionState(
    session,
    captureMode === "stub" ? "answered-no-media" : "answered",
    captureMode === "stub"
      ? "SDP answer created successfully, but media is disabled because the bridge is in stub mode."
      : "SDP answer created successfully. Waiting for the browser peer to connect.",
    { log: true }
  );

  return session.answer;
}

function handleOptions(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  });
  res.end();
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 400, { ok: false, error: "Missing URL" });
    return;
  }

  if (req.method === "OPTIONS") {
    handleOptions(res);
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "bridge-webrtc",
      signaling: "https-rest+sse",
      captureMode,
      captureFps,
      sessions: sessions.size,
      turnConfigured: Boolean(turnSecret && turnHost),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    let upstreamScreen = null;
    try {
      const info = await fetchServiceJson(apkbridgeDeviceInfoPath);
      upstreamScreen = info.screen || null;
    } catch {
      upstreamScreen = null;
    }

    sendJson(res, 200, {
      ok: true,
      signaling: {
        transport: "https-rest+sse",
        trickleIce: false,
        sessionUrl: "/bridge/api/session",
      },
      media: {
        captureMode,
        status: captureMode === "stub" ? "pending" : "configured",
        source: captureMode === "stub" ? "none" : "adb-screencap -> ffmpeg -> RTCVideoSource",
        targetFps: captureFps,
        screen: upstreamScreen,
      },
      controls: {
        inputTransport: "/bridge/api/session/:id/input",
        backend: toServiceUrl(apkbridgeInputPath),
      },
      rtcConfiguration: {
        iceServers: buildIceServers(),
        iceTransportPolicy: "all",
      },
      notes: [
        "The custom bridge now creates a live RTCPeerConnection per browser session and returns a real SDP answer.",
        "ICE remains non-trickle for now, so the bridge waits for gathering to complete before responding.",
        captureMode === "stub"
          ? "Media capture is disabled in stub mode."
          : "Video is captured from the emulator through apkbridge screencaps and piped into WebRTC.",
      ],
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session") {
    let session = null;
    try {
      const body = await readBody(req);
      if (!body?.sdp || !body?.type) {
        sendJson(res, 400, { ok: false, error: "Expected SDP offer payload with type and sdp." });
        return;
      }

      session = createSession({ type: body.type, sdp: body.sdp });
      const answer = await buildAnswer(session);
      sendJson(res, 201, {
        ok: true,
        ...sessionPayload(session),
        answer,
      });
    } catch (error) {
      if (session) {
        closeSession(session, "failed", error.message);
        sendJson(res, 500, { ok: false, error: error.message, ...sessionPayload(session) });
      } else {
        sendJson(res, 400, { ok: false, error: error.message });
      }
    }
    return;
  }

  const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)(?:\/(events|input))?$/);
  if (sessionMatch) {
    const [, sessionId, action] = sessionMatch;
    const session = sessions.get(sessionId);
    if (!session) {
      sendJson(res, 404, { ok: false, error: "Unknown session" });
      return;
    }

    if (req.method === "GET" && !action) {
      sendJson(res, 200, { ok: true, ...sessionPayload(session) });
      return;
    }

    if (req.method === "GET" && action === "events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write("\n");
      session.listeners.add(res);
      sendSse(res, "status", sessionPayload(session));
      const keepAlive = setInterval(() => {
        res.write(": keepalive\n\n");
      }, 15000);
      req.on("close", () => {
        clearInterval(keepAlive);
        session.listeners.delete(res);
      });
      return;
    }

    if (req.method === "POST" && action === "input") {
      try {
        const body = await readBody(req);
        const translated = translateInputPayload(session, body);
        const upstream = await fetchServiceJson(apkbridgeInputPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(translated),
        });

        session.lastInputAt = nowIso();
        touchSession(session);
        recordSessionLog(session, "info", "Input delivered to emulator", translated);
        broadcastSessionStatus(session);

        sendJson(res, 202, {
          ok: true,
          accepted: true,
          sessionId,
          translated,
          upstream,
        });
      } catch (error) {
        recordSessionLog(session, "error", "Failed to deliver input", { error: error.message });
        sendJson(res, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === "DELETE" && !action) {
      destroySession(session, "closed", "Session deleted by client.");
      sendJson(res, 200, { ok: true, id: sessionId, state: "closed" });
      return;
    }
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`bridge-webrtc listening on ${port}`);
});
