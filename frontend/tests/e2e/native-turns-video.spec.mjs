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

async function readBodyText(page) {
  return page.locator("body").innerText();
}

function readFieldFromBody(bodyText, heading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escapedHeading}\\s+([^\\n]+)`, "i");
  return bodyText.match(pattern)?.[1]?.trim() ?? "";
}

function readSectionFromBody(bodyText, heading, nextHeading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedNextHeading = nextHeading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escapedHeading}\\s+([\\s\\S]*?)\\s+${escapedNextHeading}`, "i");
  return bodyText.match(pattern)?.[1]?.trim() ?? "";
}

test("native emulator stream renders real video frames over deployed turns path", async ({ page }, testInfo) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.getByText("Emulator state", { exact: true })).toBeVisible({
    timeout: VIDEO_WAIT_TIMEOUT_MS,
  });
  await expect(page.getByText("Native WebRTC diagnostics", { exact: true })).toBeVisible({
    timeout: VIDEO_WAIT_TIMEOUT_MS,
  });

  const nativeVideo = page.locator("video").first();
  await expect(nativeVideo).toBeVisible({ timeout: VIDEO_WAIT_TIMEOUT_MS });

  const mediaOutcomeHandle = await page.waitForFunction(
    ({ minDimension }) => {
      const video = document.querySelector("video");
      const bodyText = document.body?.innerText ?? "";
      const failureDetected =
        bodyText.includes("The native emulator session dropped before the browser rendered a usable frame.") ||
        bodyText.includes("Mode: native WebRTC disconnected");

      if (!(video instanceof HTMLVideoElement)) {
        return failureDetected ? { outcome: "failed", videoStats: null } : null;
      }

      const playbackQuality =
        typeof video.getVideoPlaybackQuality === "function"
          ? video.getVideoPlaybackQuality()
          : null;
      const videoStats = {
        readyState: video.readyState,
        currentTime: video.currentTime,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        totalVideoFrames: playbackQuality?.totalVideoFrames ?? 0,
        droppedVideoFrames: playbackQuality?.droppedVideoFrames ?? 0,
      };

      const ready =
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.videoWidth >= minDimension &&
        video.videoHeight >= minDimension &&
        (videoStats.totalVideoFrames > 0 || video.currentTime > 0);

      if (ready) {
        return { outcome: "ready", videoStats };
      }

      if (failureDetected) {
        return { outcome: "failed", videoStats };
      }

      return null;
    },
    { minDimension: MIN_RENDERABLE_VIDEO_DIMENSION },
    { timeout: VIDEO_WAIT_TIMEOUT_MS }
  );

  const mediaOutcome = await mediaOutcomeHandle.jsonValue();
  const bodyText = await readBodyText(page);
  const emulatorState = readFieldFromBody(bodyText, "Emulator state");
  const bridgeApiState = readFieldFromBody(bodyText, "Bridge API");
  const lastMessage = readSectionFromBody(bodyText, "Last message", "Display diagnostics");
  const nativeDiagnosticsText = readSectionFromBody(
    bodyText,
    "Native WebRTC diagnostics",
    "First-frame path"
  );
  const videoStats = await nativeVideo.evaluate(extractVideoStats);
  const browserDiagnostics = await page.evaluate(() => window.__EMU_E2E__ || null);
  const selectedPairUsesRelay =
    browserDiagnostics?.selectedCandidatePair?.localCandidateType === "relay" ||
    browserDiagnostics?.selectedCandidatePair?.remoteCandidateType === "relay" ||
    /Selected pair:\s+.*relay/i.test(nativeDiagnosticsText);

  expect(mediaOutcome?.outcome, `Expected usable video, got ${JSON.stringify(mediaOutcome)}`).toBe("ready");
  expect(emulatorState.toLowerCase()).toContain("connected");
  expect(bridgeApiState.toLowerCase()).toContain("ready");
  expect(videoStats.readyState).toBeGreaterThanOrEqual(HAVE_CURRENT_DATA);
  expect(videoStats.videoWidth).toBeGreaterThanOrEqual(MIN_RENDERABLE_VIDEO_DIMENSION);
  expect(videoStats.videoHeight).toBeGreaterThanOrEqual(MIN_RENDERABLE_VIDEO_DIMENSION);
  expect(
    (videoStats.totalVideoFrames ?? 0) > 0 || videoStats.currentTime > 0,
    `Expected decoded frames or playback progress, got ${JSON.stringify(videoStats)}`
  ).toBeTruthy();
  expect(nativeDiagnosticsText).toContain("Transport: native emulator WebRTC");
  expect(
    selectedPairUsesRelay,
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
