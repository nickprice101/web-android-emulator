import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { URL } from "node:url";
import wrtc from "@roamhq/wrtc";
import { buildFfmpegArgs } from "./ffmpeg-config.mjs";
import { isRenderableNativeRtcFrame } from "./native-rtc-frame-guard.mjs";

const { RTCPeerConnection, RTCSessionDescription, MediaStream, nonstandard = {} } = wrtc;
const { RTCVideoSource, RTCVideoSink } = nonstandard;

const port = Number.parseInt(process.env.PORT || "8090", 10);
const captureMode = process.env.CAPTURE_MODE || "adb-screencap";
const emulatorGrpcWebUrl = process.env.EMULATOR_GRPC_WEB_URL || "http://envoy:8080";
const apkbridgeBaseUrl = process.env.APKBRIDGE_BASE_URL || "http://apkbridge:5000";
const apkbridgeFramePath = process.env.APKBRIDGE_FRAME_PATH || "/frame";
const apkbridgeScreenrecordPath = process.env.APKBRIDGE_SCREENRECORD_PATH || "/screenrecord";
const apkbridgeInputPath = process.env.APKBRIDGE_INPUT_PATH || "/input-event";
const apkbridgeDeviceInfoPath = process.env.APKBRIDGE_DEVICE_INFO_PATH || "/device-info";
const captureFps = Math.max(1, Number.parseInt(process.env.CAPTURE_FPS || "24", 10));
const captureBitrate = Math.max(1_000_000, Number.parseInt(process.env.CAPTURE_BIT_RATE || "12000000", 10));
const defaultScreenWidth = Math.max(1, Number.parseInt(process.env.CAPTURE_DEFAULT_WIDTH || "1080", 10));
const defaultScreenHeight = Math.max(1, Number.parseInt(process.env.CAPTURE_DEFAULT_HEIGHT || "1920", 10));
const screenrecordFirstFrameTimeoutMs = Math.max(
  1000,
  Number.parseInt(process.env.CAPTURE_SCREENRECORD_FIRST_FRAME_TIMEOUT_MS || "15000", 10)
);
const screenrecordDecodeGraceTimeoutMs = Math.max(
  1000,
  Number.parseInt(process.env.CAPTURE_SCREENRECORD_DECODE_GRACE_TIMEOUT_MS || "15000", 10)
);
const answerTimeoutMs = Number.parseInt(process.env.WEBRTC_ANSWER_TIMEOUT_MS || "10000", 10);
const sessionIdleTimeoutMs = Number.parseInt(process.env.WEBRTC_SESSION_IDLE_TIMEOUT_MS || "300000", 10);
const sessionRetentionMs = Number.parseInt(process.env.WEBRTC_SESSION_RETENTION_MS || "30000", 10);

const sessions = new Map();

// ---------------------------------------------------------------------------
// Emulator gRPC JWT token — read from a shared volume that the emulator
// entrypoint script populates once the emulator has started.
// ---------------------------------------------------------------------------
const emulatorTokenPath = process.env.EMULATOR_TOKEN_PATH || "";
let emulatorToken = null;

function loadEmulatorToken() {
  if (!emulatorTokenPath) {
    return;
  }
  try {
    const raw = fs.readFileSync(emulatorTokenPath, "utf8").trim();
    if (raw) {
      emulatorToken = raw;
    }
  } catch {
    // Token file not yet available; will be retried by the interval below.
  }
}

loadEmulatorToken();
setInterval(loadEmulatorToken, 5000);

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
  return [];
}

function parseCandidateDiagnostics(sdp) {
  const summary = {
    total: 0,
    relay: 0,
    srflx: 0,
    host: 0,
    prflx: 0,
    loopbackHost: 0,
    privateHost: 0,
    publicHost: 0,
    addresses: [],
  };

  if (!sdp) {
    return summary;
  }

  const lines = String(sdp)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("a=candidate:"));

  for (const line of lines) {
    const parts = line.slice("a=candidate:".length).split(/\s+/);
    const address = parts[4] || "";
    const typeIndex = parts.indexOf("typ");
    const candidateType = typeIndex >= 0 ? parts[typeIndex + 1] : "";

    summary.total += 1;
    if (address && !summary.addresses.includes(address)) {
      summary.addresses.push(address);
    }

    switch (candidateType) {
      case "relay":
        summary.relay += 1;
        break;
      case "srflx":
        summary.srflx += 1;
        break;
      case "prflx":
        summary.prflx += 1;
        break;
      case "host":
        summary.host += 1;
        if (address === "::1" || address === "localhost" || /^127\./.test(address)) {
          summary.loopbackHost += 1;
        } else if (
          /^10\./.test(address) ||
          /^192\.168\./.test(address) ||
          /^169\.254\./.test(address) ||
          /^172\.(1[6-9]|2\d|3[0-1])\./.test(address) ||
          /^(fc|fd|fe80)/i.test(address)
        ) {
          summary.privateHost += 1;
        } else {
          summary.publicHost += 1;
        }
        break;
      default:
        break;
    }
  }

  return summary;
}

function normalizeCandidateLine(candidateLine) {
  if (!candidateLine) {
    return null;
  }

  return candidateLine.startsWith("a=") ? candidateLine : `a=${candidateLine}`;
}

function buildAnswerSdpWithGatheredCandidates(sdp, gatheredCandidates) {
  if (!sdp || !Array.isArray(gatheredCandidates) || gatheredCandidates.length === 0) {
    return sdp;
  }

  const lines = String(sdp).replace(/\r\n/g, "\n").split("\n").filter(Boolean);
  const mediaSections = [];
  let current = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();

    if (line.startsWith("m=")) {
      current = {
        index: mediaSections.length,
        start: index,
        end: lines.length,
        mid: null,
        candidateSet: new Set(),
        hasEndOfCandidates: false,
      };
      mediaSections.push(current);
      if (mediaSections.length > 1) {
        mediaSections[mediaSections.length - 2].end = index;
      }
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("a=mid:")) {
      current.mid = line.slice("a=mid:".length);
      continue;
    }

    if (line.startsWith("a=candidate:")) {
      current.candidateSet.add(line);
      continue;
    }

    if (line === "a=end-of-candidates") {
      current.hasEndOfCandidates = true;
    }
  }

  if (mediaSections.length === 0) {
    return sdp;
  }

  const pendingBySection = mediaSections.map(() => ({
    candidates: [],
    sawEndOfCandidates: false,
  }));

  for (const gathered of gatheredCandidates) {
    if (!gathered) {
      continue;
    }

    const section =
      (gathered.sdpMid != null ? mediaSections.find((entry) => entry.mid === gathered.sdpMid) : null) ||
      (Number.isInteger(gathered.sdpMLineIndex) ? mediaSections[gathered.sdpMLineIndex] : null) ||
      mediaSections[0];

    if (!section) {
      continue;
    }

    const pending = pendingBySection[section.index];
    const candidateLine = normalizeCandidateLine(gathered.candidate);
    if (candidateLine && !section.candidateSet.has(candidateLine) && !pending.candidates.includes(candidateLine)) {
      pending.candidates.push(candidateLine);
    }

    if (gathered.completed) {
      pending.sawEndOfCandidates = true;
    }
  }

  const output = [];
  let cursor = 0;

  for (const section of mediaSections) {
    const pending = pendingBySection[section.index];
    const sectionLines = lines.slice(section.start, section.end);
    const candidateIndexes = sectionLines
      .map((line, index) => ({ line: line.trim(), index }))
      .filter((entry) => entry.line.startsWith("a=candidate:"))
      .map((entry) => entry.index);
    const insertionIndex =
      candidateIndexes.length > 0 ? candidateIndexes[candidateIndexes.length - 1] + 1 : sectionLines.length;

    output.push(...lines.slice(cursor, section.start));
    cursor = section.end;

    if (pending.candidates.length === 0 && (!pending.sawEndOfCandidates || section.hasEndOfCandidates)) {
      output.push(...sectionLines);
      continue;
    }

    output.push(...sectionLines.slice(0, insertionIndex));
    output.push(...pending.candidates);
    output.push(...sectionLines.slice(insertionIndex));
    if (pending.sawEndOfCandidates && !section.hasEndOfCandidates) {
      output.push("a=end-of-candidates");
    }
  }

  output.push(...lines.slice(cursor));
  return `${output.join("\r\n").replace(/\r\n+$/, "")}\r\n`;
}

function toServiceUrl(path) {
  return new URL(path, apkbridgeBaseUrl).toString();
}

async function fetchServiceJson(path, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  const response = await fetch(toServiceUrl(path), {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
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

function captureSourceDescription() {
  if (captureMode === "native-rtc") {
    return "emulator gRPC-Web RTC -> RTCVideoSink -> RTCVideoSource";
  }
  if (captureMode === "adb-screenrecord") {
    return "adb screenrecord -> ffmpeg -> RTCVideoSource";
  }
  if (captureMode === "stub") {
    return "none";
  }
  return "adb-screencap -> ffmpeg -> RTCVideoSource";
}

function captureSourceDescriptionForMode(mode) {
  if (mode === "native-rtc") {
    return "emulator gRPC-Web RTC -> RTCVideoSink -> RTCVideoSource";
  }
  if (mode === "adb-screenrecord") {
    return "adb screenrecord -> ffmpeg -> RTCVideoSource";
  }
  if (mode === "stub") {
    return "none";
  }
  return "adb-screencap -> ffmpeg -> RTCVideoSource";
}

function parseSdpDiagnostics(sdp) {
  if (!sdp) {
    return null;
  }

  const lines = String(sdp)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const mediaSections = [];
  let current = null;

  for (const line of lines) {
    if (line.startsWith("m=")) {
      const [kind = "unknown", port = "0", protocol = "", ...formats] = line.slice(2).split(/\s+/);
      current = {
        kind,
        port: Number.parseInt(port, 10) || 0,
        protocol,
        formats,
        direction: "sendrecv",
        mid: null,
        msid: null,
        trackId: null,
        setup: null,
        iceCandidates: 0,
        rtcpMux: false,
        codecs: [],
      };
      mediaSections.push(current);
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("a=sendrecv") || line.startsWith("a=sendonly") || line.startsWith("a=recvonly") || line.startsWith("a=inactive")) {
      current.direction = line.slice(2);
      continue;
    }

    if (line.startsWith("a=mid:")) {
      current.mid = line.slice("a=mid:".length);
      continue;
    }

    if (line.startsWith("a=msid:")) {
      const [, streamId = "", trackId = ""] = line.slice("a=msid:".length).split(/\s+/, 2);
      current.msid = streamId || null;
      current.trackId = trackId || null;
      continue;
    }

    if (line.startsWith("a=setup:")) {
      current.setup = line.slice("a=setup:".length);
      continue;
    }

    if (line === "a=rtcp-mux") {
      current.rtcpMux = true;
      continue;
    }

    if (line.startsWith("a=candidate:")) {
      current.iceCandidates += 1;
      continue;
    }

    if (line.startsWith("a=rtpmap:")) {
      current.codecs.push(line.slice("a=rtpmap:".length));
    }
  }

  return {
    type: lines.find((line) => line.startsWith("a=group:BUNDLE")) ? "bundle" : "single",
    hasVideoSection: mediaSections.some((section) => section.kind === "video"),
    hasSendonlyOrSendrecvVideo: mediaSections.some(
      (section) => section.kind === "video" && ["sendonly", "sendrecv"].includes(section.direction)
    ),
    totalIceCandidates: mediaSections.reduce((sum, section) => sum + section.iceCandidates, 0),
    candidateTypes: parseCandidateDiagnostics(sdp),
    mediaSections,
  };
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
      requestedSource: session.media.requestedSource,
      source: session.media.source,
      width: session.media.width,
      height: session.media.height,
      firstFrameAt: session.media.firstFrameAt,
      lastFrameAt: session.media.lastFrameAt,
      framesDelivered: session.media.framesDelivered,
      framesPerSecond: session.media.framesPerSecond,
      trackAttached: session.media.trackAttached,
      activeReason: session.media.activeReason || null,
      fallbackReason: session.media.fallbackReason || null,
      usingFallback: Boolean(session.media.usingFallback),
      screenrecord: session.media.screenrecord || null,
      ffmpeg: session.media.ffmpeg || null,
    },
    answerDiagnostics: session.answerDiagnostics || null,
    answerAttempts: session.answerAttempts || [],
    iceCandidateErrors: session.iceCandidateErrors.slice(-5),
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
  const detailStr = details ? ` ${JSON.stringify(details)}` : "";
  const prefix = `[session:${session.id.slice(0, 8)}]`;
  if (level === "error") {
    console.error(`${prefix} ${message}${detailStr}`);
  } else if (level === "warn") {
    console.warn(`${prefix} ${message}${detailStr}`);
  } else {
    console.log(`${prefix} ${message}${detailStr}`);
  }
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
      requestedSource: captureMode,
      source: captureMode,
      width: null,
      height: null,
      firstFrameAt: null,
      lastFrameAt: null,
      framesDelivered: 0,
      framesPerSecond: captureFps,
      trackAttached: false,
      activeReason: "initial-start",
      fallbackReason: null,
      usingFallback: false,
      screenrecord: {
        connectedAt: null,
        firstChunkAt: null,
        lastChunkAt: null,
        firstDecodedFrameAt: null,
        bytesReceived: 0,
        chunksReceived: 0,
        firstChunkSize: 0,
        lastChunkSize: 0,
        largestChunkSize: 0,
        decodeGraceUsed: false,
        verification: captureMode === "adb-screenrecord" ? "pending" : "not-requested",
      },
      ffmpeg: {
        startedAt: null,
        pid: null,
        firstStdoutAt: null,
        lastStdoutAt: null,
        stdoutBytes: 0,
        stdoutChunks: 0,
        rawBufferLength: 0,
        frameSize: 0,
        stderrLines: [],
        lastStderrAt: null,
      },
    },
    logs: [],
    listeners: new Set(),
    cleanupTimer: null,
    localIceCandidates: [],
    iceCandidateErrors: [],
    answerAttempts: [],
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

  peer.onicecandidate = (event) => {
    if (event.candidate?.candidate) {
      session.localIceCandidates.push({
        at: nowIso(),
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid ?? null,
        sdpMLineIndex: Number.isInteger(event.candidate.sdpMLineIndex) ? event.candidate.sdpMLineIndex : null,
        completed: false,
      });
      return;
    }

    session.localIceCandidates.push({
      at: nowIso(),
      candidate: null,
      sdpMid: null,
      sdpMLineIndex: null,
      completed: true,
    });
  };

  peer.onicecandidateerror = (event) => {
    const entry = {
      at: nowIso(),
      address: event.address || null,
      port: event.port || null,
      url: event.url || null,
      errorCode: event.errorCode || null,
      errorText: event.errorText || null,
    };
    session.iceCandidateErrors.push(entry);
    if (session.iceCandidateErrors.length > 20) {
      session.iceCandidateErrors.shift();
    }
    recordSessionLog(session, "warn", "Bridge ICE candidate error", {
      ...entry,
    });
  };

  peer.onicegatheringstatechange = () => {
    session.iceGatheringState = peer.iceGatheringState || "unknown";
    recordSessionLog(session, "info", "Bridge ICE gathering state changed", {
      state: session.iceGatheringState,
      localCandidates: session.localIceCandidates.length,
    });
    broadcastSessionStatus(session);
  };

  peer.oniceconnectionstatechange = () => {
    session.iceConnectionState = peer.iceConnectionState || "unknown";
    recordSessionLog(session, "info", "Bridge ICE connection state changed", {
      state: session.iceConnectionState,
    });
    broadcastSessionStatus(session);
  };

  peer.onconnectionstatechange = () => {
    session.peerConnectionState = peer.connectionState || "unknown";
    recordSessionLog(session, "info", "Bridge peer connection state changed", {
      state: session.peerConnectionState,
    });

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
    return Promise.resolve({ timedOut: false });
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      // Proceed with whatever candidates have been gathered so far rather than
      // aborting the session. This mirrors the browser-side behaviour and lets
      // same-network debug sessions proceed with whatever local candidates exist.
      cleanup();
      resolve({ timedOut: true });
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", onChange);
    }

    function onChange() {
      if (peer.iceGatheringState === "complete") {
        cleanup();
        resolve({ timedOut: false });
      }
    }

    peer.addEventListener("icegatheringstatechange", onChange);
  });
}

class EmulatorVideoCapture {
  constructor(session) {
    this.session = session;
    this.frameIntervalMs = Math.max(50, Math.round(1000 / captureFps));
    this.mode = captureMode;
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
    this.streamAbortController = null;
    this.firstFrameTimer = null;
    this.screenrecordRetryTimer = null;
    this.pipelineRestartInProgress = false;
    this.fallbackActivated = false;
    this.pipelineFirstFrameDelivered = false;
    this.screenrecordDecodeGraceUsed = false;
  }

  async start() {
    if (!RTCVideoSource) {
      throw new Error("This wrtc build does not expose RTCVideoSource");
    }

    this.videoSource = new RTCVideoSource();
    this.track = this.videoSource.createTrack();
    this.running = true;
    await this.startPipeline({ mode: this.mode, reason: "initial-start" });
    return this.track;
  }

  async prepareMode(mode, reason) {
    let firstPng = null;
    let dimensions = null;
    if (mode === "adb-screenrecord") {
      const info = await fetchServiceJson(apkbridgeDeviceInfoPath);
      dimensions = info.screen || null;
    } else {
      // Try the lightweight device-info endpoint (runs `adb shell wm size`) before
      // falling back to a full PNG screencap.  This avoids the cost of a full
      // screencap (~500 ms–2 s) when all we need are the screen dimensions.
      try {
        const info = await fetchServiceJson(apkbridgeDeviceInfoPath);
        dimensions = info.screen || null;
      } catch {
        // Ignored — fall through to PNG-based dimension detection below.
      }
      if (!dimensions) {
        firstPng = await fetchFramePng();
        dimensions = parsePngDimensions(firstPng);
      }
    }

    this.mode = mode;
    this.width = dimensions.width || defaultScreenWidth;
    this.height = dimensions.height || defaultScreenHeight;
    this.frameSize = Math.floor((this.width * this.height * 3) / 2);
    this.session.media.requestedSource = this.session.mode;
    this.session.media.source = mode;
    this.session.media.width = this.width;
    this.session.media.height = this.height;
    this.session.media.trackAttached = true;
    this.session.media.activeReason = reason || null;
    this.session.media.usingFallback = mode !== this.session.mode;
    this.session.media.fallbackReason = this.session.media.usingFallback ? reason || null : null;
    this.session.media.ffmpeg = {
      startedAt: null,
      pid: null,
      firstStdoutAt: null,
      lastStdoutAt: null,
      stdoutBytes: 0,
      stdoutChunks: 0,
      rawBufferLength: 0,
      frameSize: this.frameSize,
      stderrLines: [],
      lastStderrAt: null,
    };
    if (mode === "adb-screenrecord") {
      this.session.media.screenrecord = {
        connectedAt: null,
        firstChunkAt: null,
        lastChunkAt: null,
        firstDecodedFrameAt: null,
        bytesReceived: 0,
        chunksReceived: 0,
        firstChunkSize: 0,
        lastChunkSize: 0,
        largestChunkSize: 0,
        decodeGraceUsed: false,
        verification: "pending",
      };
      this.screenrecordDecodeGraceUsed = false;
    } else {
      this.session.media.screenrecord = {
        ...(this.session.media.screenrecord || {}),
        firstChunkSize: Number(this.session.media.screenrecord?.firstChunkSize || 0),
        lastChunkSize: Number(this.session.media.screenrecord?.lastChunkSize || 0),
        largestChunkSize: Number(this.session.media.screenrecord?.largestChunkSize || 0),
        decodeGraceUsed: this.screenrecordDecodeGraceUsed,
        verification:
          this.session.mode === "adb-screenrecord" ? "fallback-active" : "not-requested",
      };
    }

    recordSessionLog(this.session, "info", "Emulator capture initialized", {
      width: this.width,
      height: this.height,
      fps: captureFps,
      bitrate: captureBitrate,
      requestedMode: this.session.mode,
      mode,
      reason: reason || null,
      usingFallback: this.session.media.usingFallback,
      source: captureSourceDescriptionForMode(mode),
    });

    return { firstPng };
  }

  async startPipeline({ mode, reason }) {
    const { firstPng } = await this.prepareMode(mode, reason);
    this.pipelineFirstFrameDelivered = false;
    await this.startFfmpeg();
    if (firstPng) {
      await writeToStream(this.ffmpeg.stdin, firstPng);
    }

    this.loopPromise = (mode === "adb-screenrecord" ? this.captureStreamLoop() : this.captureLoop()).catch((error) => {
      if (!this.running) {
        return;
      }
      closeSession(this.session, "media-failed", error.message);
    });
    recordSessionLog(this.session, "info", "Capture pipeline started", {
      mode,
      reason,
      requestedMode: this.session.mode,
      usingFallback: false,
    });
    if (mode === "adb-screenrecord") {
      this.armFirstFrameWatchdog();
    }
  }

  stopCurrentPipeline() {
    clearTimeout(this.firstFrameTimer);
    this.firstFrameTimer = null;
    this.streamAbortController?.abort();
    this.streamAbortController = null;

    if (this.ffmpeg?.stdin && !this.ffmpeg.stdin.destroyed) {
      this.ffmpeg.stdin.end();
    }
    if (this.ffmpeg) {
      this.ffmpeg.kill("SIGTERM");
    }
    this.ffmpeg = null;
    this.rawBuffer = Buffer.alloc(0);
    this.consecutiveFailures = 0;
    this.pipelineFirstFrameDelivered = false;
  }

  async switchPipeline(mode, reason) {
    this.pipelineRestartInProgress = true;
    try {
      this.stopCurrentPipeline();
      await this.startPipeline({ mode, reason });
      broadcastSessionStatus(this.session);
    } finally {
      this.pipelineRestartInProgress = false;
    }
  }

  async startFfmpeg() {
    const args = buildFfmpegArgs({
      mode: this.mode,
      fps: captureFps,
      width: this.width,
      height: this.height,
    });

    this.ffmpeg = spawn("ffmpeg", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.session.media.ffmpeg = {
      ...(this.session.media.ffmpeg || {}),
      startedAt: nowIso(),
      pid: this.ffmpeg.pid || null,
      frameSize: this.frameSize,
    };

    this.ffmpeg.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.ffmpeg.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        const lines = text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        this.session.media.ffmpeg = {
          ...(this.session.media.ffmpeg || {}),
          lastStderrAt: nowIso(),
          stderrLines: [...(this.session.media.ffmpeg?.stderrLines || []), ...lines].slice(-8),
        };
        recordSessionLog(this.session, "warn", "ffmpeg stderr", { text });
      }
    });
    this.ffmpeg.on("error", (error) => {
      recordSessionLog(this.session, "error", "ffmpeg process error", { error: error.message });
    });
    this.ffmpeg.on("close", (code, signal) => {
      if (!this.running || this.pipelineRestartInProgress) {
        return;
      }
      this.ffmpegClosedUnexpectedly = true;
      closeSession(this.session, "media-failed", `Capture pipeline exited unexpectedly (code=${code}, signal=${signal}).`);
    });
  }

  armFirstFrameWatchdog() {
    clearTimeout(this.firstFrameTimer);
    this.firstFrameTimer = setTimeout(() => {
      if (!this.running || this.pipelineFirstFrameDelivered || this.mode !== "adb-screenrecord" || this.fallbackActivated) {
        return;
      }

      const screenrecordStats = this.session.media.screenrecord || null;
      const ffmpegStats = this.session.media.ffmpeg || null;
      const receivedBytes = Number(screenrecordStats?.bytesReceived || 0);
      const receivedChunks = Number(screenrecordStats?.chunksReceived || 0);

      if (receivedBytes > 0 && !this.screenrecordDecodeGraceUsed) {
        this.screenrecordDecodeGraceUsed = true;
        this.session.media.screenrecord = {
          ...(screenrecordStats || {}),
          decodeGraceUsed: true,
          verification: "waiting-for-decoded-frame",
        };
        recordSessionLog(
          this.session,
          "warn",
          "Screenrecord stream produced H.264 data but no decoded frame yet; extending the verification window",
          {
            timeoutMs: screenrecordFirstFrameTimeoutMs,
            decodeGraceTimeoutMs: screenrecordDecodeGraceTimeoutMs,
            bytesReceived: receivedBytes,
            chunksReceived: receivedChunks,
          }
        );
        clearTimeout(this.firstFrameTimer);
        this.firstFrameTimer = setTimeout(() => {
          this.armFirstFrameWatchdog();
        }, screenrecordDecodeGraceTimeoutMs);
        broadcastSessionStatus(this.session);
        return;
      }

      recordSessionLog(this.session, "error", "Screenrecord capture did not deliver a first frame in time; keeping WebRTC on the native stream only", {
        timeoutMs: this.screenrecordDecodeGraceUsed
          ? screenrecordFirstFrameTimeoutMs + screenrecordDecodeGraceTimeoutMs
          : screenrecordFirstFrameTimeoutMs,
        bytesReceived: receivedBytes,
        chunksReceived: receivedChunks,
        connectedAt: screenrecordStats?.connectedAt || null,
        firstChunkAt: screenrecordStats?.firstChunkAt || null,
        lastChunkAt: screenrecordStats?.lastChunkAt || null,
        firstChunkSize: Number(screenrecordStats?.firstChunkSize || 0),
        lastChunkSize: Number(screenrecordStats?.lastChunkSize || 0),
        largestChunkSize: Number(screenrecordStats?.largestChunkSize || 0),
        ffmpegStartedAt: ffmpegStats?.startedAt || null,
        ffmpegPid: ffmpegStats?.pid || null,
        ffmpegFirstStdoutAt: ffmpegStats?.firstStdoutAt || null,
        ffmpegLastStdoutAt: ffmpegStats?.lastStdoutAt || null,
        ffmpegStdoutBytes: Number(ffmpegStats?.stdoutBytes || 0),
        ffmpegStdoutChunks: Number(ffmpegStats?.stdoutChunks || 0),
        ffmpegRawBufferLength: Number(ffmpegStats?.rawBufferLength || 0),
        ffmpegFrameSize: Number(ffmpegStats?.frameSize || 0),
        ffmpegRecentStderr: Array.isArray(ffmpegStats?.stderrLines) ? ffmpegStats.stderrLines : [],
        peerConnectionState: this.session.peerConnectionState || null,
        iceConnectionState: this.session.iceConnectionState || null,
        iceGatheringState: this.session.iceGatheringState || null,
      });
      closeSession(
        this.session,
        "media-failed",
        "Screenrecord capture never produced a decoded frame. WebRTC stays on the native stream only; switch to PNG mode explicitly if you want screencap polling."
      );
    }, screenrecordFirstFrameTimeoutMs);
  }

  handleStdout(chunk) {
    this.rawBuffer = Buffer.concat([this.rawBuffer, chunk]);
    const stdoutAt = nowIso();
    const previousStdoutChunks = Number(this.session.media.ffmpeg?.stdoutChunks || 0);
    this.session.media.ffmpeg = {
      ...(this.session.media.ffmpeg || {}),
      firstStdoutAt: this.session.media.ffmpeg?.firstStdoutAt || stdoutAt,
      lastStdoutAt: stdoutAt,
      stdoutBytes: Number(this.session.media.ffmpeg?.stdoutBytes || 0) + chunk.length,
      stdoutChunks: previousStdoutChunks + 1,
      rawBufferLength: this.rawBuffer.length,
      frameSize: this.frameSize,
    };
    if (previousStdoutChunks === 0) {
      recordSessionLog(this.session, "info", "ffmpeg emitted the first raw video bytes", {
        chunkBytes: chunk.length,
        frameSize: this.frameSize,
      });
    }

    while (this.rawBuffer.length >= this.frameSize) {
      const frame = this.rawBuffer.subarray(0, this.frameSize);
      this.rawBuffer = this.rawBuffer.subarray(this.frameSize);
      this.session.media.ffmpeg = {
        ...(this.session.media.ffmpeg || {}),
        rawBufferLength: this.rawBuffer.length,
      };
      this.videoSource.onFrame({
        width: this.width,
        height: this.height,
        data: new Uint8ClampedArray(frame),
      });

      this.session.media.framesDelivered += 1;
      this.session.media.lastFrameAt = nowIso();
      if (!this.pipelineFirstFrameDelivered) {
        this.pipelineFirstFrameDelivered = true;
        clearTimeout(this.firstFrameTimer);
        this.firstFrameTimer = null;
        if (this.mode === "adb-screenrecord") {
          this.session.media.screenrecord = {
            ...(this.session.media.screenrecord || {}),
            firstDecodedFrameAt: this.session.media.lastFrameAt,
            decodeGraceUsed: this.screenrecordDecodeGraceUsed,
            verification: "verified",
          };
        }
        if (!this.session.media.firstFrameAt) {
          this.session.media.firstFrameAt = this.session.media.lastFrameAt;
        }
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

  async captureStreamLoop() {
    while (this.running) {
      try {
        this.streamAbortController = new AbortController();
        const response = await fetch(
          `${toServiceUrl(apkbridgeScreenrecordPath)}?bit_rate=${encodeURIComponent(String(captureBitrate))}`,
          {
            headers: { Accept: "video/h264" },
            signal: this.streamAbortController.signal,
          }
        );
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`Screenrecord stream failed (${response.status}): ${text.slice(0, 200)}`);
        }
        if (!response.body) {
          throw new Error("Screenrecord stream returned no body");
        }

        const reader = response.body.getReader();
        // Do NOT reset consecutiveFailures here — only reset it once the stream
        // actually delivers at least one data chunk.  Resetting unconditionally
        // on a successful HTTP connection would mask repeated "connect, empty
        // body, disconnect" cycles where apkbridge accepts the request but
        // immediately ends the stream because adb screenrecord is failing.
        this.session.media.screenrecord = {
          ...(this.session.media.screenrecord || {}),
          connectedAt: nowIso(),
          verification: "pending",
        };
        recordSessionLog(this.session, "info", "Connected to apkbridge screenrecord stream", {
          bitrate: captureBitrate,
          fps: captureFps,
        });

        let receivedData = false;
        while (this.running) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (value?.length) {
            if (!receivedData) {
              // First data chunk received — the stream is genuinely alive.
              receivedData = true;
              this.consecutiveFailures = 0;
            }
            const receivedAt = nowIso();
            const previousChunksReceived = Number(this.session.media.screenrecord?.chunksReceived || 0);
            const previousBytesReceived = Number(this.session.media.screenrecord?.bytesReceived || 0);
            this.session.media.screenrecord = {
              ...(this.session.media.screenrecord || {}),
              firstChunkAt: this.session.media.screenrecord?.firstChunkAt || receivedAt,
              lastChunkAt: receivedAt,
              bytesReceived: previousBytesReceived + value.length,
              chunksReceived: previousChunksReceived + 1,
              firstChunkSize: Number(this.session.media.screenrecord?.firstChunkSize || 0) || value.length,
              lastChunkSize: value.length,
              largestChunkSize: Math.max(Number(this.session.media.screenrecord?.largestChunkSize || 0), value.length),
              decodeGraceUsed: this.screenrecordDecodeGraceUsed,
              verification:
                this.pipelineFirstFrameDelivered || this.session.media.screenrecord?.firstDecodedFrameAt
                  ? "verified"
                  : "receiving-h264",
            };
            if (previousChunksReceived === 0) {
              recordSessionLog(this.session, "info", "Received first H.264 chunk from apkbridge screenrecord", {
                chunkBytes: value.length,
              });
            } else if ((previousChunksReceived + 1) % 120 === 0 && !this.pipelineFirstFrameDelivered) {
              recordSessionLog(this.session, "info", "Screenrecord stream is still delivering H.264 while waiting for the first decoded frame", {
                chunksReceived: previousChunksReceived + 1,
                bytesReceived: previousBytesReceived + value.length,
                lastChunkSize: value.length,
                ffmpegStdoutBytes: Number(this.session.media.ffmpeg?.stdoutBytes || 0),
                ffmpegStdoutChunks: Number(this.session.media.ffmpeg?.stdoutChunks || 0),
              });
            }
            await writeToStream(this.ffmpeg.stdin, Buffer.from(value));
          }
        }

        reader.releaseLock();
        if (!this.running) {
          return;
        }

        if (!receivedData) {
          // The stream connected but ended without sending any H.264 data.
          // This happens when adb screenrecord on the apkbridge side exits
          // immediately (e.g. because ADB dropped).  Treat this the same as a
          // fetch-level failure so the consecutive-failure limit is enforced
          // and the reconnect loop cannot spin indefinitely without backoff.
          this.consecutiveFailures += 1;
          recordSessionLog(this.session, "warn", "Screenrecord stream connected but delivered no data", {
            attempt: this.consecutiveFailures,
          });
          if (this.consecutiveFailures >= 3) {
            throw new Error("Screenrecord stream connected but delivered no data repeatedly; apkbridge screenrecord may be failing");
          }
          await sleep(500);
          continue;
        }

        recordSessionLog(this.session, "warn", "Screenrecord stream ended; reconnecting");
        // Discard any partial raw-video frame that was accumulating for the
        // previous segment.  Each new screenrecord segment restarts the H.264
        // bitstream from scratch (new SPS/PPS + IDR), so the old buffer bytes
        // do not belong to the new segment's first frame.
        this.rawBuffer = Buffer.alloc(0);
      } catch (error) {
        if (!this.running || error.name === "AbortError") {
          return;
        }
        this.consecutiveFailures += 1;
        recordSessionLog(this.session, "warn", "Screenrecord stream failed", {
          attempt: this.consecutiveFailures,
          error: error.message,
        });
        if (this.consecutiveFailures >= 3) {
          throw new Error(`Screenrecord stream failed repeatedly: ${error.message}`);
        }
        await sleep(500);
      } finally {
        this.streamAbortController = null;
      }
    }
  }

  stop() {
    this.running = false;
    clearTimeout(this.firstFrameTimer);
    this.firstFrameTimer = null;
    clearTimeout(this.screenrecordRetryTimer);
    this.screenrecordRetryTimer = null;
    this.streamAbortController?.abort();
    this.streamAbortController = null;
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

// ---------------------------------------------------------------------------
// Minimal gRPC-Web framing helpers (used by native-rtc capture mode)
// ---------------------------------------------------------------------------

function grpcWebEncodeFrame(messageBytes) {
  const frame = Buffer.alloc(5 + messageBytes.length);
  frame[0] = 0; // not compressed
  frame.writeUInt32BE(messageBytes.length, 1);
  messageBytes.copy(frame, 5);
  return frame;
}

function grpcWebParseNextFrame(buffer) {
  if (buffer.length < 5) {
    return null;
  }
  const flags = buffer[0];
  const length = buffer.readUInt32BE(1);
  if (buffer.length < 5 + length) {
    return null;
  }
  return {
    consumed: 5 + length,
    isTrailer: Boolean(flags & 0x80),
    data: buffer.slice(5, 5 + length),
  };
}

function grpcWebUnary(baseUrl, path, reqBytes) {
  return new Promise((resolve, reject) => {
    const frameBody = grpcWebEncodeFrame(reqBytes);
    const parsedBase = new URL(baseUrl);
    const headers = {
      "Content-Type": "application/grpc-web+proto",
      "Content-Length": String(frameBody.length),
      "X-Grpc-Web": "1",
    };
    if (emulatorToken) {
      headers["Authorization"] = `Bearer ${emulatorToken}`;
    }
    const req = http.request(
      {
        hostname: parsedBase.hostname,
        port: Number(parsedBase.port) || 80,
        path,
        method: "POST",
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const frame = grpcWebParseNextFrame(buf);
          if (!frame || frame.isTrailer) {
            reject(new Error(`gRPC-Web unary: no data frame (HTTP ${res.statusCode})`));
            return;
          }
          resolve(frame.data);
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.write(frameBody);
    req.end();
  });
}

function grpcWebServerStream(baseUrl, path, reqBytes, onFrame, signal) {
  const frameBody = grpcWebEncodeFrame(reqBytes);
  const parsedBase = new URL(baseUrl);
  const headers = {
    "Content-Type": "application/grpc-web+proto",
    "Content-Length": String(frameBody.length),
    "X-Grpc-Web": "1",
  };
  if (emulatorToken) {
    headers["Authorization"] = `Bearer ${emulatorToken}`;
  }
  const req = http.request(
    {
      hostname: parsedBase.hostname,
      port: Number(parsedBase.port) || 80,
      path,
      method: "POST",
      headers,
    },
    (res) => {
      // incomplete bytes that don't yet form a complete frame
      let partial = Buffer.alloc(0);

      const processFrames = () => {
        for (;;) {
          const frame = grpcWebParseNextFrame(partial);
          if (!frame) {
            break;
          }
          partial = partial.slice(frame.consumed);
          if (!frame.isTrailer) {
            onFrame(frame.data);
          }
        }
      };

      res.on("data", (chunk) => {
        // Accumulate with leftover partial bytes and scan for complete frames.
        partial = partial.length > 0 ? Buffer.concat([partial, chunk]) : chunk;
        processFrames();
      });
      res.on("end", () => onFrame(null));
      res.on("error", (err) => onFrame(null, err));
    }
  );
  if (signal) {
    signal.addEventListener("abort", () => req.destroy());
  }
  req.on("error", () => onFrame(null));
  req.write(frameBody);
  req.end();
  return req;
}

// ---------------------------------------------------------------------------
// Minimal protobuf encode/decode (RtcId and JsepMsg message types only)
// ---------------------------------------------------------------------------

function pbVarint(value) {
  const bytes = [];
  let n = value >>> 0;
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n & 0x7f);
  return Buffer.from(bytes);
}

function pbLenDelim(fieldNumber, data) {
  const tag = pbVarint(((fieldNumber << 3) | 2) >>> 0);
  return Buffer.concat([tag, pbVarint(data.length), data]);
}

function pbEncodeRtcId(guid) {
  return pbLenDelim(1, Buffer.from(guid, "utf8"));
}

function pbEncodeJsepMsg(guid, message) {
  return Buffer.concat([
    pbLenDelim(1, pbEncodeRtcId(guid)),
    pbLenDelim(2, Buffer.from(message, "utf8")),
  ]);
}

function pbDecodeVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) {
      break;
    }
    shift += 7;
  }
  return { value: result >>> 0, offset: pos };
}

function pbDecodeFields(buf) {
  const fields = [];
  let offset = 0;
  while (offset < buf.length) {
    const tagResult = pbDecodeVarint(buf, offset);
    offset = tagResult.offset;
    const fieldNumber = tagResult.value >>> 3;
    const wireType = tagResult.value & 0x7;
    if (wireType === 0) {
      const varResult = pbDecodeVarint(buf, offset);
      offset = varResult.offset;
      fields.push({ field: fieldNumber, value: varResult.value });
    } else if (wireType === 2) {
      const lenResult = pbDecodeVarint(buf, offset);
      offset = lenResult.offset;
      fields.push({ field: fieldNumber, data: buf.slice(offset, offset + lenResult.value) });
      offset += lenResult.value;
    } else {
      break;
    }
  }
  return fields;
}

function pbDecodeRtcId(bytes) {
  const fields = pbDecodeFields(bytes);
  const guidField = fields.find((f) => f.field === 1 && f.data);
  return { guid: guidField ? guidField.data.toString("utf8") : "" };
}

function pbDecodeJsepMsg(bytes) {
  const fields = pbDecodeFields(bytes);
  const idField = fields.find((f) => f.field === 1 && f.data);
  const msgField = fields.find((f) => f.field === 2 && f.data);
  return {
    id: idField ? pbDecodeRtcId(idField.data) : { guid: "" },
    message: msgField ? msgField.data.toString("utf8") : "",
  };
}

// ---------------------------------------------------------------------------
// NativeRtcVideoRelay — relays the emulator's native WebRTC video track to
// the browser by subscribing to JSEP signals via gRPC-Web, establishing an
// RTCPeerConnection with the emulator, capturing frames with RTCVideoSink,
// and pushing them into an RTCVideoSource that is added to the browser peer.
// ---------------------------------------------------------------------------

class NativeRtcVideoRelay {
  constructor(session) {
    this.session = session;
    this.videoSource = null;
    this.track = null;
    this.emulatorPeer = null;
    this.videoSink = null;
    this.abortController = new AbortController();
    this.guid = null;
    this.running = false;
    this.firstFrameTimer = null;
    this._resetFirstFrameState();
  }

  _resetFirstFrameState() {
    clearTimeout(this.firstFrameTimer);
    this.firstFrameTimer = null;
    this.firstFrameGraceUsed = false;
    this.firstRenderableFrameAt = null;
    this.placeholderFrameCount = 0;
  }

  async start() {
    if (!RTCVideoSource) {
      throw new Error("This wrtc build does not expose RTCVideoSource");
    }
    if (!RTCVideoSink) {
      throw new Error("This wrtc build does not expose RTCVideoSink");
    }

    this.videoSource = new RTCVideoSource({ isScreencast: true });
    this.track = this.videoSource.createTrack();
    this.running = true;

    const media = this.session.media;
    media.requestedSource = "native-rtc";
    media.source = "native-rtc";
    media.trackAttached = true;
    media.activeReason = "initial-start";
    media.width = defaultScreenWidth;
    media.height = defaultScreenHeight;
    media.ffmpeg = null;
    media.screenrecord = {
      verification: "not-requested",
      connectedAt: null,
      firstChunkAt: null,
      lastChunkAt: null,
      firstDecodedFrameAt: null,
      bytesReceived: 0,
      chunksReceived: 0,
      firstChunkSize: 0,
      lastChunkSize: 0,
      largestChunkSize: 0,
      decodeGraceUsed: false,
    };

    recordSessionLog(this.session, "info", "native-rtc: starting emulator gRPC-Web RTC relay", {
      url: emulatorGrpcWebUrl,
    });

    this._relayLoop().catch((error) => {
      if (this.running) {
        recordSessionLog(this.session, "error", "native-rtc: relay loop error", { error: error.message });
        closeSession(this.session, "media-failed", `native-rtc relay failed: ${error.message}`);
      }
    });

    return this.track;
  }

  async _relayLoop() {
    console.log(`[session:${this.session.id.slice(0, 8)}] native-rtc: calling requestRtcStream on ${emulatorGrpcWebUrl}`);
    const rtcIdBytes = await grpcWebUnary(
      emulatorGrpcWebUrl,
      "/android.emulation.control.Rtc/requestRtcStream",
      Buffer.alloc(0)
    );
    const rtcId = pbDecodeRtcId(rtcIdBytes);
    this.guid = rtcId.guid;
    recordSessionLog(this.session, "info", "native-rtc: obtained emulator JSEP stream ID", {
      guid: this.guid,
    });

    console.log(`[session:${this.session.id.slice(0, 8)}] native-rtc: opening receiveJsepMessages stream, guid=${this.guid}`);
    await new Promise((resolve, reject) => {
      grpcWebServerStream(
        emulatorGrpcWebUrl,
        "/android.emulation.control.Rtc/receiveJsepMessages",
        pbEncodeRtcId(this.guid),
        (msgBytes, err) => {
          if (!this.running) {
            resolve();
            return;
          }
          if (err || !msgBytes) {
            reject(err || new Error("JSEP stream closed unexpectedly"));
            return;
          }
          let signal;
          try {
            const decoded = pbDecodeJsepMsg(msgBytes);
            signal = JSON.parse(decoded.message || "{}");
          } catch {
            return;
          }
          const signalType = signal.start ? "start" : signal.sdp ? "sdp" : signal.candidate ? "candidate" : signal.bye ? "bye" : "unknown";
          console.log(`[session:${this.session.id.slice(0, 8)}] native-rtc: received JSEP signal type=${signalType}`);
          this._handleJsepSignal(signal).catch((handleErr) => {
            recordSessionLog(this.session, "warn", "native-rtc: JSEP signal error", {
              error: handleErr.message,
            });
          });
        },
        this.abortController.signal
      );
    });
  }

  _sendJsep(message) {
    if (!this.guid) {
      return;
    }
    grpcWebUnary(
      emulatorGrpcWebUrl,
      "/android.emulation.control.Rtc/sendJsepMessage",
      pbEncodeJsepMsg(this.guid, JSON.stringify(message))
    ).catch((err) => {
      recordSessionLog(this.session, "warn", "native-rtc: failed to send JSEP message", {
        error: err.message,
      });
    });
  }

  async _handleJsepSignal(signal) {
    if (signal.start) {
      // Cancel any pending first-frame watchdog from a previous JSEP session
      // so it cannot fire and close the session while a fresh negotiation is
      // in progress.
      this._resetFirstFrameState();
      if (this.emulatorPeer) {
        this.emulatorPeer.close();
      }
      // Bridge and emulator run in the same Docker network, so the internal
      // debug relay uses direct local ICE only.
      this.emulatorPeer = new RTCPeerConnection({
        iceServers: [],
        iceTransportPolicy: "all",
      });
      this.emulatorPeer.onicecandidate = (event) => {
        if (event.candidate) {
          this._sendJsep({ candidate: event.candidate.toJSON() });
        }
      };
      this.emulatorPeer.ontrack = (event) => {
        if (event.track?.kind !== "video" || !this.running) {
          return;
        }
        this._attachVideoSink(event.track);
      };
    } else if (signal.sdp && signal.sdp.type === "offer") {
      if (!this.emulatorPeer) {
        return;
      }
      await this.emulatorPeer.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      const answer = await this.emulatorPeer.createAnswer();
      await this.emulatorPeer.setLocalDescription(answer);
      this._sendJsep({ sdp: { type: answer.type, sdp: answer.sdp } });
    } else if (signal.candidate) {
      this.emulatorPeer?.addIceCandidate(signal.candidate).catch(() => {});
    } else if (signal.bye) {
      this.stop();
    }
  }

  _armFirstFrameWatchdog() {
    this._resetFirstFrameState();

    const failSession = (withGraceExtension) => {
      if (!this.running || this.firstRenderableFrameAt) {
        return;
      }
      recordSessionLog(
        this.session,
        "error",
        "native-rtc: no renderable frame received within the watchdog window; closing session",
        {
          timeoutMs: withGraceExtension
            ? screenrecordFirstFrameTimeoutMs + screenrecordDecodeGraceTimeoutMs
            : screenrecordFirstFrameTimeoutMs,
          placeholdersSeen: this.placeholderFrameCount,
          peerConnectionState: this.session.peerConnectionState || null,
          iceConnectionState: this.session.iceConnectionState || null,
        }
      );
      closeSession(
        this.session,
        "media-failed",
        "native-rtc: emulator video track connected but no renderable frame arrived in time. The emulator display may not have initialized."
      );
    };

    this.firstFrameTimer = setTimeout(() => {
      if (!this.running || this.firstRenderableFrameAt) {
        return;
      }

      const placeholdersSeen = this.placeholderFrameCount;
      if (placeholdersSeen > 0 && !this.firstFrameGraceUsed) {
        // The emulator is alive (sending placeholder frames) but Android has
        // not rendered its first real frame yet.  Extend the watchdog once by
        // the grace period to accommodate slow Android boot sequences.
        this.firstFrameGraceUsed = true;
        // Reuse the session's screenrecord tracking field — the same field is
        // used by adb-screenrecord sessions and consumed by the diagnostics UI
        // to report frame-verification state.  In native-rtc sessions this is
        // pre-initialized to "not-requested" in NativeRtcVideoRelay.start().
        this.session.media.screenrecord = {
          ...(this.session.media.screenrecord || {}),
          decodeGraceUsed: true,
          verification: "waiting-for-decoded-frame",
        };
        recordSessionLog(
          this.session,
          "warn",
          "native-rtc: emulator video track is alive (placeholder frames received) but no renderable frame yet; extending watchdog",
          {
            placeholdersSeen,
            graceTimeoutMs: screenrecordDecodeGraceTimeoutMs,
          }
        );
        this.firstFrameTimer = setTimeout(() => failSession(true), screenrecordDecodeGraceTimeoutMs);
        broadcastSessionStatus(this.session);
        return;
      }

      failSession(false);
    }, screenrecordFirstFrameTimeoutMs);
  }

  _attachVideoSink(videoTrack) {
    if (this.videoSink) {
      this.videoSink.stop();
    }
    const sink = new RTCVideoSink(videoTrack);
    this.videoSink = sink;
    let frameCount = 0;
    this.placeholderFrameCount = 0;
    this._armFirstFrameWatchdog();
    sink.onframe = ({ frame }) => {
      if (!this.running || sink.stopped) {
        return;
      }
      const { width, height, data } = frame;
      const media = this.session.media;
      if (!isRenderableNativeRtcFrame(frame)) {
        this.placeholderFrameCount += 1;
        if (this.placeholderFrameCount === 1) {
          recordSessionLog(this.session, "warn", "native-rtc: ignoring placeholder startup frame", {
            width,
            height,
          });
        }
        return;
      }
      if (!this.firstRenderableFrameAt) {
        this.firstRenderableFrameAt = nowIso();
        clearTimeout(this.firstFrameTimer);
        this.firstFrameTimer = null;
      }
      frameCount++;
      media.framesDelivered = frameCount;
      media.lastFrameAt = nowIso();
      if (frameCount === 1) {
        media.width = width;
        media.height = height;
        media.firstFrameAt = media.lastFrameAt;
        recordSessionLog(this.session, "info", "native-rtc: first frame relayed to browser", {
          width,
          height,
        });
        setSessionState(
          this.session,
          "media-ready",
          "First emulator frame relayed from the native WebRTC stream.",
          { log: false }
        );
      }
      this.videoSource.onFrame({ width, height, data });
    };
    recordSessionLog(this.session, "info", "native-rtc: RTCVideoSink attached to emulator video track");
  }

  stop() {
    this.running = false;
    this._resetFirstFrameState();
    this.abortController.abort();
    if (this.videoSink) {
      this.videoSink.stop();
      this.videoSink = null;
    }
    if (this.emulatorPeer) {
      this.emulatorPeer.close();
      this.emulatorPeer = null;
    }
  }
}

async function attachVideoSource(session, peer) {
  if (captureMode === "stub") {
    recordSessionLog(session, "warn", "Bridge is running in stub mode. No media track will be attached.");
    return;
  }

  let capture;
  let track;
  if (captureMode === "native-rtc") {
    capture = new NativeRtcVideoRelay(session);
    track = await capture.start();
  } else {
    capture = new EmulatorVideoCapture(session);
    track = await capture.start();
  }

  const stream = new MediaStream();
  stream.addTrack(track);

  const transceiver = peer
    .getTransceivers()
    .find((entry) => entry.receiver?.track?.kind === "video" || entry.sender?.track?.kind === "video");

  if (transceiver?.sender) {
    await transceiver.sender.replaceTrack(track);
    if (transceiver.direction !== "sendrecv") {
      transceiver.direction = "sendonly";
    }
    recordSessionLog(session, "info", "Attached emulator video track to offered video transceiver", {
      streamId: stream.id,
      trackId: track.id,
      direction: transceiver.direction,
      mid: transceiver.mid || null,
    });
  } else {
    peer.addTrack(track, stream);
    recordSessionLog(session, "warn", "No offered video transceiver was available; attached track using addTrack fallback", {
      streamId: stream.id,
      trackId: track.id,
    });
  }

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
  session.localIceCandidates = [];
  session.iceCandidateErrors = [];

  const iceTransportPolicy = "all";
  const peer = new RTCPeerConnection({
    iceServers: buildIceServers(),
    iceTransportPolicy,
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

  // Pre-set the video transceiver direction to sendonly so the answer SDP
  // correctly reflects that the bridge will send video, even though the
  // capture track is attached in parallel below.
  if (captureMode !== "stub") {
    const videoTransceiver = peer
      .getTransceivers()
      .find((t) => t.receiver?.track?.kind === "video" || t.sender?.track?.kind === "video");
    if (videoTransceiver && videoTransceiver.direction !== "sendrecv") {
      videoTransceiver.direction = "sendonly";
    }
  }

  setSessionState(session, "creating-answer", "Creating the SDP answer for the browser peer.", { log: true });
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);

  setSessionState(
    session,
    "gathering-ice",
    "Collecting local ICE candidates and starting the capture pipeline concurrently.",
    { log: true }
  );

  const [gatherResult] = await Promise.all([waitForIceGatheringComplete(peer), attachVideoSource(session, peer)]);
  if (gatherResult?.timedOut) {
    recordSessionLog(session, "warn", "ICE gathering timed out; proceeding with partial candidates", {
      iceTransportPolicy,
      iceGatheringState: peer.iceGatheringState,
      candidatesGathered: session.localIceCandidates.length,
      timeoutMs: answerTimeoutMs,
    });
  }

  const localAnswer = {
    type: peer.localDescription?.type || answer.type,
    sdp: buildAnswerSdpWithGatheredCandidates(peer.localDescription?.sdp || answer.sdp, session.localIceCandidates),
  };
  const diagnostics = parseSdpDiagnostics(localAnswer.sdp);
  if (diagnostics) {
    recordSessionLog(session, "info", "Created SDP answer diagnostics", {
      iceTransportPolicy,
      ...diagnostics,
    });
  }

  if ((diagnostics?.candidateTypes?.total ?? 0) === 0) {
    throw new Error("Bridge ICE gathering produced no local candidates for the optional WebRTC debug path.");
  }

  session.answer = localAnswer;
  session.answerDiagnostics = diagnostics;
  session.answerAttempts.push({
    iceTransportPolicy,
    diagnostics,
    candidateErrors: session.iceCandidateErrors.slice(),
  });

  setSessionState(
    session,
    captureMode === "stub" ? "answered-no-media" : "answered",
    captureMode === "stub"
      ? "SDP answer created successfully, but media is disabled because the bridge is in stub mode."
      : "SDP answer created with local ICE only. Waiting for the browser peer to connect.",
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
  const startMs = Date.now();
  const method = req.method || "?";
  const rawPath = req.url || "(none)";
  console.log(`[http] ${method} ${rawPath}`);

  res.on("finish", () => {
    console.log(`[http] ${method} ${rawPath} -> ${res.statusCode} (${Date.now() - startMs}ms)`);
  });

  try {
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
        iceServers: 0,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/emulator-token") {
      // Re-read the token file on every request so callers always get the
      // latest value without waiting for the 5-second refresh interval.
      loadEmulatorToken();
      sendJson(res, 200, { token: emulatorToken });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      console.log("[config] fetching device-info from apkbridge...");
      let upstreamScreen = null;
      try {
        const info = await fetchServiceJson(apkbridgeDeviceInfoPath);
        upstreamScreen = info.screen || null;
        console.log(`[config] apkbridge device-info ok, screen=${JSON.stringify(upstreamScreen)}`);
      } catch (err) {
        console.warn(`[config] apkbridge device-info failed (non-fatal): ${err.message}`);
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
        source: captureSourceDescription(),
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
        "The optional WebRTC bridge creates a live RTCPeerConnection per browser session and returns a real SDP answer.",
        "ICE remains non-trickle and local-only; the primary firewall-friendly path is the scrcpy HTTP tunnel.",
        captureMode === "stub"
          ? "Media capture is disabled in stub mode."
          : captureMode === "native-rtc"
            ? "Video is captured directly from the emulator's native WebRTC stream via gRPC-Web JSEP signalling (RTCVideoSink → RTCVideoSource relay). No ADB screencap or screenrecord is used."
            : captureMode === "adb-screenrecord"
              ? "Video is captured from the emulator through an apkbridge-backed adb screenrecord H.264 stream and piped into WebRTC. If screenrecord stalls before the first frame, the bridge surfaces that failure instead of switching to screencap polling."
              : "Video is captured from the emulator through apkbridge screencaps and piped into WebRTC.",
      ],
      warnings: [],
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

      console.log("[session] creating new session from browser offer");
      session = createSession({ type: body.type, sdp: body.sdp });
      console.log(`[session:${session.id.slice(0, 8)}] building answer (captureMode=${captureMode})`);
      const answer = await buildAnswer(session);
      console.log(`[session:${session.id.slice(0, 8)}] answer ready, state=${session.state}`);
      sendJson(res, 201, {
        ok: true,
        ...sessionPayload(session),
        answer,
      });
    } catch (error) {
      console.error(`[session] buildAnswer failed: ${error.message}`);
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
        console.log(`[session:${session.id.slice(0, 8)}] SSE client disconnected`);
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
  } catch (err) {
    console.error(`[http] unhandled error in ${method} ${rawPath}: ${err.stack || err.message}`);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: "Internal server error" });
    }
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`bridge-webrtc listening on ${port}`);
  console.log(`  captureMode        : ${captureMode}`);
  console.log(`  captureFps         : ${captureFps}`);
  console.log(`  emulatorGrpcWebUrl : ${emulatorGrpcWebUrl}`);
  console.log(`  apkbridgeBaseUrl   : ${apkbridgeBaseUrl}`);
  console.log("  iceServers         : none (local ICE only)");
});

process.on("uncaughtException", (err) => {
  console.error(`[process] uncaughtException: ${err.stack || err.message}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error(`[process] unhandledRejection: ${msg}`);
});
