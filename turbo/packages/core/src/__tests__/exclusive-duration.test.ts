import { describe, expect, it } from "vitest";

import { exclusiveDurationBreakdown } from "../exclusive-duration";

describe("exclusive duration breakdown", () => {
  it("separates sequential leaves, callback residual, and completion", () => {
    expect(
      exclusiveDurationBreakdown({
        startedAtMs: 8,
        finishedAtMs: 60,
        callbackFinishedAtMs: 50,
        leafDurationMs: 30,
      }),
    ).toEqual({
      totalMs: 52,
      completionMs: 10,
      residualMs: 12,
      overlapMs: 0,
    });
  });

  it("reports overlapping leaves instead of hiding an accounting error", () => {
    expect(
      exclusiveDurationBreakdown({
        startedAtMs: 10,
        finishedAtMs: 35,
        callbackFinishedAtMs: 30,
        leafDurationMs: 25,
      }),
    ).toEqual({
      totalMs: 25,
      completionMs: 5,
      residualMs: 0,
      overlapMs: 5,
    });
  });

  it("does not assign a completion tail before the callback ends", () => {
    expect(
      exclusiveDurationBreakdown({
        startedAtMs: 10,
        finishedAtMs: 30,
        leafDurationMs: 12,
      }),
    ).toEqual({
      totalMs: 20,
      completionMs: 0,
      residualMs: 8,
      overlapMs: 0,
    });
  });
});
