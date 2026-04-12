import fs from "node:fs/promises";
import { test, expect } from "@playwright/test";

const MIN_RENDERABLE_VIDEO_DIMENSION = 16;
const VIDEO_WAIT_TIMEOUT_MS = 180_000;
const HAVE_CURRENT_DATA = 2;

function extractVideoStats(video) {
  const playbackQuality =
    typeof video.getVideoPlaybackQuality === "function"
      ? video.getVideoPlaybackQuality()
      : null;

  return {
    readyState: video.readyState,
    currentTime: video.currentTime,
    paused: video.paused,
    ended: video.ended,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    totalVideoFrames: playbackQuality?.totalVideoFrames ?? null,
    droppedVideoFrames: playbackQuality?.droppedVideoFrames ?? null,
  };
}

test("native emulator stream renders real video frames over deployed turns path", async ({ page }, testInfo) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.getByTestId("emulator-state-value")).toBeVisible({
    timeout: VIDEO_WAIT_TIMEOUT_MS,
  });
  await expect(page.getByTestId("native-webrtc-diagnostics")).toBeVisible({
    timeout: VIDEO_WAIT_TIMEOUT_MS,
  });

  const nativeVideo = page.locator("video").first();
  await expect(nativeVideo).toBeVisible({ timeout: VIDEO_WAIT_TIMEOUT_MS });

  await page.waitForFunction(
    ({ minDimension }) => {
      const video = document.querySelector("video");
      if (!(video instanceof HTMLVideoElement)) {
        return false;
      }

      const playbackQuality =
        typeof video.getVideoPlaybackQuality === "function"
          ? video.getVideoPlaybackQuality()
          : null;
      const totalVideoFrames = playbackQuality?.totalVideoFrames ?? 0;

      return (
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.videoWidth >= minDimension &&
        video.videoHeight >= minDimension &&
        (totalVideoFrames > 0 || video.currentTime > 0)
      );
    },
    { minDimension: MIN_RENDERABLE_VIDEO_DIMENSION },
    { timeout: VIDEO_WAIT_TIMEOUT_MS }
  );

  const emulatorState = (await page.getByTestId("emulator-state-value").innerText()).trim();
  const bridgeApiState = (await page.getByTestId("bridge-api-state-value").innerText()).trim();
  const lastMessage = (await page.getByTestId("last-message").innerText()).trim();
  const nativeDiagnosticsText = (await page.getByTestId("native-webrtc-diagnostics").innerText()).trim();
  const videoStats = await nativeVideo.evaluate(extractVideoStats);
  const browserDiagnostics = await page.evaluate(() => window.__EMU_E2E__ || null);

  expect(emulatorState.toLowerCase()).toContain("connected");
  expect(bridgeApiState.toLowerCase()).toContain("ready");
  expect(videoStats.readyState).toBeGreaterThanOrEqual(HAVE_CURRENT_DATA);
  expect(videoStats.videoWidth).toBeGreaterThanOrEqual(MIN_RENDERABLE_VIDEO_DIMENSION);
  expect(videoStats.videoHeight).toBeGreaterThanOrEqual(MIN_RENDERABLE_VIDEO_DIMENSION);
  expect(
    (videoStats.totalVideoFrames ?? 0) > 0 || videoStats.currentTime > 0,
    `Expected decoded frames or playback progress, got ${JSON.stringify(videoStats)}`
  ).toBeTruthy();
  expect(nativeDiagnosticsText).toContain("Native WebRTC diagnostics");
  expect(
    browserDiagnostics?.selectedCandidatePair?.localCandidateType === "relay" ||
      browserDiagnostics?.selectedCandidatePair?.remoteCandidateType === "relay",
    `Expected selected ICE candidate pair to use TURN relay, got ${JSON.stringify(browserDiagnostics)}`
  ).toBeTruthy();

  const diagnosticsPayload = {
    emulatorState,
    bridgeApiState,
    lastMessage,
    nativeDiagnosticsText,
    browserDiagnostics,
    videoStats,
    testedAt: new Date().toISOString(),
    baseUrl: testInfo.project.use.baseURL,
  };

  await fs.writeFile(
    testInfo.outputPath("native-turns-video-diagnostics.json"),
    JSON.stringify(diagnosticsPayload, null, 2),
    "utf8"
  );

  await page.screenshot({
    path: testInfo.outputPath("native-turns-video.png"),
    fullPage: true,
  });
});
