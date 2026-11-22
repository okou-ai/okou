import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  conversationEvents,
  mockChatGeometry,
  messageOffset,
  messageAnchor,
  requiredElement,
} from "./chat-conversation-locator-test-helpers.ts";
import { RUN_PATH, RUN_THREAD_ID } from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

async function firstMarker(turns: number) {
  vi.stubEnv("TZ", "UTC");
  mockChatGeometry();
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    chatEvents: conversationEvents(turns),
  });
  await setupPage({ context, path: RUN_PATH });
  await screen.findByText("Locator answer " + turns);
  const rail = requiredElement("[data-conversation-locator]");
  await waitFor(() => {
    expect(rail.querySelectorAll("[data-locator-tick]")).toHaveLength(
      Math.min(turns, 24),
    );
  });
  fireEvent.pointerMove(rail, {
    clientY: (600 - (Math.min(turns, 24) - 1) * 10) / 2,
  });
  return rail;
}
test("chat-conversation-locator-001 first sampled marker previews the timestamp of the unrendered opening question", async () => {
  await firstMarker(25);
  expect(screen.queryByText("Locator question 1")).toBeNull();
  const time = await screen.findByText("Aug 1, 10:00 AM", { selector: "time" });
  expect(time).toHaveAttribute("datetime", "2026-08-01T10:00:00.000Z");
});
test("chat-conversation-locator-005 leaving the locator dismisses the first turn timestamp", async () => {
  const rail = await firstMarker(8);
  await screen.findByText("Aug 1, 10:00 AM", { selector: "time" });
  fireEvent.pointerLeave(rail);
  await waitFor(() => {
    expect(
      screen.queryByText("Aug 1, 10:00 AM", { selector: "time" }),
    ).toBeNull();
  });
});

test("chat-conversation-locator-002 selecting the oldest marker unmounts the far end of a thirty-turn transcript", async () => {
  const rail = await firstMarker(30);
  const pane = requiredElement("[data-scroll-container]");
  expect(screen.queryByText("Locator question 1")).not.toBeInTheDocument();
  await screen.findByText("Aug 1, 10:00 AM", { selector: "time" });
  click(rail);
  await screen.findByText("Locator question 1");
  await waitFor(() => {
    expect(messageOffset("Locator question 1", pane)).toBe(0);
    expect(
      messageAnchor("Locator question 1", pane).querySelector(
        "[data-locator-landed]",
      ),
    ).toBeInTheDocument();
  });
  expect(screen.queryByText("Locator answer 24")).not.toBeInTheDocument();
  expect(screen.queryByText("Locator answer 30")).not.toBeInTheDocument();
});
