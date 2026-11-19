import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { changeChatIndicators } from "../../../mocks/mock-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
  promptEvent,
  publishRunUpdate,
  queryButton,
  readyChat,
  RUN_PATH,
  sendText,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const CHECK_RUN_ID = "a0000000-0000-4000-a000-000000000501";
const NEXT_RUN_ID = "a0000000-0000-4000-a000-000000000502";
const REPORT_URL =
  "https://cdn.vm7.io/artifacts/status-tail/check-report/check-report.pdf";
const RESULT_TEXT = "Deployment check summary";

function thinkingIndicator(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-thinking-indicator]");
}

function statusTail(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-chat-run-status-tail]");
}

function resultActions(): HTMLElement {
  const actions = screen
    .getByText(RESULT_TEXT)
    .closest<HTMLElement>("[data-chat-run-work-main]")
    ?.querySelector<HTMLElement>('[data-testid="chat-event-actions"]');
  if (!actions) {
    throw new Error("The retained result has no actions");
  }
  return actions;
}

function expectRetainedResult(): void {
  expect(screen.getByText(RESULT_TEXT)).toBeVisible();
  const actions = resultActions();
  expect(
    within(actions).getByTestId("chat-run-related-artifacts-trigger"),
  ).toHaveAccessibleName("1 artifact");
  expect(queryButton("Copy message", actions)).toBeVisible();
}

function checkResult(runId: string): MockChatEventInput[] {
  return [
    promptEvent({
      id: `${runId}-request`,
      runId,
      seqId: 1,
      text: "Check the deployment",
    }),
    assistantEvent({
      id: `${runId}-report`,
      runId,
      seqId: 2,
      text: `Generated the check report.\n\n[Check report](${REPORT_URL})`,
    }),
    assistantEvent({
      id: `${runId}-summary`,
      runId,
      seqId: 3,
      text: RESULT_TEXT,
    }),
  ];
}

function failedEvent(args: {
  readonly id: string;
  readonly runId: string;
  readonly seqId: number;
  readonly failureReason?: "execution_timeout";
}): MockChatEventInput {
  return {
    id: args.id,
    role: "assistant",
    content: null,
    runId: args.runId,
    runLifecycleEvent: "failed",
    ...(args.failureReason === undefined
      ? {}
      : { failureReason: args.failureReason }),
    seqId: args.seqId,
    createdAt: `2026-08-01T10:00:${String(args.seqId).padStart(2, "0")}.000Z`,
  };
}

async function openRunChat(
  chatEvents: MockChatEventInput[],
  activeRunIds: string[] = [],
): Promise<void> {
  installRunChat({ chatEvents, activeRunIds });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await expect(screen.findByText(RESULT_TEXT)).resolves.toBeVisible();
}

// The send endpoint only enqueues the input. Holding its response keeps the
// new prompt unacknowledged, before any run claims it or produces output.
function holdSend() {
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

function genericFailureConversation(): MockChatEventInput[] {
  return [
    ...checkResult(CHECK_RUN_ID),
    failedEvent({ id: "check-failed", runId: CHECK_RUN_ID, seqId: 4 }),
  ];
}

async function expectGenericFailure(): Promise<void> {
  await waitFor(() => {
    expect(statusTail()).toHaveTextContent("This run couldn't finish");
  });
}

test("Retire the previous error as soon as a new message is sent, before acknowledgement or output", async () => {
  await openRunChat(genericFailureConversation());
  await expectGenericFailure();
  const send = holdSend();

  await sendText("Continue checking");
  await send.sent;

  await waitFor(() => {
    expect(thinkingIndicator()).toHaveTextContent("Thinking...");
  });
  expect(screen.queryByText("This run couldn't finish")).toBeNull();
  expectRetainedResult();
});

test("A subsequent failed response replaces the previous error while retaining its result", async () => {
  const chatEvents = genericFailureConversation();
  const activeRunIds: string[] = [];
  await openRunChat(chatEvents, activeRunIds);
  await expectGenericFailure();
  const send = holdSend();
  await sendText("Continue checking");
  const clientEventId = await send.sent;
  await waitFor(() => {
    expect(thinkingIndicator()).toBeVisible();
  });

  send.acknowledge();
  chatEvents.push(
    promptEvent({
      id: clientEventId,
      runId: NEXT_RUN_ID,
      seqId: 5,
      text: "Continue checking",
    }),
    failedEvent({
      id: "continue-timeout",
      runId: NEXT_RUN_ID,
      seqId: 6,
      failureReason: "execution_timeout",
    }),
  );
  publishRunUpdate();
  changeChatIndicators();

  await waitFor(() => {
    expect(statusTail()).toHaveTextContent("Time limit reached");
  });
  expect(screen.queryByText("This run couldn't finish")).toBeNull();
  expect(thinkingIndicator()).toBeNull();
  expect(screen.getAllByTestId("chat-event-actions")).toHaveLength(1);
  expectRetainedResult();
});

test("Derive the latest response from recorded input in the same run when opening a chat", async () => {
  await openRunChat(
    [
      ...genericFailureConversation(),
      promptEvent({
        id: "recorded-input",
        runId: CHECK_RUN_ID,
        seqId: 5,
        text: "Continue from the recorded input",
      }),
    ],
    [CHECK_RUN_ID],
  );

  await expect(
    screen.findByText("Continue from the recorded input"),
  ).resolves.toBeVisible();
  expect(screen.queryByText("This run couldn't finish")).toBeNull();
  expectRetainedResult();
});

test("Retire completion and followups while retaining the result actions", async () => {
  await openRunChat([
    ...checkResult(CHECK_RUN_ID),
    {
      id: "check-followups",
      eventType: "output.followups",
      role: "assistant",
      runId: CHECK_RUN_ID,
      content: null,
      followups: [{ prompt: "Summarize the check", kind: "talk" }],
      seqId: 4,
      createdAt: "2026-08-01T10:00:04.000Z",
    },
    completedEvent({ id: "check-complete", runId: CHECK_RUN_ID, seqId: 5 }),
  ]);
  const followups = await screen.findByRole("group", { name: "Keep going" });
  expect(queryButton("Summarize the check", followups)).toBeVisible();
  const send = holdSend();

  await sendText("Start another check");
  await send.sent;

  await waitFor(() => {
    expect(thinkingIndicator()).toHaveTextContent("Thinking...");
  });
  expect(screen.queryByRole("group", { name: "Keep going" })).toBeNull();
  expect(screen.queryByText("Summarize the check")).toBeNull();
  expectRetainedResult();
});
