import { act, screen } from "@testing-library/react";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import { runAgentEventsContract } from "@okouai/api-contracts/contracts/run-routes";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import {
  click,
  fill,
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

function refreshButton(): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === "Refresh";
  });
  if (!button) {
    throw new Error("Expected the activity refresh button");
  }
  return button;
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
    screen.queryByText("Logs do not update automatically."),
  ).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").some((button) => {
      return button.textContent?.trim() === "Refresh";
    }),
  ).toBeFalsy();
  expect(
    queryAllByRoleFast("tab").some((tab) => {
      return tab.textContent?.trim() === "Steps";
    }),
  ).toBeTruthy();
});

test("An active activity explains how to load the latest logs", async () => {
  const status = "running" as const;
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
    screen.getByText("Logs do not update automatically."),
  ).toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").find((button) => {
      return button.textContent?.trim() === "Refresh";
    }),
  ).toBeInTheDocument();
});

test("Refreshing an activity loads every log page and preserves the search", async () => {
  const secondPageStarted = context.mocks.deferred<void>();
  const releaseSecondPage = context.mocks.deferred<void>();
  let refreshed = false;
  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(
      200,
      makeLogDetail({
        status: refreshed ? "completed" : "running",
      }),
    );
  });
  context.mocks.api(
    runAgentEventsContract.getAgentEvents,
    async ({ query, respond }) => {
      if (refreshed && query.cursor === "second-page") {
        secondPageStarted.resolve();
        await releaseSecondPage.promise;
        return respond(200, {
          events: [makeAssistantEvent(1, "Latest activity log")],
          hasMore: false,
          status: "completed",
          lastEventSequence: 1,
        });
      }
      return respond(200, {
        events: [makeAssistantEvent(0, "Current activity log")],
        hasMore: refreshed,
        ...(refreshed ? { nextCursor: "second-page" } : {}),
        status: refreshed ? "completed" : "running",
        lastEventSequence: refreshed ? 1 : null,
      });
    },
  );

  await setupPage({ context, path: `/activities/${RUN_ID}` });
  await expect(
    screen.findByText("Current activity log"),
  ).resolves.toBeInTheDocument();
  const search = screen.getByPlaceholderText("Search steps");
  await fill(search, "activity");
  const button = refreshButton();

  refreshed = true;
  click(button);
  await secondPageStarted.promise;
  releaseSecondPage.resolve();
  await expect(
    screen.findByText("Latest activity log"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Current activity log")).toBeInTheDocument();
  expect(screen.getByText("Done")).toBeInTheDocument();
  expect(screen.getByPlaceholderText("Search steps")).toHaveValue("activity");
  expect(
    screen.queryByText("Logs do not update automatically."),
  ).not.toBeInTheDocument();
});

test("Leaving an activity cancels a pending refresh before it can affect the next activity", async () => {
  const nextRunId = "a0000000-0000-4000-a000-000000000100";
  const refreshStarted = context.mocks.deferred<void>();
  const releaseRefresh = context.mocks.deferred<void>();
  let refreshed = false;
  context.mocks.api(logsByIdContract.getById, ({ params, respond }) => {
    return respond(
      200,
      makeLogDetail({
        id: params.id,
        displayName: params.id === nextRunId ? "Next agent" : "Test Agent",
      }),
    );
  });
  context.mocks.api(
    runAgentEventsContract.getAgentEvents,
    async ({ params, respond }) => {
      if (params.id === RUN_ID && refreshed) {
        refreshStarted.resolve();
        await releaseRefresh.promise;
      }
      const text =
        params.id === nextRunId
          ? "Next activity log"
          : refreshed
            ? "Outdated activity log"
            : "Current activity log";
      return respond(200, {
        events: [makeAssistantEvent(0, text)],
        hasMore: false,
        status: "running",
        lastEventSequence: null,
      });
    },
  );

  await setupPage({ context, path: `/activities/${RUN_ID}` });
  await expect(
    screen.findByText("Current activity log"),
  ).resolves.toBeInTheDocument();
  refreshed = true;
  click(refreshButton());
  await refreshStarted.promise;
  act(() => {
    window.history.pushState(null, "", `/activities/${nextRunId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(
    screen.findByText("Next activity log"),
  ).resolves.toBeInTheDocument();

  await act(async () => {
    releaseRefresh.resolve();
    await releaseRefresh.promise;
  });
  expect(
    screen.getByRole("heading", { name: "Next agent" }),
  ).toBeInTheDocument();
  expect(screen.getByText("Next activity log")).toBeInTheDocument();
  expect(screen.queryByText("Outdated activity log")).not.toBeInTheDocument();
  expect(refreshButton()).not.toHaveAttribute("aria-busy");
});
