import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { after, test } from "node:test";

import { prepareIceServersForNode } from "../turn-tls-shim.mjs";

const cleanupTasks = [];

after(() => {
  for (const cleanup of cleanupTasks.splice(0).reverse()) {
    cleanup();
  }
});

test("prepareIceServersForNode rewrites turns tcp URLs through a local tunnel", async () => {
  const upstreamServer = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      socket.write(Buffer.from(`upstream:${chunk.toString("utf8")}`, "utf8"));
    });
  });
  upstreamServer.listen(0, "127.0.0.1");
  await once(upstreamServer, "listening");
  cleanupTasks.push(() => upstreamServer.close());

  const upstreamAddress = upstreamServer.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");

  const connectCalls = [];
  const prepared = await prepareIceServersForNode(
    [
      {
        credential: "pass",
        urls: [`turns:turn.example.test:${upstreamAddress.port}?transport=tcp`],
        username: "user",
      },
    ],
    {
      connectToUpstream({ host, port, servername }) {
        connectCalls.push({ host, port, servername });
        return net.connect({ host: "127.0.0.1", port: upstreamAddress.port });
      },
    }
  );
  cleanupTasks.push(() => prepared.close());

  assert.equal(prepared.tunnels.length, 1);
  assert.equal(prepared.iceServers[0].username, "user");
  assert.equal(prepared.iceServers[0].credential, "pass");
  assert.equal(prepared.iceServers[0].urls[0].startsWith("turn:127.0.0.1:"), true);

  const tunnelUrl = new URL(prepared.iceServers[0].urls[0].replace(/^turn:/, "http://"));
  const client = net.connect({
    host: tunnelUrl.hostname,
    port: Number.parseInt(tunnelUrl.port, 10),
  });
  cleanupTasks.push(() => client.destroy());

  await once(client, "connect");
  client.write("hello");
  const [response] = await once(client, "data");
  assert.equal(response.toString("utf8"), "upstream:hello");

  assert.deepEqual(connectCalls, [
    {
      host: "turn.example.test",
      port: upstreamAddress.port,
      servername: "turn.example.test",
    },
  ]);
});
