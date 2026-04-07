export function buildFfmpegArgs({ mode, fps, width, height }) {
  const normalizedWidth = Math.max(1, Number.parseInt(String(width || 0), 10) || 1);
  const normalizedHeight = Math.max(1, Number.parseInt(String(height || 0), 10) || 1);

  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "nobuffer",
    "-flags",
    "low_delay",
    "-max_delay",
    "0",
    ...(mode === "adb-screenrecord"
      ? ["-probesize", "128", "-analyzeduration", "0", "-f", "h264", "-r", String(fps)]
      : ["-f", "image2pipe", "-codec:v", "png"]),
    "-i",
    "pipe:0",
    // Always normalize ffmpeg's rawvideo output dimensions so the bridge's
    // frame slicing logic stays aligned even when adb-reported dimensions and
    // decoded media dimensions briefly disagree.
    "-vf",
    `scale=${normalizedWidth}:${normalizedHeight}`,
    "-an",
    "-pix_fmt",
    "yuv420p",
    "-f",
    "rawvideo",
    "pipe:1",
  ];
}
