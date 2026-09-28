import { screen } from "@testing-library/react";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  context,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  completedEvent,
  installRunChat,
  publishRunUpdate,
  queryWorkHistoryToggles,
} from "./chat-run-test-fixtures.ts";

const WORKFLOW_RUN_IDS = [
  "d0000000-0000-4000-a000-000000000871",
  "d0000000-0000-4000-a000-000000000872",
  "d0000000-0000-4000-a000-000000000873",
] as const;

const WORKFLOW_MESSAGE = {
  version: 1,
  parts: [
    {
      type: "automation",
      workflowName: "nightly-launch-review",
      automationBrief: "Nightly launch review",
    },
  ],
} satisfies UserMessageDocument;

function timestamp(minute: number, second: number): string {
  return `2026-08-01T10:${String(minute).padStart(2, "0")}:${String(
    second,
  ).padStart(2, "0")}.000Z`;
}

// A workflow event waits without a run. The run that picks it up appends an
// input.prompt whose ID is the run ID and which revokes the automation event.
function workflowInputs(args: {
  readonly number: number;
  readonly runId: string;
  readonly seqId: number;
  readonly minute: number;
}): MockChatEventInput[] {
  const automationEventId = `workflow-${String(args.number)}-automation`;
  return [
    {
      id: automationEventId,
      role: "user",
      eventType: "input.automation",
      content: null,
      userMessage: WORKFLOW_MESSAGE,
      runId: undefined,
      seqId: args.seqId,
      createdAt: timestamp(args.minute, 0),
    },
    {
      id: args.runId,
      role: "user",
      eventType: "input.prompt",
      content: null,
      userMessage: WORKFLOW_MESSAGE,
      runId: args.runId,
      revokesEventId: automationEventId,
      seqId: args.seqId + 1,
      createdAt: timestamp(args.minute, 1),
    },
  ];
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

function completedWorkflowRun(args: {
  readonly number: number;
  readonly runId: string;
  readonly seqId: number;
  readonly minute: number;
}): MockChatEventInput[] {
  return [
    ...workflowInputs(args),
    assistantOutput({
      id: `workflow-${String(args.number)}-work`,
      runId: args.runId,
      seqId: args.seqId + 2,
      minute: args.minute,
      second: 10,
      text: `Earlier workflow evidence ${String(args.number)}`,
    }),
    assistantOutput({
      id: `workflow-${String(args.number)}-result`,
      runId: args.runId,
      seqId: args.seqId + 3,
      minute: args.minute,
      second: 30,
      text: `Earlier workflow result ${String(args.number)}`,
    }),
    completedEvent({
      id: `workflow-${String(args.number)}-completed`,
      runId: args.runId,
      seqId: args.seqId + 4,
    }),
  ];
}

function workflowHistory(): MockChatEventInput[] {
  return [
    ...completedWorkflowRun({
      number: 1,
      runId: WORKFLOW_RUN_IDS[0],
      seqId: 1,
      minute: 0,
    }),
    ...completedWorkflowRun({
      number: 2,
      runId: WORKFLOW_RUN_IDS[1],
      seqId: 6,
      minute: 2,
    }),
    ...workflowInputs({
      number: 3,
      runId: WORKFLOW_RUN_IDS[2],
      seqId: 11,
      minute: 4,
    }),
  ];
}

function assistantResponse(text: string): HTMLElement {
  const response = screen
    .getByText(text)
    .closest<HTMLElement>('[data-role="assistant"]');
  if (!response) {
    throw new Error(`Expected "${text}" inside an assistant response`);
  }
  return response;
}

test("Fold each workflow run's work behind its own result", async () => {
  installRunChat({
    chatEvents: workflowHistory(),
    activeRunIds: [WORKFLOW_RUN_IDS[2]],
  });
  await setupPage({
    context,
    path: RUN_PATH,
  });
  await readyChat();

  expect(screen.getByText("Earlier workflow result 1")).toBeVisible();
  expect(screen.getByText("Earlier workflow result 2")).toBeVisible();
  expect(screen.queryByText("Earlier workflow evidence 1")).toBeNull();
  expect(screen.queryByText("Earlier workflow evidence 2")).toBeNull();
  expect(assistantResponse("Earlier workflow result 1")).not.toBe(
    assistantResponse("Earlier workflow result 2"),
  );
  await expect(screen.findByText("Thinking...")).resolves.toBeVisible();

  const toggles = queryWorkHistoryToggles("collapsed");
  expect(toggles).toHaveLength(2);
  click(toggles[0]!);
  await expect(
    screen.findByText("Earlier workflow evidence 1"),
  ).resolves.toBeVisible();
  expect(screen.queryByText("Earlier workflow evidence 2")).toBeNull();
});

test("Show the current workflow run's output as its own response", async () => {
  const events = workflowHistory();
  installRunChat({ chatEvents: events, activeRunIds: [WORKFLOW_RUN_IDS[2]] });
  await setupPage({
    context,
    path: RUN_PATH,
  });
  await readyChat();
  await expect(screen.findByText("Thinking...")).resolves.toBeVisible();

  events.push(
    assistantOutput({
      id: "workflow-3-result",
      runId: WORKFLOW_RUN_IDS[2],
      seqId: 13,
      minute: 4,
      second: 20,
      text: "Current workflow result",
    }),
  );
  publishRunUpdate();

  await expect(
    screen.findByText("Current workflow result"),
  ).resolves.toBeVisible();
  expect(screen.getByText("Earlier workflow result 2")).toBeVisible();
  expect(assistantResponse("Current workflow result")).not.toBe(
    assistantResponse("Earlier workflow result 2"),
  );
});
