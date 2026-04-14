import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeIceTransportPolicy,
  resolveNativeRtcPeerIceTransportPolicy,
} from "../native-rtc-ice-policy.mjs";

test("normalizeIceTransportPolicy accepts valid policy values", () => {
  assert.equal(normalizeIceTransportPolicy("relay"), "relay");
  assert.equal(normalizeIceTransportPolicy("ALL"), "all");
});

test("normalizeIceTransportPolicy falls back to all for invalid values", () => {
  assert.equal(normalizeIceTransportPolicy(undefined), "all");
  assert.equal(normalizeIceTransportPolicy("bogus"), "all");
});

test("resolveNativeRtcPeerIceTransportPolicy honors explicit emulator start policy", () => {
  assert.equal(resolveNativeRtcPeerIceTransportPolicy({ iceTransportPolicy: "relay" }), "relay");
  assert.equal(resolveNativeRtcPeerIceTransportPolicy({ iceTransportPolicy: "all" }), "all");
});

test("resolveNativeRtcPeerIceTransportPolicy defaults emulator bridge leg to mixed ICE", () => {
  assert.equal(resolveNativeRtcPeerIceTransportPolicy({}), "all");
  assert.equal(resolveNativeRtcPeerIceTransportPolicy(null), "all");
});
