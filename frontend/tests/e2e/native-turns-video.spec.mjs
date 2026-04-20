import fs from "node:fs/promises";
import { test, expect } from "@playwright/test";

const MIN_RENDERABLE_VIDEO_DIMENSION = 16;
const VIDEO_WAIT_TIMEOUT_MS = 180_000;
const HAVE_CURRENT_DATA = 2;

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

test("deployed turns path renders real video frames", async ({ page }, testInfo) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.getByText("Emulator state", { exact: true })).toBeVisible({
    timeout: VIDEO_WAIT_TIMEOUT_MS,
  });
  await expect(page.getByText("Native WebRTC diagnostics", { exact: true })).toBeVisible({
    timeout: VIDEO_WAIT_TIMEOUT_MS,
  });

  const mediaOutcomeHandle = await page.waitForFunction(
    ({ minDimension }) => {
      const videos = Array.from(document.querySelectorAll("video")).filter(
        (candidate) => candidate instanceof HTMLVideoElement
      );
      const video = videos.reduce((best, candidate) => {
        if (!best) {
          return candidate;
        }
        const candidateArea = (candidate.videoWidth || 0) * (candidate.videoHeight || 0);
        const bestArea = (best.videoWidth || 0) * (best.videoHeight || 0);
        return candidateArea >= bestArea ? candidate : best;
      }, null);
      const bodyText = document.body?.innerText ?? "";
      // Only treat disconnection as a definitive failure once the frontend has
      // exhausted all native WebRTC retries (signalled by the "could not
      // recover" message) or once the custom-bridge fallback also reports
      // disconnected.  The "native WebRTC disconnected" overlay is a transient
      // state that appears before each retry fires (~1.5 s) and must not cause
      // an early abort.
      const failureDetected =
        bodyText.includes("could not recover") ||
        bodyText.includes("Mode: custom WebRTC disconnected");

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
  const customDiagnosticsText = readSectionFromBody(bodyText, "WebRTC diagnostics", "First-frame path");
  const videoStats = mediaOutcome?.videoStats ?? null;
  const browserDiagnostics = await page.evaluate(() => window.__EMU_E2E__ || null);
  const activeTransport = browserDiagnostics?.activeTransport || null;
  const activeDiagnosticsText =
    activeTransport === "custom-bridge-webrtc" ? customDiagnosticsText : nativeDiagnosticsText;
  const selectedPairUsesRelay =
    browserDiagnostics?.selectedCandidatePair?.localCandidateType === "relay" ||
    browserDiagnostics?.selectedCandidatePair?.remoteCandidateType === "relay" ||
    /Selected pair:\s+.*relay/i.test(activeDiagnosticsText);

  const diagnosticsPayload = {
    emulatorState,
    bridgeApiState,
    lastMessage,
    activeTransport,
    nativeDiagnosticsText,
    customDiagnosticsText,
    browserDiagnostics,
    mediaOutcome,
    selectedPairUsesRelay,
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

  expect(mediaOutcome?.outcome, `Expected usable video, got ${JSON.stringify(mediaOutcome)}`).toBe("ready");
  expect(emulatorState.toLowerCase()).toContain("connected");
  expect(bridgeApiState.toLowerCase()).toContain("ready");
  expect(["native-emulator-webrtc", "custom-bridge-webrtc"]).toContain(activeTransport);
  expect(videoStats?.readyState ?? 0).toBeGreaterThanOrEqual(HAVE_CURRENT_DATA);
  expect(videoStats?.videoWidth ?? 0).toBeGreaterThanOrEqual(MIN_RENDERABLE_VIDEO_DIMENSION);
  expect(videoStats?.videoHeight ?? 0).toBeGreaterThanOrEqual(MIN_RENDERABLE_VIDEO_DIMENSION);
  expect(
    ((videoStats?.totalVideoFrames ?? 0) > 0) || (videoStats?.currentTime ?? 0) > 0,
    `Expected decoded frames or playback progress, got ${JSON.stringify(videoStats)}`
  ).toBeTruthy();
  expect(activeDiagnosticsText).toContain("Transport:");
  expect(
    selectedPairUsesRelay,
    `Expected selected ICE candidate pair to use TURN relay, got ${JSON.stringify(browserDiagnostics)}`
  ).toBeTruthy();
});
