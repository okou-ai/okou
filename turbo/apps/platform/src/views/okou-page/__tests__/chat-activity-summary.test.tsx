import { chatThreadActivitySummaryContract } from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { holdResponseField } from "./browser-response-fixture.ts";
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

test.each([
  ["A completed run cannot revive the previous indicator", true, true],
  [
    "A completed run stays ready while its last summary is withheld",
    true,
    false,
  ],
  ["An active run displays the same delivered summary", false, true],
] as const)("%s", async (_title, completed, deliver) => {
  const active = [RUN_ID];
  const events = [...finishedExchange(), checklistPrompt()];
  installRunChat({ activeRunIds: active, chatEvents: events });
  const boundary = holdResponseField(
    context,
    (url, value) => {
      return url.pathname.endsWith("/activity-summary") && value === RUN_ID;
    },
    "runId",
  );
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    ({ body, respond }) => {
      return respond(200, summaryFor(body.runId));
    },
  );
  await setupPage({ context, path: RUN_PATH });
  await boundary.received.promise;
  await screen.findByText("Thinking...");
  if (completed) {
    events.push(
      assistantEvent({
        id: "field-answer",
        runId: RUN_ID,
        seqId: 5,
        text: "The overnight forecast is ready",
      }),
      completedEvent({ id: "field-done", runId: RUN_ID, seqId: 6 }),
    );
    active.splice(0);
    publishRunUpdate();
    changeChatIndicators();
    await screen.findByText("The overnight forecast is ready");
  }
  if (deliver) {
    await act(async () => {
      boundary.release.resolve();
      await boundary.consumed.promise;
    });
  }
  if (completed) {
    const composer = await screen.findByRole("textbox", { name: "Message" });
    await fill(composer, "Send today’s field report");
    await waitFor(() => {
      expect(queryButton("Send")).toBeEnabled();
    });
    await expect(findButton("Send")).resolves.toBeVisible();
    expect(screen.queryByText("Thinking...")).toBeNull();
    expect(screen.queryByText(SUMMARY)).toBeNull();
  } else {
    await expect(screen.findByText(SUMMARY)).resolves.toBeVisible();
  }
});
