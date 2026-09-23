import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  chatThreadActivitySummaryContract,
  type ActivitySummaryResponse,
} from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  completedEvent,
  context,
  findButton,
  installRunChat,
  promptEvent,
  publishRunUpdate,
  readyChat,
  RUN_PATH,
  thinkingEvent,
} from "./chat-run-test-fixtures.ts";

const RUN_ID = "d0000000-0000-4000-a000-000000000841";
const NEXT_RUN_ID = "d0000000-0000-4000-a000-000000000842";
const PREPARATION = "Preparing the launch checklist";
const ACTIVITY = "Checking the release evidence";
const featureSwitches = Object.freeze({
  [FeatureSwitchKey.ThreadActivitySummary]: true,
});

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

test("Feature off retains initial thinking and makes no summary demand", async () => {
  const events = installActiveRun();
  events.push(
    thinkingEvent({
      id: "old-thinking",
      runId: RUN_ID,
      seqId: 2,
      text: "Preparing the original response",
    }),
  );
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.ThreadActivitySummary]: false },
  });

  await expect(
    screen.findByLabelText("Preparing the original response"),
  ).resolves.toBeVisible();
});

test("A chat event starts demand for the newly active run", async () => {
  const events: ReturnType<typeof promptEvent>[] = [];
  installRunChat({ chatEvents: events, activeRunIds: [RUN_ID] });
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    ({ respond }) => {
      return respond(200, summary());
    },
  );

  await setupPage({ context, path: RUN_PATH, featureSwitches });
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

  await setupPage({ context, path: RUN_PATH, featureSwitches });
  await firstRequestStarted.promise;
  await expect(screen.findByText("Thinking...")).resolves.toBeVisible();

  events.push(completedEvent({ id: "completed", runId: RUN_ID, seqId: 3 }));
  publishRunUpdate();
  oldRunResponse.resolve(undefined);

  await expect(findButton("Send")).resolves.toBeVisible();
  expect(screen.queryByLabelText(PREPARATION)).not.toBeInTheDocument();
  expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
});

test("A 403 response clears the displayed summary", async () => {
  installActiveRun();
  let forbidden = false;
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    ({ respond }) => {
      if (!forbidden) {
        return respond(200, summary());
      }
      return respond(403, {
        error: { message: "Unavailable", code: "FORBIDDEN" },
      });
    },
  );

  await setupPage({ context, path: RUN_PATH, featureSwitches });
  await expect(screen.findByText(PREPARATION)).resolves.toBeVisible();

  forbidden = true;
  await expect(screen.findByText("Thinking...")).resolves.toBeVisible();
  expect(screen.queryByText(PREPARATION)).not.toBeInTheDocument();
});

test("A replacement run cannot display the previous run's last result", async () => {
  const events = installActiveRun();
  const nextRunResponse = createDeferredPromise<void>(context.signal);
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    async ({ body, respond }) => {
      if (body.runId === RUN_ID) {
        return respond(200, summary());
      }
      await nextRunResponse.promise;
      return respond(
        200,
        summary({
          runId: NEXT_RUN_ID,
          messages: [{ id: ACTIVITY, text: ACTIVITY }],
        }),
      );
    },
  );

  await setupPage({ context, path: RUN_PATH, featureSwitches });
  await expect(screen.findByText(PREPARATION)).resolves.toBeVisible();

  events.push(
    promptEvent({
      id: "replacement",
      runId: NEXT_RUN_ID,
      seqId: 2,
      text: "Prepare another checklist",
    }),
  );
  publishRunUpdate();

  await expect(screen.findByText("Thinking...")).resolves.toBeVisible();
  expect(screen.queryByLabelText(PREPARATION)).not.toBeInTheDocument();

  nextRunResponse.resolve(undefined);
  await expect(screen.findByText(ACTIVITY)).resolves.toBeVisible();
});
