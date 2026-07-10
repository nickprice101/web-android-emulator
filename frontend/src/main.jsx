import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

const EMULATOR_ASPECT = 1080 / 2340;
const DISPLAY_DEBUG_UPDATE_INTERVAL_MS = 250;
const GUACAMOLE_HTTP_TARGET_FPS = 30;
const GUACAMOLE_HTTP_BIT_RATE = 6_000_000;
const DEFAULT_GUACAMOLE_HTTP_MAX_SIZE = 720;
const DISPLAY_HTTP_MODE = "display-http";
const PNG_REFRESH_MS = 1000;
const STREAM_QUALITY_OPTIONS = [
  { value: 720, label: "720p" },
  { value: 1080, label: "1080p" },
];
const STREAM_MODE_OPTIONS = [
  { value: DISPLAY_HTTP_MODE, label: "Guacamole HTTP (30fps)" },
  { value: "png", label: "PNG preview" },
];
const DEVICE_PROFILE_OPTIONS = [
  { value: "phone", label: "Phone" },
  { value: "tv", label: "TV" },
];
const STREAM_MODE_VALUES = new Set(STREAM_MODE_OPTIONS.map((option) => option.value));
const STREAM_QUALITY_VALUES = new Set(STREAM_QUALITY_OPTIONS.map((option) => option.value));
const DEVICE_PROFILE_VALUES = new Set(DEVICE_PROFILE_OPTIONS.map((option) => option.value));
const DISPLAY_MP4_MIME_CANDIDATES = [
  'video/mp4; codecs="avc1.42C02A"',
  'video/mp4; codecs="avc1.42C029"',
  'video/mp4; codecs="avc1.42E01E"',
  'video/mp4; codecs="avc1.4D4029"',
  'video/mp4; codecs="avc1.640029"',
  "video/mp4",
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampRatio(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return clamp(value, 0, 1);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveStreamMaxSize(value) {
  const numericValue = Number(value);
  return STREAM_QUALITY_VALUES.has(numericValue) ? numericValue : DEFAULT_GUACAMOLE_HTTP_MAX_SIZE;
}

function resolveDeviceProfile(value) {
  return DEVICE_PROFILE_VALUES.has(value) ? value : "phone";
}

function resolveVideoViewport(container, mediaWidth, mediaHeight, fitMode = "contain") {
  if (!container) {
    return null;
  }

  const rect = container.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  const mediaAspect = mediaWidth > 0 && mediaHeight > 0 ? mediaWidth / mediaHeight : EMULATOR_ASPECT;
  const containerAspect = rect.width / rect.height;
  const shouldCover = fitMode === "cover";

  let renderWidth = rect.width;
  let renderHeight = rect.height;
  if ((containerAspect > mediaAspect && !shouldCover) || (containerAspect <= mediaAspect && shouldCover)) {
    renderHeight = rect.height;
    renderWidth = renderHeight * mediaAspect;
  } else {
    renderWidth = rect.width;
    renderHeight = renderWidth / mediaAspect;
  }

  return {
    rect,
    offsetX: (rect.width - renderWidth) / 2,
    offsetY: (rect.height - renderHeight) / 2,
    renderWidth,
    renderHeight,
  };
}

function resolvePointerRatios(event, container, mediaWidth, mediaHeight, fitMode) {
  const viewport = resolveVideoViewport(container, mediaWidth, mediaHeight, fitMode);
  if (!viewport) {
    return null;
  }

  const x = event.clientX - viewport.rect.left - viewport.offsetX;
  const y = event.clientY - viewport.rect.top - viewport.offsetY;
  if (x < 0 || y < 0 || x > viewport.renderWidth || y > viewport.renderHeight) {
    return null;
  }

  return {
    xRatio: clampRatio(x / Math.max(1, viewport.renderWidth)),
    yRatio: clampRatio(y / Math.max(1, viewport.renderHeight)),
  };
}

function mapKeyboardEventToPayload(event) {
  if (event.altKey || event.metaKey || event.ctrlKey) {
    return null;
  }

  const keyMap = {
    Home: { type: "key", key: "GoHome" },
    Escape: { type: "key", key: "GoBack" },
    Backspace: { type: "key", key: "Backspace" },
    Delete: { type: "key", key: "Delete" },
    Enter: { type: "key", key: "Enter" },
    Tab: { type: "key", key: "Tab" },
    ArrowUp: { type: "key", key: "ArrowUp" },
    ArrowDown: { type: "key", key: "ArrowDown" },
    ArrowLeft: { type: "key", key: "ArrowLeft" },
    ArrowRight: { type: "key", key: "ArrowRight" },
  };

  if (keyMap[event.key]) {
    return keyMap[event.key];
  }
  if (event.key === " " || event.code === "Space") {
    return { type: "key", key: "Space" };
  }
  if (event.key.length === 1) {
    return { type: "text", text: event.key };
  }
  return null;
}

async function readHttpError(response, label) {
  const status = `${response.status} ${response.statusText || ""}`.trim();
  const contentType = response.headers.get("content-type") || "";
  try {
    if (contentType.includes("application/json")) {
      const data = await response.json();
      return data?.error || data?.message || `${label} failed (${status})`;
    }
    const text = await response.text();
    return text.slice(0, 500) || `${label} failed (${status})`;
  } catch {
    return `${label} failed (${status})`;
  }
}

async function parseJsonResponse(response, label) {
  if (!response.ok) {
    throw new Error(await readHttpError(response, label));
  }
  return response.json();
}

async function fetchWithRetry(url, options = {}, retry = {}) {
  const maxAttempts = retry.maxAttempts || 1;
  const baseDelayMs = retry.baseDelayMs || 500;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (retry.isCancelled?.()) {
      throw new DOMException("Request cancelled", "AbortError");
    }
    try {
      const response = await fetch(url, options);
      const retryable = [500, 502, 503, 504].includes(response.status);
      if (response.ok || !retryable || attempt === maxAttempts) {
        return response;
      }
      try {
        await response.body?.cancel();
      } catch {
        // Ignore body cancellation failures between retry attempts.
      }
    } catch (error) {
      if (attempt === maxAttempts || options.signal?.aborted || retry.isCancelled?.()) {
        throw error;
      }
    }
    await delay(baseDelayMs * attempt);
  }
  throw new Error(`${url} failed after ${maxAttempts} attempts`);
}

function selectDisplayMimeType() {
  if (!window.MediaSource || typeof window.MediaSource.isTypeSupported !== "function") {
    return DISPLAY_MP4_MIME_CANDIDATES[0];
  }
  return DISPLAY_MP4_MIME_CANDIDATES.find((candidate) => window.MediaSource.isTypeSupported(candidate)) || "";
}

function appendMediaBuffer(sourceBuffer, chunk) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      sourceBuffer.removeEventListener("updateend", onUpdateEnd);
      sourceBuffer.removeEventListener("error", onError);
    };
    const onUpdateEnd = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("MediaSource append failed"));
    };
    sourceBuffer.addEventListener("updateend", onUpdateEnd, { once: true });
    sourceBuffer.addEventListener("error", onError, { once: true });
    try {
      sourceBuffer.appendBuffer(chunk);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function readMp4BoxType(chunk) {
  if (!chunk || chunk.byteLength < 8) {
    return "waiting";
  }
  const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  return String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]).replace(/[^\x20-\x7e]/g, "?");
}

function buildDisplayDebugSnapshot(video, mediaSource, sourceBuffer) {
  const buffered = [];
  if (video?.buffered) {
    for (let index = 0; index < video.buffered.length; index += 1) {
      buffered.push(`${video.buffered.start(index).toFixed(2)}-${video.buffered.end(index).toFixed(2)}s`);
    }
  }

  return {
    mediaSource: mediaSource?.readyState || "unknown",
    sourceBufferUpdating: Boolean(sourceBuffer?.updating),
    videoReadyState: video?.readyState ?? 0,
    videoNetworkState: video?.networkState ?? 0,
    videoSize: video?.videoWidth && video?.videoHeight ? `${video.videoWidth}x${video.videoHeight}` : "0x0",
    currentTime: Number(video?.currentTime || 0).toFixed(2),
    buffered: buffered.join(", ") || "none",
  };
}

function buildInitialDisplayDebug(maxSize = DEFAULT_GUACAMOLE_HTTP_MAX_SIZE) {
  return {
    bytesReceived: 0,
    chunksReceived: 0,
    chunksAppended: 0,
    firstBox: "waiting",
    lastChunkBytes: 0,
    response: "pending",
    contentType: "pending",
    mimeType: "pending",
    mediaSource: "closed",
    sourceBufferUpdating: false,
    videoReadyState: 0,
    videoNetworkState: 0,
    videoSize: "0x0",
    currentTime: "0.00",
    buffered: "none",
    measuredFps: "0.0",
    totalVideoFrames: 0,
    droppedVideoFrames: 0,
    targetFps: GUACAMOLE_HTTP_TARGET_FPS,
    maxSize,
    lastEvent: "initializing",
    lastError: "none",
  };
}

function stateColor(value) {
  if (value === "connected" || value === "ready") {
    return "#3fb950";
  }
  if (value === "connecting" || value === "checking" || value === "initializing") {
    return "#d29922";
  }
  return "#f85149";
}

function ApiVideoInputSurface({
  containerRef,
  mediaWidth,
  mediaHeight,
  fitMode = "contain",
  onInput,
  onMessage,
  children,
}) {
  const gestureRef = useRef(null);

  const handlePointerDown = useCallback(
    (event) => {
      event.currentTarget.focus?.();
      const ratios = resolvePointerRatios(event, containerRef.current, mediaWidth, mediaHeight, fitMode);
      if (!ratios) return;
      gestureRef.current = { ...ratios, pointerId: event.pointerId, startedAt: Date.now(), moved: false };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [containerRef, fitMode, mediaHeight, mediaWidth]
  );

  const handlePointerMove = useCallback(
    (event) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const ratios = resolvePointerRatios(event, containerRef.current, mediaWidth, mediaHeight, fitMode);
      if (!ratios) return;
      if (Math.abs(ratios.xRatio - gesture.xRatio) >= 0.015 || Math.abs(ratios.yRatio - gesture.yRatio) >= 0.015) {
        gesture.moved = true;
      }
    },
    [containerRef, fitMode, mediaHeight, mediaWidth]
  );

  const clearGesture = useCallback((event) => {
    if (gestureRef.current?.pointerId === event.pointerId) gestureRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  const handlePointerUp = useCallback(
    async (event) => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      if (!gesture) return;
      const end = resolvePointerRatios(event, containerRef.current, mediaWidth, mediaHeight, fitMode);
      if (!end) return;
      try {
        if (!gesture.moved && Math.abs(end.xRatio - gesture.xRatio) < 0.015 && Math.abs(end.yRatio - gesture.yRatio) < 0.015) {
          await onInput({ type: "tap", xRatio: gesture.xRatio, yRatio: gesture.yRatio });
          onMessage?.("Tap delivered through HTTP input");
        } else {
          await onInput({
            type: "swipe",
            startXRatio: gesture.xRatio,
            startYRatio: gesture.yRatio,
            endXRatio: end.xRatio,
            endYRatio: end.yRatio,
            durationMs: Math.max(120, Date.now() - gesture.startedAt),
          });
          onMessage?.("Swipe delivered through HTTP input");
        }
      } catch (error) {
        onMessage?.(`Input failed: ${error.message}`);
      }
    },
    [containerRef, fitMode, mediaHeight, mediaWidth, onInput, onMessage]
  );

  const handleKeyDown = useCallback(
    async (event) => {
      const payload = mapKeyboardEventToPayload(event);
      if (!payload) return;
      event.preventDefault();
      try {
        await onInput(payload);
        onMessage?.(payload.type === "key" ? `Sent ${payload.key} through HTTP input` : "Text delivered through HTTP input");
      } catch (error) {
        onMessage?.(`Input failed: ${error.message}`);
      }
    },
    [onInput, onMessage]
  );

  return (
    <div
      ref={containerRef}
      style={{ flex: 1, minHeight: 0, position: "relative", background: "#000", overflow: "hidden" }}
      tabIndex={0}
      role="application"
      aria-label="Android emulator display"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={clearGesture}
      onLostPointerCapture={clearGesture}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  );
}

function DisplayHttpVideoPane({ width, height, streamMaxSize, onStateChange, onMessage, onDiagnosticsChange, onInput }) {
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const [, setStatus] = useState("connecting");
  const [detail, setDetail] = useState(
    `Opening HTTP tunnel from the emulator X display at ${GUACAMOLE_HTTP_TARGET_FPS}fps / ${streamMaxSize}p...`
  );
  const [hasVideo, setHasVideo] = useState(false);
  const [debug, setDebug] = useState(() => buildInitialDisplayDebug(streamMaxSize));

  useEffect(() => {
    onDiagnosticsChange?.(debug);
  }, [debug, onDiagnosticsChange]);

  useEffect(() => {
    let cancelled = false;
    const abortController = new AbortController();
    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    const video = videoRef.current;
    let sourceBuffer = null;
    let bytesReceived = 0;
    let chunksReceived = 0;
    let chunksAppended = 0;
    let firstBox = "waiting";
    let pendingDebugPatch = null;
    let debugFlushTimer = null;
    let reader = null;
    let frameCallbackId = null;
    let fpsTimer = null;
    let lastPlaybackFrameCount = 0;
    let lastPlaybackFrameTime = performance.now();
    const frameTimes = [];

    setStatus("connecting");
    setHasVideo(false);
    setDetail(`Opening HTTP tunnel from the emulator X display at ${GUACAMOLE_HTTP_TARGET_FPS}fps / ${streamMaxSize}p...`);
    setDebug(buildInitialDisplayDebug(streamMaxSize));

    const flushDebug = () => {
      if (debugFlushTimer) {
        clearTimeout(debugFlushTimer);
        debugFlushTimer = null;
      }
      if (cancelled || !pendingDebugPatch) {
        return;
      }
      const patch = pendingDebugPatch;
      pendingDebugPatch = null;
      setDebug((current) => ({
        ...current,
        ...buildDisplayDebugSnapshot(video, mediaSource, sourceBuffer),
        ...patch,
      }));
    };

    const updateDebug = (patch = {}, { immediate = false } = {}) => {
      if (cancelled) return;
      pendingDebugPatch = {
        ...(pendingDebugPatch || {}),
        ...patch,
      };
      if (immediate) {
        flushDebug();
        return;
      }
      if (!debugFlushTimer) {
        debugFlushTimer = setTimeout(flushDebug, DISPLAY_DEBUG_UPDATE_INTERVAL_MS);
      }
    };

    const updatePlaybackQualityDebug = (measuredFps) => {
      const playbackQuality =
        typeof video?.getVideoPlaybackQuality === "function" ? video.getVideoPlaybackQuality() : null;
      updateDebug({
        measuredFps: Number.isFinite(measuredFps) ? measuredFps.toFixed(1) : "0.0",
        totalVideoFrames: playbackQuality?.totalVideoFrames ?? 0,
        droppedVideoFrames: playbackQuality?.droppedVideoFrames ?? 0,
        targetFps: GUACAMOLE_HTTP_TARGET_FPS,
        maxSize: streamMaxSize,
      });
    };

    const trackVideoFrame = (now) => {
      frameTimes.push(now);
      while (frameTimes.length && now - frameTimes[0] > 1000) {
        frameTimes.shift();
      }

      const elapsed = frameTimes.length > 1 ? frameTimes[frameTimes.length - 1] - frameTimes[0] : 0;
      const measuredFps = elapsed > 0 ? ((frameTimes.length - 1) * 1000) / elapsed : 0;
      updatePlaybackQualityDebug(measuredFps);

      if (!cancelled && typeof video?.requestVideoFrameCallback === "function") {
        frameCallbackId = video.requestVideoFrameCallback(trackVideoFrame);
      }
    };

    const startFpsTracking = () => {
      if (!video) {
        return;
      }
      if (typeof video.requestVideoFrameCallback === "function") {
        frameCallbackId = video.requestVideoFrameCallback(trackVideoFrame);
        return;
      }

      fpsTimer = setInterval(() => {
        const playbackQuality =
          typeof video.getVideoPlaybackQuality === "function" ? video.getVideoPlaybackQuality() : null;
        const now = performance.now();
        const totalFrames = playbackQuality?.totalVideoFrames ?? 0;
        const elapsed = now - lastPlaybackFrameTime;
        const measuredFps = elapsed > 0 ? ((totalFrames - lastPlaybackFrameCount) * 1000) / elapsed : 0;
        lastPlaybackFrameCount = totalFrames;
        lastPlaybackFrameTime = now;
        updatePlaybackQualityDebug(measuredFps);
      }, 500);
    };

    const recordVideoEvent = (event) => {
      if (event.type === "loadeddata" || event.type === "playing") {
        setHasVideo(true);
      }
      updateDebug({ lastEvent: `video:${event.type}` }, { immediate: event.type === "error" });
    };
    const recordVideoError = () => {
      updateDebug(
        {
          lastEvent: "video:error",
          lastError: video?.error?.message || `media error ${video?.error?.code || "unknown"}`,
        },
        { immediate: true }
      );
    };

    if (video) {
      video.src = objectUrl;
      video.addEventListener("loadedmetadata", recordVideoEvent);
      video.addEventListener("loadeddata", recordVideoEvent);
      video.addEventListener("canplay", recordVideoEvent);
      video.addEventListener("playing", recordVideoEvent);
      video.addEventListener("stalled", recordVideoEvent);
      video.addEventListener("waiting", recordVideoEvent);
      video.addEventListener("error", recordVideoError);
    }

    async function start() {
      try {
        if (!window.MediaSource) {
          throw new Error("MediaSource is not available in this browser");
        }
        await new Promise((resolve, reject) => {
          mediaSource.addEventListener("sourceopen", resolve, { once: true });
          mediaSource.addEventListener("error", () => reject(new Error("MediaSource failed to open")), { once: true });
        });
        if (cancelled) return;

        const mimeType = selectDisplayMimeType();
        if (!mimeType) {
          throw new Error("No supported MP4/H.264 MediaSource type was found");
        }
        sourceBuffer = mediaSource.addSourceBuffer(mimeType);
        sourceBuffer.mode = "segments";
        updateDebug({ lastEvent: "mediasource:open", mimeType }, { immediate: true });

        const params = new URLSearchParams({
          cache: String(Date.now()),
          max_fps: String(GUACAMOLE_HTTP_TARGET_FPS),
          bit_rate: String(GUACAMOLE_HTTP_BIT_RATE),
          max_size: String(streamMaxSize),
        });
        const response = await fetchWithRetry(
          `/api/display-video?${params.toString()}`,
          {
            signal: abortController.signal,
            headers: { Accept: "video/mp4" },
          },
          {
            maxAttempts: 5,
            baseDelayMs: 1000,
            isCancelled: () => cancelled || abortController.signal.aborted,
          }
        );
        updateDebug(
          {
            response: `${response.status} ${response.statusText || ""}`.trim(),
            contentType: response.headers.get("content-type") || "missing",
            lastEvent: "fetch:headers",
          },
          { immediate: true }
        );
        if (!response.ok) {
          throw new Error(await readHttpError(response, "/api/display-video"));
        }
        if (!response.body) {
          throw new Error("display video stream returned no readable body");
        }

        setStatus("streaming");
        setDetail(`Receiving fragmented MP4 over HTTP from FFmpeg X display capture at ${GUACAMOLE_HTTP_TARGET_FPS}fps / ${streamMaxSize}p.`);
        onStateChange?.("connected");
        onMessage?.("Connected to Guacamole-style HTTP video tunnel");
        reader = response.body.getReader();
        startFpsTracking();

        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value?.byteLength) continue;

          chunksReceived += 1;
          bytesReceived += value.byteLength;
          if (firstBox === "waiting") {
            firstBox = readMp4BoxType(value);
          }
          updateDebug({
            bytesReceived,
            chunksReceived,
            firstBox,
            lastChunkBytes: value.byteLength,
            lastEvent: "fetch:chunk",
          });

          await appendMediaBuffer(sourceBuffer, value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
          chunksAppended += 1;

          if (video) {
            if (video.paused) {
              video.play().catch((error) => {
                updateDebug({ lastError: error.message || "video play failed" });
              });
            }
            const buffered = video.buffered;
            if (buffered?.length) {
              const end = buffered.end(buffered.length - 1);
              if (end - video.currentTime > 0.8) {
                video.currentTime = Math.max(0, end - 0.25);
              }
            }
          }
          updateDebug({ chunksAppended, lastEvent: "mediasource:append" });
        }
      } catch (error) {
        if (!cancelled && error.name !== "AbortError") {
          setStatus("error");
          setDetail(error.message);
          updateDebug({ lastEvent: "error", lastError: error.message }, { immediate: true });
          onStateChange?.("error");
          onMessage?.(`Display HTTP video failed: ${error.message}`);
        }
      }
    }

    start();
    return () => {
      cancelled = true;
      if (reader) {
        reader.cancel().catch(() => {
          // The fetch may already be aborted or closed.
        });
      }
      abortController.abort();
      if (debugFlushTimer) {
        clearTimeout(debugFlushTimer);
      }
      if (fpsTimer) {
        clearInterval(fpsTimer);
      }
      if (video) {
        if (frameCallbackId !== null && typeof video.cancelVideoFrameCallback === "function") {
          video.cancelVideoFrameCallback(frameCallbackId);
        }
        video.removeEventListener("loadedmetadata", recordVideoEvent);
        video.removeEventListener("loadeddata", recordVideoEvent);
        video.removeEventListener("canplay", recordVideoEvent);
        video.removeEventListener("playing", recordVideoEvent);
        video.removeEventListener("stalled", recordVideoEvent);
        video.removeEventListener("waiting", recordVideoEvent);
        video.removeEventListener("error", recordVideoError);
        video.removeAttribute("src");
      }
      URL.revokeObjectURL(objectUrl);
    };
  }, [onMessage, onStateChange, streamMaxSize]);

  const inlineDebugSummary = `${formatBytes(debug.bytesReceived)} / ${debug.chunksReceived} chunks`;

  return (
    <div
      aria-description={inlineDebugSummary}
      style={{ width, height, color: "#d7dfed", overflow: "hidden", display: "flex", flexDirection: "column" }}
    >
      <ApiVideoInputSurface
        containerRef={containerRef}
        mediaWidth={videoRef.current?.videoWidth || width}
        mediaHeight={videoRef.current?.videoHeight || height}
        fitMode="cover"
        onInput={onInput}
        onMessage={onMessage}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", background: "#000" }}
        />
        {!hasVideo && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
            <div style={{ maxWidth: 420, padding: 16, background: "rgba(10, 12, 18, 0.9)", border: "1px solid #3b465b", borderRadius: 8, fontSize: 13, lineHeight: 1.5 }}>
              <strong>Guacamole-style HTTP video</strong>
              <div style={{ marginTop: 8 }}>{detail}</div>
            </div>
          </div>
        )}
      </ApiVideoInputSurface>
    </div>
  );
}

function PngPreviewPane({ width, height, deviceInfo, onStateChange, onMessage, onInput }) {
  const containerRef = useRef(null);
  const [src, setSrc] = useState(`/api/frame?cache=${Date.now()}`);
  const [hasImage, setHasImage] = useState(false);
  const screen = deviceInfo?.screen || null;

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (!cancelled) {
        setSrc(`/api/frame?cache=${Date.now()}`);
      }
    };
    refresh();
    const timer = setInterval(refresh, PNG_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div style={{ width, height, color: "#d7dfed", overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <ApiVideoInputSurface
        containerRef={containerRef}
        mediaWidth={screen?.width || width}
        mediaHeight={screen?.height || height}
        fitMode="cover"
        onInput={onInput}
        onMessage={onMessage}
      >
        <img
          src={src}
          alt="Android emulator screen"
          draggable={false}
          onLoad={() => {
            setHasImage(true);
            onStateChange?.("connected");
          }}
          onError={() => {
            setHasImage(false);
            onStateChange?.("error");
            onMessage?.("PNG preview failed to fetch /api/frame");
          }}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", background: "#000", userSelect: "none" }}
        />
        {!hasImage && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
            <div style={{ maxWidth: 360, padding: 16, background: "rgba(10, 12, 18, 0.9)", border: "1px solid #3b465b", borderRadius: 8, fontSize: 13 }}>
              Waiting for PNG frame...
            </div>
          </div>
        )}
      </ApiVideoInputSurface>
    </div>
  );
}

function App() {
  const displaySurfaceRef = useRef(null);
  const browserSectionRef = useRef(null);
  const isResizingRef = useRef(false);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [displayPercent, setDisplayPercent] = useState(64);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Connecting to Guacamole-style HTTP video tunnel...");
  const [packageName, setPackageName] = useState("");
  const [apkPath, setApkPath] = useState("");
  const [emuState, setEmuState] = useState("connecting");
  const [bridgeState, setBridgeState] = useState("checking");
  const [deviceInfo, setDeviceInfo] = useState(null);
  const [deviceProfile, setDeviceProfile] = useState("phone");
  const [streamMode, setStreamMode] = useState(DISPLAY_HTTP_MODE);
  const [streamMaxSize, setStreamMaxSize] = useState(DEFAULT_GUACAMOLE_HTTP_MAX_SIZE);
  const [displayDiagnostics, setDisplayDiagnostics] = useState(null);
  const [logs, setLogs] = useState([]);
  const [logFilter, setLogFilter] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [fatalOnly, setFatalOnly] = useState(false);
  const [logsPaused, setLogsPaused] = useState(false);
  const [logRows, setLogRows] = useState(100);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserPath, setBrowserPath] = useState("");
  const [browserData, setBrowserData] = useState(null);

  useEffect(() => {
    const handleResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!isResizingRef.current) return;
      setDisplayPercent(clamp((event.clientX / Math.max(1, window.innerWidth)) * 100, 38, 82));
    };
    const handleMouseUp = () => {
      isResizingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  useEffect(() => {
    window.__EMU_E2E__ = {
      activeTransport: streamMode,
      displayDiagnostics,
      emulatorState: emuState,
      bridgeApiState: bridgeState,
      deviceInfo,
      deviceProfile,
      streamMaxSize,
    };
  }, [bridgeState, deviceInfo, deviceProfile, emuState, displayDiagnostics, streamMaxSize, streamMode]);

  useEffect(() => {
    let cancelled = false;
    async function checkHealth() {
      try {
        const data = await parseJsonResponse(await fetch("/api/health"), "/api/health");
        if (cancelled) return;
        setBridgeState(data.ok ? "ready" : "error");
      } catch {
        if (!cancelled) {
          setBridgeState("error");
        }
      }
    }
    checkHealth();
    const timer = setInterval(checkHealth, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadDeviceInfo() {
      try {
        const data = await parseJsonResponse(await fetch("/api/device-info"), "/api/device-info");
        if (!cancelled) {
          setDeviceInfo(data);
          setDeviceProfile(resolveDeviceProfile(data.device_profile?.id));
        }
      } catch {
        if (!cancelled) {
          setDeviceInfo(null);
        }
      }
    }
    loadDeviceInfo();
    const timer = setInterval(loadDeviceInfo, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (logsPaused) return undefined;
    let cancelled = false;
    async function loadLogs() {
      const params = new URLSearchParams({
        limit: String(logRows),
        filter: logFilter,
        errors_only: errorsOnly ? "1" : "0",
        fatal_only: fatalOnly ? "1" : "0",
      });
      try {
        const data = await parseJsonResponse(await fetch(`/api/logcat?${params.toString()}`), "/api/logcat");
        if (!cancelled) {
          setLogs(data.entries || []);
        }
      } catch (error) {
        if (!cancelled) {
          setLogs([`Log stream error: ${error.message}`]);
        }
      }
    }
    loadLogs();
    const timer = setInterval(loadLogs, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [errorsOnly, fatalOnly, logFilter, logRows, logsPaused]);

  const sendInput = useCallback(async (payload) => {
    const response = await fetch("/api/input-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(await readHttpError(response, "/api/input-event"));
    }
  }, []);

  async function executeApi(url, options = {}) {
    setBusy(true);
    try {
      const data = await parseJsonResponse(await fetch(url, options), url);
      setMessage(data.launch || data.message || JSON.stringify(data));
      return data;
    } catch (error) {
      setMessage(`${url} failed: ${error.message}`);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function sendKey(name) {
    try {
      await sendInput({ type: "key", key: name });
      setMessage(`Sent ${name} through Guacamole-style HTTP input`);
    } catch (error) {
      setMessage(`Key send failed: ${error.message}`);
    }
  }

  async function uploadApk(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setMessage(`Installing ${file.name}...`);
    const form = new FormData();
    form.append("apk", file);
    form.append("package", packageName);
    const data = await executeApi("/api/install", { method: "POST", body: form });
    if (data.package) {
      setPackageName(data.package);
      setMessage(`Ready to launch. Installed ${file.name} as ${data.package}`);
    } else {
      setMessage(`Ready to launch. Installed ${file.name}`);
    }
    event.target.value = "";
  }

  async function installBuilt(relativePath, packageHint = "") {
    setMessage(`Installing ${relativePath}...`);
    const data = await executeApi("/api/install-built", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relative_path: relativePath, package: packageHint || packageName }),
    });
    if (data.package) {
      setPackageName(data.package);
      setMessage(`Ready to launch. Installed ${relativePath} as ${data.package}`);
    } else {
      setMessage(`Ready to launch. Installed ${relativePath}`);
    }
  }

  async function launchPackage() {
    await executeApi("/api/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package: packageName }),
    });
  }

  async function wakeDevice() {
    await executeApi("/api/wake", { method: "POST" });
  }

  async function rebootDevice() {
    await executeApi("/api/reboot", { method: "POST" });
  }

  async function browse(path = "") {
    try {
      const data = await parseJsonResponse(await fetch(`/api/browse-apks?path=${encodeURIComponent(path)}`), "/api/browse-apks");
      setBrowserData(data);
      setBrowserPath(data.cwd || "");
      setBrowserOpen(true);
      requestAnimationFrame(() => browserSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (error) {
      setMessage(`Browse error: ${error.message}`);
    }
  }

  async function selectApk(path) {
    setApkPath(path);
    setBrowserOpen(false);
    setMessage(`Selected ${path}. Checking package details...`);
    let detectedPackage = "";
    try {
      const data = await parseJsonResponse(await fetch(`/api/apk-package?path=${encodeURIComponent(path)}`), "/api/apk-package");
      if (data.package) {
        detectedPackage = data.package;
        setPackageName(data.package);
        setMessage(`Selected ${path} (${data.package}). Installing...`);
      }
    } catch (error) {
      setMessage(`Selected ${path}. Package lookup failed: ${error.message}. Installing anyway...`);
    }
    await installBuilt(path, detectedPackage);
  }

  function fullscreen() {
    displaySurfaceRef.current?.requestFullscreen?.();
  }

  function reconnect() {
    window.location.reload();
  }

  function handleStreamModeChange(nextMode) {
    const resolvedMode = STREAM_MODE_VALUES.has(nextMode) ? nextMode : DISPLAY_HTTP_MODE;
    setDisplayDiagnostics(null);
    setEmuState("connecting");
    setMessage(resolvedMode === DISPLAY_HTTP_MODE ? "Connecting to Guacamole-style HTTP video tunnel..." : "Switching to PNG preview mode...");
    setStreamMode(resolvedMode);
  }

  function handleStreamQualityChange(nextMaxSize) {
    const resolvedMaxSize = resolveStreamMaxSize(nextMaxSize);
    setDisplayDiagnostics(null);
    setEmuState("connecting");
    setMessage(`Switching HTTP video to ${resolvedMaxSize}p at ${GUACAMOLE_HTTP_TARGET_FPS}fps...`);
    setStreamMaxSize(resolvedMaxSize);
  }

  async function handleDeviceProfileChange(nextProfile) {
    const resolvedProfile = resolveDeviceProfile(nextProfile);
    const selectedOption = DEVICE_PROFILE_OPTIONS.find((option) => option.value === resolvedProfile);
    setDeviceProfile(resolvedProfile);
    setDisplayDiagnostics(null);
    setEmuState("connecting");
    setMessage(`Switching emulator test profile to ${selectedOption?.label || resolvedProfile}...`);
    try {
      const data = await executeApi("/api/device-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: resolvedProfile }),
      });
      if (data.active) {
        setDeviceProfile(resolveDeviceProfile(data.active.id));
        setDeviceInfo((current) => ({
          ...(current || {}),
          screen: data.active.screen,
          device_profile: data.active,
          device_profiles: data.profiles || current?.device_profiles || DEVICE_PROFILE_OPTIONS,
        }));
      }
    } catch {
      setDeviceProfile(resolveDeviceProfile(deviceInfo?.device_profile?.id));
      setEmuState("error");
    }
  }

  const displaySize = useMemo(() => {
    const screen = deviceInfo?.screen || {};
    const aspect = screen.width && screen.height ? screen.width / screen.height : EMULATOR_ASPECT;
    const maxWidth = Math.max(220, Math.round((viewport.width * displayPercent) / 100) - 32);
    const maxHeight = Math.max(240, viewport.height - 64);
    let displayHeight = maxHeight;
    let displayWidth = Math.round(displayHeight * aspect);
    if (displayWidth > maxWidth) {
      displayWidth = maxWidth;
      displayHeight = Math.round(displayWidth / aspect);
    }
    return {
      width: Math.max(180, displayWidth),
      height: Math.max(240, displayHeight),
    };
  }, [deviceInfo, displayPercent, viewport]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden", background: "#11141a", color: "#d7dfed", fontFamily: "Segoe UI, Arial, sans-serif" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "8px 10px", borderBottom: "1px solid #2b313d", background: "#171a21", flexShrink: 0 }}>
        <button onClick={() => sendKey("GoBack")} title="Back" aria-label="Back">Back</button>
        <button onClick={() => sendKey("GoHome")} title="Home" aria-label="Home">Home</button>
        <button onClick={() => sendKey("AppSwitch")} title="Recents" aria-label="Recents">Recents</button>
        <button onClick={wakeDevice} disabled={busy}>Wake</button>
        <button onClick={rebootDevice} disabled={busy}>Reboot</button>
        <button onClick={fullscreen}>Fullscreen</button>
        <button onClick={reconnect}>Reconnect</button>
        <button onClick={() => browse("")}>Browse APKs</button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          Device
          <select value={deviceProfile} onChange={(event) => handleDeviceProfileChange(event.target.value)} disabled={busy}>
            {DEVICE_PROFILE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          Stream
          <select value={streamMode} onChange={(event) => handleStreamModeChange(event.target.value)}>
            {STREAM_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          Quality
          <select
            value={streamMaxSize}
            onChange={(event) => handleStreamQualityChange(event.target.value)}
            disabled={streamMode !== DISPLAY_HTTP_MODE}
          >
            {STREAM_QUALITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <input type="file" accept=".apk,application/vnd.android.package-archive" onChange={uploadApk} disabled={busy} />
        <input type="text" value={apkPath} placeholder="APK path under workspace" style={{ width: 200 }} readOnly />
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}>
        <div ref={displaySurfaceRef} style={{ width: `${displayPercent}%`, display: "flex", alignItems: "center", justifyContent: "center", padding: 8, overflow: "hidden", userSelect: "none" }}>
          {streamMode === DISPLAY_HTTP_MODE ? (
            <DisplayHttpVideoPane
              width={displaySize.width}
              height={displaySize.height}
              streamMaxSize={streamMaxSize}
              onStateChange={setEmuState}
              onMessage={setMessage}
              onDiagnosticsChange={setDisplayDiagnostics}
              onInput={sendInput}
            />
          ) : (
            <PngPreviewPane
              width={displaySize.width}
              height={displaySize.height}
              deviceInfo={deviceInfo}
              onStateChange={setEmuState}
              onMessage={setMessage}
              onInput={sendInput}
            />
          )}
        </div>

        <div
          onMouseDown={() => {
            isResizingRef.current = true;
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
          }}
          style={{ width: 6, cursor: "col-resize", background: "#2b313d", flexShrink: 0 }}
        />

        <div style={{ width: `${100 - displayPercent}%`, background: "#171a21", padding: 14, overflow: "auto", flexShrink: 0 }}>
          <div style={{ marginBottom: 12, padding: 12, border: "1px solid #2b313d", borderRadius: 8 }}>
            <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 6 }}>Package name</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input type="text" value={packageName} onChange={(event) => setPackageName(event.target.value)} placeholder="com.example.app" style={{ flex: 1 }} />
              <button onClick={launchPackage} disabled={busy || !packageName}>Launch</button>
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
            <div style={{ flex: 1, padding: 12, border: "1px solid #2b313d", borderRadius: 8 }}>
              <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 6 }}>Emulator state</div>
              <div data-testid="emulator-state-value" style={{ color: stateColor(emuState), fontWeight: 600 }}>{emuState}</div>
            </div>
            <div style={{ flex: 1, padding: 12, border: "1px solid #2b313d", borderRadius: 8 }}>
              <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 6 }}>Bridge API</div>
              <div data-testid="bridge-api-state-value" style={{ color: stateColor(bridgeState), fontWeight: 600 }}>{bridgeState}</div>
            </div>
          </div>

          <div style={{ marginBottom: 12, padding: 12, border: "1px solid #2b313d", borderRadius: 8 }}>
            <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 6 }}>Last message</div>
            <div data-testid="last-message" style={{ whiteSpace: "pre-wrap", fontFamily: "Consolas, monospace", fontSize: 12 }}>{message}</div>
          </div>

          <div style={{ marginBottom: 12, padding: 12, border: "1px solid #2b313d", borderRadius: 8 }}>
            <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 8 }}>Display diagnostics</div>
            <div style={{ fontSize: 12, color: "#a8b3c7", lineHeight: 1.6 }}>
              <div>Device profile: {deviceInfo?.device_profile?.label || DEVICE_PROFILE_OPTIONS.find((option) => option.value === deviceProfile)?.label || "Phone"}</div>
              <div>Emulator screen: {deviceInfo?.screen?.width && deviceInfo?.screen?.height ? `${deviceInfo.screen.width}x${deviceInfo.screen.height}` : "unavailable"}</div>
              <div>Video frame: {streamMode === DISPLAY_HTTP_MODE ? `FFmpeg X display MP4 over ordinary HTTP fetch (${GUACAMOLE_HTTP_TARGET_FPS}fps target, ${streamMaxSize}p)` : "PNG preview over the emulator HTTP endpoint"}</div>
              <div>Input path: keyboard, mouse, and touch events are posted through /api/input-event</div>
            </div>
          </div>

          {streamMode === DISPLAY_HTTP_MODE && (
            <div data-testid="display-http-diagnostics" style={{ marginBottom: 12, padding: 12, border: "1px solid #2b313d", borderRadius: 8 }}>
              <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 8 }}>FFmpeg X display diagnostics</div>
              <pre
                aria-label="display HTTP video debug overlay"
                style={{ margin: 0, padding: 10, background: "#0f1218", border: "1px solid #2b313d", borderRadius: 8, whiteSpace: "pre-wrap", userSelect: "text", fontFamily: "Consolas, monospace", fontSize: 11, lineHeight: 1.5, maxHeight: 260, overflow: "auto" }}
              >
                {[
                  `http: ${displayDiagnostics?.response || "pending"}`,
                  `content-type: ${displayDiagnostics?.contentType || "pending"}`,
                  `mime: ${displayDiagnostics?.mimeType || "pending"}`,
                  `stream: ${formatBytes(displayDiagnostics?.bytesReceived || 0)} / ${displayDiagnostics?.chunksReceived || 0} chunks`,
                  `target: ${displayDiagnostics?.targetFps || GUACAMOLE_HTTP_TARGET_FPS}fps / ${displayDiagnostics?.maxSize || streamMaxSize}p`,
                  `current fps: ${displayDiagnostics?.measuredFps || "0.0"}`,
                  `first box: ${displayDiagnostics?.firstBox || "waiting"}`,
                  `last chunk: ${formatBytes(displayDiagnostics?.lastChunkBytes || 0)}`,
                  `mse: ${displayDiagnostics?.mediaSource || "unknown"} / appended ${displayDiagnostics?.chunksAppended || 0}`,
                  `source buffer updating: ${String(Boolean(displayDiagnostics?.sourceBufferUpdating))}`,
                  `video: ready ${displayDiagnostics?.videoReadyState ?? 0}, net ${displayDiagnostics?.videoNetworkState ?? 0}, ${displayDiagnostics?.videoSize || "0x0"}`,
                  `frames: total ${displayDiagnostics?.totalVideoFrames ?? 0}, dropped ${displayDiagnostics?.droppedVideoFrames ?? 0}`,
                  `time: ${displayDiagnostics?.currentTime || "0.00"}s`,
                  `buffered: ${displayDiagnostics?.buffered || "none"}`,
                  `last event: ${displayDiagnostics?.lastEvent || "initializing"}`,
                  `error: ${displayDiagnostics?.lastError || "none"}`,
                ].join("\n")}
              </pre>
            </div>
          )}

          <div style={{ marginBottom: 12, padding: 12, border: "1px solid #2b313d", borderRadius: 8 }}>
            <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 8 }}>Android system logs ({logsPaused ? "paused" : "live"}, last {logRows})</div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
              <input type="text" value={logFilter} onChange={(event) => setLogFilter(event.target.value)} placeholder="Filter text (e.g. package name)" style={{ flex: 1, minWidth: 180 }} />
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                <input type="checkbox" checked={errorsOnly} onChange={(event) => setErrorsOnly(event.target.checked)} />
                Errors only
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                <input type="checkbox" checked={fatalOnly} onChange={(event) => setFatalOnly(event.target.checked)} />
                FATAL
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                Rows
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={logRows}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isNaN(value)) setLogRows(clamp(value, 1, 500));
                  }}
                  style={{ width: 72 }}
                />
              </label>
              <button onClick={() => setLogsPaused((value) => !value)}>{logsPaused ? "Resume logs" : "Pause logs"}</button>
              <button onClick={() => setLogs([])} disabled={logs.length === 0}>Clear</button>
            </div>
            <div style={{ fontFamily: "Consolas, monospace", fontSize: 12, height: 260, overflow: "auto", background: "#0f1218", border: "1px solid #2b313d", borderRadius: 8, padding: 8, whiteSpace: "pre-wrap" }}>
              {logs.length === 0 ? "No log entries." : logs.join("\n")}
            </div>
          </div>

          {browserOpen && (
            <div ref={browserSectionRef} style={{ padding: 12, border: "1px solid #2b313d", borderRadius: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <strong>Browse /workspace{browserPath ? `/${browserPath}` : ""}</strong>
                <button onClick={() => setBrowserOpen(false)}>Close</button>
              </div>
              {browserData?.parent !== null && (
                <button onClick={() => browse(browserData?.parent || "")} style={{ marginBottom: 10 }}>.. parent</button>
              )}
              <div style={{ display: "grid", gap: 10 }}>
                <div>
                  <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 6 }}>Directories</div>
                  {browserData?.directories?.length === 0 ? (
                    <div style={{ color: "#8b949e", fontSize: 12 }}>No directories.</div>
                  ) : (
                    browserData?.directories?.map((directory) => (
                      <button key={directory.path} onClick={() => browse(directory.path)} style={{ width: "100%", textAlign: "left", marginBottom: 4 }}>
                        {directory.name}/
                      </button>
                    ))
                  )}
                </div>
                <div>
                  <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 6 }}>APKs</div>
                  {browserData?.apks?.length === 0 ? (
                    <div style={{ color: "#8b949e", fontSize: 12 }}>No APKs.</div>
                  ) : (
                    browserData?.apks?.map((apk) => (
                      <button key={apk.path} onClick={() => selectApk(apk.path)} style={{ width: "100%", textAlign: "left", marginBottom: 4 }}>
                        {apk.name}
                      </button>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
