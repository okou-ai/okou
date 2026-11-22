import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

async function greeting() {
  const tagline = await screen.findByTestId("chat-tagline");
  const fullLine = tagline.getAttribute("aria-label");
  const text = tagline.querySelector('[data-slot="chat-tagline-text"]');
  if (!fullLine || !text) {
    throw new Error("Expected the greeting and its displayed text");
  }
  return { tagline, fullLine, text };
}

/** Every word box that carries the entrance, in reading order. */
function tokens(text: Element): HTMLElement[] {
  return Array.from(
    text.querySelectorAll<HTMLElement>('[data-slot="chat-tagline-word"]'),
  );
}

test("The greeting shows its complete sentence, one box per word", async () => {
  context.mocks.browser.matchMedia(false);

  await setupPage({
    context,
    path: `/?compose=1`,
  });

  const { tagline, fullLine, text } = await greeting();
  // The sentence is complete from the first frame. Each word arrives on its
  // own, so a reader never sees a partial line and the row it sits in never
  // has to move; how a word arrives is a stylesheet decision, and the deployed
  // greeting test owns it.
  expect(text.textContent).toBe(fullLine);
  expect(tagline).toHaveAccessibleName(fullLine);
  expect(
    tokens(text).map((box) => {
      return box.textContent;
    }),
  ).toStrictEqual(fullLine.split(" "));
});

test("The avatar leads the sentence", async () => {
  context.mocks.browser.matchMedia(false);

  await setupPage({
    context,
    path: `/?compose=1`,
  });

  const row = await screen.findByTestId("chat-greeting");
  const avatarBox = row.querySelector('[data-slot="chat-greeting-avatar"]');
  const tagline = await screen.findByTestId("chat-tagline");
  if (!avatarBox) {
    throw new Error("Expected the avatar to lead the greeting row");
  }
  expect(row.firstElementChild).toBe(avatarBox);
  expect(
    avatarBox.compareDocumentPosition(tagline) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
