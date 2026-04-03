import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Emulator } from "android-emulator-webrtc/emulator";

const EMULATOR_ASPECT = 1080 / 1920;

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

function mapPeerState(state) {
  switch (state) {
    case "connected":
      return "connected";
    case "connecting":
      return "connecting";
    case "completed":
      return "connected";
    default:
      return "disconnected";
  }
}

function CustomWebrtcPane({ active, width, height, onStateChange, onMessage }) {
  const videoRef = useRef(null);
  const peerRef = useRef(null);
  const sessionRef = useRef(null);
  const eventSourceRef = useRef(null);
  const [bridgeState, setBridgeState] = useState("idle");
  const [sessionState, setSessionState] = useState("idle");
  const [notes, setNotes] = useState([]);

  useEffect(() => {
    if (!active) {
      return undefined;
    }

    let cancelled = false;

    async function start() {
      try {
        setBridgeState("checking");
        setSessionState("initializing");
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

        const peer = new RTCPeerConnection(config.rtcConfiguration || {});
        peerRef.current = peer;
        peer.addTransceiver("video", { direction: "recvonly" });

        peer.ontrack = (event) => {
          if (videoRef.current) {
            videoRef.current.srcObject = event.streams[0];
          }
        };

        peer.onconnectionstatechange = () => {
          const nextState = mapPeerState(peer.connectionState);
          setSessionState(peer.connectionState || "unknown");
          onStateChange(nextState);
        };

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);

        const sessionResp = await fetch("/bridge/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: offer.type,
            sdp: offer.sdp,
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

        if (session.eventStreamUrl) {
          const source = new EventSource(session.eventStreamUrl);
          eventSourceRef.current = source;
          source.addEventListener("status", (event) => {
            try {
              const payload = JSON.parse(event.data);
              if (payload.state) {
                setSessionState(payload.state);
              }
            } catch {
              // ignore malformed status events
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
        setSessionState("answer-applied");
        onMessage("Custom WebRTC session established.");
      } catch (error) {
        if (cancelled) {
          return;
        }
        setBridgeState("error");
        setSessionState("failed");
        onStateChange("disconnected");
        onMessage(`Custom WebRTC bridge: ${error.message}`);
      }
    }

    start();

    return () => {
      cancelled = true;
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
  }, [active, onMessage, onStateChange]);

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
        <span>Custom WebRTC bridge</span>
        <span>
          bridge: {bridgeState} | session: {sessionState}
        </span>
      </div>

      <div style={{ flex: 1, position: "relative", background: "#000" }}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            display: "block",
            background: "#000",
          }}
        />
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
              maxWidth: 360,
              padding: 14,
              background: "rgba(10, 12, 18, 0.88)",
              border: "1px solid #3b465b",
              borderRadius: 14,
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Bridge scaffold active</div>
            <div>
              This fork now uses HTTPS REST plus SSE for signaling. The next step is wiring a real media
              capture pipeline into `bridge-webrtc`.
            </div>
            {notes.length > 0 && (
              <div style={{ marginTop: 10 }}>
                {notes.map((note) => (
                  <div key={note}>- {note}</div>
                ))}
              </div>
            )}
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
  const [streamMode, setStreamMode] = useState("png");
  const [webrtcNotice, setWebrtcNotice] = useState("");
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });

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
    const leftPanel = Math.max(220, Math.round((viewport.width * leftPanePercent) / 100));
    const availableHeight = Math.max(240, viewport.height - 48);
    const availableWidth = Math.max(180, leftPanel - 32);

    let height = availableHeight;
    let width = Math.round(height * EMULATOR_ASPECT);

    if (width > availableWidth) {
      width = availableWidth;
      height = Math.round(width / EMULATOR_ASPECT);
    }

    return { width, height };
  }, [viewport, leftPanePercent]);

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
            <option value="png">PNG</option>
            <option value="webrtc">Custom WebRTC</option>
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
                onMessage={(nextMessage) => {
                  setMessage(nextMessage);
                  setWebrtcNotice(nextMessage);
                }}
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
