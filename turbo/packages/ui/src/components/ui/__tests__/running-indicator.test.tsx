/// <reference types="node" />

import { render, screen } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunningIndicator } from "../running-indicator";

const packageStylesPath = resolve(process.cwd(), "src/styles/globals.css");
const globalsCss = readFileSync(
  existsSync(packageStylesPath)
    ? packageStylesPath
    : resolve(process.cwd(), "packages/ui/src/styles/globals.css"),
  "utf8",
);

/**
 * Returns the declaration body of the rule that `selector` introduces. A class
 * also appears inside other rules' selector lists, so skip any occurrence that
 * is not followed directly by its own opening brace.
 */
function getCssBlock(selector: string) {
  for (
    let selectorIndex = globalsCss.indexOf(selector);
    selectorIndex !== -1;
    selectorIndex = globalsCss.indexOf(
      selector,
      selectorIndex + selector.length,
    )
  ) {
    const openingBraceIndex = globalsCss.indexOf("{", selectorIndex);
    if (openingBraceIndex === -1) {
      break;
    }
    const betweenSelectorAndBrace = globalsCss.slice(
      selectorIndex + selector.length,
      openingBraceIndex,
    );
    if (betweenSelectorAndBrace.trim() !== "") {
      continue;
    }

    let depth = 0;
    for (let index = openingBraceIndex; index < globalsCss.length; index += 1) {
      if (globalsCss[index] === "{") {
        depth += 1;
      } else if (globalsCss[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          return globalsCss.slice(openingBraceIndex + 1, index);
        }
      }
    }
    break;
  }

  throw new Error(`Missing CSS rule for ${selector}`);
}

describe("RunningIndicator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the center and ripple layers concentric", () => {
    render(<RunningIndicator data-testid="running-indicator" />);

    const indicator = screen.getByTestId("running-indicator");
    expect(indicator).toHaveAttribute("aria-hidden", "true");
    expect(indicator.children).toHaveLength(2);

    for (const layer of indicator.children) {
      expect(layer).toHaveAttribute("aria-hidden", "true");
      expect(layer).toHaveClass("top-1/2", "left-1/2");
      expect(layer.getAttribute("class")).toContain(
        "[transform:translate(-50%,-50%)",
      );
    }

    const centerKeyframes = getCssBlock("@keyframes running-indicator-center");
    const rippleKeyframes = getCssBlock("@keyframes running-indicator-ripple");
    expect(centerKeyframes).not.toMatch(/transform:(?![^;]*translate\()/);
    expect(rippleKeyframes).not.toMatch(/transform:(?![^;]*translate\()/);
  });

  it("sets the resting offset through transform, not translate or scale", () => {
    render(<RunningIndicator data-testid="running-indicator" />);

    // The keyframes animate `transform`. Tailwind's `translate-*` and `scale-*`
    // utilities set the individual CSS properties, which compose on top of the
    // animation instead of being replaced by it and double the centring offset
    // for the whole cycle.
    for (const layer of screen.getByTestId("running-indicator").children) {
      expect(layer.getAttribute("class")).not.toMatch(
        /(^|\s)-?translate-[xy]-/,
      );
      expect(layer.getAttribute("class")).not.toMatch(/(^|\s)scale-/);
    }
  });

  it("keeps a distinct resting state before animations start", () => {
    render(<RunningIndicator data-testid="running-indicator" />);

    const [center, ripple] = screen.getByTestId("running-indicator").children;
    expect(center).toHaveClass(
      "[transform:translate(-50%,-50%)_scale(0.64)]",
      "opacity-[0.34]",
    );
    expect(ripple).toHaveClass(
      "[transform:translate(-50%,-50%)_scale(0.8)]",
      "opacity-0",
    );
  });

  it("keeps indicators mounted at different times on one pulse phase", () => {
    const now = vi.spyOn(Date, "now");

    now.mockReturnValue(125);
    const first = render(<RunningIndicator data-testid="first-running" />);

    now.mockReturnValue(725);
    const second = render(<RunningIndicator data-testid="second-running" />);

    const firstDelay = Number.parseInt(
      first
        .getByTestId("first-running")
        .style.getPropertyValue("--running-indicator-delay"),
      10,
    );
    const secondDelay = Number.parseInt(
      second
        .getByTestId("second-running")
        .style.getPropertyValue("--running-indicator-delay"),
      10,
    );

    const observationTime = 800;
    const firstPhase = observationTime - 125 - firstDelay;
    const secondPhase = observationTime - 725 - secondDelay;

    expect(firstPhase).toBe(observationTime);
    expect(secondPhase).toBe(observationTime);
  });
});
