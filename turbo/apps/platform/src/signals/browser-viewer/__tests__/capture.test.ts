import { expect, test } from "vitest";
import { captureSettings, defaultCapture } from "../viewer/capture.ts";
import type { ViewerCaptureOptions } from "../viewer/types.ts";

test("retains independent defaults and accepts zero quality and dimension boundaries", () => {
  expect(captureSettings()).toStrictEqual(defaultCapture);
  expect(captureSettings({})).toStrictEqual(defaultCapture);
  expect(captureSettings({ quality: 0 })).toStrictEqual({
    ...defaultCapture,
    quality: 0,
  });
  expect(captureSettings({ maxWidth: 1280 })).toStrictEqual({
    ...defaultCapture,
    maxWidth: 1280,
  });
  expect(
    captureSettings({ quality: 100, maxWidth: 1, maxHeight: 4096 }),
  ).toStrictEqual({
    format: "webp",
    quality: 100,
    maxWidth: 1,
    maxHeight: 4096,
  });
});

test.each([
  { quality: -1 },
  { quality: 101 },
  { quality: 0.5 },
  { quality: Number.NaN },
  { maxWidth: 0 },
  { maxWidth: 4097 },
  { maxWidth: Infinity },
  { maxHeight: -1 },
  { maxHeight: 4097 },
  { maxHeight: 1.5 },
])("rejects out-of-range capture values: %j", (value) => {
  expect(() => {
    return captureSettings(value);
  }).toThrow(/capture\./);
});

test.each([
  null,
  [],
  false,
  { format: "avif" },
  { format: "WEBP" },
  { format: "" },
  { format: null },
  { format: 70 },
  { quality: null },
  { quality: "50" },
  { maxWidth: "1280" },
])("rejects malformed JavaScript settings: %j", (value) => {
  expect(() => {
    return captureSettings(value as ViewerCaptureOptions);
  }).toThrow(/capture/);
});
