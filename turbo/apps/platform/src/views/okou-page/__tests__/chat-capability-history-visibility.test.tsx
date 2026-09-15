import {
  chatThreadEventsContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  CAPABILITY_AGENT_ID,
  context,
  findButton,
  installCapabilityChat,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
  type MockChatEventInput,
} from "./chat-event-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  findLink,
  installRunChat,
  promptEvent,
  RUN_THREAD_ID,
  thinkingEvent,
} from "./chat-run-test-fixtures.ts";
import { chatEventRowsResponse } from "../../../signals/__tests__/test-helpers.ts";

const BASE_TIME = "2026-08-01T10:00:00.000Z";
const COMPLETED_THREAD_ID = "b0000000-0000-4000-a000-000000000842";

function rejectedInput(
  id: string,
  error: string,
  userMessage: UserMessageDocument,
  seqId: number,
): MockChatEventInput {
  return {
    id,
    role: "user",
    eventType: "input.rejected",
    content: null,
    error,
    userMessage,
    seqId,
    createdAt: `2026-08-01T10:00:0${String(seqId)}.000Z`,
  };
}

function rejectedHistory(
  generatedDocument: UserMessageDocument,
): MockChatEventInput[] {
  return [
    {
      id: "rejected-history-prompt",
      role: "user",
      content: "Review the deployment plan",
      runId: "d0000000-0000-4000-a000-000000000821",
      seqId: 1,
      createdAt: BASE_TIME,
    },
    {
      id: "rejected-history-response",
      role: "assistant",
      content: "The deployment plan is ready for review.",
      runId: "d0000000-0000-4000-a000-000000000821",
      seqId: 2,
      createdAt: "2026-08-01T10:00:02.000Z",
    },
    rejectedInput(
      "rejected-generated-continuation",
      "SYSTEM_CONTINUATION_REJECTION_DETAIL",
      generatedDocument,
      3,
    ),
    rejectedInput(
      "rejected-user-prompt",
      "USER_PROMPT_REJECTION_DETAIL",
      {
        version: 1,
        parts: [
          {
            type: "text",
            text: "Keep this rejected prompt visible",
          },
        ],
      },
      4,
    ),
  ];
}

test("Keep a generic assistant failure readable", async () => {
  installCapabilityChat({
    events: [
      {
        id: "readable-error-prompt",
        role: "user",
        content: "Prepare the release checklist",
        runId: "d0000000-0000-4000-a000-000000000822",
        seqId: 1,
        createdAt: BASE_TIME,
      },
      {
        id: "readable-error-response",
        role: "assistant",
        eventType: "output.error",
        content: null,
        error:
          "## Release failed\n\nPlease **review these steps**:\n\n- Reopen the draft\n- Try again\n\n[View service status](https://status.okou.ai/incidents/release)",
        runId: "d0000000-0000-4000-a000-000000000822",
        seqId: 2,
        createdAt: "2026-08-01T10:00:02.000Z",
      },
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const frame = await screen.findByTestId("assistant-error-card-shell");
  click(await findButton("View details"));
  const errorMessage = await screen.findByRole("dialog");
  const heading = await within(errorMessage).findByRole("heading", {
    level: 2,
    name: "Release failed",
  });
  expect(heading).toBeVisible();
  expect(frame).not.toContainElement(errorMessage);
  expect(within(errorMessage).getByText("review these steps").tagName).toBe(
    "STRONG",
  );
  expect(within(errorMessage).getAllByRole("listitem")).toHaveLength(2);
  const statusLink = queryAllByRoleFast("link", errorMessage).find((link) => {
    return link.textContent?.trim() === "View service status";
  });
  expect(statusLink).toHaveAttribute(
    "href",
    "https://status.okou.ai/incidents/release",
  );
  expect(
    within(errorMessage).queryByText(/## Release failed/u),
  ).not.toBeInTheDocument();
});

test("Hide rejected system-generated goal and workflow continuations", async () => {
  installCapabilityChat({
    events: rejectedHistory({
      version: 1,
      parts: [
        {
          type: "goal",
          goalBrief: "Continue the hidden deployment goal",
        },
      ],
    }),
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const surroundingResponse = await screen.findByText(
    "The deployment plan is ready for review.",
  );
  expect(surroundingResponse).toBeVisible();
  expect(screen.getByText("Keep this rejected prompt visible")).toBeVisible();
  expect(
    screen.queryByText("Continue the hidden deployment goal"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("SYSTEM_CONTINUATION_REJECTION_DETAIL"),
  ).not.toBeInTheDocument();
});

test("Preserve selected template labels in chat history", async () => {
  const templateRequests = [
    {
      title: "Quarterly Storyboard",
      template: {
        type: "presentation" as const,
        selection: { templateId: "presentation-quarterly-storyboard" },
      },
    },
    {
      title: "Warm Documentary",
      template: {
        type: "video" as const,
        selection: { stylePresetId: "video-warm-documentary" },
      },
    },
    {
      title: "Paper Cutout",
      template: {
        type: "illustration" as const,
        selection: { illustrationStyleId: "illustration-paper-cutout" },
      },
    },
    {
      title: "Editorial Landing Page",
      template: {
        type: "website" as const,
        selection: { websiteTemplateId: "website-editorial-landing-page" },
      },
    },
  ] satisfies readonly {
    readonly title: string;
    readonly template: Extract<
      UserMessageDocument["parts"][number],
      { readonly type: "template" }
    >["template"];
  }[];
  installCapabilityChat({
    events: templateRequests.map((request, index) => {
      const seqId = index + 1;
      return {
        id: `template-history-${String(seqId)}`,
        role: "user" as const,
        content: `Create draft ${String(seqId)}`,
        runId: `d0000000-0000-4000-a000-00000000083${String(seqId)}`,
        userMessage: {
          version: 1 as const,
          parts: [
            { type: "text" as const, text: `Create draft ${String(seqId)}` },
            {
              type: "template" as const,
              titleSnapshot: request.title,
              template: request.template,
            },
          ],
        },
        seqId,
        createdAt: `2026-08-01T10:01:0${String(seqId)}.000Z`,
      };
    }),
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  for (const { title } of templateRequests) {
    const label = await screen.findByText(title);
    expect(label).toBeVisible();
    expect(label.closest("button, a, [role='combobox']")).toBeNull();
  }
});

test("Show only the selected conversation when switching chats", async () => {
  const activeRunId = "d0000000-0000-4000-a000-000000000842";
  const runningEvents = [
    promptEvent({
      id: "switch-running-prompt",
      runId: activeRunId,
      seqId: 1,
      text: "Running conversation prompt",
    }),
    thinkingEvent({
      id: "switch-running-progress",
      runId: activeRunId,
      seqId: 2,
      text: "Reviewing the running conversation",
    }),
  ];
  const completedRunId = "d0000000-0000-4000-a000-000000000843";
  const completedEvents = [
    promptEvent({
      id: "switch-completed-prompt",
      runId: completedRunId,
      seqId: 1,
      text: "Completed conversation prompt",
    }),
    assistantEvent({
      id: "switch-completed-answer",
      runId: completedRunId,
      seqId: 2,
      text: "Only this completed answer should remain visible.",
    }),
    completedEvent({
      id: "switch-completed-marker",
      runId: completedRunId,
      seqId: 3,
    }),
  ];
  const lifecycle = installRunChat({
    threadId: RUN_THREAD_ID,
    threadTitle: "Running conversation",
    chatEvents: runningEvents,
    activeRunIds: [activeRunId],
  });
  lifecycle.setThreadList([
    {
      id: RUN_THREAD_ID,
      title: "Running conversation",
      agent: { id: CAPABILITY_AGENT_ID, avatarUrl: null },
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:02:00.000Z",
      pinnedAt: null,
    },
    {
      id: COMPLETED_THREAD_ID,
      title: "Completed conversation",
      agent: { id: CAPABILITY_AGENT_ID, avatarUrl: null },
      createdAt: "2026-08-01T10:01:00.000Z",
      updatedAt: "2026-08-01T10:01:00.000Z",
      pinnedAt: null,
    },
  ]);
  const eventsByThread = new Map<string, readonly MockChatEventInput[]>([
    [RUN_THREAD_ID, runningEvents],
    [COMPLETED_THREAD_ID, completedEvents],
  ]);
  context.mocks.api(
    chatThreadEventsContract.rows,
    ({ params, query, respond }) => {
      const events = eventsByThread.get(params.threadId) ?? [];
      const rows = mockChatEventRows(
        normalizeMockChatEvents(events, params.threadId),
      ).filter((row) => {
        return row.seqId > query.sinceSeqId;
      });
      return respond(200, chatEventRowsResponse(rows, query));
    },
  );

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const runningPrompt = await screen.findByText("Running conversation prompt");
  expect(runningPrompt).toBeVisible();
  const stop = await findButton("Stop");
  expect(stop).toBeVisible();

  click(await findLink("Completed conversation"));

  const completedAnswer = await screen.findByText(
    "Only this completed answer should remain visible.",
  );
  expect(completedAnswer).toBeVisible();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/chats/${COMPLETED_THREAD_ID}`);
    expect(
      screen.queryByText("Running conversation prompt"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Reviewing the running conversation"),
    ).not.toBeInTheDocument();
    expect(
      queryAllByRoleFast("button").some((button) => {
        return (
          button.getAttribute("aria-label") === "Stop" ||
          button.textContent?.trim() === "Stop"
        );
      }),
    ).toBeFalsy();
  });
});
