import {
  chatThreadEventsContract,
  type ChatRecommendedFollowup,
} from "@okouai/api-contracts/contracts/chat-threads";
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
import {
  chatEventRowsResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
  type MockChatEventInput,
} from "./chat-event-test-helpers.ts";
import {
  createMessageExperienceHelpers,
  findComposer,
  findFastControl,
  MESSAGE_EXPERIENCE_AGENT_ID,
} from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installMessageExperienceChat } =
  createMessageExperienceHelpers(context);

const CREATED_AT = "2026-08-21T14:00:00.000Z";
const FOLLOWUP_RUN_ID = "d0000000-0000-4000-a000-000000000061";
const HANDOFF_THREAD_ID = "b0000000-0000-4000-a000-000000000062";
const PRESENTATION_PROMPT = "Create a presentation outline";

function completedReply(
  followups: readonly ChatRecommendedFollowup[],
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

function followup(group: ParentNode, prompt: string): HTMLElement {
  const button = queryAllByRoleFast("button", group).find((candidate) => {
    return candidate.textContent?.trim() === prompt;
  });
  if (!button) {
    throw new Error(`Recommendation "${prompt}" not found`);
  }
  return button;
}

function installLateFollowupChat() {
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
        ? [...currentEvents, currentFollowup]
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
  return currentThreadId;
}

test("A late recommendation appears after navigating to another chat", async () => {
  const currentThreadId = installLateFollowupChat();
  await setupPage({ context, path: `/chats/${currentThreadId}` });
  const currentGroup = await screen.findByRole("group", { name: "Keep going" });
  expect(followup(currentGroup, PRESENTATION_PROMPT)).toBeVisible();

  click(await findFastControl("link", "Handoff response"));
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/chats/${HANDOFF_THREAD_ID}`);
  });

  const handoffPane = await waitFor(() => {
    const pane = document.querySelector<HTMLElement>(
      `[data-chat-thread-container-id="${HANDOFF_THREAD_ID}"]`,
    );
    if (!pane) {
      throw new Error("Handoff chat pane not found");
    }
    return pane;
  });
  const handoffGroup = await within(handoffPane).findByRole("group", {
    name: "Keep going",
  });
  expect(followup(handoffGroup, PRESENTATION_PROMPT)).toBeVisible();
  expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
});

test("A recommended follow-up edits the draft without sending it", async () => {
  const user = userEvent.setup({ delay: null });
  const onSendRequest = vi.fn<(body: { readonly prompt: string }) => void>();
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: completedReply([
      {
        prompt: PRESENTATION_PROMPT,
        kind: "generate",
        generationType: "presentation",
      },
      {
        prompt: "Create a campaign image with the approved visual direction",
        kind: "generate",
        generationType: "image",
      },
      {
        prompt: "Build a website for the launch",
        kind: "generate",
        generationType: "website",
      },
      { prompt: "Package the remaining launch artifacts", kind: "generate" },
      { prompt: "What risks should we discuss next?", kind: "talk" },
    ]),
    onSendRequest,
  });
  await setupPage({ context, path: `/chats/${context.resourceId}` });
  const group = await screen.findByRole("group", { name: "Keep going" });
  const composer = await findComposer();
  await fill(composer, "Keep the current launch context");
  const recommendation = followup(group, PRESENTATION_PROMPT);
  const draft = `Keep the current launch context\n${PRESENTATION_PROMPT}`;

  await user.click(recommendation);

  await waitFor(() => {
    expect(composer.textContent).toBe(draft);
    expect(composer).toHaveFocus();
  });
  expect(recommendation).toBeVisible();
  expect(onSendRequest).not.toHaveBeenCalled();

  await user.click(recommendation);

  await waitFor(() => {
    expect(window.getSelection()?.toString()).toBe(PRESENTATION_PROMPT);
  });
  expect(composer.textContent).toBe(draft);
  expect(onSendRequest).not.toHaveBeenCalled();
});

test.each([false, true])(
  "Workflow and email recommendations keep their icons and edit the draft (touch: %s)",
  async (touch) => {
    context.mocks.browser.matchMedia((query) => {
      return touch && query === "(pointer: coarse)";
    });
    const workflowPrompt = "Save this process as a workflow";
    const emailPrompt = "After I send it, notify me when they reply";
    const onSendRequest = vi.fn<(body: { readonly prompt: string }) => void>();
    installMessageExperienceChat({
      threadId: context.resourceId,
      chatEvents: completedReply([
        { prompt: workflowPrompt, kind: "workflow" },
        { prompt: emailPrompt, kind: "email" },
      ]),
      onSendRequest,
    });
    await setupPage({ context, path: `/chats/${context.resourceId}` });
    const group = await screen.findByRole("group", { name: "Keep going" });
    const workflow = followup(group, workflowPrompt);
    const email = followup(group, emailPrompt);
    const composer = await findComposer();

    expect(workflow.querySelector("svg.lucide-route")).toBeVisible();
    expect(email.querySelector("svg.lucide-mail")).toBeVisible();

    click(workflow);
    await waitFor(() => {
      expect(composer.textContent).toBe(workflowPrompt);
    });
    click(email);

    await waitFor(() => {
      expect(composer.textContent).toBe(`${workflowPrompt}\n${emailPrompt}`);
      expect(composer).toHaveFocus();
    });
    expect(onSendRequest).not.toHaveBeenCalled();
  },
);
