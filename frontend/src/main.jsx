import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Emulator } from "android-emulator-webrtc/emulator";

const EMULATOR_ASPECT = 1080 / 1920;
const RAW_FRAME_URL = "/api/frame";

function formatClockTime(value) {
  if (!value) {
    return "n/a";
  }
  try {
    return new Date(value).toLocaleTimeString();
  } catch {
    return String(value);
  }
}

function buildVideoStatsSnapshot(video) {
  if (!video) {
    return null;
  }

  return {
    readyState: video.readyState,
    paused: video.paused,
    ended: video.ended,
    currentTime: Number(video.currentTime || 0).toFixed(2),
    videoWidth: video.videoWidth || 0,
    videoHeight: video.videoHeight || 0,
    networkState: video.networkState,
  };
}

function buildInboundVideoStats(reports) {
  let inbound = null;
  let track = null;
  let transport = null;
  let selectedPair = null;

  reports.forEach((report) => {
    if (report.type === "inbound-rtp" && report.kind === "video" && !report.isRemote) {
      inbound = report;
      return;
    }
    if (report.type === "track" && report.kind === "video") {
      track = report;
    }
  });

  if (inbound?.transportId) {
    transport = reports.get(inbound.transportId) || null;
    if (transport?.selectedCandidatePairId) {
      selectedPair = reports.get(transport.selectedCandidatePairId) || null;
    }
  }

  return {
    packetsReceived: inbound?.packetsReceived ?? 0,
    bytesReceived: inbound?.bytesReceived ?? 0,
    framesDecoded: inbound?.framesDecoded ?? track?.framesDecoded ?? 0,
    framesReceived: inbound?.framesReceived ?? track?.framesReceived ?? 0,
    keyFramesDecoded: inbound?.keyFramesDecoded ?? 0,
    firCount: inbound?.firCount ?? 0,
    pliCount: inbound?.pliCount ?? 0,
    nackCount: inbound?.nackCount ?? 0,
    jitter: inbound?.jitter ?? null,
    decoderImplementation: inbound?.decoderImplementation || null,
    frameWidth: track?.frameWidth ?? inbound?.frameWidth ?? 0,
    frameHeight: track?.frameHeight ?? inbound?.frameHeight ?? 0,
    selectedCandidatePair: selectedPair
      ? {
          state: selectedPair.state || null,
          currentRoundTripTime: selectedPair.currentRoundTripTime ?? null,
          availableIncomingBitrate: selectedPair.availableIncomingBitrate ?? null,
        }
      : null,
  };
}

function countSdpIceCandidates(sdp) {
  if (!sdp) {
    return 0;
  }
  const matches = String(sdp).match(/^a=candidate:/gm);
  return matches ? matches.length : 0;
}

function isLoopbackAddress(address) {
  return address === "::1" || address === "localhost" || /^127\./.test(address);
}

function isPrivateAddress(address) {
  if (!address) {
    return false;
  }
  if (isLoopbackAddress(address)) {
    return true;
  }
  if (/^10\./.test(address) || /^192\.168\./.test(address) || /^169\.254\./.test(address)) {
    return true;
  }
  const match172 = address.match(/^172\.(\d{1,3})\./);
  if (match172) {
    const octet = Number(match172[1]);
    if (octet >= 16 && octet <= 31) {
      return true;
    }
  }
  return /^(fc|fd|fe80)/i.test(address);
}

function parseSdpCandidateDiagnostics(sdp) {
  const summary = {
    total: 0,
    relay: 0,
    srflx: 0,
    host: 0,
    publicHost: 0,
    privateHost: 0,
    loopbackHost: 0,
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

    if (candidateType === "relay") {
      summary.relay += 1;
      continue;
    }
    if (candidateType === "srflx") {
      summary.srflx += 1;
      continue;
    }
    if (candidateType === "host") {
      summary.host += 1;
      if (isLoopbackAddress(address)) {
        summary.loopbackHost += 1;
      } else if (isPrivateAddress(address)) {
        summary.privateHost += 1;
      } else {
        summary.publicHost += 1;
      }
    }
  }

  return summary;
}

function parseSdpVideoSection(sdp) {
  if (!sdp) {
    return null;
  }

  const lines = String(sdp)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let current = null;
  for (const line of lines) {
    if (line.startsWith("m=")) {
      const [, kind = "unknown"] = line.slice(2).split(/\s+/);
      current =
        kind === "video"
          ? { kind, direction: "sendrecv", mid: null, trackId: null, codecs: [], candidates: 0 }
          : null;
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
      const [, trackId = ""] = line.slice("a=msid:".length).split(/\s+/, 2);
      current.trackId = trackId || null;
      continue;
    }
    if (line.startsWith("a=rtpmap:")) {
      current.codecs.push(line.slice("a=rtpmap:".length));
      continue;
    }
    if (line.startsWith("a=candidate:")) {
      current.candidates += 1;
    }
  }

  return current;
}

function formatCandidateTypeSummary(candidateTypes) {
  if (!candidateTypes) {
    return "n/a";
  }

  return [
    `total ${candidateTypes.total ?? 0}`,
    `relay ${candidateTypes.relay ?? 0}`,
    `host ${candidateTypes.host ?? 0}`,
    `srflx ${candidateTypes.srflx ?? 0}`,
    `prflx ${candidateTypes.prflx ?? 0}`,
  ].join(" | ");
}

function formatBridgeTlsStatus(tls) {
  if (tls.skipped) {
    return "skipped";
  }
  return tls.ok ? "ok" : `failed (${tls.message || "unknown"})`;
}

function formatAnswerAttemptSummary(attempts) {
  const normalizedAttempts = Array.isArray(attempts) ? attempts : [];
  if (normalizedAttempts.length === 0) {
    return "No bridge ICE attempts recorded yet.";
  }

  return normalizedAttempts
    .map((attempt, index) => {
      const candidateSummary = formatCandidateTypeSummary(attempt?.diagnostics?.candidateTypes);
      const errorCount = Array.isArray(attempt?.candidateErrors) ? attempt.candidateErrors.length : 0;
      return `attempt ${index + 1}: ${attempt?.iceTransportPolicy || "unknown"} | ${candidateSummary} | errors ${errorCount}`;
    })
    .join("\n");
}

function waitForIceGatheringComplete(peer, timeoutMs = 10000) {
  if (!peer) {
    return Promise.reject(new Error("RTCPeerConnection is not available"));
  }

  if (peer.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for browser ICE gathering after ${timeoutMs}ms.`));
    }, timeoutMs);

    function cleanup() {
      window.clearTimeout(timeout);
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

async function parseJsonResponse(resp, label) {
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 200);
    if (snippet.includes("no healthy upstream")) {
      throw new Error(
        `${label} is unavailable because Envoy has no healthy bridge-webrtc upstream. The bridge container likely failed to start or is still booting.`
      );
    }
    throw new Error(`${label} returned non-JSON: ${snippet}`);
  }
  if (!resp.ok) {
    throw new Error(data.error || data.message || `${label} failed (${resp.status})`);
  }
  return data;
}

function mapBridgeSessionState(sessionState, hasVideo) {
  if (hasVideo || sessionState === "connected" || sessionState === "media-ready") {
    return "connected";
  }

  if (["failed", "disconnected", "closed", "expired", "media-failed"].includes(sessionState)) {
    return "disconnected";
  }

  return "connecting";
}

function CustomWebrtcPane({ active, width, height, onStateChange, onMessage, inputRef, onDiagnosticsChange }) {
  const videoRef = useRef(null);
  const peerRef = useRef(null);
  const sessionRef = useRef(null);
  const eventSourceRef = useRef(null);
  const gestureRef = useRef(null);
  const [bridgeState, setBridgeState] = useState("idle");
  const [sessionState, setSessionState] = useState("idle");
  const [sessionInfo, setSessionInfo] = useState(null);
  const [notes, setNotes] = useState([]);
  const [sessionMessage, setSessionMessage] = useState("");
  const [logs, setLogs] = useState([]);
  const [hasVideo, setHasVideo] = useState(false);
  const [runtimeEvents, setRuntimeEvents] = useState([]);
  const [videoStats, setVideoStats] = useState(null);
  const [receiverStats, setReceiverStats] = useState(null);
  const [answerSdp, setAnswerSdp] = useState("");
  const [offerSummary, setOfferSummary] = useState("Offer not created yet.");

  const sendSessionInput = useCallback(
    async (payload) => {
      if (!sessionRef.current) {
        throw new Error("WebRTC session is not ready yet.");
      }

      const response = await fetch(`/bridge/api/session/${sessionRef.current}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      return parseJsonResponse(response, "/bridge/api/session/:id/input");
    },
    []
  );

  const appendRuntimeEvent = useCallback((message, details = null) => {
    const entry = {
      at: new Date().toISOString(),
      message,
      details,
    };
    setRuntimeEvents((previous) => [...previous, entry].slice(-10));
  }, []);

  useEffect(() => {
    if (!inputRef) {
      return undefined;
    }
    inputRef.current = sendSessionInput;
    return () => {
      if (inputRef.current === sendSessionInput) {
        inputRef.current = null;
      }
    };
  }, [inputRef, sendSessionInput]);

  useEffect(() => {
    onStateChange(mapBridgeSessionState(sessionState, hasVideo));
  }, [hasVideo, onStateChange, sessionState]);

  useEffect(() => {
    if (!active) {
      return undefined;
    }

    let cancelled = false;

    async function start() {
      try {
        setBridgeState("checking");
        setSessionState("initializing");
        setSessionInfo(null);
        setSessionMessage("Checking custom bridge health...");
        setHasVideo(false);
        setLogs([]);
        setRuntimeEvents([]);
        setVideoStats(null);
        setReceiverStats(null);
        setAnswerSdp("");
        onStateChange("connecting");

        const health = await parseJsonResponse(await fetch("/bridge/health"), "/bridge/health");
        if (!health.ok) {
          throw new Error("Custom bridge health check failed.");
        }

        const config = await parseJsonResponse(await fetch("/bridge/api/config"), "/bridge/api/config");
        if (cancelled) {
          return;
        }

        setBridgeState("ready");
        setNotes(Array.isArray(config.notes) ? config.notes : []);
        setSessionMessage("Creating browser offer...");

        const peer = new RTCPeerConnection(config.rtcConfiguration || {});
        peerRef.current = peer;
        peer.addTransceiver("video", { direction: "recvonly" });
        appendRuntimeEvent("Created browser RTCPeerConnection", {
          iceServers: (config.rtcConfiguration?.iceServers || []).length,
        });

        peer.ontrack = (event) => {
          const stream = event.streams?.[0] || new MediaStream([event.track]);
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play().catch(() => {});
          }
          setHasVideo(true);
          appendRuntimeEvent("Browser received remote video track", {
            trackId: event.track?.id || null,
            streams: (event.streams || []).map((streamEntry) => streamEntry.id),
            muted: Boolean(event.track?.muted),
            readyState: event.track?.readyState || "unknown",
          });
          if (event.track) {
            event.track.onmute = () => appendRuntimeEvent("Remote video track muted", { trackId: event.track.id });
            event.track.onunmute = () => appendRuntimeEvent("Remote video track unmuted", { trackId: event.track.id });
            event.track.onended = () => appendRuntimeEvent("Remote video track ended", { trackId: event.track.id });
          }
          setSessionMessage(
            event.streams?.length
              ? "Remote emulator video track attached."
              : "Remote emulator video track attached from a streamless bridge track."
          );
        };

        peer.onconnectionstatechange = () => {
          setSessionState(peer.connectionState || "unknown");
          appendRuntimeEvent("Peer connection state changed", { state: peer.connectionState || "unknown" });
        };
        peer.oniceconnectionstatechange = () =>
          appendRuntimeEvent("ICE connection state changed", { state: peer.iceConnectionState || "unknown" });
        peer.onicegatheringstatechange = () =>
          appendRuntimeEvent("ICE gathering state changed", { state: peer.iceGatheringState || "unknown" });
        peer.onicecandidateerror = (event) =>
          appendRuntimeEvent("ICE candidate error", {
            address: event.address || null,
            port: event.port || null,
            url: event.url || null,
            errorCode: event.errorCode || null,
            errorText: event.errorText || null,
          });

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        setSessionMessage("Gathering browser ICE candidates...");
        await waitForIceGatheringComplete(peer);
        const localOffer = peer.localDescription || offer;
        const localOfferCandidates = countSdpIceCandidates(localOffer.sdp);
        setOfferSummary(`type=${localOffer.type} | candidates=${localOfferCandidates}`);
        appendRuntimeEvent("Browser SDP offer created", {
          type: localOffer.type,
          iceCandidates: localOfferCandidates,
        });

        const sessionResp = await fetch("/bridge/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: localOffer.type,
            sdp: localOffer.sdp,
          }),
        });

        const sessionText = await sessionResp.text();
        let session;
        try {
          session = JSON.parse(sessionText);
        } catch {
          throw new Error(`Bridge session returned non-JSON: ${sessionText.slice(0, 200)}`);
        }

        if (session.id) {
          sessionRef.current = session.id;
        }
        setSessionInfo(session);
        setSessionState(session.state || "created");
        setSessionMessage(session.message || "Session created.");
        setAnswerSdp(session.answer?.sdp || "");
        if (Array.isArray(session.recentLogs)) {
          setLogs(session.recentLogs.slice(-6));
        }

        if (session.eventStreamUrl) {
          const source = new EventSource(session.eventStreamUrl);
          eventSourceRef.current = source;
          source.addEventListener("status", (event) => {
            try {
              const payload = JSON.parse(event.data);
              setSessionInfo(payload);
              if (payload.state) {
                setSessionState(payload.state);
              }
              if (payload.message) {
                setSessionMessage(payload.message);
              }
              if (Array.isArray(payload.recentLogs)) {
                setLogs(payload.recentLogs.slice(-6));
              }
            } catch {
              // ignore malformed status events
            }
          });
          source.addEventListener("log", (event) => {
            try {
              const payload = JSON.parse(event.data);
              setLogs((previous) => [...previous, payload].slice(-6));
            } catch {
              // ignore malformed log events
            }
          });
        }

        if (!sessionResp.ok) {
          throw new Error(session.error || `Bridge session failed (${sessionResp.status})`);
        }

        if (!session.answer?.sdp || !session.answer?.type) {
          throw new Error("Bridge session created but no SDP answer was returned.");
        }

        await peer.setRemoteDescription(session.answer);
        appendRuntimeEvent("Bridge SDP answer applied in browser", {
          type: session.answer.type,
          hasVideoSection: Boolean(session.answerDiagnostics?.hasVideoSection),
          sendCapableVideo: Boolean(session.answerDiagnostics?.hasSendonlyOrSendrecvVideo),
          iceCandidates: session.answerDiagnostics?.totalIceCandidates ?? null,
        });
        setSessionState(session.state || "answer-applied");
        onMessage(session.message || "Custom WebRTC signaling completed. Waiting for media.");
      } catch (error) {
        if (cancelled) {
          return;
        }
        setBridgeState("error");
        setSessionState("failed");
        setSessionMessage(error.message);
        onStateChange("disconnected");
        onMessage(`Custom WebRTC bridge: ${error.message}`);
      }
    }

    start();

    return () => {
      cancelled = true;
      gestureRef.current = null;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;

      if (sessionRef.current) {
        fetch(`/bridge/api/session/${sessionRef.current}`, { method: "DELETE" }).catch(() => {});
        sessionRef.current = null;
      }

      if (peerRef.current) {
        peerRef.current.close();
        peerRef.current = null;
      }
    };
  }, [active, appendRuntimeEvent, onMessage, onStateChange]);

  useEffect(() => {
    if (!active) {
      return undefined;
    }

    const video = videoRef.current;
    if (!video) {
      return undefined;
    }

    const handlers = {
      loadedmetadata: () =>
        appendRuntimeEvent("Video element loaded metadata", {
          width: video.videoWidth || 0,
          height: video.videoHeight || 0,
        }),
      playing: () => appendRuntimeEvent("Video element started playing"),
      waiting: () => appendRuntimeEvent("Video element waiting for data"),
      stalled: () => appendRuntimeEvent("Video element stalled"),
      error: () =>
        appendRuntimeEvent("Video element error", {
          code: video.error?.code || null,
          message: video.error?.message || null,
        }),
    };

    Object.entries(handlers).forEach(([eventName, handler]) => video.addEventListener(eventName, handler));
    return () => {
      Object.entries(handlers).forEach(([eventName, handler]) => video.removeEventListener(eventName, handler));
    };
  }, [active, appendRuntimeEvent]);

  useEffect(() => {
    if (!active) {
      return undefined;
    }

    let cancelled = false;

    async function collectStats() {
      const peer = peerRef.current;
      if (!peer) {
        return;
      }

      try {
        const reports = await peer.getStats();
        if (cancelled) {
          return;
        }
        setReceiverStats(buildInboundVideoStats(reports));
      } catch (error) {
        if (!cancelled) {
          appendRuntimeEvent("Failed to read RTCPeerConnection stats", { error: error.message });
        }
      }
    }

    const refreshVideo = () => setVideoStats(buildVideoStatsSnapshot(videoRef.current));

    collectStats();
    refreshVideo();
    const statsId = setInterval(collectStats, 1500);
    const videoId = setInterval(refreshVideo, 1000);

    return () => {
      cancelled = true;
      clearInterval(statsId);
      clearInterval(videoId);
    };
  }, [active, appendRuntimeEvent]);

  const answerSummary = useMemo(() => {
    const diagnostics = sessionInfo?.answerDiagnostics;
    const videoSection = diagnostics?.mediaSections?.find((section) => section.kind === "video") || parseSdpVideoSection(answerSdp);
    if (!videoSection) {
      return "Answer SDP not available yet.";
    }
    return [
      `video=${videoSection.direction}`,
      `mid=${videoSection.mid || "n/a"}`,
      `candidates=${videoSection.iceCandidates ?? videoSection.candidates ?? 0}`,
      `codecs=${videoSection.codecs.length}`,
      videoSection.trackId ? `track=${videoSection.trackId}` : null,
    ]
      .filter(Boolean)
      .join(" | ");
  }, [answerSdp, sessionInfo]);

  const answerAttemptSummary = useMemo(() => {
    return formatAnswerAttemptSummary(sessionInfo?.answerAttempts);
  }, [sessionInfo]);

  useEffect(() => {
    if (!onDiagnosticsChange) {
      return;
    }

    onDiagnosticsChange({
      bridgeState,
      sessionState,
      sessionMessage,
      sessionInfo,
      logs,
      runtimeEvents,
      videoStats,
      receiverStats,
      answerSdp,
      answerSummary,
      offerSummary,
    });
  }, [
    answerSdp,
    answerSummary,
    bridgeState,
    logs,
    offerSummary,
    onDiagnosticsChange,
    receiverStats,
    runtimeEvents,
    sessionInfo,
    sessionMessage,
    sessionState,
    videoStats,
  ]);

  const handlePointerDown = useCallback((event) => {
    if (!active) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    gestureRef.current = {
      startXRatio: (event.clientX - rect.left) / Math.max(1, rect.width),
      startYRatio: (event.clientY - rect.top) / Math.max(1, rect.height),
      pointerId: event.pointerId,
      startedAt: Date.now(),
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [active]);

  const handlePointerUp = useCallback(async (event) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const endXRatio = (event.clientX - rect.left) / Math.max(1, rect.width);
    const endYRatio = (event.clientY - rect.top) / Math.max(1, rect.height);
    const deltaX = endXRatio - gesture.startXRatio;
    const deltaY = endYRatio - gesture.startYRatio;
    const durationMs = Date.now() - gesture.startedAt;

    try {
      if (Math.abs(deltaX) < 0.015 && Math.abs(deltaY) < 0.015) {
        await sendSessionInput({
          type: "tap",
          xRatio: gesture.startXRatio,
          yRatio: gesture.startYRatio,
        });
      } else {
        await sendSessionInput({
          type: "swipe",
          startXRatio: gesture.startXRatio,
          startYRatio: gesture.startYRatio,
          endXRatio,
          endYRatio,
          durationMs: Math.max(120, durationMs),
        });
      }
    } catch (error) {
      onMessage(`Custom WebRTC input failed: ${error.message}`);
    }
  }, [onMessage, sendSessionInput]);

  return (
    <div
      style={{
        width,
        height,
        borderRadius: 18,
        background: "#05070b",
        color: "#d7dfed",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        border: "1px solid #202634",
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid #202634",
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          fontSize: 12,
        }}
      >
        <span>Custom WebRTC bridge (low latency)</span>
        <span>
          bridge: {bridgeState} | session: {sessionState}
        </span>
      </div>

      <div
        style={{ flex: 1, position: "relative", background: "#000" }}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          onLoadedMetadata={() => setHasVideo(true)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            display: "block",
            background: "#000",
          }}
        />
        {!hasVideo && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                maxWidth: 420,
                padding: 16,
                background: "rgba(10, 12, 18, 0.9)",
                border: "1px solid #3b465b",
                borderRadius: 14,
                fontSize: 12,
                lineHeight: 1.6,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Preparing low-latency stream</div>
              <div>{sessionMessage || "Waiting for custom bridge media..."}</div>
              {notes.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  {notes.map((note) => (
                    <div key={note}>- {note}</div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div
          style={{
            position: "absolute",
            left: 12,
            right: 12,
            bottom: 12,
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              maxWidth: "55%",
              padding: "8px 10px",
              background: "rgba(6, 8, 12, 0.78)",
              borderRadius: 10,
              fontSize: 11,
              color: "#d7dfed",
            }}
          >
            {sessionMessage || "Connecting..."}
          </div>
          <div
            style={{
              minWidth: 180,
              padding: "8px 10px",
              background: "rgba(6, 8, 12, 0.78)",
              borderRadius: 10,
              fontSize: 11,
              color: "#d7dfed",
            }}
          >
            <div>
              frames: {sessionInfo?.media?.framesDelivered ?? 0}
              {sessionInfo?.media?.width && sessionInfo?.media?.height
                ? ` | ${sessionInfo.media.width}x${sessionInfo.media.height}`
                : ""}
            </div>
            {logs[logs.length - 1] && <div>{logs[logs.length - 1].message}</div>}
          </div>
        </div>
      </div>

    </div>
  );
}

function App() {
  const emuRef = useRef(null);
  const wrapRef = useRef(null);
  const browserSectionRef = useRef(null);
  const webrtcInputRef = useRef(null);
  const isResizingRef = useRef(false);
  const isLogResizingRef = useRef(false);

  const [emuState, setEmuState] = useState("connecting");
  const [apiState, setApiState] = useState("checking");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Starting...");
  const [builtPath, setBuiltPath] = useState("");
  const [packageName, setPackageName] = useState("");
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserPath, setBrowserPath] = useState("");
  const [browserData, setBrowserData] = useState({ directories: [], apks: [], cwd: "", parent: null });
  const [logFilter, setLogFilter] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [fatalOnly, setFatalOnly] = useState(false);
  const [logsPaused, setLogsPaused] = useState(false);
  const [logLimit, setLogLimit] = useState(100);
  const [logEntries, setLogEntries] = useState([]);
  const [logPaneHeight, setLogPaneHeight] = useState(260);
  const lastSeenLogRef = useRef(null);
  const [leftPanePercent, setLeftPanePercent] = useState(35);
  const [streamMode, setStreamMode] = useState("webrtc");
  const [webrtcNotice, setWebrtcNotice] = useState("");
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [deviceInfo, setDeviceInfo] = useState(null);
  const [framePreviewTick, setFramePreviewTick] = useState(0);
  const [webrtcDiagnostics, setWebrtcDiagnostics] = useState(null);
  const webrtcFailureRef = useRef(false);

  const handleWebrtcMessage = useCallback((nextMessage) => {
    setMessage(nextMessage);
    setWebrtcNotice(nextMessage);
  }, []);

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    lastSeenLogRef.current = null;
    setLogEntries([]);
  }, [logFilter, errorsOnly, fatalOnly, logLimit]);

  const loadLogs = useCallback(async (forceRefresh = false) => {
    if (logsPaused && !forceRefresh) return;
    try {
      const query = new URLSearchParams({
        limit: String(logLimit),
        filter: logFilter,
        errors_only: errorsOnly ? "1" : "0",
        include_crash: "1",
        fatal_only: fatalOnly ? "1" : "0",
      });
      const data = await parseJsonResponse(await fetch(`/api/logcat?${query.toString()}`), "/api/logcat");
      const incoming = Array.isArray(data.entries) ? data.entries : [];
      const lastSeen = lastSeenLogRef.current;
      let nextEntries = incoming;

      if (lastSeen !== null) {
        const lastSeenIdx = incoming.lastIndexOf(lastSeen);
        nextEntries = lastSeenIdx >= 0 ? incoming.slice(lastSeenIdx + 1) : incoming;
      }

      if (incoming.length > 0) {
        lastSeenLogRef.current = incoming[incoming.length - 1];
      }

      if (nextEntries.length > 0) {
        setLogEntries((prev) => [...prev, ...nextEntries]);
      }
    } catch (error) {
      setMessage(`Log stream error: ${error.message}`);
    }
  }, [errorsOnly, fatalOnly, logFilter, logLimit, logsPaused]);

  useEffect(() => {
    loadLogs();
    const id = setInterval(loadLogs, 2500);
    return () => clearInterval(id);
  }, [loadLogs]);

  useEffect(() => {
    if (logsPaused) {
      loadLogs(true);
    }
  }, [loadLogs, logsPaused, logLimit]);

  useEffect(() => {
    function onMove(event) {
      if (isResizingRef.current) {
        const width = window.innerWidth || 1;
        const next = (event.clientX / width) * 100;
        setLeftPanePercent(Math.max(20, Math.min(60, next)));
      }
      if (isLogResizingRef.current) {
        const viewportHeight = window.innerHeight || 1;
        const maxLogHeight = Math.max(180, Math.round(viewportHeight * 0.65));
        setLogPaneHeight((prev) => {
          const next = prev - event.movementY;
          return Math.max(120, Math.min(maxLogHeight, next));
        });
      }
    }

    function onUp() {
      isResizingRef.current = false;
      isLogResizingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  useEffect(() => {
    async function checkHealth() {
      try {
        const health = await parseJsonResponse(await fetch("/api/health"), "/api/health");
        if (health.ok) {
          setApiState("ready");
          setMessage("Bridge API ready");
        } else {
          setApiState("error");
          setMessage("Bridge API: device not connected");
        }
      } catch (error) {
        setApiState("error");
        setMessage(`Bridge API error: ${error.message}`);
      }
    }
    checkHealth();
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadDeviceInfo() {
      try {
        const info = await parseJsonResponse(await fetch("/api/device-info"), "/api/device-info");
        if (!cancelled) {
          setDeviceInfo(info);
        }
      } catch {
        if (!cancelled) {
          setDeviceInfo(null);
        }
      }
    }

    loadDeviceInfo();
    const id = setInterval(loadDeviceInfo, 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      setFramePreviewTick(Date.now());
    }, 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (streamMode === "webrtc") {
      webrtcFailureRef.current = false;
    }
  }, [streamMode]);

  useEffect(() => {
    if (streamMode !== "webrtc" || webrtcFailureRef.current) {
      return;
    }

    const answerSdp = webrtcDiagnostics?.answerSdp || "";
    const candidateDiagnostics = parseSdpCandidateDiagnostics(answerSdp);
    const packetsReceived = webrtcDiagnostics?.receiverStats?.packetsReceived ?? 0;
    const framesReceived = webrtcDiagnostics?.receiverStats?.framesReceived ?? 0;
    const framesDecoded = webrtcDiagnostics?.receiverStats?.framesDecoded ?? 0;
    const sessionState = webrtcDiagnostics?.sessionInfo?.state || "";
    const peerState = webrtcDiagnostics?.sessionInfo?.peerConnectionState || "";
    const iceState = webrtcDiagnostics?.sessionInfo?.iceConnectionState || "";
    const browserVideoReadyState = Number(webrtcDiagnostics?.videoStats?.readyState ?? 0);
    const hardFailedStates = ["failed", "closed", "expired", "media-failed"];
    const transportFailed =
      hardFailedStates.includes(sessionState) ||
      hardFailedStates.includes(peerState) ||
      hardFailedStates.includes(iceState);
    const hostOnlyFailure =
      candidateDiagnostics.total > 0 &&
      candidateDiagnostics.relay === 0 &&
      candidateDiagnostics.publicHost === 0 &&
      packetsReceived === 0 &&
      framesReceived === 0 &&
      framesDecoded === 0 &&
      browserVideoReadyState < HTMLMediaElement.HAVE_CURRENT_DATA &&
      transportFailed;

    if (!hostOnlyFailure) {
      return;
    }

    webrtcFailureRef.current = true;
    const shownAddresses = candidateDiagnostics.addresses.slice(0, 3).join(", ");
    const failureMessage = [
      "Custom WebRTC failed because the bridge answer only exposed private or loopback ICE candidates",
      shownAddresses ? `(${shownAddresses})` : "",
      "and no relay candidate, so the browser had no reachable media path. If coturn logs show 403 Forbidden IP for a 172.16-31.x, 192.168.x, or 10.x peer, allow that private bridge subnet on the TURN server or fix relay allocation so those host candidates are never used.",
    ]
      .filter(Boolean)
      .join(" ");

    setWebrtcNotice(failureMessage);
    setMessage(failureMessage);
    setEmuState("error");
  }, [streamMode, webrtcDiagnostics]);

  const stateColor = (state) =>
    state === "connected" || state === "ready"
      ? "#3fb950"
      : state === "connecting" || state === "checking" || state === "initializing"
        ? "#d29922"
        : "#f85149";

  async function callApi(path, options = {}) {
    setBusy(true);
    try {
      const data = await parseJsonResponse(await fetch(path, options), path);
      setMessage(data.launch || data.message || JSON.stringify(data));
      return data;
    } catch (error) {
      setMessage(`${path} failed: ${error.message}`);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function sendKey(name) {
    try {
      if (streamMode === "png") {
        emuRef.current?.sendKey?.(name);
        return;
      }

      if (webrtcInputRef.current) {
        await webrtcInputRef.current({ type: "key", key: name });
        setMessage(`Sent ${name} through custom WebRTC bridge`);
        return;
      }

      await callApi("/api/input-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: name }),
      });
    } catch (error) {
      setMessage(`Key send failed: ${error.message}`);
    }
  }

  async function uploadApk(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setMessage(`Installing ${file.name}...`);
    const formData = new FormData();
    formData.append("apk", file);
    formData.append("package", packageName);
    const data = await callApi("/api/install", { method: "POST", body: formData });
    if (data.package) {
      setPackageName(data.package);
      setMessage(`Ready to launch. Installed ${file.name} as ${data.package}`);
    } else {
      setMessage(`Ready to launch. Installed ${file.name}`);
    }
    event.target.value = "";
  }

  async function installBuiltApk(path, initialPackage = "") {
    setMessage(`Installing ${path}...`);
    const data = await callApi("/api/install-built", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relative_path: path, package: initialPackage || packageName }),
    });
    if (data.package) {
      setPackageName(data.package);
      setMessage(`Ready to launch. Installed ${path} as ${data.package}`);
    } else {
      setMessage(`Ready to launch. Installed ${path}`);
    }
  }

  async function launchApp() {
    await callApi("/api/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package: packageName }),
    });
  }

  async function wakeDevice() {
    await callApi("/api/wake", { method: "POST" });
  }

  async function rebootDevice() {
    await callApi("/api/reboot", { method: "POST" });
  }

  async function browse(path = "") {
    try {
      const data = await parseJsonResponse(
        await fetch(`/api/browse-apks?path=${encodeURIComponent(path)}`),
        "/api/browse-apks"
      );
      setBrowserData(data);
      setBrowserPath(data.cwd || "");
      setBrowserOpen(true);
      requestAnimationFrame(() => {
        browserSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } catch (error) {
      setMessage(`Browse error: ${error.message}`);
    }
  }

  async function selectApk(path) {
    setBuiltPath(path);
    setBrowserOpen(false);
    setMessage(`Selected ${path}. Checking package details...`);
    let detectedPackage = "";
    try {
      const details = await parseJsonResponse(
        await fetch(`/api/apk-package?path=${encodeURIComponent(path)}`),
        "/api/apk-package"
      );
      if (details.package) {
        detectedPackage = details.package;
        setPackageName(details.package);
        setMessage(`Selected ${path} (${details.package}). Installing...`);
      }
    } catch (error) {
      setMessage(`Selected ${path}. Package lookup failed: ${error.message}. Installing anyway...`);
    }
    try {
      await installBuiltApk(path, detectedPackage);
    } catch {
      // installBuiltApk already reports the error via message state
    }
  }

  function fullscreen() {
    wrapRef.current?.requestFullscreen?.();
  }

  function reconnect() {
    window.location.reload();
  }

  function handleStreamModeChange(nextMode) {
    if (nextMode === "webrtc") {
      setWebrtcNotice("");
      setEmuState("connecting");
      setMessage("Attempting custom WebRTC session...");
    }
    setStreamMode(nextMode);
  }

  const layout = useMemo(() => {
    const deviceAspect =
      deviceInfo?.screen?.width && deviceInfo?.screen?.height
        ? deviceInfo.screen.width / deviceInfo.screen.height
        : EMULATOR_ASPECT;
    const leftPanel = Math.max(220, Math.round((viewport.width * leftPanePercent) / 100));
    const availableHeight = Math.max(240, viewport.height - 48);
    const availableWidth = Math.max(180, leftPanel - 32);

    let height = availableHeight;
    let width = Math.round(height * deviceAspect);

    if (width > availableWidth) {
      width = availableWidth;
      height = Math.round(width / deviceAspect);
    }

    return { width, height };
  }, [deviceInfo, viewport, leftPanePercent]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
          padding: "8px 10px",
          borderBottom: "1px solid #2b313d",
          background: "#171a21",
          flexShrink: 0,
        }}
      >
        <button onClick={() => sendKey("GoBack")} title="Back" aria-label="Back">Back</button>
        <button onClick={() => sendKey("GoHome")} title="Home" aria-label="Home">Home</button>
        <button onClick={() => sendKey("AppSwitch")} title="Recents" aria-label="Recents">Recents</button>
        <button onClick={wakeDevice} disabled={busy}>Wake</button>
        <button onClick={rebootDevice} disabled={busy}>Reboot</button>
        <button onClick={fullscreen}>Fullscreen</button>
        <button onClick={reconnect}>Reconnect</button>
        <button onClick={() => browse("")}>Browse APKs</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          Stream
          <select value={streamMode} onChange={(event) => handleStreamModeChange(event.target.value)}>
            <option value="webrtc">Custom WebRTC</option>
            <option value="png">PNG</option>
          </select>
        </label>
        <input type="file" accept=".apk,application/vnd.android.package-archive" onChange={uploadApk} disabled={busy} />
        <input
          type="text"
          value={builtPath}
          placeholder="APK path under workspace"
          style={{ width: 200 }}
          readOnly
        />
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}>
        <div
          ref={wrapRef}
          style={{
            width: `${leftPanePercent}%`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 8,
            overflow: "hidden",
            userSelect: "none",
            WebkitUserSelect: "none",
          }}
        >
          <div
            onMouseDown={(event) => event.preventDefault()}
            onDragStart={(event) => event.preventDefault()}
            style={{
              width: layout.width,
              height: layout.height,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              borderRadius: 18,
              background: "#000",
              userSelect: "none",
              WebkitUserSelect: "none",
            }}
          >
            {streamMode === "png" ? (
              <Emulator
                ref={emuRef}
                uri={window.location.origin}
                view="png"
                muted={true}
                width={layout.width}
                height={layout.height}
                onStateChange={(state) => setEmuState(state)}
                onError={(error) => setMessage(`Emulator error: ${String(error)}`)}
              />
            ) : (
              <CustomWebrtcPane
                active={streamMode === "webrtc"}
                width={layout.width}
                height={layout.height}
                onStateChange={setEmuState}
                inputRef={webrtcInputRef}
                onMessage={handleWebrtcMessage}
                onDiagnosticsChange={setWebrtcDiagnostics}
              />
            )}
          </div>
        </div>

        <div
          onMouseDown={() => {
            isResizingRef.current = true;
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
          }}
          style={{
            width: 6,
            cursor: "col-resize",
            background: "#2b313d",
            flexShrink: 0,
          }}
        />

        <div
          style={{
            width: `${100 - leftPanePercent}%`,
            background: "#171a21",
            padding: 14,
            overflow: "auto",
            flexShrink: 0,
          }}
        >
          <div style={{ marginBottom: 12, padding: 12, border: "1px solid #2b313d", borderRadius: 12 }}>
            <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 6 }}>Package name</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                value={packageName}
                onChange={(event) => setPackageName(event.target.value)}
                placeholder="com.example.app"
                style={{ flex: 1 }}
              />
              <button onClick={launchApp} disabled={busy || !packageName}>Launch</button>
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
            <div style={{ flex: 1, padding: 12, border: "1px solid #2b313d", borderRadius: 12 }}>
              <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 6 }}>Emulator state</div>
              <div style={{ color: stateColor(emuState), fontWeight: 600 }}>{emuState}</div>
            </div>
            <div style={{ flex: 1, padding: 12, border: "1px solid #2b313d", borderRadius: 12 }}>
              <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 6 }}>Bridge API</div>
              <div style={{ color: stateColor(apiState), fontWeight: 600 }}>{apiState}</div>
            </div>
          </div>

          <div style={{ marginBottom: 12, padding: 12, border: "1px solid #2b313d", borderRadius: 12 }}>
            <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 6 }}>Last message</div>
            <div style={{ whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: 12 }}>{message}</div>
          </div>

          {webrtcNotice && (
            <div
              style={{
                marginBottom: 12,
                padding: 12,
                border: "1px solid #6b4f1d",
                borderRadius: 12,
                background: "#2a2112",
                color: "#f3d9a4",
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              {webrtcNotice}
            </div>
          )}

          <div style={{ marginBottom: 12, padding: 12, border: "1px solid #2b313d", borderRadius: 12 }}>
            <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 8 }}>Display diagnostics</div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div style={{ flex: "1 1 220px", minWidth: 220 }}>
                <div style={{ fontSize: 12, color: "#d7dfed", marginBottom: 6 }}>
                  Raw ADB frame endpoint: <a href={RAW_FRAME_URL} target="_blank" rel="noreferrer">{RAW_FRAME_URL}</a>
                </div>
                <div style={{ fontSize: 12, color: "#a8b3c7", lineHeight: 1.6 }}>
                  <div>
                    Emulator screen:{" "}
                    {deviceInfo?.screen?.width && deviceInfo?.screen?.height
                      ? `${deviceInfo.screen.width}x${deviceInfo.screen.height}`
                      : "unavailable"}
                  </div>
                  <div>
                    WebRTC frame:{" "}
                    {streamMode === "webrtc"
                      ? webrtcNotice || "waiting for session status"
                      : "switch to Custom WebRTC to compare"}
                  </div>
                  <div>
                    Tip: if the preview below is visible but WebRTC stays black, the bug is in the bridge/render path.
                  </div>
                </div>
              </div>
              <div style={{ width: 160, flexShrink: 0 }}>
                <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 6 }}>Raw screencap preview</div>
                <img
                  src={`${RAW_FRAME_URL}?t=${framePreviewTick}`}
                  alt="Raw emulator frame"
                  style={{
                    width: "100%",
                    aspectRatio: `${deviceInfo?.screen?.width || 1080} / ${deviceInfo?.screen?.height || 1920}`,
                    objectFit: "contain",
                    display: "block",
                    background: "#000",
                    border: "1px solid #2b313d",
                    borderRadius: 10,
                  }}
                />
              </div>
            </div>
          </div>

          {streamMode === "webrtc" && (
            <div style={{ marginBottom: 12, padding: 12, border: "1px solid #2b313d", borderRadius: 12 }}>
              <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 8 }}>Custom WebRTC diagnostics</div>
              <div style={{ fontSize: 12, lineHeight: 1.7, color: "#d7dfed", marginBottom: 10 }}>
                <div>Browser offer: {webrtcDiagnostics?.offerSummary || "Offer not created yet."}</div>
                <div>Bridge answer: {webrtcDiagnostics?.answerSummary || "Answer SDP not available yet."}</div>
                <div>
                  Browser RTP: packets {webrtcDiagnostics?.receiverStats?.packetsReceived ?? 0} | bytes{" "}
                  {webrtcDiagnostics?.receiverStats?.bytesReceived ?? 0} | frames decoded{" "}
                  {webrtcDiagnostics?.receiverStats?.framesDecoded ?? 0}
                </div>
                <div>
                  Browser video: readyState {webrtcDiagnostics?.videoStats?.readyState ?? 0} | currentTime{" "}
                  {webrtcDiagnostics?.videoStats?.currentTime ?? "0.00"} | size{" "}
                  {webrtcDiagnostics?.videoStats?.videoWidth ?? 0}x{webrtcDiagnostics?.videoStats?.videoHeight ?? 0}
                </div>
                <div>
                  Bridge media: frames {webrtcDiagnostics?.sessionInfo?.media?.framesDelivered ?? 0} | first frame{" "}
                  {formatClockTime(webrtcDiagnostics?.sessionInfo?.media?.firstFrameAt)}
                </div>
                <div>
                  Bridge states: session {webrtcDiagnostics?.sessionInfo?.peerConnectionState || "new"} | ice{" "}
                  {webrtcDiagnostics?.sessionInfo?.iceConnectionState || "new"} | gathering{" "}
                  {webrtcDiagnostics?.sessionInfo?.iceGatheringState || "new"}
                </div>
                <div>
                  Bridge TURN policy: requested {webrtcDiagnostics?.sessionInfo?.turnPolicy?.requested || "n/a"} | applied{" "}
                  {webrtcDiagnostics?.sessionInfo?.turnPolicy?.applied || "n/a"} | fallback{" "}
                  {webrtcDiagnostics?.sessionInfo?.relayFallbackUsed ? "yes" : "no"}
                </div>
                <div>
                  Bridge TURN URL strategy: {webrtcDiagnostics?.sessionInfo?.turnUrlStrategy || "n/a"}
                  {webrtcDiagnostics?.sessionInfo?.turnResolution?.resolvedAddresses?.length
                    ? ` | resolved IPs ${webrtcDiagnostics.sessionInfo.turnResolution.resolvedAddresses.join(", ")}`
                    : ""}
                  {webrtcDiagnostics?.sessionInfo?.turnResolution?.bridgeUrl
                    ? ` | bridge URL ${webrtcDiagnostics.sessionInfo.turnResolution.bridgeUrl}`
                    : ""}
                </div>
                {webrtcDiagnostics?.sessionInfo?.turnConnectivity?.bridgeHostProbe && (
                  <div>
                    TURN bridge-host preflight ({webrtcDiagnostics.sessionInfo.turnConnectivity.bridgeHostProbe.host}): tcp{" "}
                    {webrtcDiagnostics.sessionInfo.turnConnectivity.bridgeHostProbe.tcp?.ok
                      ? "ok"
                      : `failed (${webrtcDiagnostics.sessionInfo.turnConnectivity.bridgeHostProbe.tcp?.message || "unknown"})`}
                    {webrtcDiagnostics.sessionInfo.turnConnectivity.bridgeHostProbe.tls
                      ? ` | tls ${formatBridgeTlsStatus(webrtcDiagnostics.sessionInfo.turnConnectivity.bridgeHostProbe.tls)}`
                      : ""}
                  </div>
                )}
                <div>
                  Bridge candidates:{" "}
                  {formatCandidateTypeSummary(webrtcDiagnostics?.sessionInfo?.answerDiagnostics?.candidateTypes)}
                </div>
                <div>
                  Bridge attempts: {Array.isArray(webrtcDiagnostics?.sessionInfo?.answerAttempts) ? webrtcDiagnostics.sessionInfo.answerAttempts.length : 0}
                </div>
                <div>
                  TURN preflight: dns{" "}
                  {webrtcDiagnostics?.sessionInfo?.turnConnectivity?.dns
                    ? webrtcDiagnostics.sessionInfo.turnConnectivity.dns.ok
                      ? "ok"
                      : `failed (${webrtcDiagnostics.sessionInfo.turnConnectivity.dns.message})`
                    : "pending"}{" "}
                  | tcp{" "}
                  {webrtcDiagnostics?.sessionInfo?.turnConnectivity?.tcp
                    ? webrtcDiagnostics.sessionInfo.turnConnectivity.tcp.ok
                      ? "ok"
                      : `failed (${webrtcDiagnostics.sessionInfo.turnConnectivity.tcp.message})`
                    : "pending"}{" "}
                  | tls{" "}
                  {webrtcDiagnostics?.sessionInfo?.turnConnectivity?.tls
                    ? webrtcDiagnostics.sessionInfo.turnConnectivity.tls.skipped
                      ? "skipped"
                      : webrtcDiagnostics.sessionInfo.turnConnectivity.tls.ok
                        ? "ok"
                        : `failed (${webrtcDiagnostics.sessionInfo.turnConnectivity.tls.message})`
                    : "pending"}
                </div>
                <div>
                  TURN failure summary: {webrtcDiagnostics?.sessionInfo?.turnFailureSummary || "none"}
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: "#9db0cc", marginBottom: 6 }}>Runtime events</div>
                  <div
                    style={{
                      maxHeight: 180,
                      overflow: "auto",
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      fontSize: 10,
                      lineHeight: 1.45,
                    }}
                  >
                    {(webrtcDiagnostics?.runtimeEvents || []).length === 0 && (
                      <div style={{ color: "#7e8ba3" }}>Session events will appear here once the browser starts negotiating.</div>
                    )}
                    {(webrtcDiagnostics?.runtimeEvents || []).map((entry) => (
                      <div
                        key={`${entry.at}:${entry.message}`}
                        style={{
                          padding: 8,
                          borderRadius: 10,
                          background: "#0f1218",
                          border: "1px solid #2b313d",
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}
                      >
                        [{formatClockTime(entry.at)}] {entry.message}
                        {entry.details ? ` ${JSON.stringify(entry.details)}` : ""}
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: "#9db0cc", marginBottom: 6 }}>Answer SDP</div>
                  <textarea
                    readOnly
                    value={webrtcDiagnostics?.answerSdp || "Answer SDP will appear here after session creation."}
                    style={{
                      width: "100%",
                      minHeight: 180,
                      resize: "vertical",
                      fontSize: 10,
                      lineHeight: 1.45,
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                      padding: 8,
                      borderRadius: 10,
                      color: "#d7dfed",
                      background: "#0f1218",
                      border: "1px solid #2b313d",
                    }}
                  />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: "#9db0cc", marginBottom: 6 }}>Bridge ICE attempts</div>
                  <textarea
                    readOnly
                    value={formatAnswerAttemptSummary(webrtcDiagnostics?.sessionInfo?.answerAttempts)}
                    style={{
                      width: "100%",
                      minHeight: 180,
                      resize: "vertical",
                      fontSize: 10,
                      lineHeight: 1.45,
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                      padding: 8,
                      borderRadius: 10,
                      color: "#d7dfed",
                      background: "#0f1218",
                      border: "1px solid #2b313d",
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          <div style={{ marginBottom: 12, padding: 12, border: "1px solid #2b313d", borderRadius: 12 }}>
            <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 8 }}>
              Android system logs ({logsPaused ? "paused" : "live"}, last {logLimit})
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
              <input
                type="text"
                value={logFilter}
                onChange={(event) => setLogFilter(event.target.value)}
                placeholder="Filter text (e.g. package name)"
                style={{ flex: 1 }}
              />
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={errorsOnly}
                  onChange={(event) => setErrorsOnly(event.target.checked)}
                />
                Errors only
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={fatalOnly}
                  onChange={(event) => setFatalOnly(event.target.checked)}
                />
                FATAL
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                Rows
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={logLimit}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isNaN(next)) return;
                    setLogLimit(Math.max(1, Math.min(500, next)));
                  }}
                  style={{ width: 72 }}
                />
              </label>
              <button onClick={() => setLogsPaused((prev) => !prev)}>
                {logsPaused ? "Resume logs" : "Pause logs"}
              </button>
              <button
                onClick={() =>
                  setLogEntries((prev) => {
                    if (prev.length > 0) {
                      lastSeenLogRef.current = prev[prev.length - 1];
                    }
                    return [];
                  })
                }
                disabled={logEntries.length === 0}
              >
                Clear
              </button>
            </div>
            <div
              style={{
                fontFamily: "monospace",
                fontSize: 12,
                height: logPaneHeight,
                overflow: "auto",
                background: "#0f1218",
                border: "1px solid #2b313d",
                borderRadius: 8,
                padding: 8,
                whiteSpace: "pre-wrap",
              }}
            >
              {logEntries.length === 0 ? "No log entries." : logEntries.join("\n")}
            </div>
            <div
              onMouseDown={(event) => {
                event.preventDefault();
                isLogResizingRef.current = true;
                document.body.style.cursor = "row-resize";
                document.body.style.userSelect = "none";
              }}
              style={{
                marginTop: 8,
                height: 10,
                cursor: "row-resize",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              title="Drag to resize log window height"
              aria-label="Resize log window"
            >
              <div
                style={{
                  width: 48,
                  height: 4,
                  borderRadius: 999,
                  background: "#3a4355",
                }}
              />
            </div>
          </div>

          {browserOpen && (
            <div ref={browserSectionRef} style={{ padding: 12, border: "1px solid #2b313d", borderRadius: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: "#a8b3c7" }}>
                  Browse /workspace{browserPath ? `/${browserPath}` : ""}
                </div>
                <button onClick={() => setBrowserOpen(false)}>Close</button>
              </div>

              {browserData.parent !== null && (
                <div style={{ marginBottom: 8 }}>
                  <button onClick={() => browse(browserData.parent)}>.. parent</button>
                </div>
              )}

              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 6 }}>Directories</div>
                {browserData.directories.length === 0 ? (
                  <div style={{ fontSize: 12, color: "#999" }}>No subdirectories</div>
                ) : (
                  browserData.directories.map((directory) => (
                    <div key={directory.path} style={{ marginBottom: 6 }}>
                      <button onClick={() => browse(directory.path)} style={{ width: "100%", textAlign: "left" }}>
                        [DIR] {directory.name}
                      </button>
                    </div>
                  ))
                )}
              </div>

              <div>
                <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 6 }}>APK files</div>
                {browserData.apks.length === 0 ? (
                  <div style={{ fontSize: 12, color: "#999" }}>No APKs here</div>
                ) : (
                  browserData.apks.map((apk) => (
                    <div key={apk.path} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                      <button onClick={() => selectApk(apk.path)} style={{ flex: 1, textAlign: "left" }}>
                        [APK] {apk.name}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
