import net from "node:net";
import tls from "node:tls";
import { URL } from "node:url";

function formatHostForTurnUrl(host) {
  return net.isIP(host) === 6 ? `[${host}]` : host;
}

function parseTurnUrl(turnUrl) {
  if (typeof turnUrl !== "string" || !turnUrl.trim()) {
    return null;
  }

  const trimmed = turnUrl.trim();
  const match = trimmed.match(/^(turns?):(.+)$/i);
  if (!match) {
    return null;
  }

  const scheme = match[1].toLowerCase();
  const pseudoScheme = scheme === "turns" ? "https" : "http";

  let parsed;
  try {
    parsed = new URL(`${pseudoScheme}://${match[2]}`);
  } catch {
    return null;
  }

  const transport = (parsed.searchParams.get("transport") || (scheme === "turns" ? "tcp" : "")).toLowerCase();
  const defaultPort = scheme === "turns" ? 443 : 3478;
  const port = Number.parseInt(parsed.port || String(defaultPort), 10);
  if (!parsed.hostname || !Number.isFinite(port)) {
    return null;
  }

  return {
    host: parsed.hostname,
    originalUrl: trimmed,
    port,
    scheme,
    searchParams: parsed.searchParams,
    transport,
  };
}

function buildTurnUrl({ scheme, host, port, searchParams }) {
  const query = searchParams?.toString();
  return `${scheme}:${formatHostForTurnUrl(host)}:${port}${query ? `?${query}` : ""}`;
}

function defaultConnectToUpstream({ host, port, servername, timeoutMs, tlsConnectOptions }) {
  return tls.connect({
    host,
    port,
    servername,
    timeout: timeoutMs,
    rejectUnauthorized: true,
    ...tlsConnectOptions,
  });
}

async function createTurnsTcpTunnel(turnUrl, options = {}) {
  const parsed = parseTurnUrl(turnUrl);
  if (!parsed || parsed.scheme !== "turns" || parsed.transport !== "tcp") {
    return null;
  }

  const bindHost = options.bindHost || "127.0.0.1";
  const connectToUpstream = options.connectToUpstream || defaultConnectToUpstream;
  const logger = typeof options.logger === "function" ? options.logger : null;
  const timeoutMs = Math.max(1000, Number.parseInt(String(options.timeoutMs || 5000), 10));
  const tlsConnectOptions = options.tlsConnectOptions || {};
  const activeSockets = new Set();

  const server = net.createServer((incomingSocket) => {
    let settled = false;
    const upstreamSocket = connectToUpstream({
      host: parsed.host,
      port: parsed.port,
      servername: net.isIP(parsed.host) ? undefined : parsed.host,
      timeoutMs,
      tlsConnectOptions,
    });

    activeSockets.add(incomingSocket);
    activeSockets.add(upstreamSocket);
    incomingSocket.pause();

    const cleanup = () => {
      activeSockets.delete(incomingSocket);
      activeSockets.delete(upstreamSocket);
    };

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      logger?.("warn", "turns-tls-shim: upstream connection failed", {
        error: error?.message || String(error),
        upstreamHost: parsed.host,
        upstreamPort: parsed.port,
      });
      incomingSocket.destroy(error);
      upstreamSocket.destroy();
      cleanup();
    };

    const startPiping = () => {
      if (settled) {
        return;
      }
      settled = true;
      incomingSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(incomingSocket);
      incomingSocket.resume();
    };

    incomingSocket.setTimeout(timeoutMs, () => {
      incomingSocket.destroy(new Error(`turns-tls-shim incoming socket timed out after ${timeoutMs}ms`));
    });
    upstreamSocket.setTimeout(timeoutMs, () => {
      upstreamSocket.destroy(new Error(`turns-tls-shim upstream socket timed out after ${timeoutMs}ms`));
    });

    incomingSocket.on("close", cleanup);
    upstreamSocket.on("close", cleanup);
    incomingSocket.on("error", (error) => {
      if (!settled) {
        fail(error);
      } else {
        upstreamSocket.destroy(error);
      }
    });
    upstreamSocket.on("error", fail);
    upstreamSocket.once("secureConnect", startPiping);
    upstreamSocket.once("connect", startPiping);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, bindHost, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("turns-tls-shim failed to bind a local TCP tunnel");
  }

  const localSearchParams = new URLSearchParams(parsed.searchParams);
  localSearchParams.set("transport", "tcp");
  const localUrl = buildTurnUrl({
    scheme: "turn",
    host: bindHost,
    port: address.port,
    searchParams: localSearchParams,
  });

  const tunnel = {
    close() {
      for (const socket of activeSockets) {
        socket.destroy();
      }
      activeSockets.clear();
      server.close();
    },
    localUrl,
    originalUrl: parsed.originalUrl,
    upstreamHost: parsed.host,
    upstreamPort: parsed.port,
  };

  logger?.("info", "turns-tls-shim: listening", tunnel);
  return tunnel;
}

export async function prepareIceServersForNode(iceServers, options = {}) {
  const cleanupCallbacks = [];
  const tunnels = [];
  const servers = Array.isArray(iceServers) ? iceServers : [];

  const preparedIceServers = await Promise.all(
    servers.map(async (server) => {
      const originalUrls = Array.isArray(server?.urls) ? server.urls : server?.urls ? [server.urls] : [];
      const preparedUrls = [];

      for (const url of originalUrls) {
        const tunnel = await createTurnsTcpTunnel(url, options);
        if (tunnel) {
          tunnels.push({
            localUrl: tunnel.localUrl,
            originalUrl: tunnel.originalUrl,
            upstreamHost: tunnel.upstreamHost,
            upstreamPort: tunnel.upstreamPort,
          });
          cleanupCallbacks.push(() => tunnel.close());
          preparedUrls.push(tunnel.localUrl);
        } else {
          preparedUrls.push(url);
        }
      }

      return {
        ...server,
        urls: Array.isArray(server?.urls) ? preparedUrls : preparedUrls[0],
      };
    })
  );

  return {
    close() {
      for (const cleanup of cleanupCallbacks.splice(0).reverse()) {
        cleanup();
      }
    },
    iceServers: preparedIceServers,
    tunnels,
  };
}
