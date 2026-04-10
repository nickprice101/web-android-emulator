import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import wrtc from '@roamhq/wrtc';

const { RTCPeerConnection } = wrtc;

const placeholderSecretPatterns = [/^PLACEHOLDER/i, /^REPLACE_ME/i, /^CHANGEME$/i];

const turnHost = (process.env.TURN_HOST || '').trim();
const turnKey = (process.env.TURN_KEY || '').trim();
const turnPort = process.env.TURN_PORT || '443';
const turnProtocol = process.env.TURN_PROTOCOL || 'tcp';
const turnScheme = process.env.TURN_SCHEME || 'turns';
const turnTtl = Number.parseInt(process.env.TURN_TTL || '2592000', 10);
const turnUsernameSuffix = process.env.TURN_USERNAME_SUFFIX || 'emuuser';
const timeoutMs = Math.max(2000, Number.parseInt(process.env.TURN_HARNESS_TIMEOUT_MS || '12000', 10));

function fail(message) {
  console.error(`[turn-harness] FAIL: ${message}`);
  process.exit(1);
}

function info(message, obj) {
  if (obj) {
    console.log(`[turn-harness] ${message}`, obj);
    return;
  }
  console.log(`[turn-harness] ${message}`);
}

function connectTcp(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`TCP timeout after ${timeoutMs}ms`));
    });
    socket.once('error', (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

function connectTls(host, port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, timeout: timeoutMs }, () => {
      socket.end();
      resolve({ authorized: socket.authorized, authorizationError: socket.authorizationError || null });
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`TLS timeout after ${timeoutMs}ms`));
    });
    socket.once('error', (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

async function gatherRelayCandidate({ url, username, credential }) {
  const pc = new RTCPeerConnection({
    iceTransportPolicy: 'relay',
    iceServers: [{ urls: [url], username, credential }],
  });

  const relayCandidates = [];
  const candidateErrors = [];
  let gatheringComplete = false;

  pc.onicecandidate = (event) => {
    const value = event?.candidate?.candidate || '';
    if (value.includes(' typ relay ')) {
      relayCandidates.push(value);
    }
    if (!event.candidate) {
      gatheringComplete = true;
    }
  };

  pc.onicecandidateerror = (event) => {
    candidateErrors.push({
      url: event?.url || null,
      hostCandidate: event?.hostCandidate || null,
      errorCode: event?.errorCode || null,
      errorText: event?.errorText || null,
    });
  };

  pc.createDataChannel('turn-harness');
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const start = Date.now();
  while (!gatheringComplete && Date.now() - start < timeoutMs) {
    await sleep(100);
  }

  pc.close();
  return { relayCandidates, candidateErrors, timedOut: !gatheringComplete };
}

if (!turnHost) {
  fail('TURN_HOST is required');
}
if (!turnKey) {
  fail('TURN_KEY is required');
}
if (placeholderSecretPatterns.some((pattern) => pattern.test(turnKey))) {
  fail('TURN_KEY is still a placeholder value; set the real coturn static-auth-secret before running this harness');
}

const now = Math.floor(Date.now() / 1000);
const username = `${now + turnTtl}:${turnUsernameSuffix}`;
const credential = createHmac('sha1', turnKey).update(username).digest('base64');
const turnUrl = `${turnScheme}:${turnHost}:${turnPort}?transport=${turnProtocol}`;

const emulatorTurnPayload = {
  iceServers: [{ urls: [turnUrl], username, credential }],
};

info('Generated emulator-style TURN payload', emulatorTurnPayload);

try {
  const records = await dns.lookup(turnHost, { all: true });
  info(`DNS lookup ok for ${turnHost}`, records.map((record) => record.address));
} catch (error) {
  fail(`DNS lookup failed for ${turnHost}: ${error.message}`);
}

try {
  await connectTcp(turnHost, Number.parseInt(turnPort, 10));
  info(`TCP connect ok for ${turnHost}:${turnPort}`);
} catch (error) {
  fail(`TCP connect failed for ${turnHost}:${turnPort}: ${error.message}`);
}

if (turnScheme === 'turns') {
  try {
    const tlsState = await connectTls(turnHost, Number.parseInt(turnPort, 10));
    info(`TLS handshake ok for ${turnHost}:${turnPort}`, tlsState);
  } catch (error) {
    fail(`TLS handshake failed for ${turnHost}:${turnPort}: ${error.message}`);
  }
}

const relayResult = await gatherRelayCandidate({ url: turnUrl, username, credential });
if (relayResult.timedOut) {
  fail(`ICE gathering timed out after ${timeoutMs}ms`);
}
if (relayResult.relayCandidates.length === 0) {
  fail(`No relay candidates were gathered. TURN auth/connectivity likely failed. Candidate errors: ${JSON.stringify(relayResult.candidateErrors)}`);
}

info(`Relay candidates gathered: ${relayResult.relayCandidates.length}`);
info('PASS: TURN reachable, credentials accepted, and emulator-style payload produced a relay connection path');
