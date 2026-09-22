import { screen, waitFor, within } from "@testing-library/react";
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

const MAX_TICK_COUNT = 24;
const TICK_PITCH = 10;

async function setupLocatorConversation({
  threadId,
  turnCount,
}: {
  threadId: string;
  turnCount: number;
}) {
  mockChatGeometry();
  mockChatLifecycleWithoutBrowserSession({
    threadId,
    threadTitle: "Locator sampled history",
    chatEvents: conversationEvents(turnCount),
  });
  await setupPage({
    context,
    path: `/chats/${threadId}`,
    host: "app.okou.ai",
  });

  await screen.findByText(`Locator answer ${String(turnCount)}`);
  const container = chatScrollContainer();
  const rail = requiredElement("[data-conversation-locator]");
  const tickCount = Math.min(turnCount, MAX_TICK_COUNT);
  await waitFor(() => {
    expect(rail.querySelectorAll("[data-locator-tick]")).toHaveLength(
      tickCount,
    );
  });
  return { container, rail, tickCount };
}

function endpointMarkY(tickCount: number, endpoint: "first" | "last"): number {
  const halfTrack = ((tickCount - 1) * TICK_PITCH) / 2;
  return VIEWPORT_HEIGHT / 2 + (endpoint === "first" ? -halfTrack : halfTrack);
}

test("sampled markers preserve first-turn navigation beyond the rendered conversation", async () => {
  const user = userEvent.setup();
  const { container, rail, tickCount } = await setupLocatorConversation({
    threadId: "b0000000-0000-4000-a000-000000000825",
    // One turn above the compact scale limit proves that the whole thread is
    // sampled without making unrelated interaction cases render 60 events.
    turnCount: MAX_TICK_COUNT + 1,
  });
  expect(
    within(container).queryByText("Locator question 1"),
  ).not.toBeInTheDocument();

  await user.pointer({
    target: rail,
    coords: { clientX: 12, clientY: endpointMarkY(tickCount, "first") },
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
});

test("repeat marker selection restarts the landing feedback", async () => {
  const user = userEvent.setup();
  const { container, rail, tickCount } = await setupLocatorConversation({
    threadId: "b0000000-0000-4000-a000-000000000826",
    turnCount: 8,
  });

  await user.pointer({
    target: rail,
    coords: { clientX: 12, clientY: endpointMarkY(tickCount, "first") },
  });
  click(rail);
  await within(container).findByText("Locator question 1");
  await waitFor(() => {
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
  click(rail);
  await waitFor(() => {
    expect(firstHighlight).not.toBeInTheDocument();
    expect(
      messageAnchor("Locator question 1", container).querySelector(
        "[data-locator-landed]",
      ),
    ).toBeInTheDocument();
  });
});

test("selecting another marker moves the landing feedback", async () => {
  const user = userEvent.setup();
  const { container, rail, tickCount } = await setupLocatorConversation({
    threadId: "b0000000-0000-4000-a000-000000000827",
    turnCount: 8,
  });

  await user.pointer({
    target: rail,
    coords: { clientX: 12, clientY: endpointMarkY(tickCount, "first") },
  });
  click(rail);
  await within(container).findByText("Locator question 1");
  await waitFor(() => {
    expect(
      messageAnchor("Locator question 1", container).querySelector(
        "[data-locator-landed]",
      ),
    ).toBeInTheDocument();
  });

  await user.pointer({
    target: rail,
    coords: { clientX: 12, clientY: endpointMarkY(tickCount, "last") },
  });
  const preview = requiredElement("[data-conversation-locator-preview]");
  await waitFor(() => {
    expect(preview).toHaveTextContent("Locator question 8");
  });
  click(rail);
  await waitFor(() => {
    expect(messageOffset("Locator question 8", container)).toBeCloseTo(168);
    expect(messageOffset("Locator question 1", container)).toBeLessThan(0);
    expect(
      messageAnchor("Locator question 8", container).querySelector(
        "[data-locator-landed]",
      ),
    ).toBeInTheDocument();
    expect(
      messageAnchor("Locator question 1", container).querySelector(
        "[data-locator-landed]",
      ),
    ).not.toBeInTheDocument();
  });
});

test("leaving the locator hides its preview", async () => {
  const user = userEvent.setup();
  const { rail, tickCount } = await setupLocatorConversation({
    threadId: "b0000000-0000-4000-a000-000000000829",
    turnCount: 8,
  });

  await user.pointer({
    target: rail,
    coords: { clientX: 12, clientY: endpointMarkY(tickCount, "first") },
  });
  const preview = requiredElement("[data-conversation-locator-preview]");
  await waitFor(() => {
    expect(preview).toHaveTextContent("Locator question 1");
  });

  await user.unhover(rail);
  await waitFor(() => {
    expect(preview).not.toBeInTheDocument();
  });
});
