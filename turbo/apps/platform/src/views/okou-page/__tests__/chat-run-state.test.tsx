import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { changeChatIndicators } from "../../../mocks/mock-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  cancelledEvent,
  completedEvent,
  createChatRunFixtures,
  findButton,
  promptEvent,
  publishRunUpdate,
  queryButton,
  readyChat,
  RUN_PATH,
  sendText,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const RUN_ID = "a0000000-0000-4000-a000-000000000401";
const EARLIER_RUN_ID = "a0000000-0000-4000-a000-000000000402";

function thinkingIndicator(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-thinking-indicator]");
}

function userTurnCount(text: string): number {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-role="user"]'),
  ).filter((turn) => {
    return turn.textContent?.includes(text) === true;
  }).length;
}

function queuedMessageRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[role="listitem"][aria-label="Queued message"]',
  );
}

async function openRunChat(
  chatEvents: MockChatEventInput[],
  activeRunIds: string[] = [],
): Promise<void> {
  installRunChat({ chatEvents, activeRunIds });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
}

interface HeldSend {
  readonly sent: Promise<string>;
  readonly acknowledge: () => void;
}

// The send endpoint only enqueues input; the run that claims it arrives later
// through the thread's event stream. Holding the response keeps the prompt
// unacknowledged until the test releases it.
function holdSend(): HeldSend {
  const sent = context.mocks.deferred<string>();
  const acknowledged = context.mocks.deferred<void>();
  context.mocks.api(chatEventsContract.send, async ({ body, respond }) => {
    sent.resolve(body.clientEventId ?? "");
    await acknowledged.promise;
    return respond(201, {
      threadId: body.threadId ?? "",
      createdAt: "2026-08-01T10:01:00.000Z",
    });
  });
  return {
    sent: sent.promise,
    acknowledge: () => {
      acknowledged.resolve();
    },
  };
}

function earlierConversation(): MockChatEventInput[] {
  return [
    promptEvent({
      id: "earlier-request",
      runId: EARLIER_RUN_ID,
      seqId: 1,
      text: "Collect the launch notes",
    }),
    assistantEvent({
      id: "earlier-answer",
      runId: EARLIER_RUN_ID,
      seqId: 2,
      text: "Launch notes collected",
    }),
    completedEvent({ id: "earlier-complete", runId: EARLIER_RUN_ID, seqId: 3 }),
  ];
}

test("Show one cancellation outcome for an interrupted run", async () => {
  await openRunChat([
    promptEvent({
      id: "interrupted-request",
      runId: RUN_ID,
      seqId: 1,
      text: "Draft the launch notes",
    }),
    assistantEvent({
      id: "interrupted-partial",
      runId: RUN_ID,
      seqId: 2,
      text: "Partial launch notes",
    }),
    {
      id: "interrupt-control",
      role: "user",
      content: null,
      interruptsRunId: RUN_ID,
      seqId: 3,
      createdAt: "2026-08-01T10:00:03.000Z",
    },
    cancelledEvent({ id: "interrupted-cancelled", runId: RUN_ID, seqId: 4 }),
  ]);

  await expect(
    screen.findByText("Partial launch notes"),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(screen.getAllByText("Run paused — resume anytime.")).toHaveLength(1);
  });
  expect(queryButton("Stop")).toBeNull();
});

test("Show thinking as soon as a new prompt is sent", async () => {
  const chatEvents = earlierConversation();
  const activeRunIds: string[] = [];
  await openRunChat(chatEvents, activeRunIds);
  const send = holdSend();

  await sendText("Summarize the launch risks");
  const clientEventId = await send.sent;

  await waitFor(() => {
    expect(userTurnCount("Summarize the launch risks")).toBe(1);
  });
  expect(thinkingIndicator()).toHaveTextContent("Thinking...");
  expect(queuedMessageRow()).toBeNull();

  send.acknowledge();
  chatEvents.push(
    promptEvent({
      id: clientEventId,
      runId: RUN_ID,
      seqId: 4,
      text: "Summarize the launch risks",
    }),
  );
  activeRunIds.push(RUN_ID);
  publishRunUpdate();
  changeChatIndicators();

  await waitFor(() => {
    expect(queryButton("Stop")).toBeVisible();
  });
  expect(thinkingIndicator()).toHaveTextContent("Thinking...");
  expect(userTurnCount("Summarize the launch risks")).toBe(1);

  chatEvents.push(
    assistantEvent({
      id: "risks-answer",
      runId: RUN_ID,
      seqId: 5,
      text: "Launch risks summarized",
    }),
    completedEvent({ id: "risks-complete", runId: RUN_ID, seqId: 6 }),
  );
  activeRunIds.splice(0);
  publishRunUpdate();
  changeChatIndicators();

  await expect(
    screen.findByText("Launch risks summarized"),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(queryButton("Send")).toBeVisible();
  });
  expect(queryButton("Stop")).toBeNull();
  expect(thinkingIndicator()).toBeNull();
});

test("Keep the composer and transcript in sync as a sent prompt is queued, claimed and finished", async () => {
  const chatEvents = earlierConversation();
  const activeRunIds: string[] = [];
  await openRunChat(chatEvents, activeRunIds);
  const send = holdSend();

  await sendText("Prepare the launch checklist");
  const clientEventId = await send.sent;

  await waitFor(() => {
    expect(userTurnCount("Prepare the launch checklist")).toBe(1);
  });
  expect(thinkingIndicator()).toHaveTextContent("Thinking...");

  // The server holds the input without a run while the workspace waits for a
  // free run slot.
  send.acknowledge();
  chatEvents.push({
    ...promptEvent({
      id: clientEventId,
      seqId: 4,
      text: "Prepare the launch checklist",
    }),
    runId: undefined,
  });
  publishRunUpdate();

  const queueControl = await findButton("queue...");
  expect(queueControl).toBeVisible();
  expect(
    queueControl.closest('[data-role="assistant-thinking"]'),
  ).toHaveTextContent("Waiting in queue...");
  expect(thinkingIndicator()).toBeNull();
  expect(screen.queryByText("Thinking...")).toBeNull();
  expect(queryButton("Send")).toBeVisible();
  expect(queryButton("Stop")).toBeNull();
  expect(userTurnCount("Prepare the launch checklist")).toBe(1);

  chatEvents.push({
    ...promptEvent({
      id: "claimed-checklist",
      runId: RUN_ID,
      seqId: 5,
      text: "Prepare the launch checklist",
    }),
    revokesEventId: clientEventId,
  });
  activeRunIds.push(RUN_ID);
  publishRunUpdate();
  changeChatIndicators();

  await waitFor(() => {
    expect(queryButton("Stop")).toBeVisible();
  });
  expect(queryButton("queue...")).toBeNull();
  expect(thinkingIndicator()).toHaveTextContent("Thinking...");
  expect(userTurnCount("Prepare the launch checklist")).toBe(1);

  chatEvents.push(
    assistantEvent({
      id: "checklist-answer",
      runId: RUN_ID,
      seqId: 6,
      text: "Launch checklist prepared",
    }),
    completedEvent({ id: "checklist-complete", runId: RUN_ID, seqId: 7 }),
  );
  activeRunIds.splice(0);
  publishRunUpdate();
  changeChatIndicators();

  await expect(
    screen.findByText("Launch checklist prepared"),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(queryButton("Send")).toBeVisible();
  });
  expect(queryButton("Stop")).toBeNull();
  expect(thinkingIndicator()).toBeNull();
  expect(screen.queryByText("Thinking...")).toBeNull();
  expect(userTurnCount("Prepare the launch checklist")).toBe(1);
});

test("Keep a prompt waiting for steer delivery in the message history", async () => {
  await openRunChat(
    [
      promptEvent({
        id: "rollout-request",
        runId: RUN_ID,
        seqId: 1,
        text: "Draft the rollout",
      }),
      {
        ...promptEvent({
          id: "appendix-steer",
          seqId: 2,
          text: "Add the appendix",
        }),
        runId: undefined,
      },
    ],
    [RUN_ID],
  );

  await waitFor(() => {
    expect(userTurnCount("Add the appendix")).toBe(1);
  });
  await waitFor(() => {
    expect(thinkingIndicator()).toHaveTextContent("Thinking...");
  });
  expect(queuedMessageRow()).toBeNull();
});
