export const MIN_RENDERABLE_NATIVE_RTC_DIMENSION = 16;

export function isRenderableNativeRtcFrame(frame, minDimension = MIN_RENDERABLE_NATIVE_RTC_DIMENSION) {
  const width = Number(frame?.width ?? 0);
  const height = Number(frame?.height ?? 0);
  return width >= minDimension && height >= minDimension;
}
