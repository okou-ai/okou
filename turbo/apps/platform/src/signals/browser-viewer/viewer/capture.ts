import { CdpFault, isRecord } from "../cdp/errors.ts";
import { positive, type DisplaySize } from "../display/geometry.ts";

import { maximumFrameArea, maximumFrameDimension } from "../display/limits.ts";
import type { ViewerCaptureOptions } from "./types.ts";

export type CaptureSettings = Readonly<Required<ViewerCaptureOptions>>;

/** Bounded startup fallback until a committed surface can be measured. */
export const defaultCapture: CaptureSettings = Object.freeze({
  format: "webp",
  quality: 70,
  maxWidth: 1920,
  maxHeight: 1080,
});

export const captureResolutions = [
  { width: 960, height: 540 },
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
] as const;

function setting(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new CdpFault(
      "configuration",
      `${field} must be an integer from ${min} to ${max}.`,
    );
  }
  return value;
}

export function captureSettings(
  options?: ViewerCaptureOptions,
  size: DisplaySize | null = null,
): CaptureSettings {
  if (options !== undefined && !isRecord(options)) {
    throw new CdpFault(
      "configuration",
      "capture must be an image settings object.",
    );
  }
  const format =
    options?.format === undefined ? defaultCapture.format : options.format;
  if (format !== "webp" && format !== "jpeg" && format !== "png") {
    throw new CdpFault(
      "configuration",
      'capture.format must be "webp", "jpeg" or "png".',
    );
  }
  let bounds = defaultCapture;
  if (size && [size.width, size.height, size.dpr].every(positive)) {
    const scale = Math.min(
      size.dpr,
      maximumFrameDimension / size.width,
      maximumFrameDimension / size.height,
      Math.sqrt(maximumFrameArea / size.width / size.height),
    );
    bounds = {
      ...defaultCapture,
      maxWidth: Math.max(1, Math.floor(size.width * scale)),
      maxHeight: Math.max(1, Math.floor(size.height * scale)),
    };
  }
  const quality = setting(
    options?.quality,
    defaultCapture.quality,
    0,
    100,
    "capture.quality",
  );
  let maxWidth = setting(
    options?.maxWidth,
    bounds.maxWidth,
    1,
    maximumFrameDimension,
    "capture.maxWidth",
  );
  let maxHeight = setting(
    options?.maxHeight,
    bounds.maxHeight,
    1,
    maximumFrameDimension,
    "capture.maxHeight",
  );
  // Only automatic axes yield to the shared budget; fixed pairs are validated.
  if (options?.maxWidth === undefined) {
    maxWidth = Math.min(maxWidth, Math.floor(maximumFrameArea / maxHeight));
  }
  if (options?.maxHeight === undefined) {
    maxHeight = Math.min(maxHeight, Math.floor(maximumFrameArea / maxWidth));
  }
  if (maxWidth * maxHeight > maximumFrameArea) {
    throw new CdpFault(
      "configuration",
      `capture.maxWidth × capture.maxHeight must not exceed ${maximumFrameArea} pixels.`,
    );
  }
  return Object.freeze({ format, quality, maxWidth, maxHeight });
}

/** Retain omitted axes so they can follow the latest committed surface. */
export function capturePreferences(
  options?: ViewerCaptureOptions,
): ViewerCaptureOptions {
  const settings = captureSettings(options);
  return Object.freeze({
    format: settings.format,
    quality: settings.quality,
    ...(options?.maxWidth === undefined ? {} : { maxWidth: settings.maxWidth }),
    ...(options?.maxHeight === undefined
      ? {}
      : { maxHeight: settings.maxHeight }),
  });
}

/** Compare preferences, including quality retained for a later lossy format. */
export function sameCapture(
  a: ViewerCaptureOptions,
  b: ViewerCaptureOptions,
): boolean {
  return (
    a.format === b.format &&
    a.quality === b.quality &&
    a.maxWidth === b.maxWidth &&
    a.maxHeight === b.maxHeight
  );
}

/** Compare normalized settings that affect the native image stream. */
export function sameCaptureSettings(
  a: CaptureSettings,
  b: CaptureSettings,
): boolean {
  if (a.format === "png" && b.format === "png") {
    return a.maxWidth === b.maxWidth && a.maxHeight === b.maxHeight;
  }
  return sameCapture(a, b);
}
