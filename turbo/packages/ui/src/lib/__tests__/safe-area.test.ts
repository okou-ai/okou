import { afterEach, describe, expect, it } from "vitest";

import { resolveCollisionPadding } from "../safe-area";

const INSETS = ["--sat", "--sar", "--okou-safe-b", "--sal"] as const;

function setInsets(values: Partial<Record<(typeof INSETS)[number], string>>) {
  for (const [property, value] of Object.entries(values)) {
    document.documentElement.style.setProperty(property, value);
  }
}

afterEach(() => {
  for (const property of INSETS) {
    document.documentElement.style.removeProperty(property);
  }
});

// Base UI's positioner is a JavaScript engine measuring against the raw
// viewport, so this is the one safe-area decision CSS cannot express. Roughly
// 190 anchored surfaces rely on the default; five state a gap of their own.
describe("anchored collision boundary", () => {
  it("keeps a gap from every edge when the device reserves nothing", () => {
    expect(resolveCollisionPadding(undefined)).toStrictEqual({
      top: 12,
      right: 12,
      bottom: 12,
      left: 12,
    });
  });

  it("adds each reserved edge to that gap", () => {
    setInsets({
      "--sat": "59px",
      "--sar": "44px",
      "--okou-safe-b": "34px",
      "--sal": "44px",
    });

    expect(resolveCollisionPadding(undefined)).toStrictEqual({
      top: 71,
      right: 56,
      bottom: 46,
      left: 56,
    });
  });

  // The bottom reads the keyboard-aware property, so a menu anchored above an
  // open keyboard does not reserve the home indicator hidden behind it.
  it("drops the bottom reserve once the keyboard retires it", () => {
    setInsets({ "--okou-safe-b": "0px", "--sat": "59px" });

    const padding = resolveCollisionPadding(undefined);

    expect(padding.bottom).toBe(12);
    expect(padding.top).toBe(71);
  });

  // A caller asking for more room is not asking for less protection. Letting
  // the request replace the default would silently strip the insets from the
  // few surfaces that state a gap of their own.
  it("widens rather than replaces a caller's request", () => {
    setInsets({ "--okou-safe-b": "34px" });

    expect(resolveCollisionPadding(16)).toStrictEqual({
      top: 16,
      right: 16,
      bottom: 46,
      left: 16,
    });
  });

  it("widens a per-side request the same way", () => {
    setInsets({ "--sat": "59px" });

    expect(resolveCollisionPadding({ top: 4, bottom: 40 })).toStrictEqual({
      top: 71,
      right: 12,
      bottom: 40,
      left: 12,
    });
  });

  it("ignores a property that does not resolve to a length", () => {
    setInsets({ "--sat": "auto" });

    expect(resolveCollisionPadding(undefined).top).toBe(12);
  });
});
