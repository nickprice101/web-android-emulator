import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Emulator } from "android-emulator-webrtc/emulator";

const EMULATOR_ASPECT = 1080 / 1920;

function App() {
  const emuRef = useRef(null);
  const wrapRef = useRef(null);
  const isResizingRef = useRef(false);

  const [emuState, setEmuState] = useState("connecting");
  const [apiState, setApiState] = useState("checking");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Starting…");
  const [builtPath, setBuiltPath] = useState("");
  const [packageName, setPackageName] = useState("");
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserPath, setBrowserPath] = useState("");
  const [browserData, setBrowserData] = useState({ directories: [], apks: [], cwd: "", parent: null });
  const [logFilter, setLogFilter] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [includeCrashBuffer, setIncludeCrashBuffer] = useState(true);
  const [logsPaused, setLogsPaused] = useState(false);
  const [logLimit, setLogLimit] = useState(100);
  const [logEntries, setLogEntries] = useState([]);
  const [leftPanePercent, setLeftPanePercent] = useState(35);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    async function loadLogs() {
      if (logsPaused) return;
      try {
        const query = new URLSearchParams({
          limit: String(logLimit),
          filter: logFilter,
          errors_only: errorsOnly ? "1" : "0",
          include_crash: includeCrashBuffer ? "1" : "0",
        });
        const data = await parseJsonResponse(await fetch(`/api/logcat?${query.toString()}`), "/api/logcat");
        setLogEntries(data.entries || []);
      } catch (e) {
        setMessage(`Log stream error: ${e.message}`);
      }
    }

    loadLogs();
    const id = setInterval(loadLogs, 2500);
    return () => clearInterval(id);
  }, [logFilter, errorsOnly, includeCrashBuffer, logsPaused, logLimit]);

  useEffect(() => {
    function onMove(e) {
      if (!isResizingRef.current) return;
      const width = window.innerWidth || 1;
      const next = (e.clientX / width) * 100;
      setLeftPanePercent(Math.max(20, Math.min(60, next)));
    }

    function onUp() {
      isResizingRef.current = false;
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

  async function parseJsonResponse(resp, label) {
    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${label} returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (!resp.ok) {
      throw new Error(data.error || data.message || `${label} failed (${resp.status})`);
    }
    return data;
  }

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
      } catch (e) {
        setApiState("error");
        setMessage(`Bridge API error: ${e.message}`);
      }
    }
    checkHealth();
  }, []);

  const stateColor = (s) =>
    s === "connected" || s === "ready"
      ? "#3fb950"
      : s === "connecting" || s === "checking"
      ? "#d29922"
      : "#f85149";

  function sendKey(name) {
    try {
      emuRef.current?.sendKey?.(name);
    } catch (e) {
      setMessage(`Key send failed: ${e.message}`);
    }
  }

  async function callApi(path, options = {}) {
    setBusy(true);
    try {
      const data = await parseJsonResponse(await fetch(path, options), path);
      setMessage(data.launch || data.message || JSON.stringify(data));
      return data;
    } catch (e) {
      setMessage(`${path} failed: ${e.message}`);
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function uploadApk(ev) {
    const file = ev.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("apk", file);
    fd.append("package", packageName);
    const data = await callApi("/api/install", { method: "POST", body: fd });
    if (data.package) {
      setPackageName(data.package);
      setMessage(`Ready to launch! Installed ${file.name} as ${data.package}`);
    } else {
      setMessage(`Ready to launch! Installed ${file.name}`);
    }
    ev.target.value = "";
  }

  async function installBuiltApk(path, initialPackage = "") {
    const data = await callApi("/api/install-built", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relative_path: path, package: initialPackage || packageName }),
    });
    if (data.package) {
      setPackageName(data.package);
      setMessage(`Ready to launch! Installed ${path} as ${data.package}`);
    } else {
      setMessage(`Ready to launch! Installed ${path}`);
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
    } catch (e) {
      setMessage(`Browse error: ${e.message}`);
    }
  }

  async function selectApk(path) {
    setBuiltPath(path);
    setBrowserOpen(false);
    setMessage(`Selected ${path}`);
    try {
      const details = await parseJsonResponse(
        await fetch(`/api/apk-package?path=${encodeURIComponent(path)}`),
        "/api/apk-package"
      );
      if (details.package) {
        setPackageName(details.package);
        setMessage(`Selected ${path} (${details.package})`);
      }
    } catch (e) {
      setMessage(`Selected ${path}. Package lookup failed: ${e.message}`);
    }
  }

  function fullscreen() {
    wrapRef.current?.requestFullscreen?.();
  }

  function reconnect() {
    window.location.reload();
  }

  const layout = useMemo(() => {
    const leftPanel = Math.max(220, Math.round((viewport.width * leftPanePercent) / 100));
    // 48px accounts for padding around the emulator container
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
        <button onClick={() => sendKey("GoBack")} title="Back" aria-label="Back" style={{ fontSize: 20, lineHeight: 1 }}>◁</button>
        <button onClick={() => sendKey("GoHome")} title="Home" aria-label="Home" style={{ fontSize: 20, lineHeight: 1 }}>◯</button>
        <button onClick={() => sendKey("AppSwitch")} title="Recents" aria-label="Recents" style={{ fontSize: 20, lineHeight: 1 }}>□</button>
        <button onClick={wakeDevice} disabled={busy}>Wake</button>
        <button onClick={rebootDevice} disabled={busy}>Reboot</button>
        <button onClick={fullscreen}>Fullscreen</button>
        <button onClick={reconnect}>Reconnect</button>
        <button onClick={() => browse("")}>Browse APKs</button>
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
            onMouseDown={(e) => e.preventDefault()}
            onDragStart={(e) => e.preventDefault()}
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
            <Emulator
              ref={emuRef}
              uri={window.location.origin}
              view="png"
              muted={true}
              width={layout.width}
              height={layout.height}
              onStateChange={(s) => setEmuState(s)}
              onError={(e) => setMessage(`Emulator error: ${String(e)}`)}
            />
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
                onChange={(e) => setPackageName(e.target.value)}
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

          <div style={{ marginBottom: 12, padding: 12, border: "1px solid #2b313d", borderRadius: 12 }}>
            <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 8 }}>
              Android system logs ({logsPaused ? "paused" : "live"}, last {logLimit})
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
              <input
                type="text"
                value={logFilter}
                onChange={(e) => setLogFilter(e.target.value)}
                placeholder="Filter text (e.g. package name)"
                style={{ flex: 1 }}
              />
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={errorsOnly}
                  onChange={(e) => setErrorsOnly(e.target.checked)}
                />
                Errors only
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={includeCrashBuffer}
                  onChange={(e) => setIncludeCrashBuffer(e.target.checked)}
                />
                Crash buffer
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                Rows
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={logLimit}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    if (Number.isNaN(next)) return;
                    setLogLimit(Math.max(1, Math.min(500, next)));
                  }}
                  style={{ width: 72 }}
                />
              </label>
              <button onClick={() => setLogsPaused((prev) => !prev)}>
                {logsPaused ? "Resume logs" : "Pause logs"}
              </button>
            </div>
            <div
              style={{
                fontFamily: "monospace",
                fontSize: 12,
                maxHeight: 260,
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
          </div>

          {browserOpen && (
            <div style={{ padding: 12, border: "1px solid #2b313d", borderRadius: 12 }}>
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
                  browserData.directories.map((d) => (
                    <div key={d.path} style={{ marginBottom: 6 }}>
                      <button onClick={() => browse(d.path)} style={{ width: "100%", textAlign: "left" }}>
                        📁 {d.name}
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
                  browserData.apks.map((a) => (
                    <div key={a.path} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                      <button onClick={() => selectApk(a.path)} style={{ flex: 1, textAlign: "left" }}>
                        📦 {a.name}
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
