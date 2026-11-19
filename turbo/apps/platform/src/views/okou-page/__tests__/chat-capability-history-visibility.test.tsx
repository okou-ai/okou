import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  chatEventRowsResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
  type MockChatEventInput,
} from "./chat-event-test-helpers.ts";
import { AGENT_ID } from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
  findLink,
  promptEvent,
  queryButton,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const TEMPLATE_RUN_ID = "d0000000-0000-4000-a000-000000000941";

test("Preserve selected template labels in chat history", async () => {
  installRunChat({
    chatEvents: [
      {
        id: "template-history-user",
        role: "user",
        content: null,
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Prepare the launch kit" },
            {
              type: "template",
              titleSnapshot: "Quarterly Storyboard",
              template: {
                type: "presentation",
                selection: { templateId: "quarterly-storyboard" },
              },
            },
            {
              type: "template",
              titleSnapshot: "Warm Documentary",
              template: {
                type: "video",
                selection: { stylePresetId: "warm-documentary" },
              },
            },
            {
              type: "template",
              titleSnapshot: "Paper Cutout",
              template: {
                type: "illustration",
                selection: { illustrationStyleId: "paper-cutout" },
              },
            },
            {
              type: "template",
              titleSnapshot: "Editorial Landing Page",
              template: {
                type: "website",
                selection: { websiteTemplateId: "editorial-landing-page" },
              },
            },
          ],
        },
        runId: TEMPLATE_RUN_ID,
        seqId: 1,
        createdAt: "2026-08-01T10:00:01.000Z",
      },
      assistantEvent({
        id: "template-history-assistant",
        runId: TEMPLATE_RUN_ID,
        seqId: 2,
        text: "The launch kit is ready.",
      }),
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  const thread = await readyChat();

  for (const label of [
    "Quarterly Storyboard",
    "Warm Documentary",
    "Paper Cutout",
    "Editorial Landing Page",
  ]) {
    const element = await within(thread).findByText(label);
    expect(element).toBeVisible();
    expect(element.closest("a, button")).toBeNull();
  }
});

test("Show only the selected conversation when switching chats", async () => {
  const runningRunId = "d0000000-0000-4000-a000-000000000942";
  const completedRunId = "d0000000-0000-4000-a000-000000000943";
  const completedThreadId = "b0000000-0000-4000-a000-000000000944";
  const runningEvents: MockChatEventInput[] = [
    promptEvent({
      id: "running-thread-user",
      runId: runningRunId,
      seqId: 1,
      text: "Keep drafting the investor update",
    }),
  ];
  const completedEvents: MockChatEventInput[] = [
    promptEvent({
      id: "completed-thread-user",
      runId: completedRunId,
      seqId: 1,
      text: "List the open hiring roles",
    }),
    assistantEvent({
      id: "completed-thread-answer",
      runId: completedRunId,
      seqId: 2,
      text: "There are three open hiring roles.",
    }),
    completedEvent({
      id: "completed-thread-done",
      runId: completedRunId,
      seqId: 3,
    }),
  ];
  const control = installRunChat({
    threadTitle: "Running conversation",
    activeRunIds: [runningRunId],
    chatEvents: runningEvents,
  });
  control.setThreadList([
    {
      id: RUN_THREAD_ID,
      title: "Running conversation",
      agent: { id: AGENT_ID, avatarUrl: null },
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:01.000Z",
    },
    {
      id: completedThreadId,
      title: "Completed conversation",
      agent: { id: AGENT_ID, avatarUrl: null },
      createdAt: "2026-08-01T09:00:00.000Z",
      updatedAt: "2026-08-01T09:00:03.000Z",
    },
  ]);
  context.mocks.api(
    chatThreadEventsContract.rows,
    ({ params, query, respond }) => {
      const events =
        params.threadId === completedThreadId ? completedEvents : runningEvents;
      const rows = mockChatEventRows(
        normalizeMockChatEvents(events, params.threadId),
      )
        .filter((row) => {
          return row.seqId > query.sinceSeqId;
        })
        .slice(0, query.limit ?? 50);
      return respond(200, chatEventRowsResponse(rows, query));
    },
  );
  await setupPage({ context, path: RUN_PATH });
  const running = await readyChat();
  await expect(
    within(running).findByText("Keep drafting the investor update"),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(queryButton("Stop")).toBeVisible();
  });

  click(await findLink("Completed conversation"));

  await expect(
    screen.findByText("There are three open hiring roles."),
  ).resolves.toBeVisible();
  expect(location.pathname).toBe(`/chats/${completedThreadId}`);
  await expect(findLink("Completed conversation")).resolves.toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(
    screen.queryByText("Keep drafting the investor update"),
  ).not.toBeInTheDocument();
  expect(queryButton("Stop")).not.toBeInTheDocument();
});
