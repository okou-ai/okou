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
    screen.queryByText("Reload this page to see the latest activity logs."),
  ).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("tab").some((tab) => {
      return tab.textContent?.trim() === "Steps";
    }),
  ).toBeTruthy();
});

test.each(["queued", "pending", "running"] as const)(
  "A %s activity explains how to load the latest logs",
  async (status) => {
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(200, makeLogDetail({ status }));
    });
    context.mocks.api(runAgentEventsContract.getAgentEvents, ({ respond }) => {
      return respond(200, {
        events: [makeAssistantEvent(0, "Current activity log")],
        hasMore: false,
        status,
        lastEventSequence: null,
      } satisfies AgentEventsResponse);
    });

    await setupPage({
      context,
      path: "/activities/a0000000-0000-4000-a000-000000000099",
    });

    await expect(
      screen.findByText("Current activity log"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText("Reload this page to see the latest activity logs."),
    ).toBeInTheDocument();
  },
);

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
