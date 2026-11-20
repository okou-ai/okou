import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, within } from "@testing-library/react";
import { test, expect } from "vitest";
import { setupPage, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  assistantEvent,
  promptEvent,
  completedEvent,
  cancelledEvent,
  createChatRunFixtures,
  RUN_PATH,
  RUN_THREAD_ID,
  publishRunUpdate,
  sendText,
  findEnabledButton,
  queryButton,
  findButton,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);
const runId = "055304c5-4bea-42ed-b7b5-869765017450";

test("chat-run-state-001 shows one pause for the interrupted partial answer", async () => {
  const partial = "The release review has reached section three.";
  installRunChat({
    chatEvents: [
      promptEvent({
        id: "review",
        runId,
        seqId: 1,
        text: "Review the release.",
      }),
      assistantEvent({ id: "progress", runId, seqId: 2, text: partial }),
      {
        id: "stop",
        eventType: "control.interrupt",
        interruptsRunId: runId,
        runId: undefined,
        content: null,
        seqId: 3,
        createdAt: "2026-08-01T10:00:03Z",
      },
      cancelledEvent({ id: "cancelled", runId, seqId: 4 }),
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  await screen.findByText(partial);
  await expect(
    screen.findAllByText("Run paused — resume anytime."),
  ).resolves.toHaveLength(1);
  expect(queryButton("Stop")).toBeNull();
});

test("chat-run-state-003 follows one risk summary from local submission through acceptance and completion", async () => {
  const gate = context.mocks.deferred<void>();
  const run = installRunChat({ sendGate: gate.promise });
  const text = "Summarize the launch risks.";
  await setupPage({ context, path: RUN_PATH });
  await sendText(text);
  await screen.findByText("Thinking...");
  expect(screen.getAllByText(text)).toHaveLength(1);
  expect(screen.queryByRole("listitem", { name: "Queued message" })).toBeNull();
  expect(queryButton("Stop")).toBeNull();
  gate.resolve();
  await findEnabledButton("Stop");
  expect(screen.getByText("Thinking...")).toBeVisible();
  run.completeRun("Staffing is the main launch risk.");
  const riskSummary = await screen.findByText(
    "Staffing is the main launch risk.",
  );
  const riskTurn = riskSummary.closest<HTMLElement>('[data-role="assistant"]')!;
  await within(riskTurn).findByText("Worked for 2 sec");
  await findButton("Send");
  expect(queryButton("Stop")).toBeNull();
});

test("chat-run-state-004 tracks the same checklist through local send, queue, claim and result", async () => {
  const events: MockChatEventInput[] = [];
  const gate = context.mocks.deferred<void>();
  const submitted = context.mocks.deferred<string>();
  installRunChat({ chatEvents: events });
  context.mocks.api(chatEventsContract.send, async ({ body, respond }) => {
    if (!body.clientEventId || !body.prompt) {
      throw new Error("Expected a new prompt");
    }
    await gate.promise;
    const event = promptEvent({
      id: body.clientEventId,
      seqId: 1,
      text: body.prompt,
    });
    events.push(event);
    submitted.resolve(body.clientEventId);
    publishRunUpdate();
    return respond(201, {
      threadId: RUN_THREAD_ID,
      createdAt: event.createdAt,
    });
  });
  await setupPage({ context, path: RUN_PATH });
  const text = "Prepare the launch checklist";
  await sendText(text);
  await screen.findByText("Thinking...");
  expect(screen.getAllByText(text)).toHaveLength(1);
  gate.resolve();
  await findButton("queue...");
  expect(screen.getByText("Waiting in")).toBeVisible();
  const editor = screen.getByRole("textbox", { name: "Message" });
  await fill(editor, "Another question");
  await findEnabledButton("Send");
  await fill(editor, "");
  expect(queryButton("Stop")).toBeNull();
  expect(screen.queryByText("Thinking...")).toBeNull();
  events.push({
    ...promptEvent({
      id: "checklist-claimed",
      seqId: 2,
      runId,
      text,
      createdAt: "2026-08-01T10:00:01.000Z",
    }),
    revokesEventId: await submitted.promise,
  });
  publishRunUpdate();
  await findEnabledButton("Stop");
  expect(screen.getByText("Thinking...")).toBeVisible();
  expect(queryButton("queue...")).toBeNull();
  events.push({
    ...assistantEvent({
      id: "summary",
      runId,
      seqId: 3,
      text: "The release checklist is ready.",
    }),
    runEventId: "checklist-output",
  });
  publishRunUpdate();
  await screen.findByText("The release checklist is ready.");
  expect(queryButton("Stop")).toBeEnabled();
  events.push(
    completedEvent({
      id: "finished",
      runId,
      seqId: 4,
      createdAt: "2026-08-01T10:00:31.000Z",
    }),
  );
  publishRunUpdate();
  const checklistTurn = screen
    .getByText("The release checklist is ready.")
    .closest<HTMLElement>('[data-role="assistant"]')!;
  // A composer-wide transition alone can reflect a terminal event for another run.
  await within(checklistTurn).findByText("Worked for 30 sec");
  await findButton("Send");
  expect(queryButton("Stop")).toBeNull();
  expect(screen.queryByText("Thinking...")).toBeNull();
  expect(screen.getAllByText(text)).toHaveLength(1);
});

test("chat-run-state-005 leaves the persisted appendix request in the live rollout conversation", async () => {
  installRunChat({
    activeRunIds: [runId],
    chatEvents: [
      promptEvent({
        id: "rollout",
        seqId: 1,
        runId,
        text: "Draft the rollout",
      }),
      promptEvent({ id: "appendix", seqId: 2, text: "Add the appendix" }),
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  await screen.findByText("Thinking...");
  expect(screen.getByText("Draft the rollout")).toBeVisible();
  expect(
    screen.getByText("Add the appendix", { selector: '[data-role="user"] *' }),
  ).toBeVisible();
  expect(screen.queryByRole("listitem", { name: "Queued message" })).toBeNull();
});
