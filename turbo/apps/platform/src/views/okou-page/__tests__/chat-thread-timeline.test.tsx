import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { createMessageExperienceHelpers } from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installMessageExperienceChat } =
  createMessageExperienceHelpers(context);
const RUN_ID = "a0000000-0000-4000-a000-000000000901";
const NOW = "2026-10-28T12:00:00.000Z";

function prompt(content: string, createdAt: string): MockChatEventInput {
  return {
    id: content,
    role: "user",
    content,
    createdAt,
    runId: RUN_ID,
  };
}

async function openChat(
  events: MockChatEventInput[],
  lastMessage: string,
  timelineEnabled = true,
) {
  mockNow(new Date(NOW), context.signal);
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: events,
  });
  await setupPage({
    context,
    path: `/chats/${context.resourceId}`,
    featureSwitches: {
      [FeatureSwitchKey.ChatThreadTimeline]: timelineEnabled,
    },
  });
  const message = await screen.findByText(lastMessage);
  const transcript = message.closest<HTMLElement>("[data-message-container]");
  if (!transcript) {
    throw new Error("Expected the message in the chat transcript");
  }
  return within(transcript);
}

test("Chat history keeps its existing appearance when the timeline switch is off", async () => {
  const chat = await openChat(
    [
      prompt("Yesterday's plan", "2026-10-27T10:00:00.000Z"),
      prompt("Today's plan", "2026-10-28T10:00:00.000Z"),
    ],
    "Today's plan",
    false,
  );

  expect(chat.getByText("Yesterday's plan")).toBeInTheDocument();
  expect(chat.queryByRole("separator", { name: "Yesterday" })).toBeNull();
  expect(chat.queryByRole("separator", { name: "Today" })).toBeNull();
});

test("Chat dates separate days once and include the year only for past years", async () => {
  const chat = await openChat(
    [
      prompt("Save last year's priorities", "2025-12-18T10:00:00.000Z"),
      prompt("Plan the week", "2026-10-26T10:00:00.000Z"),
      prompt("Review yesterday's plan", "2026-10-27T10:00:00.000Z"),
      prompt("Add another priority", "2026-10-27T11:00:00.000Z"),
      prompt("Review today's plan", "2026-10-28T10:00:00.000Z"),
    ],
    "Review today's plan",
  );

  expect(
    chat.getAllByRole("separator").map((separator) => {
      return separator.textContent;
    }),
  ).toStrictEqual(["Dec 18, 2025", "Oct 26", "Yesterday", "Today"]);
});

test("A conversation containing only today's messages does not need a Today divider", async () => {
  const chat = await openChat(
    [prompt("Start a new conversation", "2026-10-28T10:00:00.000Z")],
    "Start a new conversation",
  );

  expect(chat.getByText("Start a new conversation")).toBeInTheDocument();
  expect(chat.queryByRole("separator", { name: "Today" })).toBeNull();
});

test("Older history does not enable Today without a Yesterday section", async () => {
  const chat = await openChat(
    [
      prompt("An earlier discussion", "2026-10-26T10:00:00.000Z"),
      prompt("Continue the discussion", "2026-10-28T10:00:00.000Z"),
    ],
    "Continue the discussion",
  );

  expect(chat.getByRole("separator", { name: "Oct 26" })).toBeInTheDocument();
  expect(chat.queryByRole("separator", { name: "Today" })).toBeNull();
});

test("Messages in the same user turn receive a date boundary at local midnight", async () => {
  const chat = await openChat(
    [
      prompt("A late-night note", new Date(2026, 9, 27, 23, 59).toISOString()),
      prompt(
        "An early-morning note",
        new Date(2026, 9, 28, 0, 1).toISOString(),
      ),
    ],
    "An early-morning note",
  );

  const yesterday = chat.getByRole("separator", { name: "Yesterday" });
  const today = chat.getByRole("separator", { name: "Today" });
  expect(yesterday).toBeInTheDocument();
  expect(today).toBeInTheDocument();
  expect(
    today.compareDocumentPosition(chat.getByText("An early-morning note")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
});

test("Hidden lifecycle events from yesterday do not create a Yesterday section", async () => {
  const chat = await openChat(
    [
      {
        id: "yesterday-completion",
        eventType: "run.completed",
        content: null,
        runId: "a0000000-0000-4000-a000-000000000902",
        createdAt: "2026-10-27T10:00:00.000Z",
      },
      prompt("Today's first visible message", "2026-10-28T10:00:00.000Z"),
    ],
    "Today's first visible message",
  );

  expect(chat.queryByRole("separator", { name: "Yesterday" })).toBeNull();
  expect(chat.queryByRole("separator", { name: "Today" })).toBeNull();
});

test("An assistant reply can open a new date section", async () => {
  const chat = await openChat(
    [
      prompt(
        "Review the overnight plan",
        new Date(2026, 9, 26, 23, 50).toISOString(),
      ),
      {
        id: "overnight-reply",
        role: "assistant",
        content: "The overnight review is ready.",
        runId: RUN_ID,
        createdAt: "2026-10-27T10:00:00.000Z",
      },
      {
        ...prompt("Continue today", "2026-10-28T10:00:00.000Z"),
        runId: "a0000000-0000-4000-a000-000000000903",
      },
    ],
    "Continue today",
  );

  const yesterday = chat.getByRole("separator", { name: "Yesterday" });
  expect(
    yesterday.compareDocumentPosition(
      chat.getByText("The overnight review is ready."),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  expect(chat.getByRole("separator", { name: "Today" })).toBeInTheDocument();
});
