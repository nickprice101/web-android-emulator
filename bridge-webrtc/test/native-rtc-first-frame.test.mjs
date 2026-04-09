import test from "node:test";
import assert from "node:assert/strict";
import wrtc from "@roamhq/wrtc";

import { isRenderableNativeRtcFrame } from "../native-rtc-frame-guard.mjs";

const { RTCPeerConnection, nonstandard = {} } = wrtc;
const { RTCVideoSource, RTCVideoSink } = nonstandard;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loopbackConnect(pcA, pcB) {
  pcA.onicecandidate = ({ candidate }) => {
    if (candidate) {
      pcB.addIceCandidate(candidate);
    }
  };
  pcB.onicecandidate = ({ candidate }) => {
    if (candidate) {
      pcA.addIceCandidate(candidate);
    }
  };

  const offer = await pcA.createOffer();
  await pcA.setLocalDescription(offer);
  await pcB.setRemoteDescription(offer);

  const answer = await pcB.createAnswer();
  await pcB.setLocalDescription(answer);
  await pcA.setRemoteDescription(answer);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for ICE connection")), 10_000);
    const poll = setInterval(() => {
      const state = pcA.iceConnectionState;
      if (state === "connected" || state === "completed") {
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      } else if (state === "failed" || state === "closed") {
        clearInterval(poll);
        clearTimeout(timer);
        reject(new Error(`ICE reached terminal state: ${state}`));
      }
    }, 100);
  });
}

test("native RTC loopback skips 2x2 placeholder startup frames and keeps streaming real video", async () => {
  assert.ok(RTCVideoSource, "RTCVideoSource must be available in this wrtc build");
  assert.ok(RTCVideoSink, "RTCVideoSink must be available in this wrtc build");

  const realWidth = 1080;
  const realHeight = 1920;
  const realFrameSize = Math.floor((realWidth * realHeight * 3) / 2);
  const realFrame = new Uint8ClampedArray(realFrameSize);
  const placeholderFrame = new Uint8ClampedArray(Math.floor((2 * 2 * 3) / 2));

  const source = new RTCVideoSource();
  const videoTrack = source.createTrack();
  const pcA = new RTCPeerConnection({ sdpSemantics: "unified-plan" });
  const pcB = new RTCPeerConnection({ sdpSemantics: "unified-plan" });

  const receivedFrames = [];
  let sink = null;

  try {
    pcA.addTrack(videoTrack);

    const framesPromise = new Promise((resolve) => {
      pcB.ontrack = ({ track: rxTrack }) => {
        sink = new RTCVideoSink(rxTrack);
        sink.onframe = ({ frame }) => {
          receivedFrames.push({ width: frame.width, height: frame.height });
          if (receivedFrames.length >= 3) {
            resolve(receivedFrames.slice());
          }
        };
      };
    });

    await loopbackConnect(pcA, pcB);

    const pushIfRenderable = (frame) => {
      if (isRenderableNativeRtcFrame(frame)) {
        source.onFrame(frame);
      }
    };

    pushIfRenderable({ width: 2, height: 2, data: placeholderFrame });

    const deadline = Date.now() + 10_000;
    while (receivedFrames.length < 3 && Date.now() < deadline) {
      pushIfRenderable({ width: realWidth, height: realHeight, data: realFrame });
      await sleep(40);
    }

    const settledFrames = await Promise.race([framesPromise, sleep(10_000).then(() => null)]);

    assert.ok(settledFrames, "Expected the receiver to collect real frames after placeholder filtering");
    assert.deepEqual(settledFrames[0], { width: realWidth, height: realHeight });
    assert.ok(
      settledFrames.every((frame) => frame.width === realWidth && frame.height === realHeight),
      "Expected all delivered frames to use real emulator dimensions instead of the 2x2 placeholder"
    );
    assert.ok(
      pcA.connectionState === "connected" || pcA.iceConnectionState === "connected" || pcA.iceConnectionState === "completed",
      `Expected a stable WebRTC connection after first frame delivery, got connectionState=${pcA.connectionState}, iceConnectionState=${pcA.iceConnectionState}`
    );
  } finally {
    try {
      sink?.stop();
    } catch {}
    try {
      videoTrack.stop();
    } catch {}
    try {
      pcA.close();
    } catch {}
    try {
      pcB.close();
    } catch {}
  }
});
