import { chatThreadByIdContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill } from "../../../__tests__/page-helper.ts";
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
  RUN_THREAD_ID,
  sendText,
  thinkingEvent,
} from "./chat-run-test-fixtures.ts";

const RUN_A = "a0000000-0000-4000-a000-000000000101";
const RUN_B = "a0000000-0000-4000-a000-000000000102";

function optimisticUserMessageSpinners(): readonly Element[] {
  return [...document.querySelectorAll("[data-optimistic-user-message]")];
}

function requiredButton(name: string, container: ParentNode): HTMLElement {
  const button = queryButton(name, container);
  if (!button) {
    throw new Error(`Button ${name} was not available`);
  }
  return button;
}

function automationEvent(
  id: string,
  seqId: number,
  brief: string,
): MockChatEventInput {
  return {
    id,
    eventType: "input.automation",
    role: "user",
    content: null,
    runId: undefined,
    seqId,
    createdAt: `2026-08-01T10:01:${String(seqId).padStart(2, "0")}.000Z`,
    userMessage: {
      version: 1,
      parts: [
        {
          type: "automation",
          workflowName: "Deployment checks",
          automationBrief: brief,
        },
      ],
    },
  };
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

test("Let the latest completion end stale thinking", async () => {
  installRunChat({
    activeRunIds: [RUN_A],
    chatEvents: [
      promptEvent({
        id: "stale-user",
        runId: RUN_A,
        seqId: 1,
        text: "Older request",
      }),
      thinkingEvent({
        id: "stale-thinking",
        runId: RUN_A,
        seqId: 2,
        text: "Old work that must not revive",
      }),
      promptEvent({
        id: "latest-user",
        runId: RUN_B,
        seqId: 3,
        text: "Latest request",
      }),
      assistantEvent({
        id: "latest-answer",
        runId: RUN_B,
        seqId: 4,
        text: "Latest work is complete.",
      }),
      completedEvent({ id: "latest-complete", runId: RUN_B, seqId: 5 }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  expect(screen.getByText("Latest work is complete.")).toBeVisible();
  expect(
    screen.queryByLabelText("Old work that must not revive"),
  ).not.toBeInTheDocument();
  expect(queryButton("Stop")).toBeNull();
});

test("Explain queued work while a cancelled run is recovering", async () => {
  const events: MockChatEventInput[] = [
    promptEvent({
      id: "recovery-user",
      runId: RUN_A,
      seqId: 1,
      text: "Prepare the handoff",
    }),
    cancelledEvent({ id: "recovery-cancelled", runId: RUN_A, seqId: 2 }),
    automationEvent("recovery-automation", 3, "Run deployment checks"),
  ];
  let recoveryPending = true;
  installRunChat({ chatEvents: events });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: recoveryPending,
    });
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  expect(
    screen.getByText("Paused mid-thought — pick it back up whenever."),
  ).toBeVisible();
  const pendingAutomation = await screen.findByRole("listitem", {
    name: "Pending automation event",
  });
  expect(pendingAutomation).toHaveTextContent("Run deployment checks");

  click(requiredButton("About this automation event", pendingAutomation));
  await expect(screen.findByText("Automation event")).resolves.toBeVisible();
  expect(
    screen.getAllByText(
      "Finalizing the cancelled run before queued work continues.",
    ),
  ).toHaveLength(2);

  const composer = screen.getByRole("textbox", { name: "Message" });
  await fill(composer, "The composer still works");
  expect(composer).toHaveTextContent("The composer still works");
  click(requiredButton("Skip automation event", pendingAutomation));
  await waitFor(() => {
    expect(
      screen.queryByRole("listitem", { name: "Pending automation event" }),
    ).not.toBeInTheDocument();
  });

  recoveryPending = false;
  events.push(
    automationEvent("new-recovery-automation", 4, "Check the follow-up"),
  );
  publishRunUpdate();
  context.mocks.ably.trigger(`chatThreadDetailChanged:${RUN_THREAD_ID}`);

  const nextPendingAutomation = await screen.findByRole("listitem", {
    name: "Pending automation event",
  });
  expect(nextPendingAutomation).toHaveTextContent("Check the follow-up");
  click(requiredButton("About this automation event", nextPendingAutomation));
  await expect(
    screen.findByText(
      "Waits behind queued messages and runs once the current run finishes.",
    ),
  ).resolves.toBeVisible();
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

test("Show a cancelled run as paused", async () => {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "paused-user",
        runId: RUN_A,
        seqId: 1,
        text: "Build the launch plan",
      }),
      assistantEvent({
        id: "paused-partial",
        runId: RUN_A,
        seqId: 2,
        text: "The first milestones are drafted.",
      }),
      cancelledEvent({ id: "paused-terminal", runId: RUN_A, seqId: 3 }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  expect(screen.getByText("The first milestones are drafted.")).toBeVisible();
  expect(
    screen.getByText("Paused mid-thought — pick it back up whenever."),
  ).toBeVisible();
  expect(queryButton("Stop")).toBeNull();
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

test("Spin beside a user message the server has not confirmed", async () => {
  const runAccepted = context.mocks.deferred<void>();
  installRunChat({ sendGate: runAccepted.promise });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.OptimisticMessageSpinner]: true },
  });

  await readyChat();
  await sendText("Draft the launch checklist");
  await expect(
    screen.findByText("Draft the launch checklist"),
  ).resolves.toBeInTheDocument();
  expect(optimisticUserMessageSpinners()).toHaveLength(1);

  runAccepted.resolve(undefined);
  await waitFor(() => {
    expect(optimisticUserMessageSpinners()).toHaveLength(0);
  });
  expect(screen.getAllByText("Draft the launch checklist")).toHaveLength(1);
});

test("Leave an unconfirmed user message unmarked without the switch", async () => {
  const runAccepted = context.mocks.deferred<void>();
  installRunChat({ sendGate: runAccepted.promise });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.OptimisticMessageSpinner]: false },
  });

  await readyChat();
  await sendText("Draft the launch checklist");
  await expect(
    screen.findByText("Draft the launch checklist"),
  ).resolves.toBeInTheDocument();
  expect(optimisticUserMessageSpinners()).toHaveLength(0);

  runAccepted.resolve(undefined);
  await waitFor(() => {
    expect(screen.getAllByText("Draft the launch checklist")).toHaveLength(1);
  });
  expect(optimisticUserMessageSpinners()).toHaveLength(0);
});
