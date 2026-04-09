import test from "node:test";
import assert from "node:assert/strict";

import { isRenderableNativeRtcFrame } from "../native-rtc-frame-guard.mjs";

test("native RTC frame filter drops 2x2 placeholder startup frame and forwards real frame", () => {
  const realWidth = 1080;
  const realHeight = 1920;
  const realFrameSize = Math.floor((realWidth * realHeight * 3) / 2);

  const placeholderFrame = {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray(Math.floor((2 * 2 * 3) / 2)),
  };

  const realFrame = {
    width: realWidth,
    height: realHeight,
    data: new Uint8ClampedArray(realFrameSize),
  };

  const deliveredFrames = [];
  const pushIfRenderable = (frame) => {
    if (isRenderableNativeRtcFrame(frame)) {
      deliveredFrames.push(frame);
    }
  };

  pushIfRenderable(placeholderFrame);
  pushIfRenderable(realFrame);

  assert.equal(deliveredFrames.length, 1, "Expected only one renderable frame after placeholder filtering");
  assert.equal(deliveredFrames[0].width, realWidth, "Expected delivered frame width to match real frame width");
  assert.equal(deliveredFrames[0].height, realHeight, "Expected delivered frame height to match real frame height");
});
