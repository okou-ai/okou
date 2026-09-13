import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  assistantEvent,
  cancelledEvent,
  completedEvent,
  context,
  installRunChat,
  promptEvent,
  publishRunUpdate,
  queryButton,
  readyChat,
  RUN_PATH,
  sendText,
} from "./chat-run-test-fixtures.ts";

const RUN_A = "a0000000-0000-4000-a000-000000000291";
const RUN_B = "a0000000-0000-4000-a000-000000000292";
const GROUP_ID = "a0000000-0000-4000-a000-000000000293";
const RESULT = "The API is checking dependencies. No errors so far.";
const OLD_ERROR = "The provider could not complete the previous request.";
const NEW_ERROR = "The provider could not complete the next request.";
const GENERIC_ERROR = "Oops, something went wrong. Please try again later.";

function failedEvent(
  runId = RUN_A,
  error = OLD_ERROR,
  seqId = 4,
): MockChatEventInput {
  return {
    id: `${runId}-failure`,
    eventType: "run.failed",
    content: null,
    error,
    runId,
    seqId,
    createdAt: "2026-08-01T10:00:04.000Z",
  };
}

function resultEvents(): MockChatEventInput[] {
  return [
    promptEvent({
      id: "first-input",
      runId: RUN_A,
      seqId: 1,
      text: "Check the API",
    }),
    assistantEvent({
      id: "supporting-artifact",
      runId: RUN_A,
      seqId: 2,
      text: "![Report](https://cdn.vm7.io/artifacts/status-tail/evidence/report.pdf)",
    }),
    assistantEvent({
      id: "first-result",
      runId: RUN_A,
      seqId: 3,
      text: RESULT,
    }),
  ];
}

async function openChat(): Promise<void> {
  await setupPage({
    context,
    path: RUN_PATH,
  });
  await readyChat();
}

async function expectRetainedResult(): Promise<HTMLElement> {
  const result = screen.getByText(RESULT);
  const main = result.closest<HTMLElement>("[data-chat-run-work-main]");
  if (!main) {
    throw new Error("Expected the previous main result");
  }
  const artifactTrigger = await screen.findByTestId(
    "chat-run-related-artifacts-trigger",
  );
  expect(main).toContainElement(artifactTrigger);
  expect(artifactTrigger).toHaveAccessibleName("1 artifact");
  expect(queryButton("Copy message", main)).toBeVisible();
  return main;
}

test.each(["run.failed", "output.error"] as const)(
  "Show a scheduled workflow %s in a status card with its assistant avatar when no output was produced",
  async (eventType) => {
    installRunChat({
      chatEvents: [
        {
          id: "scheduled-workflow",
          eventType: "input.automation",
          content: null,
          runId: RUN_A,
          seqId: 1,
          createdAt: "2026-08-01T10:00:00.000Z",
          userMessage: {
            version: 1,
            parts: [
              {
                type: "automation",
                workflowName: "daily-connector-registry-refresh",
                automationBrief: "This workflow started on schedule.",
              },
            ],
          },
        },
        { ...failedEvent(RUN_A, GENERIC_ERROR, 2), eventType },
      ],
    });

    await openChat();

    const error = await screen.findByText(GENERIC_ERROR);
    expect(screen.getAllByText(GENERIC_ERROR)).toHaveLength(1);
    expect(error.closest("[data-chat-run-status-tail]")).toBeVisible();
    expect(error.closest("[data-chat-selection-source]")).toBeNull();
    expect(error.closest('[role="status"]')).toBeVisible();
    expect(screen.getByText("This run couldn't finish")).toBeVisible();
    expect(error.closest('[data-role="assistant"]')).toContainElement(
      screen.getByLabelText("View agent profile"),
    );
    expect(screen.queryByTestId("chat-event-actions")).toBeNull();
    expect(
      screen.getByText("This workflow started on schedule."),
    ).toBeVisible();
  },
);

test("Keep a generic failure out of the message body while retaining previous output and actions", async () => {
  installRunChat({
    chatEvents: [...resultEvents(), failedEvent(RUN_A, GENERIC_ERROR)],
  });

  await openChat();

  const error = await screen.findByText(GENERIC_ERROR);
  const main = await expectRetainedResult();
  expect(screen.getAllByText(GENERIC_ERROR)).toHaveLength(1);
  expect(error.closest("[data-chat-run-status-tail]")).toBeVisible();
  expect(error.closest("[data-chat-selection-source]")).toBeNull();
  expect(main).not.toContainElement(error);
});

async function sendAfterPreviousFailure() {
  const sendGate = context.mocks.deferred<void>();
  const runCreated = context.mocks.deferred<void>();
  const chat = installRunChat({
    chatEvents: [...resultEvents(), failedEvent()],
    sendGate: sendGate.promise,
    onRunCreate: () => {
      runCreated.resolve();
    },
  });
  await openChat();
  const error = await screen.findByText(OLD_ERROR);
  const main = await expectRetainedResult();
  expect(error.closest("[data-chat-run-status-tail]")).toBeVisible();
  expect(main).not.toContainElement(error);

  await sendText("Continue checking");

  await expect(screen.findByText("Continue checking")).resolves.toBeVisible();
  await waitFor(() => {
    expect(document.querySelector("[data-thinking-indicator]")).toBeVisible();
    expect(screen.queryByText(OLD_ERROR)).toBeNull();
  });
  await expectRetainedResult();
  return { chat, sendGate, runCreated };
}

test("Retire the previous error as soon as a new message is sent, before acknowledgement or output", async () => {
  await sendAfterPreviousFailure();
  expect(screen.queryByText(OLD_ERROR)).toBeNull();
});

test("A subsequent failed response replaces the previous error while retaining its result", async () => {
  const { chat, sendGate, runCreated } = await sendAfterPreviousFailure();
  sendGate.resolve();
  await runCreated.promise;
  chat.failRun(NEW_ERROR);

  const nextError = await screen.findByText(NEW_ERROR);
  expect(nextError.closest("[data-chat-run-status-tail]")).toBeVisible();
  expect(screen.queryByText(OLD_ERROR)).toBeNull();
  expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
  expect(screen.getAllByTestId("chat-event-actions")).toHaveLength(1);
  await expectRetainedResult();
});

test("Retrying the latest recorded failure retires it while retaining the earlier result", async () => {
  installRunChat({
    chatEvents: [
      ...resultEvents(),
      failedEvent(),
      promptEvent({
        id: "next-input",
        runId: RUN_B,
        seqId: 5,
        text: "Continue checking",
      }),
      failedEvent(RUN_B, NEW_ERROR, 6),
    ],
  });
  await openChat();
  await screen.findByText(NEW_ERROR);
  await sendText("Try the next check");

  await expect(screen.findByText("Try the next check")).resolves.toBeVisible();
  await waitFor(() => {
    expect(document.querySelector("[data-thinking-indicator]")).toBeVisible();
    expect(screen.queryByText(NEW_ERROR)).toBeNull();
  });
  await expectRetainedResult();
});

test.each([
  { label: "unassociated input", runId: undefined, sameGroup: false },
  { label: "input in the same run", runId: RUN_A, sameGroup: false },
  { label: "input in the same run group", runId: RUN_B, sameGroup: true },
])(
  "Derive the latest response from recorded $label when opening a chat",
  async ({ runId, sameGroup }) => {
    const events = [
      ...resultEvents(),
      failedEvent(),
      promptEvent({
        id: "recorded-next-input",
        runId,
        seqId: 5,
        text: "Continue from the recorded input",
      }),
    ].map((event) => {
      return sameGroup ? { ...event, runGroupId: GROUP_ID } : event;
    });
    installRunChat({ chatEvents: events, activeRunIds: runId ? [runId] : [] });

    await openChat();

    expect(screen.getByText("Continue from the recorded input")).toBeVisible();
    expect(screen.queryByText(OLD_ERROR)).toBeNull();
    await expectRetainedResult();
  },
);

test("Show only the latest failure when neither response produced output", async () => {
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "empty-a",
        runId: RUN_A,
        seqId: 1,
        text: "First attempt",
      }),
      failedEvent(RUN_A, OLD_ERROR, 2),
      promptEvent({
        id: "empty-b",
        runId: RUN_B,
        seqId: 3,
        text: "Second attempt",
      }),
      failedEvent(RUN_B, NEW_ERROR),
    ],
  });

  await openChat();

  expect(
    screen.getByText(NEW_ERROR).closest("[data-chat-run-status-tail]"),
  ).toBeVisible();
  expect(screen.queryByText(OLD_ERROR)).toBeNull();
  expect(screen.queryByTestId("chat-event-actions")).toBeNull();
});

test.each(["failed", "cancelled"] as const)(
  "Keep a %s tail mutually exclusive with late followups",
  async (status) => {
    const terminal =
      status === "failed"
        ? failedEvent()
        : cancelledEvent({ id: "cancelled", runId: RUN_A, seqId: 4 });
    installRunChat({
      chatEvents: [
        ...resultEvents(),
        terminal,
        {
          id: "late-followups",
          content: null,
          runId: RUN_A,
          seqId: 5,
          createdAt: "2026-08-01T10:00:05.000Z",
          followups: [{ prompt: "Summarize the check", kind: "talk" }],
        },
      ],
    });

    await openChat();

    expect(
      screen.getByText(
        status === "failed"
          ? OLD_ERROR
          : "Paused mid-thought — pick it back up whenever.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("group", { name: "Keep going" })).toBeNull();
    expect(screen.queryByText("Summarize the check")).toBeNull();
    expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    await expectRetainedResult();
  },
);

test("Keep completion status visible while followups are unavailable", async () => {
  const events = [
    ...resultEvents(),
    completedEvent({
      id: "completed-without-followups",
      runId: RUN_A,
      seqId: 4,
    }),
  ];
  installRunChat({ chatEvents: events });
  await openChat();

  const completionTail = document.querySelector<HTMLElement>(
    "[data-chat-run-status-tail]",
  );
  expect(completionTail).toBeVisible();
  expect(completionTail?.querySelector("p")).toBeVisible();
  expect(completionTail?.querySelector('[role="separator"]')).toBeVisible();
  expect(screen.queryByRole("group", { name: "Keep going" })).toBeNull();
  await expectRetainedResult();

  events.push({
    id: "delayed-followups",
    content: null,
    runId: RUN_A,
    seqId: 5,
    createdAt: "2026-08-01T10:00:05.000Z",
    followups: [{ prompt: "Summarize the check", kind: "talk" }],
  });
  publishRunUpdate();

  const followups = await screen.findByRole("group", { name: "Keep going" });
  expect(followups.closest("[data-chat-run-status-tail]")).toBeVisible();
  expect(screen.getByText("Summarize the check")).toBeVisible();
  await expectRetainedResult();
});

test("Retire completion and followups while retaining the result actions", async () => {
  const sendGate = context.mocks.deferred<void>();
  installRunChat({
    sendGate: sendGate.promise,
    chatEvents: [
      ...resultEvents(),
      completedEvent({ id: "completed", runId: RUN_A, seqId: 4 }),
      {
        id: "followups",
        content: null,
        runId: RUN_A,
        seqId: 5,
        createdAt: "2026-08-01T10:00:05.000Z",
        followups: [{ prompt: "Summarize the check", kind: "talk" }],
      },
    ],
  });
  await openChat();
  await expect(
    screen.findByRole("group", { name: "Keep going" }),
  ).resolves.toBeVisible();

  await sendText("Start another check");

  await expect(screen.findByText("Start another check")).resolves.toBeVisible();
  await waitFor(() => {
    expect(document.querySelector("[data-thinking-indicator]")).toBeVisible();
    expect(screen.queryByRole("group", { name: "Keep going" })).toBeNull();
  });
  await expectRetainedResult();
  sendGate.resolve();
});

test("Handle a late previous-run failure during the next response", async () => {
  const events = [
    ...resultEvents(),
    completedEvent({ id: "old-completion", runId: RUN_A, seqId: 4 }),
    promptEvent({
      id: "pending-next-input",
      runId: RUN_B,
      seqId: 5,
      text: "Continue with the next response",
    }),
  ];
  installRunChat({ chatEvents: events, activeRunIds: [RUN_B] });
  await setupPage({
    context,
    path: RUN_PATH,
  });
  await readyChat();
  expect(screen.getByText("Continue with the next response")).toBeVisible();

  events.push(
    failedEvent(RUN_A, OLD_ERROR, 6),
    assistantEvent({
      id: "next-response-result",
      runId: RUN_B,
      seqId: 7,
      text: "The next response is progressing",
    }),
  );
  publishRunUpdate();

  await expect(
    screen.findByText("The next response is progressing"),
  ).resolves.toBeVisible();
  expect(screen.queryByText(OLD_ERROR)).not.toBeInTheDocument();
  await expectRetainedResult();
});
