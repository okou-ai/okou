import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import {
  conversationEvents,
  messageAnchor,
  messageOffset,
  mockChatGeometry,
  requiredElement,
  VIEWPORT_HEIGHT,
} from "./chat-conversation-locator-test-helpers.ts";
import {
  chatScrollContainer,
  context,
  mockChatLifecycleWithoutBrowserSession,
  setupPage,
} from "./chat-lifecycle-test-helpers.ts";

const THREAD_ID = "b0000000-0000-4000-a000-000000000825";

test("sampled user markers preview and navigate beyond the rendered conversation", async () => {
  const user = userEvent.setup();
  mockChatGeometry();
  mockChatLifecycleWithoutBrowserSession({
    threadId: THREAD_ID,
    threadTitle: "Locator sampled history",
    chatEvents: conversationEvents(30),
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });

  await screen.findByText("Locator answer 30");
  const container = chatScrollContainer();
  expect(
    within(container).queryByText("Locator question 1"),
  ).not.toBeInTheDocument();

  // Native scrolling reports the initial tail position after the DOM commit.
  fireEvent.scroll(container);
  const rail = requiredElement("[data-conversation-locator]");
  await waitFor(() => {
    expect(rail.querySelectorAll("[data-locator-tick]")).toHaveLength(24);
  });

  // The compact 24-mark scale has a 10px pitch around the rail's center.
  const firstMarkY = VIEWPORT_HEIGHT / 2 - 115;
  const lastMarkY = VIEWPORT_HEIGHT / 2 + 115;
  await user.pointer({
    target: rail,
    coords: { clientX: 12, clientY: firstMarkY },
  });
  const preview = requiredElement("[data-conversation-locator-preview]");
  await waitFor(() => {
    expect(preview).toHaveTextContent("Locator question 1");
  });
  click(rail);

  await within(container).findByText("Locator question 1");
  await waitFor(() => {
    // The first message cannot move below the top edge without overscrolling.
    expect(messageOffset("Locator question 1", container)).toBe(0);
    expect(
      messageAnchor("Locator question 1", container).querySelector(
        "[data-locator-landed]",
      ),
    ).toBeInTheDocument();
  });

  const firstHighlight = requiredElement(
    "[data-locator-landed]",
    messageAnchor("Locator question 1", container),
  );
  // A repeat selection starts the CSS landing animation again on this turn.
  click(rail);
  await waitFor(() => {
    expect(firstHighlight).not.toBeInTheDocument();
    expect(
      messageAnchor("Locator question 1", container).querySelector(
        "[data-locator-landed]",
      ),
    ).toBeInTheDocument();
  });

  await user.pointer({
    target: rail,
    coords: { clientX: 12, clientY: lastMarkY },
  });
  await waitFor(() => {
    expect(preview).toHaveTextContent("Locator question 30");
  });
  click(rail);
  await waitFor(() => {
    expect(messageOffset("Locator question 30", container)).toBeCloseTo(168);
    expect(messageOffset("Locator question 1", container)).toBeLessThan(0);
    expect(
      messageAnchor("Locator question 30", container).querySelector(
        "[data-locator-landed]",
      ),
    ).toBeInTheDocument();
    expect(
      messageAnchor("Locator question 1", container).querySelector(
        "[data-locator-landed]",
      ),
    ).not.toBeInTheDocument();
  });

  await user.unhover(rail);
  await waitFor(() => {
    expect(preview).not.toBeInTheDocument();
  });
});
