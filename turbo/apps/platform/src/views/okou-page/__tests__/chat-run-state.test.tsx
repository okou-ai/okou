import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  assistantEvent,
  cancelledEvent,
  completedEvent,
  context,
  findButton,
  installRunChat,
  promptEvent,
  publishRunUpdate,
  queryButton,
  readyChat,
  RUN_PATH,
  sendText,
} from "./chat-run-test-fixtures.ts";

const RUN_A = "a0000000-0000-4000-a000-000000000101";
const RUN_B = "a0000000-0000-4000-a000-000000000102";

function requiredButton(name: string, container: ParentNode): HTMLElement {
  const button = queryButton(name, container);
  if (!button) {
    throw new Error(`Button ${name} was not available`);
  }
  return button;
}

function queuedEvent(
  id: string,
  runId: string,
  seqId: number,
): MockChatEventInput {
  return {
    id,
    eventType: "run.queued",
    role: "assistant",
    content: "Waiting in queue...",
    runId,
    runEventId: "queue:queued",
    seqId,
    createdAt: `2026-08-01T10:02:${String(seqId).padStart(2, "0")}.000Z`,
  };
}

test("Show one cancellation outcome for an interrupted run", async () => {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "cancel-user",
        runId: RUN_A,
        seqId: 1,
        text: "Draft the rollout",
      }),
      assistantEvent({
        id: "cancel-partial",
        runId: RUN_A,
        seqId: 2,
        text: "I drafted the first section.",
      }),
      {
        id: "cancel-interrupt",
        eventType: "control.interrupt",
        role: "user",
        content: null,
        interruptsRunId: RUN_A,
        seqId: 3,
        createdAt: "2026-08-01T10:00:03.000Z",
      },
      cancelledEvent({ id: "cancel-terminal", runId: RUN_A, seqId: 4 }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  const chat = await readyChat();
  expect(within(chat).getByText("I drafted the first section.")).toBeVisible();
  expect(
    within(chat).getAllByText("Paused mid-thought — pick it back up whenever."),
  ).toHaveLength(1);
  expect(queryButton("Stop")).toBeNull();
});

test("Finish a run and return the composer to send mode", async () => {
  const lifecycle = installRunChat({
    activeRunIds: [RUN_A],
    chatEvents: [
      promptEvent({
        id: "complete-user",
        runId: RUN_A,
        seqId: 1,
        text: "Finish the release notes",
      }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(
    screen.findByText("Finish the release notes"),
  ).resolves.toBeVisible();
  await expect(findButton("Stop")).resolves.toBeVisible();

  lifecycle.completeRun("## Release notes\n\n- Deployment is ready");

  await expect(findButton("Send")).resolves.toBeVisible();
  expect(screen.getByText("Release notes").tagName).toBe("H2");
  expect(screen.getByText("Deployment is ready")).toBeVisible();
  expect(queryButton("Stop")).toBeNull();
});

test("Manage work waiting in the queue", async () => {
  const events: MockChatEventInput[] = [
    promptEvent({
      id: "first-queued-user",
      runId: RUN_A,
      seqId: 1,
      text: "Queued report",
    }),
    queuedEvent("first-queued-marker", RUN_A, 2),
    promptEvent({
      id: "first-waiting-followup",
      seqId: 3,
      text: "Add the appendix",
    }),
  ];
  installRunChat({ chatEvents: events });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(findButton("queue...")).resolves.toBeVisible();
  expect(
    screen.queryByLabelText("Writing the queued report"),
  ).not.toBeInTheDocument();
  await expect(findButton("Stop")).resolves.toBeVisible();

  events.push(
    {
      id: "first-dequeued",
      eventType: "run.dequeued",
      role: "assistant",
      content: null,
      runId: RUN_A,
      runEventId: "queue:dequeued",
      revokesEventId: "first-queued-marker",
      seqId: 4,
      createdAt: "2026-08-01T10:02:04.000Z",
    },
    assistantEvent({
      id: "first-result",
      runId: RUN_A,
      seqId: 5,
      text: "The queued report is ready.",
    }),
    completedEvent({ id: "first-done", runId: RUN_A, seqId: 6 }),
  );
  publishRunUpdate();

  await expect(
    screen.findByText("The queued report is ready."),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(queryButton("queue...")).not.toBeInTheDocument();
  });

  events.push(
    promptEvent({
      id: "second-queued-user",
      runId: RUN_B,
      seqId: 7,
      text: "Queued audit",
    }),
    queuedEvent("second-queued-marker", RUN_B, 8),
    promptEvent({
      id: "second-waiting-followup",
      seqId: 9,
      text: "Include the receipts",
    }),
  );
  publishRunUpdate();
  await expect(screen.findByText("Queued audit")).resolves.toBeVisible();
  await waitFor(() => {
    expect(queryButton("Stop")).toBeVisible();
  });

  const stopButton = requiredButton("Stop", document.body);
  expect(stopButton).toBeVisible();
  click(stopButton);
  events.push(
    cancelledEvent({ id: "second-cancelled", runId: RUN_B, seqId: 10 }),
    {
      id: "recall-second-followup",
      eventType: "control.revoke",
      role: "user",
      content: null,
      revokesEventId: "second-waiting-followup",
      seqId: 11,
      createdAt: "2026-08-01T10:02:11.000Z",
    },
  );
  publishRunUpdate();

  await expect(
    screen.findByText("Paused mid-thought — pick it back up whenever."),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(screen.queryByText("Include the receipts")).not.toBeInTheDocument();
    expect(queryButton("Stop")).toBeNull();
  });
});

test("Show thinking while a newly accepted prompt starts", async () => {
  const runAccepted = context.mocks.deferred<void>();
  const lifecycle = installRunChat({ sendGate: runAccepted.promise });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await sendText("Start the pending analysis");
  await expect(
    screen.findByText("Start the pending analysis"),
  ).resolves.toBeVisible();
  await expect(findButton("Stop")).resolves.toBeVisible();

  runAccepted.resolve(undefined);
  await waitFor(() => {
    expect(screen.getAllByText("Start the pending analysis")).toHaveLength(1);
    expect(queryButton("Stop")).not.toBeNull();
    expect(context.mocks.ably.hasSharedDatabaseSubscription()).toBeTruthy();
  });

  lifecycle.completeRun("The pending analysis is complete.");
  await expect(
    screen.findByText("The pending analysis is complete."),
  ).resolves.toBeVisible();
  await expect(findButton("Send")).resolves.toBeVisible();
  expect(queryButton("Stop")).toBeNull();
});
