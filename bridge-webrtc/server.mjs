import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { URL } from "node:url";
import wrtc from "@roamhq/wrtc";
import { buildFfmpegArgs } from "./ffmpeg-config.mjs";
import { isRenderableNativeRtcFrame } from "./native-rtc-frame-guard.mjs";
import { prepareIceServersForNode } from "./turn-tls-shim.mjs";

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
const captureFps = Math.max(1, Number.parseInt(process.env.CAPTURE_FPS || "30", 10));
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
const turnKey = process.env.TURN_KEY || "";
const turnSecretSource = process.env.TURN_KEY ? "TURN_KEY" : null;
const turnHost = process.env.TURN_HOST || "";
const turnBridgeHost = process.env.TURN_BRIDGE_HOST?.trim() || "";
const turnBridgeHostIsIp = Boolean(turnBridgeHost && net.isIP(turnBridgeHost));
const turnBridgePort = process.env.TURN_BRIDGE_PORT?.trim() || "";
const turnBridgeScheme = process.env.TURN_BRIDGE_SCHEME?.trim() || "";
const turnPort = process.env.TURN_PORT || "443";
const turnProtocol = process.env.TURN_PROTOCOL || "tcp";
const turnScheme = process.env.TURN_SCHEME || "turns";
const turnTtl = Number.parseInt(process.env.TURN_TTL || "86400", 10);
const turnUsernameSuffix = process.env.TURN_USERNAME_SUFFIX || "emuuser";
const answerTimeoutMs = Number.parseInt(process.env.WEBRTC_ANSWER_TIMEOUT_MS || "10000", 10);
const sessionIdleTimeoutMs = Number.parseInt(process.env.WEBRTC_SESSION_IDLE_TIMEOUT_MS || "300000", 10);
const sessionRetentionMs = Number.parseInt(process.env.WEBRTC_SESSION_RETENTION_MS || "30000", 10);
const turnProbeTimeoutMs = Math.max(1000, Number.parseInt(process.env.TURN_PROBE_TIMEOUT_MS || "2000", 10));
const allowRelayFallback = process.env.WEBRTC_ALLOW_RELAY_FALLBACK !== "false";
const placeholderSecretPatterns = [/^PLACEHOLDER/i, /^REPLACE_ME/i, /^CHANGEME$/i];
const hasConfiguredTurnSecret = Boolean(
  turnKey &&
    turnHost &&
    !placeholderSecretPatterns.some((pattern) => pattern.test(turnKey.trim()))
);
const preferRelayTransport = hasConfiguredTurnSecret;

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
  if (!hasConfiguredTurnSecret) {
    return [];
  }

  return buildIceServersForUrls([buildTurnServerUrl()].filter(Boolean));
}

function formatTurnHostForUrl(host) {
  if (!host) {
    return host;
  }
  return net.isIP(host) === 6 ? `[${host}]` : host;
}

function buildTurnServerUrl(host = turnHost) {
  if (!host) {
    return null;
  }
  return `${turnScheme}:${formatTurnHostForUrl(host)}:${turnPort}?transport=${turnProtocol}`;
}

function buildBridgeTurnServerUrl(host = turnBridgeHost) {
  if (!host) {
    return null;
  }
  const scheme = turnBridgeScheme || turnScheme;
  const port = turnBridgePort || turnPort;
  return `${scheme}:${formatTurnHostForUrl(host)}:${port}?transport=${turnProtocol}`;
}

function buildIceServersForUrls(urls) {
  if (!hasConfiguredTurnSecret || !Array.isArray(urls) || urls.length === 0) {
    return [];
  }

  const expiry = Math.floor(Date.now() / 1000) + turnTtl;
  const username = `${expiry}:${turnUsernameSuffix}`;
  const credential = createHmac("sha1", turnKey).update(username).digest("base64");

  return [
    {
      urls,
      username,
      credential,
    },
  ];
}

function uniqueValues(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

async function resolveTurnServerUrls() {
  const hostnameUrl = buildTurnServerUrl();
  // When TURN_BRIDGE_HOST is set, build a bridge-specific URL using
  // TURN_BRIDGE_SCHEME and TURN_BRIDGE_PORT (if provided). This lets the bridge
  // use plain TURN (turn: scheme) on the TURN server's standard listening port
  // (typically 3478) for its own relay gathering, bypassing both the DNS lookup
  // that libwebrtc's C++ resolver cannot satisfy from /etc/hosts, and any TLS
  // certificate hostname mismatch that would occur when connecting via the LAN IP
  // with the turns: scheme. Browsers still receive the public TURN_HOST URL.
  const bridgeUrl =
    turnBridgeHost && turnBridgeHost !== turnHost
      ? buildBridgeTurnServerUrl(turnBridgeHost)
      : null;
  if (!hostnameUrl || !turnHost) {
    return { hostnameUrl: null, bridgeUrl, resolvedUrls: [], resolvedAddresses: [] };
  }

  try {
    const records = await dns.lookup(turnHost, { all: true });
    const resolvedAddresses = uniqueValues(records.map((record) => record.address));
    return {
      hostnameUrl,
      bridgeUrl,
      resolvedAddresses,
      resolvedUrls: resolvedAddresses.map((address) => buildTurnServerUrl(address)).filter(Boolean),
    };
  } catch {
    return { hostnameUrl, bridgeUrl, resolvedUrls: [], resolvedAddresses: [] };
  }
}

function buildTurnWarnings() {
  const warnings = [];

  if (!turnHost) {
    warnings.push("TURN_HOST is not configured, so relay ICE cannot be used.");
  }

  if (!turnKey) {
    warnings.push("TURN_KEY is not configured, so the bridge will not mint TURN credentials.");
  } else if (placeholderSecretPatterns.some((pattern) => pattern.test(turnKey.trim()))) {
    warnings.push("TURN_KEY still looks like a placeholder value, so TURN credentials are disabled.");
  }

  if (turnBridgeHost && turnBridgeHost !== turnHost) {
    const effectiveBridgeScheme = turnBridgeScheme || turnScheme;
    const effectiveBridgePort = turnBridgePort || turnPort;
    if (effectiveBridgeScheme === "turn" && turnBridgeHostIsIp) {
      warnings.push(
        `TURN_BRIDGE_HOST is set to '${turnBridgeHost}' with TURN_BRIDGE_SCHEME 'turn'. The bridge will connect to this IP on port ${effectiveBridgePort} using plain (unencrypted) TURN for relay gathering, bypassing both the DNS lookup that can fail for libwebrtc's C++ resolver and any TLS certificate mismatch when connecting via an IP literal. Browsers still use TURN_HOST '${turnHost}' with ${turnScheme.toUpperCase()}.`
      );
    } else if (effectiveBridgeScheme === "turns" && turnBridgeHostIsIp) {
      warnings.push(
        `TURN_BRIDGE_HOST is set to the IP '${turnBridgeHost}' with scheme 'turns'. TLS certificate validation applies; the server certificate must be valid for '${turnHost}'. Consider setting TURN_BRIDGE_SCHEME=turn and TURN_BRIDGE_PORT=3478 to use plain TURN and avoid TLS certificate issues when connecting via an IP literal. Browsers still use TURN_HOST '${turnHost}'.`
      );
    } else {
      warnings.push(
        `TURN_BRIDGE_HOST is set to '${turnBridgeHost}'. The bridge will use this host to reach the TURN server internally (e.g. to bypass hairpin NAT). Browsers still use TURN_HOST '${turnHost}'.`
      );
    }
  }

  return warnings;
}

const turnWarnings = buildTurnWarnings();

function probeErrorDetails(error) {
  return {
    code: error?.code || null,
    message: error?.message || String(error),
  };
}

async function probeTurnDns() {
  try {
    const records = await dns.lookup(turnHost, { all: true });
    return {
      ok: true,
      addresses: records.map((record) => record.address),
      family: records[0]?.family || null,
    };
  } catch (error) {
    return {
      ok: false,
      ...probeErrorDetails(error),
    };
  }
}

function connectTcp(host, portNumber) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({
      host,
      port: portNumber,
      timeout: turnProbeTimeoutMs,
    });

    socket.once("connect", () => {
      const details = {
        ok: true,
        localAddress: socket.localAddress || null,
        localPort: socket.localPort || null,
        remoteAddress: socket.remoteAddress || null,
        remotePort: socket.remotePort || null,
      };
      socket.end();
      resolve(details);
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`Timed out after ${turnProbeTimeoutMs}ms`));
    });
    socket.once("error", (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

async function probeTurnTcp() {
  try {
    return await connectTcp(turnHost, Number.parseInt(turnPort, 10) || 443);
  } catch (error) {
    return {
      ok: false,
      ...probeErrorDetails(error),
    };
  }
}

function handshakeTls(host, portNumber, servername) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port: portNumber,
      servername: servername !== undefined ? servername : host,
      timeout: turnProbeTimeoutMs,
    });

    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate?.(true) || null;
      const details = {
        ok: socket.authorized,
        authorized: socket.authorized,
        authorizationError: socket.authorizationError || null,
        protocol: socket.getProtocol?.() || null,
        subject: certificate?.subject?.CN || null,
        issuer: certificate?.issuer?.CN || null,
      };
      socket.end();
      if (details.ok) {
        resolve(details);
        return;
      }
      reject(new Error(details.authorizationError || "TLS certificate was not authorized"));
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`Timed out after ${turnProbeTimeoutMs}ms`));
    });
    socket.once("error", (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

async function probeTurnTls() {
  if (turnScheme !== "turns") {
    return {
      ok: true,
      skipped: true,
      reason: "TURN is not using TLS.",
    };
  }

  try {
    return await handshakeTls(turnHost, Number.parseInt(turnPort, 10) || 443);
  } catch (error) {
    return {
      ok: false,
      ...probeErrorDetails(error),
    };
  }
}

async function probeTurnConnectivity() {
  if (!hasConfiguredTurnSecret) {
    return null;
  }

  const effectiveHost = turnBridgeHost || turnHost;
  const dnsResult = await probeTurnDns();
  const tcpResult = dnsResult.ok ? await probeTurnTcp() : null;
  const tlsResult = dnsResult.ok && tcpResult?.ok ? await probeTurnTls() : null;

  let bridgeProbe = null;
  if (turnBridgeHost && turnBridgeHost !== turnHost) {
    const effectiveBridgeScheme = turnBridgeScheme || turnScheme;
    const effectiveBridgePort = Number.parseInt(turnBridgePort || turnPort, 10) || 443;
    const bridgeTcpResult = await connectTcp(turnBridgeHost, effectiveBridgePort).then(
      (r) => r,
      (e) => ({ ok: false, ...probeErrorDetails(e) })
    );
    const bridgeTlsResult =
      effectiveBridgeScheme === "turns" && bridgeTcpResult?.ok
        ? await handshakeTls(
            turnBridgeHost,
            effectiveBridgePort,
            turnBridgeHostIsIp ? turnHost : undefined
          ).then(
            (r) => r,
            (e) => ({ ok: false, ...probeErrorDetails(e) })
          )
        : effectiveBridgeScheme === "turn"
          ? { ok: true, skipped: true }
          : null;
    bridgeProbe = {
      host: turnBridgeHost,
      tcp: bridgeTcpResult,
      tls: bridgeTlsResult,
    };
  }

  return {
    at: nowIso(),
    serverUrl: turnBridgeHost && turnBridgeHost !== turnHost ? buildBridgeTurnServerUrl(turnBridgeHost) : buildTurnServerUrl(effectiveHost),
    dns: dnsResult,
    tcp: tcpResult,
    tls: tlsResult,
    bridgeHostProbe: bridgeProbe,
  };
}

function summarizeTurnFailure(session, diagnostics) {
  const candidateTypes = diagnostics?.candidateTypes || parseCandidateDiagnostics("");
  const probe = session.turnConnectivity || null;
  const recentErrors = (session.turnCandidateErrors || []).slice(-3);
  const recentErrorText = recentErrors
    .map((entry) => entry.errorText || entry.url || `ICE error ${entry.errorCode || "unknown"}`)
    .join(" | ");

  if (probe?.bridgeHostProbe && !probe.bridgeHostProbe.tcp?.ok) {
    const bridgePortDisplay = turnBridgePort || turnPort;
    return `TURN_BRIDGE_HOST '${turnBridgeHost}' TCP connect on port ${bridgePortDisplay} failed: ${probe.bridgeHostProbe.tcp?.message || "unknown error"}. The bridge cannot reach the TURN server at this internal address.`;
  }

  if (probe?.bridgeHostProbe && probe.bridgeHostProbe.tls && !probe.bridgeHostProbe.tls?.ok) {
    const bridgePortDisplay = turnBridgePort || turnPort;
    return `TURN_BRIDGE_HOST '${turnBridgeHost}' TLS handshake on port ${bridgePortDisplay} failed: ${probe.bridgeHostProbe.tls?.message || "unknown error"}.`;
  }

  if (probe?.dns && !probe.dns.ok) {
    return `DNS lookup failed for ${turnHost}: ${probe.dns.message}.`;
  }

  if (probe?.tcp && !probe.tcp.ok) {
    return `TCP connect to ${turnHost}:${turnPort} failed: ${probe.tcp.message}.`;
  }

  if (probe?.tls && !probe.tls.ok) {
    return `TLS handshake to ${turnHost}:${turnPort} failed: ${probe.tls.message}.`;
  }

  if (recentErrors.some((entry) => /host lookup/i.test(entry.errorText || ""))) {
    if (session.turnUrlStrategy === "resolved-ip") {
      return `TURN client still reported host lookup or socket setup errors even after retrying with DNS-resolved TURN IPs (${(session.turnResolution?.resolvedAddresses || []).join(", ")}). Recent ICE errors: ${recentErrorText}.`;
    }
    return `TURN client reported a DNS or host lookup error after preflight while using the TURN hostname. Recent ICE errors: ${recentErrorText}.`;
  }

  if (recentErrors.some((entry) => /tls|certificate|ssl/i.test(entry.errorText || ""))) {
    return `TURN client reported a TLS failure after preflight. Recent ICE errors: ${recentErrorText}.`;
  }

  if (recentErrors.some((entry) => /create turn client socket/i.test(entry.errorText || ""))) {
    return `TURN client socket setup failed after DNS/TCP${turnScheme === "turns" ? "/TLS" : ""} preflight passed. This usually points to TURN auth mismatch or blocked relay connectivity on 49160-49200/tcp.`;
  }

  if (
    probe?.dns?.ok &&
    probe?.tcp?.ok &&
    (probe?.tls?.ok || probe?.tls?.skipped) &&
    (candidateTypes.relay ?? 0) === 0 &&
    (candidateTypes.privateHost ?? 0) > 0
  ) {
    return "TURN DNS/TCP/TLS preflight passed, but the bridge answer only exposed private Docker/LAN host candidates and no relay candidate. Browsers that fall back to TURN for those private peers commonly hit coturn 403 Forbidden IP unless that subnet is explicitly allowed.";
  }

  if (
    probe?.dns?.ok &&
    probe?.tcp?.ok &&
    (probe?.tls?.ok || probe?.tls?.skipped) &&
    (candidateTypes.relay ?? 0) === 0 &&
    (candidateTypes.loopbackHost ?? 0) > 0
  ) {
    return "TURN DNS/TCP/TLS preflight passed, but the bridge answer still exposed loopback host candidates like 127.0.0.1 and no relay candidate. That SDP is not usable for a remote browser session.";
  }

  if (probe?.dns?.ok && probe?.tcp?.ok && (probe?.tls?.ok || probe?.tls?.skipped) && (candidateTypes.relay ?? 0) === 0) {
    return "TURN DNS/TCP/TLS preflight passed, but no relay candidate was allocated. This usually points to TURN auth mismatch or blocked relay ports 49160-49200/tcp.";
  }

  return recentErrorText ? `Recent ICE errors: ${recentErrorText}.` : null;
}

function summarizeCandidateTypes(candidateTypes) {
  if (!candidateTypes) {
    return "no candidate diagnostics";
  }

  return [
    `total=${candidateTypes.total ?? 0}`,
    `relay=${candidateTypes.relay ?? 0}`,
    `host=${candidateTypes.host ?? 0}`,
    `srflx=${candidateTypes.srflx ?? 0}`,
    `prflx=${candidateTypes.prflx ?? 0}`,
  ].join(", ");
}

function summarizeCandidateAddresses(candidateTypes) {
  const addresses = Array.isArray(candidateTypes?.addresses) ? candidateTypes.addresses.filter(Boolean) : [];
  if (addresses.length === 0) {
    return "no candidate addresses";
  }
  return addresses.join(", ");
}

function hasTurnHostLookupError(errors) {
  return (errors || []).some((entry) => /host lookup/i.test(entry?.errorText || ""));
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

function buildRelayFailureMessage(session, diagnostics) {
  const candidateTypes = diagnostics?.candidateTypes || parseCandidateDiagnostics("");
  const addresses = candidateTypes.addresses.slice(0, 4).join(", ");
  const failureSummary = summarizeTurnFailure(session, diagnostics);
  const details = [
    `TURN relay gathering failed for ${buildTurnServerUrl() || "the configured TURN server"}.`,
    candidateTypes.total > 0
      ? `The bridge only gathered non-relay candidates${addresses ? ` (${addresses})` : ""}.`
      : "The bridge gathered no ICE candidates at all while relay-only mode was enabled.",
    failureSummary,
    "Check coturn reachability on 443/tcp and 49160-49200/tcp, and verify TURN_KEY matches coturn static-auth-secret exactly.",
  ];
  return details.filter(Boolean).join(" ");
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
    turnPolicy: session.turnPolicy || null,
    relayFallbackUsed: Boolean(session.relayFallbackUsed),
    turnFailureSummary: session.turnFailureSummary || null,
    turnConnectivity: session.turnConnectivity,
    turnResolution: session.turnResolution || null,
    turnUrlStrategy: session.turnUrlStrategy || null,
    turnTlsTunnels: session.turnTlsTunnels || [],
    turnCandidateErrors: session.turnCandidateErrors.slice(-5),
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
    turnCandidateErrors: [],
    turnConnectivity: null,
    turnResolution: null,
    turnUrlStrategy: null,
    turnTlsTunnels: [],
    turnTlsTunnelCleanup: null,
    answerAttempts: [],
    turnPolicy: null,
    relayFallbackUsed: false,
    turnFailureSummary: null,
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

  if (typeof session.turnTlsTunnelCleanup === "function") {
    session.turnTlsTunnelCleanup();
    session.turnTlsTunnelCleanup = null;
  }
  session.turnTlsTunnels = [];

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
    session.turnCandidateErrors.push(entry);
    if (session.turnCandidateErrors.length > 20) {
      session.turnCandidateErrors.shift();
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
      // aborting the session.  This mirrors the browser-side behaviour and allows
      // the answer to be built from partial candidates when the TURN server is
      // slow or unreachable instead of failing the entire session.
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
        this.consecutiveFailures = 0;
        this.session.media.screenrecord = {
          ...(this.session.media.screenrecord || {}),
          connectedAt: nowIso(),
          verification: "pending",
        };
        recordSessionLog(this.session, "info", "Connected to apkbridge screenrecord stream", {
          bitrate: captureBitrate,
          fps: captureFps,
        });

        while (this.running) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (value?.length) {
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
    this.turnTlsTunnelCleanup = null;
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
      if (typeof this.turnTlsTunnelCleanup === "function") {
        this.turnTlsTunnelCleanup();
        this.turnTlsTunnelCleanup = null;
      }
      if (this.emulatorPeer) {
        this.emulatorPeer.close();
      }
      const sourceIceServers =
        Array.isArray(signal.start.iceServers) && signal.start.iceServers.length > 0
          ? signal.start.iceServers
          : buildIceServers();
      const preparedIceServers = await prepareIceServersForNode(sourceIceServers, {
        logger: (level, message, details) => {
          recordSessionLog(this.session, level, `native-rtc: ${message}`, details);
        },
      });
      this.turnTlsTunnelCleanup = preparedIceServers.close;
      this.emulatorPeer = new RTCPeerConnection({
        iceServers: preparedIceServers.iceServers,
        iceTransportPolicy: preferRelayTransport ? "relay" : "all",
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

  _attachVideoSink(videoTrack) {
    if (this.videoSink) {
      this.videoSink.stop();
    }
    const sink = new RTCVideoSink(videoTrack);
    this.videoSink = sink;
    let frameCount = 0;
    let placeholderFrameCount = 0;
    sink.onframe = ({ frame }) => {
      if (!this.running || sink.stopped) {
        return;
      }
      const { width, height, data } = frame;
      const media = this.session.media;
      if (!isRenderableNativeRtcFrame(frame)) {
        placeholderFrameCount += 1;
        if (placeholderFrameCount === 1) {
          recordSessionLog(this.session, "warn", "native-rtc: ignoring placeholder startup frame", {
            width,
            height,
          });
        }
        return;
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
    this.abortController.abort();
    if (typeof this.turnTlsTunnelCleanup === "function") {
      this.turnTlsTunnelCleanup();
      this.turnTlsTunnelCleanup = null;
    }
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
  const turnUrlOptions = await resolveTurnServerUrls();
  session.turnResolution = turnUrlOptions;

  async function attemptAnswer(iceTransportPolicy, options = {}) {
    const priorErrorCount = session.turnCandidateErrors.length;
    session.localIceCandidates = [];
    session.turnConnectivity = preferRelayTransport ? await probeTurnConnectivity() : null;
    if (session.turnConnectivity) {
      recordSessionLog(session, "info", "TURN connectivity preflight", session.turnConnectivity);
    }

    const turnUrls = options.turnUrls || buildIceServers().flatMap((server) => server.urls || []);
    const turnUrlStrategy = options.turnUrlStrategy || (turnUrls[0] === turnUrlOptions.hostnameUrl ? "hostname" : "resolved-ip");
    session.turnUrlStrategy = turnUrlStrategy;
    if (turnUrls.length > 0) {
      recordSessionLog(session, "info", "Configuring bridge TURN URLs", {
        turnUrlStrategy,
        urls: turnUrls,
      });
    }

    const preparedIceServers = await prepareIceServersForNode(buildIceServersForUrls(turnUrls), {
      logger: (level, message, details) => {
        recordSessionLog(session, level, message, details);
      },
    });
    session.turnTlsTunnels = preparedIceServers.tunnels;
    session.turnTlsTunnelCleanup = preparedIceServers.close;

    const peer = new RTCPeerConnection({
      iceServers: preparedIceServers.iceServers,
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
      `Collecting ICE candidates and starting the capture pipeline concurrently (${iceTransportPolicy}).`,
      { log: true }
    );

    // Run ICE gathering and media pipeline setup in parallel.  Previously the
    // pipeline was started before createAnswer(), which prevented ICE gathering
    // from beginning until the (potentially slow) screencap or screenrecord
    // initialisation finished.  Running them concurrently cuts time-to-first-
    // frame by up to ~2 s in the typical case.
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

    return {
      answer: localAnswer,
      diagnostics,
      iceTransportPolicy,
      turnUrls,
      turnUrlStrategy,
      candidateErrors: session.turnCandidateErrors.slice(priorErrorCount),
    };
  }

  let result = await attemptAnswer(preferRelayTransport ? "relay" : "all", {
    turnUrls: turnUrlOptions.bridgeUrl
      ? [turnUrlOptions.bridgeUrl]
      : turnUrlOptions.hostnameUrl
        ? [turnUrlOptions.hostnameUrl]
        : [],
    turnUrlStrategy: turnUrlOptions.bridgeUrl ? "bridge-host" : "hostname",
  });
  session.answerAttempts.push({
    iceTransportPolicy: result.iceTransportPolicy,
    turnUrlStrategy: result.turnUrlStrategy,
    turnUrls: result.turnUrls || [],
    diagnostics: result.diagnostics || null,
    candidateErrors: result.candidateErrors || [],
  });

  if (
    preferRelayTransport &&
    (result.diagnostics?.candidateTypes?.relay ?? 0) === 0 &&
    result.turnUrlStrategy === "bridge-host" &&
    turnUrlOptions.hostnameUrl
  ) {
    recordSessionLog(
      session,
      "warn",
      "Relay-only ICE gathering via TURN_BRIDGE_HOST produced no relay candidates; retrying with the public TURN_HOST hostname.",
      {
        bridgeUrl: turnUrlOptions.bridgeUrl,
        hostnameUrl: turnUrlOptions.hostnameUrl,
        candidateErrors: result.candidateErrors || [],
      }
    );
    closeSessionResources(session);
    result = await attemptAnswer("relay", {
      turnUrls: [turnUrlOptions.hostnameUrl],
      turnUrlStrategy: "hostname",
    });
    session.answerAttempts.push({
      iceTransportPolicy: result.iceTransportPolicy,
      turnUrlStrategy: result.turnUrlStrategy,
      turnUrls: result.turnUrls || [],
      diagnostics: result.diagnostics || null,
      candidateErrors: result.candidateErrors || [],
    });
  }

  if (
    preferRelayTransport &&
    (result.diagnostics?.candidateTypes?.relay ?? 0) === 0 &&
    hasTurnHostLookupError(result.candidateErrors) &&
    (turnUrlOptions.resolvedUrls?.length ?? 0) > 0
  ) {
    recordSessionLog(
      session,
      "warn",
      "Relay-only ICE gathering reported TURN host lookup errors; retrying with DNS-resolved TURN IP literals.",
      {
        hostnameUrl: turnUrlOptions.hostnameUrl,
        resolvedAddresses: turnUrlOptions.resolvedAddresses,
        resolvedUrls: turnUrlOptions.resolvedUrls,
      }
    );
    closeSessionResources(session);
    result = await attemptAnswer("relay", {
      turnUrls: turnUrlOptions.resolvedUrls,
      turnUrlStrategy: "resolved-ip",
    });
    session.answerAttempts.push({
      iceTransportPolicy: result.iceTransportPolicy,
      turnUrlStrategy: result.turnUrlStrategy,
      turnUrls: result.turnUrls || [],
      diagnostics: result.diagnostics || null,
      candidateErrors: result.candidateErrors || [],
    });
  }

  if (preferRelayTransport && (result.diagnostics?.candidateTypes?.relay ?? 0) === 0) {
    const relayFailureMessage = buildRelayFailureMessage(session, result.diagnostics);
    session.turnFailureSummary = relayFailureMessage;

    if (allowRelayFallback) {
      session.relayFallbackUsed = true;
      session.turnPolicy = {
        requested: "relay",
        applied: "all",
        fallbackReason: relayFailureMessage,
      };
      recordSessionLog(session, "warn", "Relay-only ICE gathering produced no relay candidates; retrying with all candidates enabled.", {
        relayCandidateSummary: summarizeCandidateTypes(result.diagnostics?.candidateTypes),
        candidateErrors: result.candidateErrors || [],
      });
      closeSessionResources(session);
      const allPolicyTurnUrls = turnUrlOptions.bridgeUrl
        ? [turnUrlOptions.bridgeUrl]
        : (turnUrlOptions.resolvedUrls?.length ?? 0) > 0
          ? turnUrlOptions.resolvedUrls
          : null;
      const allPolicyTurnUrlStrategy = turnUrlOptions.bridgeUrl
        ? "bridge-host"
        : (turnUrlOptions.resolvedUrls?.length ?? 0) > 0
          ? "resolved-ip"
          : null;
      result = await attemptAnswer("all", {
        ...(allPolicyTurnUrls ? { turnUrls: allPolicyTurnUrls, turnUrlStrategy: allPolicyTurnUrlStrategy } : {}),
      });
      session.answerAttempts.push({
        iceTransportPolicy: result.iceTransportPolicy,
        diagnostics: result.diagnostics || null,
        candidateErrors: result.candidateErrors || [],
      });
    } else {
      throw new Error(relayFailureMessage);
    }
  }

  if (
    preferRelayTransport &&
    (result.diagnostics?.candidateTypes?.relay ?? 0) === 0 &&
    (result.diagnostics?.candidateTypes?.publicHost ?? 0) === 0
  ) {
    session.turnFailureSummary = [
      buildRelayFailureMessage(session, result.diagnostics),
      `Bridge candidate addresses: ${summarizeCandidateAddresses(result.diagnostics?.candidateTypes)}.`,
    ]
      .filter(Boolean)
      .join(" ");
    throw new Error(session.turnFailureSummary);
  }

  if ((result.diagnostics?.candidateTypes?.total ?? 0) === 0) {
    session.turnFailureSummary = buildRelayFailureMessage(session, result.diagnostics);
    throw new Error(session.turnFailureSummary);
  }

  session.answer = result.answer;
  session.answerDiagnostics = result.diagnostics;
  if (!session.turnPolicy) {
    session.turnPolicy = {
      requested: result.iceTransportPolicy,
      applied: result.iceTransportPolicy,
      fallbackReason: null,
    };
  }

  setSessionState(
    session,
    captureMode === "stub" ? "answered-no-media" : "answered",
    captureMode === "stub"
      ? "SDP answer created successfully, but media is disabled because the bridge is in stub mode."
      : session.relayFallbackUsed
        ? "SDP answer created after retrying ICE gathering with all candidates enabled. Waiting for the browser peer to connect."
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
        turnConfigured: hasConfiguredTurnSecret,
        turnSecretSource,
        turnServerUrl: buildTurnServerUrl(),
        warnings: turnWarnings,
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
        iceTransportPolicy: preferRelayTransport ? "relay" : "all",
      },
      notes: [
        "The custom bridge now creates a live RTCPeerConnection per browser session and returns a real SDP answer.",
        "ICE remains non-trickle for now, so the bridge waits for gathering to complete before responding.",
        preferRelayTransport
          ? "TURN is configured, so the bridge requires relay candidates instead of advertising container-local host candidates."
          : "TURN is not configured, so the bridge can only advertise local host candidates.",
        captureMode === "stub"
          ? "Media capture is disabled in stub mode."
          : captureMode === "native-rtc"
            ? "Video is captured directly from the emulator's native WebRTC stream via gRPC-Web JSEP signalling (RTCVideoSink → RTCVideoSource relay). No ADB screencap or screenrecord is used."
            : captureMode === "adb-screenrecord"
              ? "Video is captured from the emulator through an apkbridge-backed adb screenrecord H.264 stream and piped into WebRTC. If screenrecord stalls before the first frame, the bridge surfaces that failure instead of switching to screencap polling."
              : "Video is captured from the emulator through apkbridge screencaps and piped into WebRTC.",
        ...turnWarnings,
      ],
      warnings: turnWarnings,
      turn: {
        configured: hasConfiguredTurnSecret,
        secretSource: turnSecretSource,
        url: buildTurnServerUrl(),
        bridgeHost: turnBridgeHost && turnBridgeHost !== turnHost ? turnBridgeHost : null,
        bridgeUrl:
          turnBridgeHost && turnBridgeHost !== turnHost
            ? buildBridgeTurnServerUrl(turnBridgeHost)
            : null,
      },
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
  console.log(`  TURN configured    : ${hasConfiguredTurnSecret}`);
  if (hasConfiguredTurnSecret) {
    console.log(`  TURN server url    : ${buildTurnServerUrl()}`);
    console.log(`  TURN bridge host   : ${turnBridgeHost || "(same as TURN_HOST)"}`);
    console.log(`  preferRelay        : ${preferRelayTransport}`);
  } else {
    console.log(`  TURN              : not configured (TURN_KEY is missing or placeholder)`);
  }
  if (turnWarnings.length > 0) {
    for (const w of turnWarnings) {
      console.warn(`  [warn] ${w}`);
    }
  }
});

process.on("uncaughtException", (err) => {
  console.error(`[process] uncaughtException: ${err.stack || err.message}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error(`[process] unhandledRejection: ${msg}`);
});
