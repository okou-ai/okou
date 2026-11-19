import {
  workflowAutomationsContract,
  type ChatThreadWorkflowAutomation,
  type WorkflowAutomationSummary,
} from "@okouai/api-contracts/contracts/workflows";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { AGENT_ID } from "./chat-lifecycle-test-helpers.ts";
import {
  completedEvent,
  createChatRunFixtures,
  findButton,
  findLink,
  queryButton,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

async function chooseMenuItem(name: string): Promise<void> {
  const item = await waitFor(() => {
    const match = queryAllByRoleFast("menuitem").find((candidate) => {
      return candidate.textContent?.trim() === name;
    });
    if (!match) {
      throw new Error(`Menu item ${name} was not visible`);
    }
    return match;
  });
  click(item);
}

const AUTOMATION_ID = "e1000000-0000-4000-a000-000000000301";
const WORKFLOW_ID = "e2000000-0000-4000-a000-000000000301";

type ScheduleAutomation = Extract<
  ChatThreadWorkflowAutomation,
  { kind: "schedule" }
>;

function intervalAutomation(intervalSeconds: number): ScheduleAutomation {
  return {
    id: AUTOMATION_ID,
    ownerUserId: "test-user-123",
    enabled: true,
    chatThreadId: RUN_THREAD_ID,
    nextRunAt: "2026-08-01T10:05:00.000Z",
    lastRunAt: null,
    official: null,
    workflow: {
      id: WORKFLOW_ID,
      agentId: AGENT_ID,
      name: "inbox-sweep",
      displayName: "Inbox sweep",
      description: null,
    },
    kind: "schedule",
    schedule: { type: "loop", intervalSeconds },
    scheduleSummary: `Every ${String(intervalSeconds)} seconds`,
  };
}

test("Edit schedule and Gmail workflow triggers", async () => {
  installRunChat();
  let automation = intervalAutomation(300);
  const updates: number[] = [];
  context.mocks.api(
    workflowAutomationsContract.listForChatThread,
    ({ respond }) => {
      return respond(200, [automation]);
    },
  );
  context.mocks.api(
    workflowAutomationsContract.update,
    ({ params, body, respond }) => {
      expect(params.id).toBe(AUTOMATION_ID);
      if (!("schedule" in body) || body.schedule.type !== "loop") {
        throw new Error("Expected a loop schedule update");
      }
      updates.push(body.schedule.intervalSeconds);
      automation = intervalAutomation(body.schedule.intervalSeconds);
      const { workflow: _workflow, ...summary } = automation;
      return respond(200, summary satisfies WorkflowAutomationSummary);
    },
  );
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  click(await findButton("More actions"));
  await chooseMenuItem("Automations");
  const panel = await screen.findByRole("complementary", {
    name: "Automations",
  });
  await waitFor(() => {
    expect(panel).toHaveTextContent("Every 5 minutes");
  });

  click(queryButton("Edit", panel)!);
  const editor = await screen.findByRole("dialog", {
    name: "Edit automation",
  });
  click(within(editor).getByRole("combobox", { name: "Every" }));
  click(await screen.findByRole("option", { name: "15 minutes" }));
  click(queryButton("Save automation", editor)!);

  await waitFor(() => {
    expect(editor).not.toBeInTheDocument();
  });
  await waitFor(() => {
    expect(panel).toHaveTextContent("Every 15 minutes");
  });
  expect(updates).toStrictEqual([900]);
});

test("Present workflow trigger events as meaningful chat history", async () => {
  const completedRunId = "d0000000-0000-4000-a000-000000000931";
  const legacyRunId = "d0000000-0000-4000-a000-000000000932";
  installRunChat({
    chatEvents: [
      {
        id: "workflow-trigger-completed",
        role: "user",
        eventType: "input.automation",
        content: null,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "automation",
              workflowName: "release-digest",
              workflowId: WORKFLOW_ID,
              automationBrief: "Summarize yesterday's releases",
            },
            { type: "text", text: "Post the release digest to #launch" },
          ],
        },
        runId: completedRunId,
        seqId: 1,
        createdAt: "2026-08-01T10:00:01.000Z",
      },
      {
        id: "workflow-trigger-result",
        role: "assistant",
        content: "The release digest is posted.",
        runId: completedRunId,
        seqId: 2,
        createdAt: "2026-08-01T10:00:02.000Z",
      },
      completedEvent({ id: "workflow-done", runId: completedRunId, seqId: 3 }),
      {
        id: "workflow-trigger-legacy",
        role: "user",
        eventType: "input.automation",
        content: null,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "automation",
              workflowName: "legacy-digest",
              automationBrief: "Legacy weekly digest",
            },
          ],
        },
        runId: legacyRunId,
        seqId: 4,
        createdAt: "2026-08-01T10:00:04.000Z",
      },
      completedEvent({ id: "legacy-done", runId: legacyRunId, seqId: 5 }),
      {
        id: "workflow-trigger-pending",
        role: "user",
        eventType: "input.automation",
        content: null,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "automation",
              workflowName: "incident-digest",
              automationBrief: "Pending incident summary",
            },
          ],
        },
        runId: undefined,
        seqId: 6,
        createdAt: "2026-08-01T10:00:06.000Z",
      },
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  const thread = await readyChat();

  const workflowLink = await findLink("Open workflow release-digest");
  expect(workflowLink).toHaveAttribute(
    "href",
    `/workflows/${WORKFLOW_ID}/automations`,
  );
  const prompt = await within(thread).findByText(
    "Post the release digest to #launch",
  );
  expect(
    within(thread).queryByText("Summarize yesterday's releases"),
  ).not.toBeInTheDocument();
  click(prompt);
  expect(location.pathname).toBe(RUN_PATH);
  expect(within(thread).getByText("Legacy weekly digest")).toBeVisible();

  const pending = await screen.findByLabelText("Pending automation event");
  expect(pending).toHaveTextContent("Pending incident summary");
  expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
});
