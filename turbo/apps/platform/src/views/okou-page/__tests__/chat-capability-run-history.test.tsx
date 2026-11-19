import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatRunFixtures,
  queryWorkHistoryToggles,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const FIRST_RUN_ID = "d0000000-0000-4000-a000-000000000921";
const SECOND_RUN_ID = "d0000000-0000-4000-a000-000000000922";
const ACTIVE_RUN_ID = "d0000000-0000-4000-a000-000000000923";

function automationInput(brief: string): UserMessageDocument {
  return {
    version: 1,
    parts: [
      {
        type: "automation",
        workflowName: "release-digest",
        automationBrief: brief,
      },
    ],
  };
}

function completedWorkflowRun(args: {
  readonly runId: string;
  readonly firstSeqId: number;
  readonly brief: string;
  readonly evidence: string;
  readonly result: string;
}): MockChatEventInput[] {
  const at = (offset: number) => {
    return `2026-08-01T10:00:${String(args.firstSeqId + offset).padStart(2, "0")}.000Z`;
  };
  return [
    {
      id: `${args.runId}-input`,
      role: "user",
      eventType: "input.automation",
      content: null,
      userMessage: automationInput(args.brief),
      runId: args.runId,
      seqId: args.firstSeqId,
      createdAt: at(0),
    },
    {
      id: `${args.runId}-evidence`,
      role: "assistant",
      content: args.evidence,
      runId: args.runId,
      seqId: args.firstSeqId + 1,
      createdAt: at(1),
    },
    {
      id: `${args.runId}-result`,
      role: "assistant",
      content: args.result,
      runId: args.runId,
      seqId: args.firstSeqId + 2,
      createdAt: at(2),
    },
    {
      id: `${args.runId}-completed`,
      role: "assistant",
      content: null,
      runId: args.runId,
      runLifecycleEvent: "completed",
      seqId: args.firstSeqId + 3,
      createdAt: at(3),
    },
  ];
}

test("Fold each workflow run's work behind its own result", async () => {
  installRunChat({
    activeRunIds: [ACTIVE_RUN_ID],
    chatEvents: [
      ...completedWorkflowRun({
        runId: FIRST_RUN_ID,
        firstSeqId: 1,
        brief: "Morning release digest",
        evidence: "Checked the overnight release dashboard.",
        result: "Morning digest: two releases shipped.",
      }),
      ...completedWorkflowRun({
        runId: SECOND_RUN_ID,
        firstSeqId: 5,
        brief: "Midday release digest",
        evidence: "Compared the midday deploy queue.",
        result: "Midday digest: one rollback pending.",
      }),
      {
        id: "active-workflow-input",
        role: "user",
        eventType: "input.automation",
        content: null,
        userMessage: automationInput("Evening release digest"),
        runId: ACTIVE_RUN_ID,
        seqId: 9,
        createdAt: "2026-08-01T10:00:09.000Z",
      },
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();

  await expect(
    screen.findByText("Morning digest: two releases shipped."),
  ).resolves.toBeVisible();
  expect(
    screen.getByText("Midday digest: one rollback pending."),
  ).toBeVisible();
  expect(
    screen.queryByText("Checked the overnight release dashboard."),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("Compared the midday deploy queue."),
  ).not.toBeInTheDocument();
  const collapsed = queryWorkHistoryToggles("collapsed");
  expect(collapsed).toHaveLength(2);

  click(collapsed[0]!);

  await expect(
    screen.findByText("Checked the overnight release dashboard."),
  ).resolves.toBeVisible();
  expect(
    screen.queryByText("Compared the midday deploy queue."),
  ).not.toBeInTheDocument();
  expect(queryWorkHistoryToggles("collapsed")).toHaveLength(1);
  expect(screen.getByText("Thinking...")).toBeVisible();
});
