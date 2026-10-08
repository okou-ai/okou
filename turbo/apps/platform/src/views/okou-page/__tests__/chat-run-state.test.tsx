import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  cancelledEvent,
  completedEvent,
  context,
  findButton,
  installRunChat,
  promptEvent,
  queryButton,
  readyChat,
  RUN_PATH,
  sendText,
} from "./chat-run-test-fixtures.ts";

const RUN_A = "a0000000-0000-4000-a000-000000000101";

function userMessageInHistory(text: string): HTMLElement | null {
  return (
    screen
      .queryAllByText(text)
      .map((element) => {
        return element.closest<HTMLElement>('[data-role="user"]');
      })
      .find((element) => {
        return element !== null;
      }) ?? null
  );
}

function queuedMessageRow(): HTMLElement | null {
  return screen.queryByRole("listitem", { name: "Queued message" });
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
    within(chat).getAllByText("Run paused — resume anytime."),
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

test("Show thinking as soon as a new prompt is sent", async () => {
  const runAccepted = context.mocks.deferred<void>();
  const lifecycle = installRunChat({ sendGate: runAccepted.promise });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await sendText("Summarize the launch risks");

  await waitFor(() => {
    expect(userMessageInHistory("Summarize the launch risks")).not.toBeNull();
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });
  expect(queuedMessageRow()).toBeNull();

  runAccepted.resolve(undefined);
  await waitFor(() => {
    expect(queryButton("Stop")).toBeVisible();
  });
  expect(screen.getByText("Thinking...")).toBeInTheDocument();
  expect(screen.getAllByText("Summarize the launch risks")).toHaveLength(1);

  lifecycle.completeRun("The launch risks are summarized.");
  await expect(
    screen.findByText("The launch risks are summarized."),
  ).resolves.toBeVisible();
  await expect(findButton("Send")).resolves.toBeVisible();
  expect(queryButton("Stop")).toBeNull();
});

test("Keep a prompt waiting for steer delivery in the message history", async () => {
  installRunChat({
    activeRunIds: [RUN_A],
    chatEvents: [
      promptEvent({
        id: "steer-running-user",
        runId: RUN_A,
        seqId: 1,
        text: "Draft the rollout",
      }),
      promptEvent({
        id: "steer-waiting-user",
        seqId: 2,
        text: "Add the appendix",
      }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(screen.findByText("Thinking...")).resolves.toBeInTheDocument();
  expect(userMessageInHistory("Add the appendix")).not.toBeNull();
  expect(queuedMessageRow()).toBeNull();
});

test("Show waiting in queue for a persisted prompt without a run", async () => {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "org-full-finished-user",
        runId: RUN_A,
        seqId: 1,
        text: "Draft the rollout",
      }),
      assistantEvent({
        id: "org-full-finished-result",
        runId: RUN_A,
        seqId: 2,
        text: "The rollout draft is ready.",
      }),
      completedEvent({ id: "org-full-finished-done", runId: RUN_A, seqId: 3 }),
      promptEvent({
        id: "org-full-waiting-user",
        seqId: 4,
        text: "Add the appendix",
      }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(findButton("queue...")).resolves.toBeInTheDocument();
  expect(screen.getByText("Waiting in")).toBeInTheDocument();
  expect(userMessageInHistory("Add the appendix")).not.toBeNull();
  expect(queuedMessageRow()).toBeNull();
  expect(screen.getByText("The rollout draft is ready.")).toBeInTheDocument();
  expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
  expect(queryButton("Stop")).toBeNull();
  expect(queryButton("Send")).not.toBeNull();
});

test("Open the queue drawer from waiting in queue", async () => {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "org-full-drawer-user",
        seqId: 1,
        text: "Draft the rollout",
      }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  click(await findButton("queue..."));

  const drawer = await screen.findByRole("dialog", {
    name: "Your agent is waiting in line",
  });
  expect(
    within(drawer).getByText(
      "See how many concurrent runs are in use and upgrade to skip the wait.",
    ),
  ).toBeInTheDocument();
});

test("Show waiting in queue for a persisted automation event without a run", async () => {
  installRunChat({
    chatEvents: [
      {
        id: "org-full-waiting-automation",
        eventType: "input.automation",
        role: "user",
        runId: undefined,
        content: null,
        seqId: 1,
        createdAt: "2026-08-01T10:00:01.000Z",
        userMessage: {
          version: 1,
          parts: [
            {
              type: "automation",
              workflowName: "Release watcher",
              automationBrief: "Check rollout health",
            },
          ],
        },
      },
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await expect(findButton("queue...")).resolves.toBeInTheDocument();
  expect(screen.getByText("Waiting in")).toBeInTheDocument();
  expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
});
