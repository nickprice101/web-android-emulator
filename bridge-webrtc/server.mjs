import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import { URL } from "node:url";

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
    state: captureMode === "stub" ? "awaiting-capture-pipeline" : "initializing",
    mode: captureMode,
    message:
      captureMode === "stub"
        ? "Custom bridge signaling is live, but the media capture pipeline is not implemented yet. Add a capture source before expecting browser video."
        : "Session created.",
    offer,
    listeners: new Set(),
  };
  sessions.set(id, session);
  return session;
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
        "Media capture is scaffolded but not implemented in this fork yet.",
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
      const payload = {
        ok: false,
        ...sessionPayload(session),
        error:
          captureMode === "stub"
            ? "Bridge session created, but answering SDP is disabled until a media capture pipeline is implemented."
            : "Bridge session created.",
      };

      for (const listener of session.listeners) {
        sendSse(listener, "status", sessionPayload(session));
      }

      sendJson(res, captureMode === "stub" ? 501 : 201, payload);
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
