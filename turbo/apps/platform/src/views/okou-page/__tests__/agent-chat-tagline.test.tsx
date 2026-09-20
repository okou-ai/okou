import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000002";

function mountedAgent(): void {
  context.mocks.data.agents([
    {
      agentId: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Nova",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
    },
  ]);
}

/**
 * The greeting is centred, so the width of this heading is what holds the
 * avatar in place; a line that grew by one character every 40ms would walk the
 * avatar left across the whole animation. jsdom has no layout, so the box
 * cannot be measured here — what it can show is the guarantee behind the
 * width: the complete line is in the heading from the first observable frame,
 * and the typed text only ever paints over it.
 */
test("The tagline holds its full line while it types", async () => {
  mountedAgent();

  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });

  const tagline = await screen.findByTestId("chat-tagline");
  const fullLine = tagline.getAttribute("aria-label");
  expect(fullLine).toBeTruthy();

  // The whole line is in the heading and hidden from both the page and the
  // accessibility tree, which is what holds the box open. Asserted through the
  // hidden copy rather than through the number or order of elements, so that
  // reserving the same width another way stays free to pass.
  const reserved = tagline.querySelector("[aria-hidden='true']");
  expect(reserved).toBeInTheDocument();
  expect(reserved?.textContent).toBe(fullLine);

  // Whatever the typewriter has reached is a prefix of that same line, so the
  // visible text can never ask for more room than is already reserved.
  const typed = tagline.querySelector("[aria-hidden='true'] ~ *");
  expect(fullLine?.startsWith(typed?.textContent ?? "")).toBeTruthy();

  await waitFor(() => {
    expect(typed?.textContent).toBe(fullLine);
  });
  expect(reserved?.textContent).toBe(fullLine);
});

/**
 * The avatar reaches the row before the line does, because the line needs the
 * agent's name, so it stands centred on its own until that resolves and the
 * reserved line then moves it left by half of what the line occupies. The
 * travel is a CSS transition, which jsdom has no layout to run; what it can
 * hold is the pair of values the transition is written against, and that both
 * of them come from the line this page is rendering rather than from anything
 * an earlier visit left behind.
 */
test("The greeting settles against the line it is rendering", async () => {
  mountedAgent();

  await setupPage({ context, path: `/agents/${AGENT_ID}/chat` });

  const greeting = await screen.findByTestId("chat-greeting");
  const fullLine = screen
    .getByTestId("chat-tagline")
    .getAttribute("aria-label");
  expect(fullLine).toBeTruthy();

  // The row is settled because the line is on it, so the avatar is left where
  // the layout puts it rather than held at the centre of an empty row.
  expect(greeting.dataset.settled).toBe("true");

  // The travel accompanies the typing, so its length is the line's own: one
  // character every 40ms. A duration read from anywhere else would drift from
  // the run it is supposed to last as long as.
  expect(
    greeting.style.getPropertyValue("--chat-greeting-settle-duration"),
  ).toBe(`${String((fullLine ?? "").length * 40)}ms`);
});
