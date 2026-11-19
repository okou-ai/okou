import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
  promptEvent,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const FIRST_RUN_ID = "a0000000-0000-4000-a000-000000000611";
const SECOND_RUN_ID = "a0000000-0000-4000-a000-000000000612";

/** A wall-clock time on the viewer's local calendar, as an ISO timestamp. */
function localTime(
  month: number,
  day: number,
  hours: number,
  minutes: number,
): string {
  return new Date(2026, month - 1, day, hours, minutes).toISOString();
}

function viewOnOctober28(): void {
  mockNow(new Date(2026, 9, 28, 12, 0), context.signal);
}

async function openConversation(
  chatEvents: MockChatEventInput[],
): Promise<void> {
  installRunChat({ chatEvents });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
}

function dateSeparator(label: string): HTMLElement | null {
  return screen.queryByRole("separator", { name: label });
}

function precedes(first: Node, second: Node): boolean {
  return Boolean(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

test("A conversation containing only today's messages does not need a Today divider", async () => {
  viewOnOctober28();
  await openConversation([
    promptEvent({
      id: "today-request",
      runId: FIRST_RUN_ID,
      seqId: 1,
      text: "Summarize this morning's notes",
      createdAt: localTime(10, 28, 9, 0),
    }),
  ]);

  await expect(
    screen.findByText("Summarize this morning's notes"),
  ).resolves.toBeVisible();
  expect(dateSeparator("Today")).not.toBeInTheDocument();
});

test("Messages in the same user turn receive a date boundary at local midnight", async () => {
  viewOnOctober28();
  await openConversation([
    promptEvent({
      id: "late-request",
      runId: FIRST_RUN_ID,
      seqId: 1,
      text: "Start the overnight import",
      createdAt: localTime(10, 27, 23, 59),
    }),
    promptEvent({
      id: "early-follow-up",
      runId: FIRST_RUN_ID,
      seqId: 2,
      text: "Also include the archived rows",
      createdAt: localTime(10, 28, 0, 1),
    }),
  ]);

  const earlyMessage = await screen.findByText(
    "Also include the archived rows",
  );
  const yesterday = dateSeparator("Yesterday");
  const today = dateSeparator("Today");
  expect(yesterday).toBeInTheDocument();
  expect(today).toBeInTheDocument();
  expect(precedes(yesterday!, today!)).toBeTruthy();
  expect(precedes(today!, earlyMessage)).toBeTruthy();
  expect(
    precedes(screen.getByText("Start the overnight import"), today!),
  ).toBeTruthy();
});

test("An assistant reply can open a new date section", async () => {
  viewOnOctober28();
  await openConversation([
    promptEvent({
      id: "late-question",
      runId: FIRST_RUN_ID,
      seqId: 1,
      text: "Draft the quarterly summary",
      createdAt: localTime(10, 26, 23, 30),
    }),
    assistantEvent({
      id: "next-day-reply",
      runId: FIRST_RUN_ID,
      seqId: 2,
      text: "Here is the quarterly summary draft",
      createdAt: localTime(10, 27, 0, 30),
    }),
    completedEvent({
      id: "first-complete",
      runId: FIRST_RUN_ID,
      seqId: 3,
      createdAt: localTime(10, 27, 0, 31),
    }),
    promptEvent({
      id: "today-question",
      runId: SECOND_RUN_ID,
      seqId: 4,
      text: "Shorten the summary",
      createdAt: localTime(10, 28, 9, 0),
    }),
  ]);

  const reply = await screen.findByText("Here is the quarterly summary draft");
  const todayMessage = screen.getByText("Shorten the summary");
  const yesterday = dateSeparator("Yesterday");
  const today = dateSeparator("Today");
  expect(yesterday).toBeInTheDocument();
  expect(today).toBeInTheDocument();
  expect(
    precedes(screen.getByText("Draft the quarterly summary"), yesterday!),
  ).toBeTruthy();
  expect(precedes(yesterday!, reply)).toBeTruthy();
  expect(precedes(reply, today!)).toBeTruthy();
  expect(precedes(today!, todayMessage)).toBeTruthy();
});
