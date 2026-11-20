import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";

const context = testContext();

test("The greeting shows its complete sentence, one box per word", async () => {
  // A desktop window whose user asks for reduced motion.
  context.mocks.browser.matchMedia((query) => {
    return [
      SIDEBAR_DESKTOP_MEDIA_QUERY,
      "(min-width: 1280px)",
      "(prefers-reduced-motion: reduce)",
    ].includes(query);
  });

  await setupPage({ context, path: "/" });

  const greeting = await screen.findByTestId("chat-greeting");
  const heading = within(greeting).getByRole("heading");
  const sentence = heading.getAttribute("aria-label") ?? "";
  expect(sentence.trim()).not.toBe("");
  const boxes = [
    ...heading.querySelectorAll<HTMLElement>('[data-slot="chat-tagline-word"]'),
  ].map((box) => {
    return box.textContent ?? "";
  });
  expect(boxes).toStrictEqual(sentence.split(" "));
  expect(heading).toHaveAccessibleName(sentence);
});
