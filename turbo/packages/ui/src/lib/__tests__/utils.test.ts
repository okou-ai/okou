import { describe, expect, it } from "vitest";

import { cn } from "../utils";

// `cn` exists so the last class a caller writes wins. A class the merger cannot
// classify belongs to no group, therefore conflicts with nothing, and both
// copies reach the DOM — at which point stylesheet order decides and a caller's
// override silently stops working. The safe-area utilities are the newest way
// to land in that hole, because neither `safe` nor `safe-or-8` is a number.
describe("safe-area class merging", () => {
  it.each([
    ["p-safe", "p-6"],
    ["pb-safe", "pb-4"],
    ["pb-safe-or-8", "pb-4"],
    ["pb-safe-offset-4", "pb-2"],
    ["bottom-safe-or-6", "bottom-4"],
    ["top-safe-offset-6", "top-4"],
    ["-mb-safe-offset-6", "mb-0"],
  ])("lets a later value replace %s", (safe, override) => {
    expect(cn(safe, override)).toBe(override);
  });

  it.each([
    ["p-6", "p-safe"],
    ["pb-4", "pb-safe"],
    ["pb-4", "pb-safe-or-8"],
    ["bottom-4", "bottom-safe-or-6"],
  ])("lets %s be replaced by the safe-area class", (base, safe) => {
    expect(cn(base, safe)).toBe(safe);
  });

  it("replaces one safe-area gutter with another", () => {
    expect(cn("pb-safe-or-8", "pb-safe-or-12")).toBe("pb-safe-or-12");
    expect(cn("pb-safe-or-8", "pb-safe")).toBe("pb-safe");
    expect(cn("pb-safe-or-8", "pb-safe-or-[10vh]")).toBe("pb-safe-or-[10vh]");
  });

  it("keeps classes that set different properties", () => {
    expect(cn("pb-safe-or-8", "mb-4")).toBe("pb-safe-or-8 mb-4");
    expect(cn("bottom-safe-or-6", "pb-safe")).toBe("bottom-safe-or-6 pb-safe");
  });

  it("lets the shorthand supersede a single side", () => {
    expect(cn("pb-4", "p-safe")).toBe("p-safe");
  });
});
