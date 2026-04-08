/**
 * Testbed: full-size frame generation via RTCVideoSource (loopback)
 *
 * This test confirms that the bridge-webrtc's RTCVideoSource pipeline can
 * produce and deliver full-resolution YUV420p frames through a loopback
 * peer connection.  It rules out the bridge as the source of the 2×2
 * placeholder frames that appear on the native-emulator WebRTC path when the
 * emulator advertises no ICE servers and ICE connectivity fails.
 */

import test from "node:test";
import assert from "node:assert/strict";
import wrtc from "@roamhq/wrtc";

const { RTCPeerConnection, nonstandard = {} } = wrtc;
const { RTCVideoSource, RTCVideoSink } = nonstandard;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wire two RTCPeerConnections together (offer/answer + trickle-ICE) using
 * only loopback / host candidates so no STUN or TURN server is needed.
 */
async function loopbackConnect(pcA, pcB) {
  pcA.onicecandidate = ({ candidate }) => {
    if (candidate) pcB.addIceCandidate(candidate);
  };
  pcB.onicecandidate = ({ candidate }) => {
    if (candidate) pcA.addIceCandidate(candidate);
  };

  const offer = await pcA.createOffer();
  await pcA.setLocalDescription(offer);
  await pcB.setRemoteDescription(offer);

  const answer = await pcB.createAnswer();
  await pcB.setLocalDescription(answer);
  await pcA.setRemoteDescription(answer);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for ICE connection")),
      10_000
    );
    const poll = setInterval(() => {
      const s = pcA.iceConnectionState;
      if (s === "connected" || s === "completed") {
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      } else if (s === "failed" || s === "closed") {
        clearInterval(poll);
        clearTimeout(timer);
        reject(new Error(`ICE reached terminal state: ${s}`));
      }
    }, 100);
  });
}

test("RTCVideoSource delivers a full-size YUV420p frame through a loopback peer connection", async () => {
  assert.ok(RTCVideoSource, "RTCVideoSource must be available in this wrtc build");
  assert.ok(RTCVideoSink, "RTCVideoSink must be available in this wrtc build");

  const width = 1080;
  const height = 1920;
  // YUV420p: width*height luma bytes + width*height/2 chroma bytes
  const frameSize = Math.floor((width * height * 3) / 2);
  const data = new Uint8ClampedArray(frameSize); // all-zero (black) frame

  const source = new RTCVideoSource();
  const videoTrack = source.createTrack();

  const pcA = new RTCPeerConnection({ sdpSemantics: "unified-plan" });
  const pcB = new RTCPeerConnection({ sdpSemantics: "unified-plan" });

  try {
    // pcA sends the synthetic video; pcB receives it.
    pcA.addTrack(videoTrack);

    const firstFrame = new Promise((resolve) => {
      pcB.ontrack = ({ track: rxTrack }) => {
        const sink = new RTCVideoSink(rxTrack);
        sink.onframe = ({ frame }) => {
          resolve({ width: frame.width, height: frame.height });
          sink.stop();
        };
      };
    });

    await loopbackConnect(pcA, pcB);

    // Push frames at ~30 fps until the sink receives one (or timeout).
    let received = null;
    const MAX_WAIT_MS = 10_000;
    const FRAME_INTERVAL_MS = 33;
    const deadline = Date.now() + MAX_WAIT_MS;
    const frameResult = Promise.race([
      firstFrame,
      sleep(MAX_WAIT_MS).then(() => null),
    ]);

    while (!received && Date.now() < deadline) {
      source.onFrame({ width, height, data });
      await sleep(FRAME_INTERVAL_MS);
      // Check if the promise already settled without blocking the push loop.
      received = await Promise.race([firstFrame, Promise.resolve(null)]);
    }

    const frame = await frameResult;

    assert.ok(
      frame !== null,
      `Bridge RTCVideoSource did not deliver a frame within ${MAX_WAIT_MS} ms`
    );
    assert.equal(
      frame.width,
      width,
      `Received frame width ${frame.width} does not match pushed width ${width}`
    );
    assert.equal(
      frame.height,
      height,
      `Received frame height ${frame.height} does not match pushed height ${height}`
    );
  } finally {
    try { videoTrack.stop(); } catch (_) { /* ignore */ }
    try { pcA.close(); } catch (_) { /* ignore */ }
    try { pcB.close(); } catch (_) { /* ignore */ }
  }
});
