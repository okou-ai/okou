import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
  getWorkHistoryToggle,
  publishRunUpdate,
  RUN_PATH,
  findLink,
  queryButton,
} from "./chat-run-test-fixtures.ts";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import {
  mockAttachmentChat,
  mockSplitAttachmentChats,
  ATTACHMENT_THREAD_ID,
  SECOND_ATTACHMENT_THREAD_ID,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();

async function openWorkflowHistory() {
  const history: MockChatEventInput[] = [];
  const workflows = [
    {
      runId: "33ab3b66-64a5-49d9-b22e-e43d0dec7901",
      name: "Policy digest",
      evidence: "Read the review guidelines.",
      result: "The policy digest is ready.",
    },
    {
      runId: "1009fa1f-6363-498a-926a-00ff3ea52b01",
      name: "Launch digest",
      evidence: "Read the launch calendar.",
      result: "The launch digest is ready.",
    },
  ] as const;
  const active = "464186e9-104b-49c4-ad59-fdc6ba81909c";
  function workflowInput(
    runId: string,
    name: string,
    seqId: number,
  ): MockChatEventInput {
    return {
      id: runId,
      eventType: "input.automation",
      runId,
      seqId,
      createdAt: "2026-08-01T10:00:00Z",
      content: null,
      userMessage: {
        version: 1,
        parts: [
          { type: "automation", workflowName: name, automationBrief: name },
        ],
      },
    };
  }
  for (const [
    index,
    { runId, name, evidence, result },
  ] of workflows.entries()) {
    const first = 1 + index * 4;
    history.push(
      workflowInput(runId, name, first),
      assistantEvent({
        id: runId + "-evidence",
        seqId: first + 1,
        runId,
        text: evidence,
      }),
      assistantEvent({
        id: runId + "-result",
        seqId: first + 2,
        runId,
        text: result,
      }),
      completedEvent({ id: runId + "-done", seqId: first + 3, runId }),
    );
  }
  history.push(workflowInput(active, "Current digest", 9));
  createChatRunFixtures(context).installRunChat({
    chatEvents: history,
    activeRunIds: [active],
  });
  await setupPage({ context, path: RUN_PATH });
  return { history, workflows, active };
}

test("chat-capability-run-history-001 expands evidence for one completed workflow while the current run keeps thinking", async () => {
  const {
    workflows: [policy, launch],
  } = await openWorkflowHistory();
  const policyTurn = (
    await screen.findByText(policy.result)
  ).closest<HTMLElement>('[data-role="assistant"]')!;
  const launchTurn = screen
    .getByText(launch.result)
    .closest<HTMLElement>('[data-role="assistant"]')!;
  expect(screen.queryByText(policy.evidence)).toBeNull();
  expect(screen.queryByText(launch.evidence)).toBeNull();
  expect(getWorkHistoryToggle("collapsed", launchTurn)).toBeVisible();
  click(getWorkHistoryToggle("collapsed", policyTurn));
  await expect(
    within(policyTurn).findByText(policy.evidence),
  ).resolves.toBeVisible();
  expect(screen.queryByText(launch.evidence)).toBeNull();
  await expect(screen.findByText("Thinking...")).resolves.toBeVisible();
});

test("a live workflow publishes its result in a separate reply from the completed launch digest", async () => {
  const {
    history,
    workflows: [, launch],
    active,
  } = await openWorkflowHistory();
  await expect(screen.findByText("Thinking...")).resolves.toBeVisible();
  const earlier = screen
    .getByText(launch.result)
    .closest<HTMLElement>('[data-role="assistant"]')!;
  history.push(
    assistantEvent({
      id: active + "-result",
      seqId: 10,
      runId: active,
      text: "Current digest is ready.",
    }),
  );
  publishRunUpdate();

  const current = await screen.findByText("Current digest is ready.");
  expect(current).toBeVisible();
  expect(within(earlier).getByText(launch.result)).toBeVisible();
  const currentTurn = current.closest<HTMLElement>('[data-role="assistant"]');
  expect(currentTurn).toBeTruthy();
  expect(currentTurn).not.toBe(earlier);
});

const createdAt = "2026-10-01T11:00:00Z";

const runId = "0f1b14c5-bb0c-4fff-b889-856c59166e46";

test("chat-capability-history-visibility-002 keeps the four saved template names readable in the sent message", async () => {
  const templates = [
    {
      type: "template",
      titleSnapshot: "Quarterly Storyboard",
      template: {
        type: "presentation",
        selection: { templateId: "storyboard" },
      },
    },
    {
      type: "template",
      titleSnapshot: "Warm Documentary",
      template: { type: "video", selection: { stylePresetId: "documentary" } },
    },
    {
      type: "template",
      titleSnapshot: "Paper Cutout",
      template: {
        type: "illustration",
        selection: { illustrationStyleId: "cutout" },
      },
    },
    {
      type: "template",
      titleSnapshot: "Editorial Landing Page",
      template: {
        type: "website",
        selection: { websiteTemplateId: "editorial" },
      },
    },
  ] satisfies UserMessageDocument["parts"];
  mockAttachmentChat(context, {
    chatEvents: [
      {
        role: "user",
        content: null,
        createdAt,
        runId,
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Use our launch templates" },
            ...templates,
          ],
        },
      },
    ],
  });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const prompt = await screen.findByText("Use our launch templates");
  const turn = within(prompt.closest<HTMLElement>('[data-role="user"]')!);
  for (const template of templates) {
    const label = turn.getByText(template.titleSnapshot);
    expect(
      label.closest("button, a, [role=button], [role=link], [tabindex='0']"),
    ).toBeNull();
  }
});

test("chat-capability-history-visibility-003 switches from an active run to the finished chat and its answer", async () => {
  const question = "Collect launch responses";
  mockSplitAttachmentChats(
    context,
    {
      threadId: ATTACHMENT_THREAD_ID,
      title: "Ongoing collection",
      events: [{ role: "user", content: question, createdAt, runId }],
    },
    {
      threadId: SECOND_ATTACHMENT_THREAD_ID,
      title: "Published report",
      events: [
        {
          role: "user",
          content: "Publish the summary",
          createdAt,
          runId: "690eb790-cd51-4501-82da-5ae78a51ac42",
        },
        {
          role: "assistant",
          content: "The summary is published",
          createdAt,
          runId: "690eb790-cd51-4501-82da-5ae78a51ac42",
          runLifecycleEvent: "completed",
        },
      ],
    },
  );
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  await screen.findByText(question);
  await screen.findByLabelText("Stop");
  click(await findLink("Published report"));
  await screen.findByText("The summary is published");
  expect(window.location.pathname).toBe(
    `/chats/${SECOND_ATTACHMENT_THREAD_ID}`,
  );
  expect(screen.queryByText(question)).not.toBeInTheDocument();
  expect(queryButton("Stop")).not.toBeInTheDocument();
});
