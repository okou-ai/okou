import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  context,
  installRunChat,
  queryWorkHistoryToggles,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const RUN_A = "a0000000-0000-4000-a000-000000000201";

function createdAt(minute: number, second = 0): string {
  return `2026-08-01T10:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
}

function goalContinuationEvent(args: {
  readonly id: string;
  readonly runId: string;
  readonly seqId: number;
  readonly brief: string;
  readonly model: string;
  readonly createdAt: string;
}): MockChatEventInput {
  return {
    id: args.id,
    role: "user",
    eventType: "input.prompt",
    content: null,
    runId: args.runId,
    seqId: args.seqId,
    createdAt: args.createdAt,
    userMessage: {
      version: 1,
      parts: [
        { type: "goal", goalBrief: args.brief },
        { type: "model", selectedModel: args.model },
      ],
    },
  };
}

test("A runless message stays outside later work history", async () => {
  installRunChat({
    chatEvents: [
      {
        id: "runless-welcome",
        eventType: "output.message",
        runId: undefined,
        content: "The complete welcome before any run",
        createdAt: createdAt(0),
        seqId: 1,
      },
      goalContinuationEvent({
        id: "later-work-input",
        runId: RUN_A,
        seqId: 2,
        brief: "Continue the actual task",
        model: "gpt-5.6-sol",
        createdAt: createdAt(1),
      }),
      assistantEvent({
        id: "later-work-output",
        runId: RUN_A,
        seqId: 3,
        text: "The actual work result",
        createdAt: createdAt(1, 20),
      }),
      completedEvent({
        id: "later-work-completed",
        runId: RUN_A,
        seqId: 4,
        createdAt: createdAt(1, 21),
      }),
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await expect(
    screen.findByText("The complete welcome before any run"),
  ).resolves.toBeVisible();
  expect(screen.getByText("Continue the actual task")).toBeVisible();
  expect(screen.getByText("The actual work result")).toBeVisible();
  expect(queryWorkHistoryToggles("collapsed")).toHaveLength(0);
  expect(screen.getAllByText(/^Worked for /u)).toHaveLength(1);
});
