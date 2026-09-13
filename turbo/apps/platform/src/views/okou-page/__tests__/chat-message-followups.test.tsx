import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import { chatEventRowsResponse } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
  type MockChatEventInput,
} from "./chat-event-test-helpers.ts";
import {
  context,
  findComposer,
  findFastControl,
  installMessageExperienceChat,
  MESSAGE_EXPERIENCE_AGENT_ID,
} from "./chat-message-experience-test-helpers.ts";

const CREATED_AT = "2026-08-21T14:00:00.000Z";
const FOLLOWUP_RUN_ID = "d0000000-0000-4000-a000-000000000061";
const HANDOFF_THREAD_ID = "b0000000-0000-4000-a000-000000000062";
const PRESENTATION_PROMPT = "Create a presentation outline";

function variedFollowups() {
  return [
    {
      prompt: PRESENTATION_PROMPT,
      kind: "generate" as const,
      generationType: "presentation" as const,
    },
    {
      prompt: "Create a campaign image with the approved visual direction",
      kind: "generate" as const,
      generationType: "image" as const,
    },
    {
      prompt: "Turn this into a short launch video",
      kind: "generate" as const,
      generationType: "video" as const,
    },
    {
      prompt: "Build a website for the launch",
      kind: "generate" as const,
      generationType: "website" as const,
    },
    {
      prompt: "Package the remaining launch artifacts",
      kind: "generate" as const,
    },
    { prompt: "What risks should we discuss next?", kind: "talk" as const },
  ];
}

function completedReply(
  followups = variedFollowups(),
  runId = FOLLOWUP_RUN_ID,
): MockChatEventInput[] {
  return [
    {
      id: `${runId}-user`,
      role: "user",
      content: "Review the launch plan",
      runId,
      createdAt: CREATED_AT,
    },
    {
      id: `${runId}-assistant`,
      role: "assistant",
      content: "The launch plan is ready.",
      runId,
      runLifecycleEvent: "completed",
      followups,
      createdAt: "2026-08-21T14:00:05.000Z",
    },
  ];
}

async function keepGoingGroup(): Promise<HTMLElement> {
  return await screen.findByRole("group", { name: "Keep going" });
}

function followupButtons(group: ParentNode): HTMLElement[] {
  return queryAllByRoleFast("button", group).filter((button) => {
    return button.hasAttribute("title");
  });
}

test("Invalid recommended-follow-up data stays hidden", async () => {
  const unsafePrompt = "Run <script>unsafe()</script> immediately";
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: [
      ...completedReply([], FOLLOWUP_RUN_ID),
      {
        id: "unsupported-followups",
        eventType: "output.followups",
        role: "assistant",
        runId: FOLLOWUP_RUN_ID,
        content: JSON.stringify({
          version: 99,
          followups: [{ prompt: unsafePrompt, kind: "talk" }],
        }),
        createdAt: "2026-08-21T14:00:06.000Z",
      },
    ],
  });

  await setupPage({ context, path: `/chats/${context.resourceId}` });

  await expect(findComposer()).resolves.toBeVisible();
  await waitFor(() => {
    expect(screen.queryByRole("group", { name: "Keep going" })).toBeNull();
  });
  expect(screen.queryByText(unsafePrompt)).toBeNull();
  expect(screen.queryByText(/"version":99/u)).toBeNull();
  expect(document.querySelector("script")).toBeNull();
});

test("Valid recommended follow-ups still appear when delivered late", async () => {
  const currentThreadId = context.resourceId;
  const currentRunId = "d0000000-0000-4000-a000-000000000063";
  const handoffRunId = "d0000000-0000-4000-a000-000000000064";
  const currentEvents = completedReply([], currentRunId);
  const handoffEvents = completedReply([], handoffRunId).map((event) => {
    return event.id === `${handoffRunId}-assistant`
      ? { ...event, content: "The handoff response is complete." }
      : event;
  });
  const currentFollowup: MockChatEventInput = {
    id: "current-late-followup",
    eventType: "output.followups",
    role: "assistant",
    runId: currentRunId,
    content: JSON.stringify({
      version: 1,
      followups: [{ prompt: PRESENTATION_PROMPT, kind: "talk" }],
    }),
    createdAt: "2026-08-21T14:00:06.000Z",
  };
  const handoffFollowup: MockChatEventInput = {
    ...currentFollowup,
    id: "handoff-late-followup",
    runId: handoffRunId,
  };
  let currentIncludesFollowup = false;
  let handoffIncludesFollowup = false;
  let handoffInitialResponseSent = false;
  const control = installMessageExperienceChat({
    threadId: currentThreadId,
    threadTitle: "Current response",
    chatEvents: currentEvents,
  });
  control.setThreadList([
    {
      id: currentThreadId,
      title: "Current response",
      agent: { id: MESSAGE_EXPERIENCE_AGENT_ID, avatarUrl: null },
      createdAt: CREATED_AT,
      updatedAt: "2026-08-21T14:02:00.000Z",
    },
    {
      id: HANDOFF_THREAD_ID,
      title: "Handoff response",
      agent: { id: MESSAGE_EXPERIENCE_AGENT_ID, avatarUrl: null },
      createdAt: CREATED_AT,
      updatedAt: "2026-08-21T14:01:00.000Z",
    },
  ]);
  context.mocks.api(
    chatThreadEventsContract.rows,
    ({ params, query, respond }) => {
      const isCurrent = params.threadId === currentThreadId;
      const sourceEvents = isCurrent
        ? [
            ...currentEvents,
            ...(currentIncludesFollowup ? [currentFollowup] : []),
          ]
        : [
            ...handoffEvents,
            ...(handoffIncludesFollowup ? [handoffFollowup] : []),
          ];
      const rows = mockChatEventRows(
        normalizeMockChatEvents(sourceEvents, params.threadId),
      ).filter((row) => {
        return row.seqId > query.sinceSeqId;
      });
      if (!isCurrent && query.sinceSeqId === 0 && !handoffInitialResponseSent) {
        handoffInitialResponseSent = true;
        queueMicrotask(() => {
          handoffIncludesFollowup = true;
          createChatEvent(HANDOFF_THREAD_ID);
        });
      }
      return respond(200, chatEventRowsResponse(rows, query));
    },
  );

  await setupPage({ context, path: `/chats/${currentThreadId}` });

  await expect(
    screen.findByText("The launch plan is ready."),
  ).resolves.toBeVisible();
  expect(screen.queryByRole("group", { name: "Keep going" })).toBeNull();
  currentIncludesFollowup = true;
  createChatEvent(currentThreadId);
  let group = await keepGoingGroup();
  expect(
    followupButtons(group).find((button) => {
      return button.title === PRESENTATION_PROMPT;
    }),
  ).toBeVisible();
  expect(document.querySelector("[data-thinking-indicator]")).toBeNull();

  click(await findFastControl("link", "Handoff response"));
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/chats/${HANDOFF_THREAD_ID}`);
  });
  await expect(
    screen.findByText("The handoff response is complete."),
  ).resolves.toBeVisible();
  const handoffPane = await waitFor(() => {
    const pane = document.querySelector<HTMLElement>(
      `[data-chat-thread-container-id="${HANDOFF_THREAD_ID}"]`,
    );
    if (!pane) {
      throw new Error("Handoff chat pane not found");
    }
    return pane;
  });
  group = await within(handoffPane).findByRole("group", {
    name: "Keep going",
  });
  expect(
    followupButtons(group).find((button) => {
      return button.title === PRESENTATION_PROMPT;
    }),
  ).toBeVisible();
  expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
});

test("A newer assistant reply retires older follow-ups", async () => {
  const newerRunId = "d0000000-0000-4000-a000-000000000065";
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: [
      ...completedReply(
        [{ prompt: PRESENTATION_PROMPT, kind: "talk" }],
        FOLLOWUP_RUN_ID,
      ),
      {
        id: "newer-user",
        role: "user",
        content: "Focus on delivery dates instead",
        runId: newerRunId,
        createdAt: "2026-08-21T14:01:00.000Z",
      },
      {
        id: "newer-assistant",
        role: "assistant",
        content: "Here is the updated delivery schedule.",
        runId: newerRunId,
        runLifecycleEvent: "completed",
        createdAt: "2026-08-21T14:01:05.000Z",
      },
    ],
  });

  await setupPage({ context, path: `/chats/${context.resourceId}` });

  await expect(
    screen.findByText("The launch plan is ready."),
  ).resolves.toBeVisible();
  expect(
    screen.getByText("Here is the updated delivery schedule."),
  ).toBeVisible();
  await waitFor(() => {
    expect(screen.queryByRole("group", { name: "Keep going" })).toBeNull();
  });
  expect(screen.queryByText(PRESENTATION_PROMPT)).toBeNull();
});

test("A recommended follow-up edits the draft without sending it", async () => {
  const user = userEvent.setup({ delay: null });
  const followups = variedFollowups();
  const onSendRequest = vi.fn<(body: { readonly prompt: string }) => void>();
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: completedReply(followups),
    onSendRequest,
  });

  await setupPage({ context, path: `/chats/${context.resourceId}` });

  const group = await keepGoingGroup();
  expect(screen.getByText(/Keep going ·/u)).toBeVisible();
  expect(followupButtons(group)).toHaveLength(followups.length);
  const composer = await findComposer();
  await fill(composer, "Keep the current launch context");
  const recommendation = followupButtons(group).find((button) => {
    return button.title === PRESENTATION_PROMPT;
  });
  if (!recommendation) {
    throw new Error("Presentation recommendation not found");
  }

  await user.click(recommendation);
  await waitFor(() => {
    expect(composer.textContent).toBe(
      `Keep the current launch context\n${PRESENTATION_PROMPT}`,
    );
    expect(composer).toHaveFocus();
  });
  expect(recommendation).toBeVisible();
  expect(onSendRequest).not.toHaveBeenCalled();

  await user.click(recommendation);
  await waitFor(() => {
    expect(window.getSelection()?.toString()).toBe(PRESENTATION_PROMPT);
  });
  expect(composer.textContent).toBe(
    `Keep the current launch context\n${PRESENTATION_PROMPT}`,
  );
  expect(composer).toHaveFocus();
  expect(onSendRequest).not.toHaveBeenCalled();
});

test("A touch device renders the recommended follow-ups as a quick reply rail", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === "(pointer: coarse)";
  });
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: completedReply(),
  });

  await setupPage({
    context,
    path: `/chats/${context.resourceId}`,
  });

  const group = await keepGoingGroup();
  expect(group).toHaveAttribute("data-followup-layout", "quick-reply-rail");
  expect(followupButtons(group)).toHaveLength(variedFollowups().length);
});

test("A fine-pointer device keeps the recommended follow-up rows at any width", async () => {
  // The layout follows the pointer, never the viewport. Width is deliberately
  // left unset: a desktop window dragged narrow must keep these rows, and
  // pinning that in jsdom is not possible because it evaluates neither layout
  // nor container queries.
  context.mocks.browser.matchMedia((query) => {
    return query === "(any-pointer: fine)";
  });
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: completedReply(),
  });

  await setupPage({
    context,
    path: `/chats/${context.resourceId}`,
  });

  const group = await keepGoingGroup();
  expect(group).toHaveAttribute("data-followup-layout", "rows");
});
