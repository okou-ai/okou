import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OkouAvatar } from "../okou-avatar";

function mockReducedMotion(reduce: boolean): void {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    return {
      matches: reduce && query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  });
}

/** Captures animation frames so a test decides when time passes. */
function captureFrames(): { advance: (now: number) => void } {
  let pending: FrameRequestCallback | null = null;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    pending = callback;
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
    pending = null;
  });
  return {
    advance: (now) => {
      const callback = pending;
      pending = null;
      act(() => {
        callback?.(now);
      });
    },
  };
}

/** Lets a test scroll avatars in and out of view. */
function captureVisibility(): { show: (visible: boolean) => void } {
  const callbacks: IntersectionObserverCallback[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  return {
    show: (visible) => {
      act(() => {
        for (const callback of callbacks) {
          callback(
            [{ isIntersecting: visible } as IntersectionObserverEntry],
            {} as IntersectionObserver,
          );
        }
      });
    },
  };
}

/** The pose the rig drew: the head group's transform for this frame. */
function headPose(container: HTMLElement): string | null {
  return (
    container.querySelector('[id$="head-motion"]')?.getAttribute("transform") ??
    null
  );
}

describe("OkouAvatar", () => {
  it("draws Okou inside a smoothed square frame over the brand texture", () => {
    mockReducedMotion(false);
    const { container } = render(<OkouAvatar size={40} motion="static" />);

    const avatar = container.querySelector("svg[data-okou-avatar]");
    expect(avatar).toHaveAttribute("data-okou-avatar", "static");
    expect(avatar).toHaveAttribute("width", "40");
    expect(avatar).toHaveAttribute("aria-hidden", "true");
    expect(avatar?.querySelector("clipPath path")).toHaveAttribute(
      "d",
      expect.stringMatching(/^M.*a12 12 0 0 1/u),
    );
    expect(avatar?.querySelector("image")).toHaveAttribute(
      "href",
      expect.stringContaining("drop-lightblue-blue.svg"),
    );
    expect(headPose(container)).not.toBeNull();
  });

  it("is named when it stands for Okou on its own", () => {
    mockReducedMotion(false);
    render(<OkouAvatar size={32} motion="static" label="Okou" />);

    expect(screen.getByRole("img", { name: "Okou" })).toBeInTheDocument();
  });

  it("plays its mood over time when animated", () => {
    mockReducedMotion(false);
    const frames = captureFrames();
    const visibility = captureVisibility();
    const { container } = render(<OkouAvatar size={56} mood="idle" />);
    visibility.show(true);

    expect(container.querySelector("svg[data-okou-avatar]")).toHaveAttribute(
      "data-okou-avatar",
      "animated",
    );
    frames.advance(1000);
    const first = headPose(container);
    frames.advance(3000);
    expect(headPose(container)).not.toBe(first);
  });

  it("stops drawing while scrolled out of view and resumes where it left off", () => {
    mockReducedMotion(false);
    const frames = captureFrames();
    const visibility = captureVisibility();
    const { container } = render(<OkouAvatar size={56} mood="idle" />);
    visibility.show(true);
    frames.advance(1000);
    frames.advance(2000);
    const beforeLeaving = headPose(container);

    visibility.show(false);
    frames.advance(5000);
    expect(headPose(container)).toBe(beforeLeaving);

    // Time spent off screen is not skipped over: the next frames continue the
    // motion from the pose it left on.
    visibility.show(true);
    frames.advance(9000);
    expect(headPose(container)).toBe(beforeLeaving);
    frames.advance(10_000);
    expect(headPose(container)).not.toBe(beforeLeaving);
  });

  it("holds the same still frame for reduced-motion users", () => {
    mockReducedMotion(true);
    const frames = captureFrames();
    const { container } = render(<OkouAvatar size={56} mood="idle" />);
    const still = render(<OkouAvatar size={56} mood="idle" motion="static" />);

    expect(container.querySelector("svg[data-okou-avatar]")).toHaveAttribute(
      "data-okou-avatar",
      "static",
    );
    frames.advance(3000);
    expect(headPose(container)).toBe(headPose(still.container));
  });
});
