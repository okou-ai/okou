import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  context,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  findWorkHistoryToggle,
  installRunChat,
  publishRunUpdate,
  queryWorkHistoryToggle,
} from "./chat-run-test-fixtures.ts";

const WORKFLOW_GROUP_ID = "e0000000-0000-4000-a000-000000000871";
const WORKFLOW_RUN_IDS = [
  "d0000000-0000-4000-a000-000000000871",
  "d0000000-0000-4000-a000-000000000872",
  "d0000000-0000-4000-a000-000000000873",
] as const;

function timestamp(minute: number, second: number): string {
  return `2026-08-01T10:${String(minute).padStart(2, "0")}:${String(
    second,
  ).padStart(2, "0")}.000Z`;
}

function workflowInput(args: {
  readonly id: string;
  readonly runId: string;
  readonly runGroupId: string;
  readonly seqId: number;
  readonly minute: number;
}): MockChatEventInput {
  return {
    id: args.id,
    role: "user",
    eventType: "input.automation",
    content: null,
    runId: args.runId,
    runGroupId: args.runGroupId,
    userMessage: {
      version: 1,
      parts: [
        {
          type: "automation",
          workflowName: "nightly-launch-review",
          automationBrief: "Nightly launch review",
        },
      ],
    },
    seqId: args.seqId,
    createdAt: timestamp(args.minute, 0),
  };
}

function assistantOutput(args: {
  readonly id: string;
  readonly runId: string;
  readonly runGroupId: string;
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
    runGroupId: args.runGroupId,
    seqId: args.seqId,
    createdAt: timestamp(args.minute, args.second),
  };
}

function completedMarker(args: {
  readonly id: string;
  readonly runId: string;
  readonly runGroupId: string;
  readonly seqId: number;
  readonly minute: number;
}): MockChatEventInput {
  return {
    id: args.id,
    role: "assistant",
    eventType: "run.completed",
    content: null,
    runId: args.runId,
    runGroupId: args.runGroupId,
    runLifecycleEvent: "completed",
    seqId: args.seqId,
    createdAt: timestamp(args.minute, 31),
  };
}

function completedWorkflowRun(args: {
  readonly number: number;
  readonly runId: string;
  readonly seqId: number;
  readonly minute: number;
}): MockChatEventInput[] {
  return [
    workflowInput({
      id: `workflow-history-${String(args.number)}-input`,
      runId: args.runId,
      runGroupId: WORKFLOW_GROUP_ID,
      seqId: args.seqId,
      minute: args.minute,
    }),
    assistantOutput({
      id: `workflow-history-${String(args.number)}-work`,
      runId: args.runId,
      runGroupId: WORKFLOW_GROUP_ID,
      seqId: args.seqId + 1,
      minute: args.minute,
      second: 10,
      text: `Earlier workflow evidence ${String(args.number)}`,
    }),
    assistantOutput({
      id: `workflow-history-${String(args.number)}-result`,
      runId: args.runId,
      runGroupId: WORKFLOW_GROUP_ID,
      seqId: args.seqId + 2,
      minute: args.minute,
      second: 30,
      text: `Earlier workflow result ${String(args.number)}`,
    }),
    completedMarker({
      id: `workflow-history-${String(args.number)}-completed`,
      runId: args.runId,
      runGroupId: WORKFLOW_GROUP_ID,
      seqId: args.seqId + 3,
      minute: args.minute,
    }),
  ];
}

test("Project workflow history expansion through the existing run group", async () => {
  const events = [
    ...completedWorkflowRun({
      number: 1,
      runId: WORKFLOW_RUN_IDS[0],
      seqId: 1,
      minute: 0,
    }),
    ...completedWorkflowRun({
      number: 2,
      runId: WORKFLOW_RUN_IDS[1],
      seqId: 5,
      minute: 2,
    }),
    workflowInput({
      id: "workflow-history-current-input",
      runId: WORKFLOW_RUN_IDS[2],
      runGroupId: WORKFLOW_GROUP_ID,
      seqId: 9,
      minute: 4,
    }),
    {
      id: "workflow-history-current-thinking",
      role: "assistant" as const,
      eventType: "output.thinking" as const,
      content: null,
      thinking: "Checking the latest workflow run",
      runId: WORKFLOW_RUN_IDS[2],
      runGroupId: WORKFLOW_GROUP_ID,
      seqId: 10,
      createdAt: timestamp(4, 10),
    },
  ] satisfies MockChatEventInput[];
  installRunChat({ chatEvents: events, activeRunIds: [WORKFLOW_RUN_IDS[2]] });
  // Current progress is drawn from the run's own thinking event only while
  // thread activity summaries are off, which is the case this test covers.
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ThreadActivitySummary]: false },
  });
  await readyChat();
  expect(screen.queryByText("Earlier workflow evidence 1")).toBeNull();
  expect(screen.queryByText("Earlier workflow result 1")).toBeNull();
  expect(screen.queryByText("Earlier workflow evidence 2")).toBeNull();
  const main = screen.getByText("Earlier workflow result 2");
  expect(main).toBeVisible();
  expect(queryWorkHistoryToggle("collapsed")).toBeVisible();
  const currentProgress = await screen.findByLabelText(
    "Checking the latest workflow run",
  );
  expect(currentProgress).toBeVisible();
  const assistantGroup = main.closest<HTMLElement>('[data-role="assistant"]');
  if (!assistantGroup) {
    throw new Error(
      "Expected the workflow result inside an assistant response",
    );
  }
  expect(assistantGroup).toContainElement(currentProgress);
  expect(
    queryAllByRoleFast("link").filter((link) => {
      return link.getAttribute("aria-label") === "View agent profile";
    }),
  ).toHaveLength(1);
  click(await findWorkHistoryToggle("collapsed"));
  const firstEarlierEvidence = await screen.findByText(
    "Earlier workflow evidence 1",
  );
  expect(firstEarlierEvidence).toBeVisible();
  expect(screen.getByText("Earlier workflow result 1")).toBeVisible();
  expect(screen.getByText("Earlier workflow evidence 2")).toBeVisible();
  expect(screen.getByText("Earlier workflow result 2")).toBeVisible();
  expect(firstEarlierEvidence.closest('[data-role="assistant"]')).toBe(
    assistantGroup,
  );
  expect(screen.queryByText("Nightly launch review")).toBeNull();
  click(await findWorkHistoryToggle("expanded"));
  await expect(findWorkHistoryToggle("collapsed")).resolves.toBeVisible();
});

test("Project workflow current run output through the existing run group", async () => {
  const events = [
    ...completedWorkflowRun({
      number: 1,
      runId: WORKFLOW_RUN_IDS[0],
      seqId: 1,
      minute: 0,
    }),
    ...completedWorkflowRun({
      number: 2,
      runId: WORKFLOW_RUN_IDS[1],
      seqId: 5,
      minute: 2,
    }),
    workflowInput({
      id: "workflow-history-current-input",
      runId: WORKFLOW_RUN_IDS[2],
      runGroupId: WORKFLOW_GROUP_ID,
      seqId: 9,
      minute: 4,
    }),
    {
      id: "workflow-history-current-thinking",
      role: "assistant" as const,
      eventType: "output.thinking" as const,
      content: null,
      thinking: "Checking the latest workflow run",
      runId: WORKFLOW_RUN_IDS[2],
      runGroupId: WORKFLOW_GROUP_ID,
      seqId: 10,
      createdAt: timestamp(4, 10),
    },
  ] satisfies MockChatEventInput[];
  installRunChat({ chatEvents: events, activeRunIds: [WORKFLOW_RUN_IDS[2]] });
  // Current progress is drawn from the run's own thinking event only while
  // thread activity summaries are off, which is the case this test covers.
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ThreadActivitySummary]: false },
  });
  await readyChat();
  expect(screen.queryByText("Earlier workflow evidence 1")).toBeNull();
  expect(screen.queryByText("Earlier workflow result 1")).toBeNull();
  expect(screen.queryByText("Earlier workflow evidence 2")).toBeNull();
  const main = screen.getByText("Earlier workflow result 2");
  expect(main).toBeVisible();
  expect(queryWorkHistoryToggle("collapsed")).toBeVisible();
  const currentProgress = await screen.findByLabelText(
    "Checking the latest workflow run",
  );
  expect(currentProgress).toBeVisible();
  const assistantGroup = main.closest<HTMLElement>('[data-role="assistant"]');
  if (!assistantGroup) {
    throw new Error(
      "Expected the workflow result inside an assistant response",
    );
  }
  expect(assistantGroup).toContainElement(currentProgress);
  expect(
    queryAllByRoleFast("link").filter((link) => {
      return link.getAttribute("aria-label") === "View agent profile";
    }),
  ).toHaveLength(1);
  events.push(
    assistantOutput({
      id: "workflow-history-current-result",
      runId: WORKFLOW_RUN_IDS[2],
      runGroupId: WORKFLOW_GROUP_ID,
      seqId: 11,
      minute: 4,
      second: 20,
      text: "Current workflow result",
    }),
  );
  publishRunUpdate();
  const currentMain = await screen.findByText("Current workflow result");
  expect(currentMain).toBeVisible();
  expect(screen.queryByText("Earlier workflow result 2")).toBeNull();
  expect(currentMain.closest('[data-role="assistant"]')).toBe(assistantGroup);
  await expect(findWorkHistoryToggle("collapsed")).resolves.toBeVisible();
});

test("Keep different run groups as separate assistant responses", async () => {
  const secondGroupId = "e0000000-0000-4000-a000-000000000879";
  installRunChat({
    chatEvents: [
      workflowInput({
        id: "first-group-input",
        runId: WORKFLOW_RUN_IDS[0],
        runGroupId: WORKFLOW_GROUP_ID,
        seqId: 1,
        minute: 0,
      }),
      assistantOutput({
        id: "first-group-output",
        runId: WORKFLOW_RUN_IDS[0],
        runGroupId: WORKFLOW_GROUP_ID,
        seqId: 2,
        minute: 0,
        second: 20,
        text: "First group result",
      }),
      completedMarker({
        id: "first-group-completed",
        runId: WORKFLOW_RUN_IDS[0],
        runGroupId: WORKFLOW_GROUP_ID,
        seqId: 3,
        minute: 0,
      }),
      workflowInput({
        id: "second-group-input",
        runId: WORKFLOW_RUN_IDS[1],
        runGroupId: secondGroupId,
        seqId: 4,
        minute: 2,
      }),
      assistantOutput({
        id: "second-group-output",
        runId: WORKFLOW_RUN_IDS[1],
        runGroupId: secondGroupId,
        seqId: 5,
        minute: 2,
        second: 20,
        text: "Second group result",
      }),
      completedMarker({
        id: "second-group-completed",
        runId: WORKFLOW_RUN_IDS[1],
        runGroupId: secondGroupId,
        seqId: 6,
        minute: 2,
      }),
    ],
  });

  await setupPage({
    context,
    path: RUN_PATH,
  });
  await readyChat();

  const first = screen.getByText("First group result");
  const second = screen.getByText("Second group result");
  expect(first.closest('[data-role="assistant"]')).not.toBe(
    second.closest('[data-role="assistant"]'),
  );
  expect(
    queryAllByRoleFast("link").filter((link) => {
      return link.getAttribute("aria-label") === "View agent profile";
    }),
  ).toHaveLength(2);
  expect(queryWorkHistoryToggle("collapsed")).toBeNull();
});

const ARCHIVED_GOAL_GROUP_ID = "e0000000-0000-4000-a000-000000000881";
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
      runGroupId: ARCHIVED_GOAL_GROUP_ID,
      seqId: args.seqId,
      createdAt: timestamp(args.number * 2, 0),
    },
    assistantOutput({
      id: args.resultId,
      runId: args.runId,
      runGroupId: ARCHIVED_GOAL_GROUP_ID,
      seqId: args.seqId + 1,
      minute: args.number * 2,
      second: 30,
      text: args.result,
    }),
    completedMarker({
      id: `archived-goal-${String(args.number)}-completed`,
      runId: args.runId,
      runGroupId: ARCHIVED_GOAL_GROUP_ID,
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
