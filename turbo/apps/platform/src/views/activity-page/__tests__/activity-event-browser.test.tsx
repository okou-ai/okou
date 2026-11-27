import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import {
  runNetworkLogsContract,
  runTelemetryEventsContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const RUN_ID = "d0000000-0000-4000-a000-000000000f62";
const API_URL = "https://api.release.test/v1/builds";
const DNS_TARGET = "api.release.test:53";
const TCP_TARGET = "db.release.test:5432";

function typeFilter(): HTMLElement {
  const trigger = queryAllByRoleFast("button").find((button) => {
    return button.getAttribute("aria-label") === "Type filter";
  });
  if (!trigger) {
    throw new Error("Expected the network type filter");
  }
  return trigger;
}

function typeOption(name: string): HTMLElement | undefined {
  return queryAllByRoleFast("menuitemcheckbox").find((item) => {
    return item.textContent?.trim() === name;
  });
}

test("Enter and Space each toggle a network type once, and Escape restores trigger focus", async () => {
  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(200, {
      id: RUN_ID,
      sessionId: null,
      framework: "claude-code",
      modelProvider: null,
      selectedModel: null,
      triggerSource: "web",
      status: "completed",
      prompt: "Check the build",
      appendSystemPrompt: null,
      createdAt: "2026-11-20T08:00:00.000Z",
      startedAt: "2026-11-20T08:00:01.000Z",
      completedAt: "2026-11-20T08:00:20.000Z",
    });
  });
  context.mocks.api(runNetworkLogsContract.getNetworkLogs, ({ respond }) => {
    return respond(200, {
      networkLogs: [
        {
          timestamp: "2026-11-20T08:00:02.000Z",
          type: "dns",
          host: "api.release.test",
          port: 53,
          dns_query_type: "A",
        },
        {
          timestamp: "2026-11-20T08:00:03.000Z",
          type: "tcp",
          host: "db.release.test",
          port: 5432,
        },
        {
          timestamp: "2026-11-20T08:00:04.000Z",
          type: "http",
          method: "GET",
          url: API_URL,
          host: "api.release.test",
          status: 200,
        },
      ],
      hasMore: false,
    });
  });
  await setupPage({
    context,
    path: `/activities/${RUN_ID}?tab=network`,
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });
  await expect(screen.findByText(API_URL)).resolves.toBeInTheDocument();
  expect(typeFilter()).toHaveTextContent("HTTP");
  const user = userEvent.setup({ delay: null });
  typeFilter().focus();

  await user.keyboard("{Enter}");
  // Opening from the keyboard moves focus to the first entry, All types.
  await waitFor(() => {
    expect(
      queryAllByRoleFast("menuitemcheckbox").find((item) => {
        return item.textContent?.trim() === "All types";
      }),
    ).toHaveFocus();
  });
  await user.keyboard("{ArrowDown}");
  await user.keyboard("{ArrowDown}");
  const dns = typeOption("DNS") as HTMLElement;
  await waitFor(() => {
    expect(dns).toHaveFocus();
  });
  expect(dns).toHaveAttribute("aria-checked", "false");

  await user.keyboard("{Enter}");

  await waitFor(() => {
    expect(typeFilter()).toHaveTextContent("2 types");
  });
  expect(dns).toHaveAttribute("aria-checked", "true");
  expect(dns).toHaveFocus();
  expect(screen.getByText(DNS_TARGET)).toBeInTheDocument();
  expect(screen.queryByText(TCP_TARGET)).not.toBeInTheDocument();

  await user.keyboard(" ");

  await waitFor(() => {
    expect(typeFilter()).toHaveTextContent("HTTP");
  });
  expect(dns).toHaveAttribute("aria-checked", "false");
  expect(dns).toHaveFocus();
  expect(screen.queryByText(DNS_TARGET)).not.toBeInTheDocument();

  await user.keyboard("{Escape}");

  await waitFor(() => {
    expect(typeFilter()).toHaveFocus();
  });
  expect(typeOption("DNS")).toBeUndefined();
  expect(screen.getByText(API_URL)).toBeInTheDocument();
});

const PAGED_RUN_ID = "d0000000-0000-4000-a000-000000000f63";

function textEvent(sequenceNumber: number, text: string) {
  return {
    sequenceNumber,
    eventType: "assistant",
    eventData: {
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    },
    createdAt: `2026-11-20T09:00:0${sequenceNumber}.000Z`,
  };
}

test("Completed activity history waits for the final events page before showing either page", async () => {
  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(200, {
      id: PAGED_RUN_ID,
      sessionId: null,
      framework: "claude-code",
      modelProvider: null,
      selectedModel: null,
      triggerSource: "web",
      status: "completed",
      prompt: "Summarize both pages",
      appendSystemPrompt: null,
      createdAt: "2026-11-20T09:00:00.000Z",
      startedAt: "2026-11-20T09:00:01.000Z",
      completedAt: "2026-11-20T09:00:09.000Z",
    });
  });
  const secondPageRequested = context.mocks.deferred<void>();
  const releaseSecondPage = context.mocks.deferred<void>();
  context.mocks.api(
    runTelemetryEventsContract.getTelemetryEvents,
    async ({ query, respond }) => {
      if (query.cursor === undefined) {
        return respond(200, {
          events: [textEvent(1, "Page one content")],
          hasMore: true,
          nextCursor: "1",
          status: "completed",
          lastEventSequence: 2,
        });
      }
      secondPageRequested.resolve();
      await releaseSecondPage.promise;
      return respond(200, {
        events: [textEvent(2, "Page two content")],
        hasMore: false,
        nextCursor: null,
        status: "completed",
        lastEventSequence: 2,
      });
    },
  );

  await setupPage({
    context,
    path: `/activities/${PAGED_RUN_ID}`,
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });

  await expect(
    screen.findByRole("heading", { name: "Okou" }),
  ).resolves.toBeInTheDocument();
  await secondPageRequested.promise;
  expect(screen.queryByText("Page one content")).not.toBeInTheDocument();

  releaseSecondPage.resolve();

  await expect(
    screen.findByText("Page two content"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Page one content")).toBeInTheDocument();
  expect(
    queryAllByRoleFast("tab").map((tab) => {
      return tab.textContent?.trim();
    }),
  ).toContain("Steps");
});
