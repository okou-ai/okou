import { describe, expect, it } from "vitest";

import { nativeSvgPath } from "../svg-path";

describe("SVG path normalization", () => {
  it("preserves relative subpaths, close commands and horizontal/vertical lines", () => {
    expect(nativeSvgPath("m10 20 h30 v40 l-10 -5 z m50 0 h5")).toEqual({
      points: [
        { x: 10, y: 20, moveTo: true },
        { x: 40, y: 20 },
        { x: 40, y: 60 },
        { x: 30, y: 55 },
        { close: true },
        { x: 60, y: 20, moveTo: true },
        { x: 65, y: 20 },
      ],
    });
  });

  it("expands reflected cubic and quadratic control points", () => {
    expect(
      nativeSvgPath("M0 0 C10 0 10 10 20 10 S30 20 40 10 Q50 0 60 10 T80 10"),
    ).toEqual({
      points: [
        { x: 0, y: 0, moveTo: true },
        {
          x: 20,
          y: 10,
          curve: { type: "cubic", x1: 10, y1: 0, x2: 10, y2: 10 },
        },
        {
          x: 40,
          y: 10,
          curve: { type: "cubic", x1: 30, y1: 10, x2: 30, y2: 20 },
        },
        { x: 60, y: 10, curve: { type: "quadratic", x1: 50, y1: 0 } },
        { x: 80, y: 10, curve: { type: "quadratic", x1: 70, y1: 20 } },
      ],
    });
  });

  it("approximates an elliptical arc with cubic curves and keeps its endpoints", () => {
    const result = nativeSvgPath("M10 0 A10 10 0 0 1 0 10");
    expect(result).toHaveProperty("points");
    if (!("points" in result)) throw new Error(result.unsupported);
    expect(result.points[0]).toEqual({ x: 10, y: 0, moveTo: true });
    const last = result.points.at(-1);
    if (!last || !("curve" in last)) throw new Error("Arc must remain a curve");
    expect(last.x).toBeCloseTo(0, 10);
    expect(last.y).toBeCloseTo(10, 10);
    expect(last.curve.type).toBe("cubic");
    expect(last.curve.x1).toBeCloseTo(10, 10);
    expect(last.curve.y1).toBeCloseTo(5.5228475, 6);
  });

  it("retains empty paths and reports malformed or non-finite paths without partial geometry", () => {
    expect(nativeSvgPath("")).toEqual({ points: [] });
    expect(nativeSvgPath("M0 0 L10")).toHaveProperty("unsupported");
    expect(nativeSvgPath("M0 0 L1e999 10")).toHaveProperty("unsupported");
  });
});
