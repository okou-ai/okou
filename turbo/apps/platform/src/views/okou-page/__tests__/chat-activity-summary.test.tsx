import { chatThreadActivitySummaryContract } from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { fill } from "../../../__tests__/page-helper.ts";
import { changeChatIndicators } from "../../../mocks/mock-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
  findButton,
  promptEvent,
  publishRunUpdate,
  queryButton,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const RUN_ID = "a0000000-0000-4000-a000-000000000611";
const SUMMARY = "Preparing the launch checklist.";

function finishedExchange(): MockChatEventInput[] {
  const earlierRunId = "a0000000-0000-4000-a000-000000000610";
  return [
    promptEvent({
      id: "notes-request",
      runId: earlierRunId,
      seqId: 1,
      text: "Gather the launch notes",
    }),
    assistantEvent({
      id: "notes-answer",
      runId: earlierRunId,
      seqId: 2,
      text: "Launch notes gathered",
    }),
    completedEvent({ id: "notes-complete", runId: earlierRunId, seqId: 3 }),
  ];
}

function checklistPrompt(): MockChatEventInput {
  return promptEvent({
    id: "checklist-request",
    runId: RUN_ID,
    seqId: 4,
    text: "Prepare the launch checklist",
  });
}

function summaryFor(runId: string) {
  return {
    runId,
    messages: [{ id: "summary-1", text: SUMMARY }],
    status: "available" as const,
  };
}

test("A chat event starts demand for the newly active run", async () => {
  const chatEvents = finishedExchange();
  installRunChat({ chatEvents, activeRunIds: [RUN_ID] });
  const summaryRequest: { latest: { thread: string; run: string } | null } = {
    latest: null,
  };
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    ({ params, body, respond }) => {
      summaryRequest.latest = { thread: params.id, run: body.runId };
      return respond(200, summaryFor(body.runId));
    },
  );
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await expect(
    screen.findByText("Launch notes gathered"),
  ).resolves.toBeInTheDocument();

  chatEvents.push(checklistPrompt());
  publishRunUpdate();

  await expect(screen.findByText(SUMMARY)).resolves.toBeInTheDocument();
  expect(summaryRequest.latest).toStrictEqual({
    thread: RUN_THREAD_ID,
    run: RUN_ID,
  });
});

test("A completed run cannot revive the previous indicator", async () => {
  const chatEvents = [...finishedExchange(), checklistPrompt()];
  const activeRunIds = [RUN_ID];
  installRunChat({ chatEvents, activeRunIds });
  const requested = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const answered = context.mocks.deferred<void>();
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    async ({ body, respond }) => {
      requested.resolve();
      await release.promise;
      answered.resolve();
      return respond(200, summaryFor(body.runId));
    },
  );
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await requested.promise;
  await expect(screen.findByText("Thinking...")).resolves.toBeInTheDocument();

  chatEvents.push(
    assistantEvent({
      id: "checklist-answer",
      runId: RUN_ID,
      seqId: 5,
      text: "Launch checklist prepared",
    }),
    completedEvent({ id: "checklist-complete", runId: RUN_ID, seqId: 6 }),
  );
  activeRunIds.splice(0);
  publishRunUpdate();
  changeChatIndicators();
  await expect(findButton("Send")).resolves.toBeVisible();
  release.resolve();
  await answered.promise;

  // The next draft is typed after the late summary has been answered.
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fill(composer, "Share the checklist");
  await waitFor(() => {
    expect(queryButton("Send")).toBeEnabled();
  });
  expect(screen.getByText("Launch checklist prepared")).toBeInTheDocument();
  expect(screen.queryByText(SUMMARY)).not.toBeInTheDocument();
  expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
  expect(queryButton("Send")).toBeVisible();
});
