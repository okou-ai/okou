/// <reference types="node" />

import { fireEvent, render, screen } from "@testing-library/react";
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

// Happy DOM does not implement CSS animations or the Web Animations API.
// Model the browser-owned animation returned by each layer at this boundary.
function mockAnimation(layer: Element, startTime: number) {
  const animation = { startTime };
  Object.defineProperty(layer, "getAnimations", {
    configurable: true,
    value: () => {
      return [animation];
    },
  });
  return animation;
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

  it("keeps both layers of separately mounted indicators on one timeline", () => {
    const onAnimationStart = vi.fn();
    render(
      <RunningIndicator
        data-testid="first-running"
        onAnimationStart={onAnimationStart}
      />,
    );
    const first = screen.getByTestId("first-running");
    const outerAnimation = mockAnimation(first, 125);
    for (const layer of first.children) {
      const animation = mockAnimation(layer, 125);
      fireEvent.animationStart(layer);
      expect(animation.startTime).toBe(0);
    }
    expect(onAnimationStart).toHaveBeenCalledTimes(2);
    expect(outerAnimation.startTime).toBe(125);

    render(<RunningIndicator data-testid="second-running" />);
    for (const layer of screen.getByTestId("second-running").children) {
      const animation = mockAnimation(layer, 725);
      fireEvent.animationStart(layer);
      expect(animation.startTime).toBe(0);
    }
  });

  it.each([0, 1 / 12])(
    "realigns recreated animations without remounting at offset %s",
    (phaseOffset) => {
      render(
        <RunningIndicator
          data-testid="running-indicator"
          phaseOffset={phaseOffset}
        />,
      );
      const indicator = screen.getByTestId("running-indicator");

      for (const layer of indicator.children) {
        const initialAnimation = mockAnimation(layer, 125);
        fireEvent.animationStart(layer);
        expect(initialAnimation.startTime).toBe(0);

        // Hiding and showing an ancestor creates a new CSS animation on the
        // same element, rather than mounting a new RunningIndicator.
        const restartedAnimation = mockAnimation(layer, 975);
        fireEvent.animationStart(layer);
        expect(restartedAnimation.startTime).toBe(0);
      }
    },
  );

  it.each([
    { offset: 0, delay: 0 },
    { offset: 1 / 12, delay: -11 / 12 },
    { offset: 13 / 12, delay: -11 / 12 },
    { offset: 6406 / 12, delay: -1 / 6 },
  ])("enters the wave immediately for offset $offset", ({ offset, delay }) => {
    render(
      <RunningIndicator data-testid="running-indicator" phaseOffset={offset} />,
    );
    const indicator = screen.getByTestId("running-indicator");
    const phase = Number(
      indicator.style.getPropertyValue("--running-indicator-phase"),
    );
    expect(phase).toBeCloseTo(delay);
    expect(phase).toBeGreaterThan(-1);
    expect(phase).toBeLessThanOrEqual(0);
    expect(indicator).not.toHaveAttribute("phaseOffset");
  });

  it("follows a new row position without remounting or losing caller styles", () => {
    const { rerender } = render(
      <RunningIndicator
        data-testid="running-indicator"
        phaseOffset={1 / 12}
        className="ml-1"
        style={{ opacity: 0.5 }}
      />,
    );
    const indicator = screen.getByTestId("running-indicator");
    const animations = Array.from(indicator.children, (layer) => {
      const animation = mockAnimation(layer, 975);
      fireEvent.animationStart(layer);
      return animation;
    });
    rerender(
      <RunningIndicator
        data-testid="running-indicator"
        phaseOffset={3 / 12}
        className="ml-1"
        style={{ opacity: 0.5 }}
      />,
    );
    expect(screen.getByTestId("running-indicator")).toBe(indicator);
    expect(
      Number(indicator.style.getPropertyValue("--running-indicator-phase")),
    ).toBe(-0.75);
    expect(indicator.style.opacity).toBe("0.5");
    expect(indicator).toHaveClass("ml-1");
    for (const animation of animations) {
      expect(animation.startTime).toBe(0);
    }
    rerender(<RunningIndicator data-testid="running-indicator" />);
    expect(screen.getByTestId("running-indicator")).toBe(indicator);
    expect(
      Number(indicator.style.getPropertyValue("--running-indicator-phase")),
    ).toBe(0);
  });
});
