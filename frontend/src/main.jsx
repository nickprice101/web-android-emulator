import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Emulator } from "android-emulator-webrtc/emulator";

const EMULATOR_ASPECT = 1080 / 1920;

function App() {
  const emuRef = useRef(null);
  const wrapRef = useRef(null);

  const [emuState, setEmuState] = useState("connecting");
  const [apiState, setApiState] = useState("checking");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Starting…");
  const [builtPath, setBuiltPath] = useState("");
  const [packageName, setPackageName] = useState("");
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserPath, setBrowserPath] = useState("");
  const [browserData, setBrowserData] = useState({ directories: [], apks: [], cwd: "", parent: null });
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
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
    await callApi("/api/install", { method: "POST", body: fd });
    ev.target.value = "";
  }

  async function installBuiltApk() {
    await callApi("/api/install-built", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relative_path: builtPath, package: packageName }),
    });
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

  function selectApk(path) {
    setBuiltPath(path);
    setBrowserOpen(false);
    setMessage(`Selected ${path}`);
  }

  function fullscreen() {
    wrapRef.current?.requestFullscreen?.();
  }

  function reconnect() {
    window.location.reload();
  }

  const layout = useMemo(() => {
    const rightPanel = browserOpen ? 620 : 320;
    // 48px accounts for padding around the emulator container
    const availableHeight = Math.max(240, viewport.height - 48);
    const availableWidth = Math.max(200, viewport.width - rightPanel - 32);

    let height = availableHeight;
    let width = Math.round(height * EMULATOR_ASPECT);

    if (width > availableWidth) {
      width = availableWidth;
      height = Math.round(width / EMULATOR_ASPECT);
    }

    return { width, height };
  }, [viewport, browserOpen]);

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
        <button onClick={() => sendKey("GoHome")}>Home</button>
        <button onClick={() => sendKey("GoBack")}>Back</button>
        <button onClick={() => sendKey("AppSwitch")}>Recents</button>
        <button onClick={wakeDevice} disabled={busy}>Wake</button>
        <button onClick={rebootDevice} disabled={busy}>Reboot</button>
        <button onClick={fullscreen}>Fullscreen</button>
        <button onClick={reconnect}>Reconnect</button>
        <button onClick={() => browse("")}>Browse APKs</button>
        <input
          type="text"
          value={packageName}
          onChange={(e) => setPackageName(e.target.value)}
          placeholder="Package name"
          style={{ width: 220 }}
        />
        <button onClick={launchApp} disabled={busy || !packageName}>Launch</button>
        <input type="file" accept=".apk,application/vnd.android.package-archive" onChange={uploadApk} disabled={busy} />
        <input
          type="text"
          value={builtPath}
          onChange={(e) => setBuiltPath(e.target.value)}
          placeholder="APK path under workspace"
          style={{ width: 200 }}
        />
        <button onClick={installBuiltApk} disabled={busy || !builtPath}>Install APK</button>
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}>
        <div
          ref={wrapRef}
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 8,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: layout.width,
              height: layout.height,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              borderRadius: 18,
              background: "#000",
            }}
          >
            <Emulator
              ref={emuRef}
              uri={window.location.origin}
              view="webrtc"
              muted={true}
              width={layout.width}
              height={layout.height}
              onStateChange={(s) => setEmuState(s)}
              onError={(e) => setMessage(`Emulator error: ${String(e)}`)}
            />
          </div>
        </div>

        <div
          style={{
            width: browserOpen ? 620 : 320,
            borderLeft: "1px solid #2b313d",
            background: "#171a21",
            padding: 14,
            overflow: "auto",
            flexShrink: 0,
          }}
        >
          <div style={{ marginBottom: 12, padding: 12, border: "1px solid #2b313d", borderRadius: 12 }}>
            <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 6 }}>Emulator state</div>
            <div style={{ color: stateColor(emuState), fontWeight: 600 }}>{emuState}</div>
          </div>

          <div style={{ marginBottom: 12, padding: 12, border: "1px solid #2b313d", borderRadius: 12 }}>
            <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 6 }}>Bridge API</div>
            <div style={{ color: stateColor(apiState), fontWeight: 600 }}>{apiState}</div>
          </div>

          <div style={{ marginBottom: 12, padding: 12, border: "1px solid #2b313d", borderRadius: 12 }}>
            <div style={{ fontSize: 12, color: "#a8b3c7", marginBottom: 6 }}>Last message</div>
            <div style={{ whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: 12 }}>{message}</div>
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
