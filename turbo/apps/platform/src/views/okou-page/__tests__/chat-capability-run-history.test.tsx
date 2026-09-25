import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  context,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  installRunChat,
  queryWorkHistoryToggle,
} from "./chat-run-test-fixtures.ts";

function timestamp(minute: number, second: number): string {
  return `2026-08-01T10:${String(minute).padStart(2, "0")}:${String(
    second,
  ).padStart(2, "0")}.000Z`;
}

function assistantOutput(args: {
  readonly id: string;
  readonly runId: string;
  readonly seqId: number;
  readonly minute: number;
  readonly second: number;
  readonly text: string;
}): MockChatEventInput {
  return {
    id: args.id,
    role: "assistant",
    eventType: "output.message",
    content: args.text,
    runId: args.runId,
    seqId: args.seqId,
    createdAt: timestamp(args.minute, args.second),
  };
}

function completedMarker(args: {
  readonly id: string;
  readonly runId: string;
  readonly seqId: number;
  readonly minute: number;
}): MockChatEventInput {
  return {
    id: args.id,
    role: "assistant",
    eventType: "run.completed",
    content: null,
    runId: args.runId,
    runLifecycleEvent: "completed",
    seqId: args.seqId,
    createdAt: timestamp(args.minute, 31),
  };
}

const LINKED_ARCHIVED_EVENT_ID = "archived-goal-linked-result";

function archivedGoalRun(args: {
  readonly number: number;
  readonly runId: string;
  readonly seqId: number;
  readonly resultId: string;
  readonly result: string;
}): MockChatEventInput[] {
  return [
    {
      id: `archived-goal-${String(args.number)}-input`,
      role: "user",
      eventType: "input.prompt",
      content: null,
      userMessage: {
        version: 1,
        parts: [{ type: "goal", goalBrief: "Archive the launch evidence" }],
      },
      runId: args.runId,
      seqId: args.seqId,
      createdAt: timestamp(args.number * 2, 0),
    },
    assistantOutput({
      id: args.resultId,
      runId: args.runId,
      seqId: args.seqId + 1,
      minute: args.number * 2,
      second: 30,
      text: args.result,
    }),
    completedMarker({
      id: `archived-goal-${String(args.number)}-completed`,
      runId: args.runId,
      seqId: args.seqId + 2,
      minute: args.number * 2,
    }),
  ];
}

test("Open an archived goal run from a linked event", async () => {
  const events = [
    ...archivedGoalRun({
      number: 1,
      runId: "d0000000-0000-4000-a000-000000000881",
      seqId: 1,
      resultId: LINKED_ARCHIVED_EVENT_ID,
      result: "Linked archived launch result",
    }),
    ...archivedGoalRun({
      number: 2,
      runId: "d0000000-0000-4000-a000-000000000882",
      seqId: 4,
      resultId: "archived-goal-middle-result",
      result: "Middle archived launch result",
    }),
    ...archivedGoalRun({
      number: 3,
      runId: "d0000000-0000-4000-a000-000000000883",
      seqId: 7,
      resultId: "archived-goal-latest-result",
      result: "Latest launch result",
    }),
  ];
  installRunChat({ chatEvents: events });

  await setupPage({
    context,
    path: `${RUN_PATH}#event-${LINKED_ARCHIVED_EVENT_ID}`,
  });

  await readyChat();
  const linkedResult = await screen.findByText("Linked archived launch result");
  expect(linkedResult).toBeVisible();
  expect(screen.getByText("Latest launch result")).toBeVisible();
  expect(queryWorkHistoryToggle("collapsed")).toBeNull();
});
