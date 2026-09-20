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

  // Two layers, not one: the first carries the whole line and is hidden from
  // both the page and the accessibility tree, the second carries whatever has
  // been typed so far. Asserting they are separate elements is what keeps this
  // test from passing once the reserving copy is deleted -- the progress
  // assertions below would still hold against a single self-sizing line.
  const [reserved, typed] = Array.from(tagline.children);
  expect(tagline.children).toHaveLength(2);
  expect(reserved?.getAttribute("aria-hidden")).toBe("true");
  expect(reserved?.textContent).toBe(fullLine);

  // Whatever the typewriter has reached is a prefix of that same line, so the
  // two layers can never disagree about where the box ends.
  expect(fullLine?.startsWith(typed?.textContent ?? "")).toBeTruthy();

  await waitFor(() => {
    expect(typed?.textContent).toBe(fullLine);
  });
  expect(reserved?.textContent).toBe(fullLine);
});
