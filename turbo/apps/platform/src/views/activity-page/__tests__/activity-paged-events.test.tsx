import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import { runAgentEventsContract } from "@okouai/api-contracts/contracts/run-routes";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const RUN_ID = "d0000000-0000-4000-a000-000000000f63";

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

test("A completed activity appears only after its full event history is ready", async () => {
  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
    return respond(200, {
      id: RUN_ID,
      sessionId: null,
      agentId: "c0000000-0000-4000-a000-000000000063",
      displayName: "Test Agent",
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
    runAgentEventsContract.getAgentEvents,
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
    path: `/activities/${RUN_ID}`,
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });

  await expect(
    screen.findByRole("heading", { name: "Test Agent" }),
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
