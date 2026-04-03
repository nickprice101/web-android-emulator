import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import wrtc from "@roamhq/wrtc";

const { RTCPeerConnection, RTCSessionDescription } = wrtc;

const port = Number.parseInt(process.env.PORT || "8090", 10);
const captureMode = process.env.CAPTURE_MODE || "stub";
const turnSecret = process.env.TURN_SECRET || "";
const turnHost = process.env.TURN_HOST || "";
const turnPort = process.env.TURN_PORT || "443";
const turnProtocol = process.env.TURN_PROTOCOL || "tcp";
const turnScheme = process.env.TURN_SCHEME || "turns";
const turnTtl = Number.parseInt(process.env.TURN_TTL || "86400", 10);
const turnUsernameSuffix = process.env.TURN_USERNAME_SUFFIX || "emuuser";

const sessions = new Map();
const answerTimeoutMs = Number.parseInt(process.env.WEBRTC_ANSWER_TIMEOUT_MS || "10000", 10);

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

function sessionPayload(session) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    state: session.state,
    mode: session.mode,
    message: session.message,
    hasAnswer: Boolean(session.answer),
    peerConnectionState: session.peerConnectionState || "new",
    iceConnectionState: session.iceConnectionState || "new",
    iceGatheringState: session.iceGatheringState || "new",
    eventStreamUrl: `/bridge/api/session/${session.id}/events`,
    deleteUrl: `/bridge/api/session/${session.id}`,
    inputUrl: `/bridge/api/session/${session.id}/input`,
  };
}

function createSession(offer) {
  const id = randomUUID();
  const session = {
    id,
    createdAt: new Date().toISOString(),
    state: "initializing",
    mode: captureMode,
    message:
      captureMode === "stub"
        ? "Negotiating WebRTC session. The bridge can answer SDP, but no media capture pipeline is attached yet."
        : "Negotiating WebRTC session.",
    offer,
    answer: null,
    peer: null,
    peerConnectionState: "new",
    iceConnectionState: "new",
    iceGatheringState: "new",
    listeners: new Set(),
  };
  sessions.set(id, session);
  return session;
}

function broadcastSessionStatus(session) {
  const payload = sessionPayload(session);
  for (const listener of session.listeners) {
    sendSse(listener, "status", payload);
  }
}

function setSessionState(session, state, message) {
  session.state = state;
  if (message) {
    session.message = message;
  }
  broadcastSessionStatus(session);
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

    let nextState = session.state;
    let nextMessage = session.message;

    switch (peer.connectionState) {
      case "connecting":
        nextState = "connecting";
        nextMessage = "WebRTC answer applied. Waiting for the peer connection to finish connecting.";
        break;
      case "connected":
        nextState = captureMode === "stub" ? "connected-no-media" : "connected";
        nextMessage =
          captureMode === "stub"
            ? "Peer connection established. Media is still absent until the capture pipeline is implemented."
            : "Peer connection established.";
        break;
      case "failed":
        nextState = "failed";
        nextMessage = "Peer connection failed after SDP negotiation.";
        break;
      case "disconnected":
        nextState = "disconnected";
        nextMessage = "Peer connection disconnected.";
        break;
      case "closed":
        nextState = "closed";
        nextMessage = "Peer connection closed.";
        break;
      default:
        break;
    }

    setSessionState(session, nextState, nextMessage);
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
    "Applying browser SDP offer on the bridge peer connection."
  );

  await peer.setRemoteDescription(new RTCSessionDescription(session.offer));

  setSessionState(
    session,
    "creating-answer",
    captureMode === "stub"
      ? "Creating SDP answer without media tracks. Milestone 2 will attach a video source."
      : "Creating SDP answer."
  );

  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  await waitForIceGatheringComplete(peer);

  session.answer = {
    type: peer.localDescription?.type || answer.type,
    sdp: peer.localDescription?.sdp || answer.sdp,
  };

  setSessionState(
    session,
    captureMode === "stub" ? "answered-no-media" : "answered",
    captureMode === "stub"
      ? "SDP answer created successfully. The session is live, but no media capture pipeline is attached yet."
      : "SDP answer created successfully."
  );

  return session.answer;
}

function closeSession(session, state = "closed", message = "Session closed.") {
  if (!session) {
    return;
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
  session.state = state;
  session.message = message;
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
      sessions: sessions.size,
      turnConfigured: Boolean(turnSecret && turnHost),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, {
      ok: true,
      signaling: {
        transport: "https-rest+sse",
        trickleIce: false,
        sessionUrl: "/bridge/api/session",
      },
      media: {
        captureMode,
        status:
          captureMode === "stub"
            ? "pending"
            : "configured",
      },
      rtcConfiguration: {
        iceServers: buildIceServers(),
        iceTransportPolicy: "all",
      },
      notes: [
        "This bridge uses HTTPS requests plus optional Server-Sent Events for corporate-firewall-friendly signaling.",
        "The bridge now creates a real SDP answer and keeps a live RTCPeerConnection per browser session.",
        "Media capture is still scaffolded, so milestone 1 can validate signaling before milestone 2 adds video.",
      ],
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session") {
    try {
      const body = await readBody(req);
      if (!body?.sdp || !body?.type) {
        sendJson(res, 400, { ok: false, error: "Expected SDP offer payload with type and sdp." });
        return;
      }

      const session = createSession({ type: body.type, sdp: body.sdp });
      const answer = await buildAnswer(session);
      sendJson(res, 201, {
        ok: true,
        ...sessionPayload(session),
        answer,
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
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
        sendJson(res, 202, {
          ok: true,
          accepted: true,
          sessionId,
          message: "Input endpoint scaffolded. Wire this to adb or emulator control once media is live.",
          payload: body,
        });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (req.method === "DELETE" && !action) {
      closeSession(session, "closed", "Session deleted by client.");
      for (const listener of session.listeners) {
        sendSse(listener, "closed", { id: sessionId, state: "closed" });
        listener.end();
      }
      sessions.delete(sessionId);
      sendJson(res, 200, { ok: true, id: sessionId, state: "closed" });
      return;
    }
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`bridge-webrtc listening on ${port}`);
});
