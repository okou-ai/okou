import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  chatThreadActivitySummaryContract,
  type ActivitySummaryResponse,
} from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  completedEvent,
  findButton,
  promptEvent,
  publishRunUpdate,
  readyChat,
  RUN_PATH,
  createChatRunFixtures,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const RUN_ID = "d0000000-0000-4000-a000-000000000841";
const NEXT_RUN_ID = "d0000000-0000-4000-a000-000000000842";
const PREPARATION = "Preparing the launch checklist";

function summary(
  overrides: Partial<ActivitySummaryResponse> = {},
): ActivitySummaryResponse {
  return {
    runId: RUN_ID,
    messages: [{ id: PREPARATION, text: PREPARATION }],
    status: "available",
    ...overrides,
  };
}

function installActiveRun() {
  mockNow(new Date("2026-09-09T08:00:00.000Z"), context.signal);
  const events = [
    promptEvent({
      id: "activity-prompt",
      runId: RUN_ID,
      seqId: 1,
      text: "Prepare a launch checklist",
    }),
  ];
  installRunChat({ chatEvents: events, activeRunIds: [RUN_ID, NEXT_RUN_ID] });
  return events;
}

test("A chat event starts demand for the newly active run", async () => {
  const events: ReturnType<typeof promptEvent>[] = [];
  installRunChat({ chatEvents: events, activeRunIds: [RUN_ID] });
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    ({ respond }) => {
      return respond(200, summary());
    },
  );

  await setupPage({ context, path: RUN_PATH });
  await readyChat();

  events.push(
    promptEvent({
      id: "event-driven-prompt",
      runId: RUN_ID,
      seqId: 1,
      text: "Start the release review",
    }),
  );
  publishRunUpdate();

  await expect(screen.findByText(PREPARATION)).resolves.toBeVisible();
});

test("A completed run cannot revive the previous indicator", async () => {
  const events = installActiveRun();
  const firstRequestStarted = createDeferredPromise<void>(context.signal);
  const oldRunResponse = createDeferredPromise<void>(context.signal);
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    async ({ body, respond }) => {
      if (!firstRequestStarted.settled()) {
        firstRequestStarted.resolve(undefined);
      }
      await oldRunResponse.promise;
      return respond(200, summary({ runId: body.runId }));
    },
  );

  await setupPage({ context, path: RUN_PATH });
  await firstRequestStarted.promise;

  events.push(completedEvent({ id: "completed", runId: RUN_ID, seqId: 3 }));
  publishRunUpdate();
  oldRunResponse.resolve(undefined);

  await expect(findButton("Send")).resolves.toBeVisible();
  expect(screen.queryByLabelText(PREPARATION)).not.toBeInTheDocument();
  expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
});
