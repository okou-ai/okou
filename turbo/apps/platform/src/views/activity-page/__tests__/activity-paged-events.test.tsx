import { screen } from "@testing-library/react";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import { runAgentEventsContract } from "@okouai/api-contracts/contracts/run-routes";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type {
  AgentEventsResponse,
  LogDetail,
} from "../../../signals/okou-page/log-types.ts";

const context = testContext();

const RUN_ID = "a0000000-0000-4000-a000-000000000099";

function makeLogDetail(overrides: Partial<LogDetail>): LogDetail {
  return {
    id: RUN_ID,
    sessionId: "session_test",
    agentId: "e0000000-0000-4000-a000-000000000010",
    displayName: "Test Agent",
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web",
    status: "running",
    prompt: "Hello",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2026-03-10T14:56:00Z",
    startedAt: "2026-03-10T14:56:01Z",
    completedAt: null,
    artifact: { name: null, version: null },
    ...overrides,
  };
}

function makeAssistantEvent(
  sequenceNumber: number,
  text: string,
): AgentEventsResponse["events"][number] {
  return {
    sequenceNumber,
    eventType: "assistant",
    eventData: {
      message: { content: [{ type: "text", text }] },
    },
    createdAt: "2026-03-10T14:56:02Z",
  };
}

test("A completed activity appears only after its full event history is ready", async () => {
  const secondPageStarted = context.mocks.deferred<void>();
  const releaseSecondPage = context.mocks.deferred<void>();

  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(200, makeLogDetail({ status: "completed" }));
  });
  context.mocks.api(
    runAgentEventsContract.getAgentEvents,
    async ({ query, respond }) => {
      if (query.cursor === undefined) {
        return respond(200, {
          events: [makeAssistantEvent(0, "Page one content")],
          hasMore: true,
          nextCursor: "second-page",
          status: "completed",
          lastEventSequence: 1,
        } satisfies AgentEventsResponse);
      }

      secondPageStarted.resolve();
      await releaseSecondPage.promise;
      return respond(200, {
        events: [makeAssistantEvent(1, "Page two content")],
        hasMore: false,
        status: "completed",
        lastEventSequence: 1,
      } satisfies AgentEventsResponse);
    },
  );

  const page = await startPage({
    context,
    path: "/activities/a0000000-0000-4000-a000-000000000099",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });

  await secondPageStarted.promise;
  await expect(
    screen.findByRole("heading", { name: "Test Agent" }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Page one content")).not.toBeInTheDocument();

  releaseSecondPage.resolve();
  await page.ready;

  await expect(
    screen.findByText("Page two content"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Page one content")).toBeInTheDocument();
  expect(
    queryAllByRoleFast("tab").some((tab) => {
      return tab.textContent?.trim() === "Steps";
    }),
  ).toBeTruthy();
});

test("A live activity waits for indexed events through completion", async () => {
  const initialEmptyResult = context.mocks.deferred<void>();
  const releaseRunningEvent = context.mocks.deferred<void>();
  const completionReported = context.mocks.deferred<void>();
  const finalEventRequested = context.mocks.deferred<void>();
  const releaseFinalEvent = context.mocks.deferred<void>();
  let requestCount = 0;

  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(200, makeLogDetail({ status: "running" }));
  });
  context.mocks.api(
    runAgentEventsContract.getAgentEvents,
    async ({ respond }) => {
      requestCount += 1;
      if (requestCount === 1) {
        initialEmptyResult.resolve();
        return respond(200, {
          events: [],
          hasMore: false,
          status: "running",
          lastEventSequence: null,
        } satisfies AgentEventsResponse);
      }
      if (requestCount === 2) {
        await releaseRunningEvent.promise;
        return respond(200, {
          events: [makeAssistantEvent(0, "Running event")],
          hasMore: false,
          status: "running",
          lastEventSequence: null,
        } satisfies AgentEventsResponse);
      }
      if (requestCount === 3) {
        completionReported.resolve();
        return respond(200, {
          events: [],
          hasMore: false,
          status: "completed",
          lastEventSequence: 1,
        } satisfies AgentEventsResponse);
      }

      finalEventRequested.resolve();
      await releaseFinalEvent.promise;
      return respond(200, {
        events: [makeAssistantEvent(1, "Final indexed event")],
        hasMore: false,
        status: "completed",
        lastEventSequence: 1,
      } satisfies AgentEventsResponse);
    },
  );

  await setupPage({
    context,
    path: "/activities/a0000000-0000-4000-a000-000000000099",
  });

  await initialEmptyResult.promise;
  await expect(
    screen.findByRole("heading", { name: "Test Agent" }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Running event")).not.toBeInTheDocument();

  releaseRunningEvent.resolve();

  await expect(screen.findByText("Running event")).resolves.toBeInTheDocument();
  await completionReported.promise;
  await finalEventRequested.promise;
  expect(screen.queryByText("Final indexed event")).not.toBeInTheDocument();

  releaseFinalEvent.resolve();

  await expect(
    screen.findByText("Final indexed event"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Running event")).toBeInTheDocument();
});

test("A completed activity remains usable when a reported event gap never closes", async () => {
  const boundedRetriesFinished = context.mocks.deferred<void>();
  let requestCount = 0;

  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(200, makeLogDetail({ status: "completed" }));
  });
  context.mocks.api(
    runAgentEventsContract.getAgentEvents,
    ({ query, respond }) => {
      requestCount += 1;
      if (requestCount === 31) {
        boundedRetriesFinished.resolve();
      }
      return respond(200, {
        events:
          query.since === undefined
            ? [makeAssistantEvent(0, "Only indexed event")]
            : [],
        hasMore: false,
        status: "completed",
        lastEventSequence: 2,
      } satisfies AgentEventsResponse);
    },
  );

  await setupPage({
    context,
    path: "/activities/a0000000-0000-4000-a000-000000000099",
  });

  await expect(
    screen.findByText("Only indexed event"),
  ).resolves.toBeInTheDocument();
  await boundedRetriesFinished.promise;

  expect(screen.getByText("Only indexed event")).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Test Agent" }),
  ).toBeInTheDocument();
});

test("Activity metadata remains usable when its timeline cannot load", async () => {
  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(200, makeLogDetail({ status: "completed" }));
  });
  context.mocks.api(runAgentEventsContract.getAgentEvents, ({ respond }) => {
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Event storage unavailable",
      },
    });
  });

  await expect(
    setupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000099",
      featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
    }),
  ).rejects.toThrow("Event storage unavailable");

  await expect(
    screen.findByRole("heading", { name: "Test Agent" }),
  ).resolves.toBeInTheDocument();
  expect(
    queryAllByRoleFast("tab").map((tab) => {
      return tab.textContent?.trim();
    }),
  ).toStrictEqual(["Steps", "Context", "Runner", "Network"]);
});
