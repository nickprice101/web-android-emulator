import test from "node:test";
import assert from "node:assert/strict";

import { buildFfmpegArgs } from "../ffmpeg-config.mjs";

test("buildFfmpegArgs scales screenrecord output to the expected frame size", () => {
  const args = buildFfmpegArgs({
    mode: "adb-screenrecord",
    fps: 30,
    width: 1080,
    height: 1920,
  });

  assert.ok(args.includes("-vf"));
  assert.ok(args.includes("scale=1080:1920"));
  assert.ok(args.includes("-f"));
  assert.ok(args.includes("rawvideo"));
});

test("buildFfmpegArgs scales screencap output to the expected frame size", () => {
  const args = buildFfmpegArgs({
    mode: "adb-screencap",
    fps: 15,
    width: 720,
    height: 1280,
  });

  assert.ok(args.includes("-codec:v"));
  assert.ok(args.includes("png"));
  assert.ok(args.includes("scale=720:1280"));
});
