import { waitFor } from "@testing-library/react";
import { waitForAnimationFrame } from "../../../signals/utils.ts";
import { expect, test, vi } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

async function greeting(reducedMotion: boolean) {
  vi.stubGlobal("IntersectionObserver", undefined);
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(min-width: 48rem)" ||
      (query === "(prefers-reduced-motion: reduce)" && reducedMotion)
    );
  });
  await setupPage({ context, path: "/" });
  const drawing = await waitFor(() => {
    const svg = document.querySelector(
      '[data-slot="chat-greeting-avatar"] button svg[data-okou-avatar]',
    );
    if (!svg) {
      throw new Error("The Home greeting has no avatar artwork");
    }
    return svg;
  });
  const pose = () => {
    return Array.from(drawing.querySelectorAll("[transform]"), (node) => {
      return node.getAttribute("transform");
    });
  };
  const initial = pose();
  expect(initial.length).toBeGreaterThan(0);
  return { drawing, initial, pose };
}

test("agent-chat-avatar-texture-006 revised member Home greeting moves the Okou artwork", async () => {
  const { drawing, initial, pose } = await greeting(false);
  expect(drawing).toHaveAttribute("data-okou-avatar", "animated");
  await waitFor(() => {
    expect(pose()).not.toStrictEqual(initial);
  });
});

test("The same greeting holds a still pose for reduced motion", async () => {
  const { drawing, initial, pose } = await greeting(true);
  await waitForAnimationFrame(context.signal);
  await waitForAnimationFrame(context.signal);
  expect(drawing).toHaveAttribute("data-okou-avatar", "static");
  expect(pose()).toStrictEqual(initial);
});
