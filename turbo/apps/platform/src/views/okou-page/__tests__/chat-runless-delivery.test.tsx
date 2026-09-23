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

const LEGACY_RUN = "a0000000-0000-4000-a000-000000000401";
const LEGACY_WORK = "Collected yesterday's activity";
const LEGACY_BRIEF = "Brief delivered by a Run";
const NATIVE_BRIEF = "Brief delivered without a Run";
const NATIVE_DELIVERED_AT = "2026-08-02T03:25:05.000Z";

/**
 * A native Morning Brief delivery writes one bare `output.message`: no run id,
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
 * The thread's history before the first native delivery. Every message is
 * anchored to a Run, because the legacy Morning Brief executed as an Official
 * Workflow agent Run.
 */
function runAnchoredHistory(): MockChatEventInput[] {
  return [
    {
      id: "legacy-automation",
      role: "user",
      eventType: "input.automation",
      content: null,
      userMessage: {
        version: 1,
        parts: [
          {
            type: "automation",
            workflowName: "morning-brief",
            automationBrief: "Morning Brief",
          },
        ],
      },
      runId: LEGACY_RUN,
      seqId: 1,
      createdAt: "2026-08-01T03:25:00.000Z",
    },
    assistantEvent({
      id: "legacy-work",
      runId: LEGACY_RUN,
      seqId: 2,
      text: LEGACY_WORK,
      createdAt: "2026-08-01T03:25:02.000Z",
    }),
    assistantEvent({
      id: "legacy-brief",
      runId: LEGACY_RUN,
      seqId: 3,
      text: LEGACY_BRIEF,
      createdAt: "2026-08-01T03:25:04.000Z",
    }),
    completedEvent({
      id: "legacy-completed",
      runId: LEGACY_RUN,
      seqId: 4,
      createdAt: "2026-08-01T03:25:05.000Z",
    }),
  ];
}

function nativeDeliveryAfterRunHistory(): MockChatEventInput[] {
  return [
    ...runAnchoredHistory(),
    runlessDelivery({
      id: "native-brief",
      seqId: 5,
      text: NATIVE_BRIEF,
      createdAt: NATIVE_DELIVERED_AT,
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
        id: "native-brief",
        seqId: 1,
        text: NATIVE_BRIEF,
        createdAt: NATIVE_DELIVERED_AT,
      }),
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();

  await expect(screen.findByText(NATIVE_BRIEF)).resolves.toBeInTheDocument();
});

test("renders a delivery that carries no run identity after a Run", async () => {
  installRunChat({ chatEvents: nativeDeliveryAfterRunHistory() });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();

  await expect(screen.findByText(NATIVE_BRIEF)).resolves.toBeInTheDocument();
});

test("keeps run work history off a delivery that has no Run", async () => {
  installRunChat({ chatEvents: nativeDeliveryAfterRunHistory() });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await screen.findByText(NATIVE_BRIEF);

  expectTextOrder(LEGACY_BRIEF, NATIVE_BRIEF);
  const runResponse = assistantGroupFor(LEGACY_BRIEF);
  const runlessResponse = assistantGroupFor(NATIVE_BRIEF);
  // The delivery reads as a response of its own rather than as more of the
  // Run's answer, and only the Run offers the work behind its answer.
  expect(runlessResponse).not.toBe(runResponse);
  expect(queryWorkHistoryToggle("collapsed", runResponse)).not.toBeNull();
  expect(queryWorkHistoryToggle("collapsed", runlessResponse)).toBeNull();
});
