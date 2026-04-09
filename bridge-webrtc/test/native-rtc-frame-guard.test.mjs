import test from "node:test";
import assert from "node:assert/strict";

import {
  MIN_RENDERABLE_NATIVE_RTC_DIMENSION,
  isRenderableNativeRtcFrame,
} from "../native-rtc-frame-guard.mjs";

test("native RTC frame guard rejects tiny placeholder frames", () => {
  assert.equal(MIN_RENDERABLE_NATIVE_RTC_DIMENSION, 16);
  assert.equal(isRenderableNativeRtcFrame({ width: 2, height: 2 }), false);
  assert.equal(isRenderableNativeRtcFrame({ width: 15, height: 1080 }), false);
  assert.equal(isRenderableNativeRtcFrame({ width: 1080, height: 15 }), false);
});

test("native RTC frame guard accepts real emulator-sized frames", () => {
  assert.equal(isRenderableNativeRtcFrame({ width: 16, height: 16 }), true);
  assert.equal(isRenderableNativeRtcFrame({ width: 1080, height: 1920 }), true);
});
