import { act, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  chatThreadActivitySummaryContract,
  type ActivitySummaryResponse,
} from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  cancelledEvent,
  completedEvent,
  context,
  findButton,
  findLink,
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
const LEGACY_FALLBACK =
  /^(Brewing up a response|Piecing things together|Spinning up|On it|Assembling the pieces|Sketching the details|Mapping it out|Wiring it together|Shaping the response|Tuning in)\.\.\.$/;
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

test.each(["available", "unavailable", 500] as const)(
  "A %s response without a batch uses the fallback and recovers on a later loop tick",
  async (outcome) => {
    installActiveRun();
    let recovered = false;
    context.mocks.api(
      chatThreadActivitySummaryContract.summarize,
      ({ respond }) => {
        if (recovered) {
          return respond(200, summary());
        }
        // A storage failure answers 500, which this viewer handles exactly as it
        // handles `unavailable`: the request rejects and the last batch stands.
        return outcome === 500
          ? respond(500, {
              error: {
                message: "Summary unavailable",
                code: "INTERNAL_SERVER_ERROR",
              },
            })
          : respond(200, summary({ status: outcome, messages: [] }));
      },
    );

    await setupPage({ context, path: RUN_PATH, featureSwitches });
    await expect(screen.findByText("Thinking...")).resolves.toBeVisible();

    recovered = true;
    await expect(screen.findByText(PREPARATION)).resolves.toBeVisible();
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
  },
);

async function openPendingActivitySummary() {
  installActiveRun();
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    ({ respond }) => {
      return respond(200, summary({ messages: [] }));
    },
  );

  await setupPage({ context, path: RUN_PATH, featureSwitches });
  await expect(screen.findByText("Thinking...")).resolves.toBeVisible();
}

test("The pending summary fallback stays stable when reopening the thread", async () => {
  await openPendingActivitySummary();
  click(await findLink("Agents"));
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
  click(await findLink("Run conversation"));
  await expect(screen.findByText("Thinking...")).resolves.toBeVisible();
});

test("The pending summary fallback follows a saved language change", async () => {
  await openPendingActivitySummary();
  click(await findButton("Test User"));
  const menu = await screen.findByRole("menu");
  const settings = queryAllByRoleFast("menuitem", menu).find((item) => {
    return item.textContent?.trim() === "Settings";
  });
  expect(settings).toBeDefined();
  click(settings!);
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  click(within(dialog).getByRole("combobox", { name: "Language" }));
  click(await screen.findByRole("option", { name: "日本語" }));

  await expect(screen.findByText("考え中...")).resolves.toBeVisible();
  expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
});

test("Authoritative switch hydration waits for a chat event before starting demand", async () => {
  const events = installActiveRun();
  const featureResponse = createDeferredPromise<void>(context.signal);
  const featureResponseReturned = createDeferredPromise<void>(context.signal);
  context.mocks.api(featureSwitchesContract.get, async ({ respond }) => {
    await featureResponse.promise;
    const response = respond(200, {
      switches: featureSwitches,
      effectiveSwitches: featureSwitches,
    });
    featureResponseReturned.resolve(undefined);
    return response;
  });
  let eventPublished = false;
  let requestedBeforeEvent = false;
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    ({ respond }) => {
      if (!eventPublished) {
        requestedBeforeEvent = true;
      }
      return respond(200, summary());
    },
  );

  await setupPage({ context, path: RUN_PATH });
  await expect(screen.findByText(LEGACY_FALLBACK)).resolves.toBeVisible();

  await act(async () => {
    featureResponse.resolve(undefined);
    await featureResponseReturned.promise;
  });
  await expect(screen.findByText("Thinking...")).resolves.toBeVisible();
  expect(requestedBeforeEvent).toBeFalsy();
  expect(screen.queryByText(PREPARATION)).not.toBeInTheDocument();

  eventPublished = true;
  events.push(
    thinkingEvent({
      id: "hydrated-thinking",
      runId: RUN_ID,
      seqId: 2,
      text: "Preparing the original response",
    }),
  );
  publishRunUpdate();

  await expect(screen.findByText(PREPARATION)).resolves.toBeVisible();
  expect(screen.queryByText(LEGACY_FALLBACK)).not.toBeInTheDocument();
});

test("The loop keeps polling on its fixed interval while hidden", async () => {
  context.mocks.browser.visibilityState("hidden");
  installActiveRun();
  let refreshed = false;
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    ({ respond }) => {
      if (!refreshed) {
        return respond(200, summary());
      }
      return respond(
        200,
        summary({ messages: [{ id: ACTIVITY, text: ACTIVITY }] }),
      );
    },
  );

  await setupPage({ context, path: RUN_PATH, featureSwitches });
  await expect(screen.findByText(PREPARATION)).resolves.toBeVisible();

  refreshed = true;
  await expect(screen.findByText(ACTIVITY)).resolves.toBeVisible();
});

test("The last resolved summary remains visible while a refresh is loading", async () => {
  installActiveRun();
  const refreshStarted = createDeferredPromise<void>(context.signal);
  const refreshResponse = createDeferredPromise<void>(context.signal);
  let refreshing = false;
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    async ({ respond }) => {
      if (!refreshing) {
        return respond(200, summary());
      }
      if (!refreshStarted.settled()) {
        refreshStarted.resolve(undefined);
      }
      await refreshResponse.promise;
      return respond(
        200,
        summary({ messages: [{ id: ACTIVITY, text: ACTIVITY }] }),
      );
    },
  );

  await setupPage({ context, path: RUN_PATH, featureSwitches });
  await expect(screen.findByText(PREPARATION)).resolves.toBeVisible();
  refreshing = true;
  await act(async () => {
    await refreshStarted.promise;
  });
  expect(screen.getByText(PREPARATION)).toBeVisible();

  refreshResponse.resolve(undefined);
  await expect(screen.findByText(ACTIVITY)).resolves.toBeVisible();
});

test.each(["completed", "cancelled", "replaced", "queued"] as const)(
  "A %s run cannot revive the previous indicator",
  async (outcome) => {
    const events = installActiveRun();
    const firstRequestStarted = createDeferredPromise<void>(context.signal);
    const oldRunResponse = createDeferredPromise<void>(context.signal);
    context.mocks.api(
      chatThreadActivitySummaryContract.summarize,
      async ({ body, respond }) => {
        if (body.runId === RUN_ID) {
          if (!firstRequestStarted.settled()) {
            firstRequestStarted.resolve(undefined);
          }
          await oldRunResponse.promise;
        }
        return respond(
          200,
          summary({
            runId: body.runId,
            messages: [
              {
                id: "current",
                text: body.runId === RUN_ID ? PREPARATION : ACTIVITY,
              },
            ],
          }),
        );
      },
    );

    await setupPage({ context, path: RUN_PATH, featureSwitches });
    await firstRequestStarted.promise;
    await expect(screen.findByText("Thinking...")).resolves.toBeVisible();

    if (outcome === "replaced") {
      events.push(
        promptEvent({
          id: "replacement",
          runId: NEXT_RUN_ID,
          seqId: 3,
          text: "Prepare another checklist",
        }),
      );
    } else if (outcome === "queued") {
      events.push({
        id: "queued-run",
        role: "assistant",
        content: null,
        eventType: "run.queued",
        runEventId: "queue:queued",
        runId: RUN_ID,
        seqId: 3,
        createdAt: "2026-08-01T10:00:03.000Z",
      });
    } else {
      events.push(
        outcome === "completed"
          ? completedEvent({ id: "completed", runId: RUN_ID, seqId: 3 })
          : cancelledEvent({ id: "cancelled", runId: RUN_ID, seqId: 3 }),
      );
    }
    publishRunUpdate();
    oldRunResponse.resolve(undefined);

    const outcomeIndicator =
      outcome === "replaced"
        ? screen.findByText(ACTIVITY)
        : outcome === "queued"
          ? findButton("queue...")
          : outcome === "completed"
            ? findButton("Send")
            : screen.findByText(
                "Paused mid-thought — pick it back up whenever.",
              );
    await expect(outcomeIndicator).resolves.toBeVisible();
    expect(screen.queryByLabelText(PREPARATION)).not.toBeInTheDocument();
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
  },
);

test.each([403, 404, "ineligible"] as const)(
  "A %s response clears copy without blocking a later loop retry",
  async (status) => {
    installActiveRun();
    let phase: "fresh" | "failed" | "recovered" = "fresh";
    context.mocks.api(
      chatThreadActivitySummaryContract.summarize,
      ({ respond }) => {
        if (phase === "fresh") {
          return respond(200, summary());
        }
        if (phase === "recovered") {
          return respond(
            200,
            summary({ messages: [{ id: ACTIVITY, text: ACTIVITY }] }),
          );
        }
        return status === "ineligible"
          ? respond(200, summary({ status, messages: [] }))
          : respond(status, {
              error: { message: "Unavailable", code: "FORBIDDEN" },
            });
      },
    );

    await setupPage({ context, path: RUN_PATH, featureSwitches });
    await expect(screen.findByText(PREPARATION)).resolves.toBeVisible();

    phase = "failed";
    await expect(screen.findByText("Thinking...")).resolves.toBeVisible();
    expect(screen.queryByText(PREPARATION)).not.toBeInTheDocument();

    phase = "recovered";
    await expect(screen.findByText(ACTIVITY)).resolves.toBeVisible();
  },
);

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

test("Navigating away prevents an outstanding summary from reviving the indicator", async () => {
  installActiveRun();
  const requestStarted = createDeferredPromise<void>(context.signal);
  const response = createDeferredPromise<void>(context.signal);
  const responseReturned = createDeferredPromise<void>(context.signal);
  context.mocks.api(
    chatThreadActivitySummaryContract.summarize,
    async ({ respond }) => {
      if (!requestStarted.settled()) {
        requestStarted.resolve(undefined);
      }
      await response.promise;
      if (!responseReturned.settled()) {
        responseReturned.resolve(undefined);
      }
      return respond(200, summary());
    },
  );

  await setupPage({ context, path: RUN_PATH, featureSwitches });
  await requestStarted.promise;
  await expect(screen.findByText("Thinking...")).resolves.toBeVisible();

  click(await findLink("Agents"));
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
  response.resolve(undefined);
  await act(async () => {
    await responseReturned.promise;
  });

  expect(screen.getByRole("heading", { name: "Agents" })).toBeVisible();
  expect(screen.queryByLabelText(PREPARATION)).not.toBeInTheDocument();
});
