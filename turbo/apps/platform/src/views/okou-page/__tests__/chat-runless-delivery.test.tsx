import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  context,
  expectTextOrder,
  installRunChat,
  queryWorkHistoryToggle,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const PREVIOUS_RUN = "a0000000-0000-4000-a000-000000000401";
const PREVIOUS_WORK = "Work performed during the previous Run";
const PREVIOUS_RESPONSE = "Response from the previous Run";
const RUNLESS_MESSAGE = "Message delivered without a Run";
const MESSAGE_CREATED_AT = "2026-08-02T03:25:05.000Z";

/**
 * An independent message is one bare `output.message`: no run id,
 * no run event id and no run event sequence number, and none of the input,
 * terminal or followup events a Run leaves around its answer.
 */
function runlessDelivery(args: {
  readonly id: string;
  readonly seqId: number;
  readonly text: string;
  readonly createdAt: string;
}): MockChatEventInput {
  return {
    id: args.id,
    role: "assistant",
    content: args.text,
    runId: undefined,
    runEventId: undefined,
    sequenceNumber: undefined,
    seqId: args.seqId,
    createdAt: args.createdAt,
  };
}

/**
 * A prior automation Run's input, work, answer and completion before an
 * independent message is delivered to the same thread.
 */
function runAnchoredHistory(): MockChatEventInput[] {
  return [
    {
      id: "previous-automation",
      role: "user",
      eventType: "input.automation",
      content: null,
      userMessage: {
        version: 1,
        parts: [
          {
            type: "automation",
            workflowName: "example-workflow",
            automationBrief: "Scheduled update",
          },
        ],
      },
      runId: PREVIOUS_RUN,
      seqId: 1,
      createdAt: "2026-08-01T03:25:00.000Z",
    },
    assistantEvent({
      id: "previous-work",
      runId: PREVIOUS_RUN,
      seqId: 2,
      text: PREVIOUS_WORK,
      createdAt: "2026-08-01T03:25:02.000Z",
    }),
    assistantEvent({
      id: "previous-response",
      runId: PREVIOUS_RUN,
      seqId: 3,
      text: PREVIOUS_RESPONSE,
      createdAt: "2026-08-01T03:25:04.000Z",
    }),
    completedEvent({
      id: "previous-completed",
      runId: PREVIOUS_RUN,
      seqId: 4,
      createdAt: "2026-08-01T03:25:05.000Z",
    }),
  ];
}

function deliveryAfterRunHistory(): MockChatEventInput[] {
  return [
    ...runAnchoredHistory(),
    runlessDelivery({
      id: "runless-message",
      seqId: 5,
      text: RUNLESS_MESSAGE,
      createdAt: MESSAGE_CREATED_AT,
    }),
  ];
}

function assistantGroupFor(text: string): HTMLElement {
  const group = screen
    .getByText(text)
    .closest<HTMLElement>('[data-role="assistant"]');
  if (!group) {
    throw new Error(`No assistant response renders "${text}"`);
  }
  return group;
}

test("renders a thread whose only message carries no run identity", async () => {
  installRunChat({
    chatEvents: [
      runlessDelivery({
        id: "runless-message",
        seqId: 1,
        text: RUNLESS_MESSAGE,
        createdAt: MESSAGE_CREATED_AT,
      }),
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();

  await expect(screen.findByText(RUNLESS_MESSAGE)).resolves.toBeInTheDocument();
});

test("renders a delivery that carries no run identity after a Run", async () => {
  installRunChat({ chatEvents: deliveryAfterRunHistory() });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();

  await expect(screen.findByText(RUNLESS_MESSAGE)).resolves.toBeInTheDocument();
});

test("keeps run work history off a delivery that has no Run", async () => {
  installRunChat({ chatEvents: deliveryAfterRunHistory() });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await screen.findByText(RUNLESS_MESSAGE);

  expectTextOrder(PREVIOUS_RESPONSE, RUNLESS_MESSAGE);
  const runResponse = assistantGroupFor(PREVIOUS_RESPONSE);
  const runlessResponse = assistantGroupFor(RUNLESS_MESSAGE);
  // The delivery reads as a response of its own rather than as more of the
  // Run's answer, and only the Run offers the work behind its answer.
  expect(runlessResponse).not.toBe(runResponse);
  expect(queryWorkHistoryToggle("collapsed", runResponse)).not.toBeNull();
  expect(queryWorkHistoryToggle("collapsed", runlessResponse)).toBeNull();
});
