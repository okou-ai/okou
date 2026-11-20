import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
  getWorkHistoryToggle,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const context = testContext();

test("chat-capability-run-history-001 expands evidence for one completed workflow while the current run keeps thinking", async () => {
  const history: MockChatEventInput[] = [];
  const workflows = [
    {
      runId: "33ab3b66-64a5-49d9-b22e-e43d0dec7901",
      name: "Policy digest",
      evidence: "Read the review guidelines.",
      result: "The policy digest is ready.",
    },
    {
      runId: "1009fa1f-6363-498a-926a-00ff3ea52b01",
      name: "Launch digest",
      evidence: "Read the launch calendar.",
      result: "The launch digest is ready.",
    },
  ] as const;
  const active = "464186e9-104b-49c4-ad59-fdc6ba81909c";
  function workflowInput(
    runId: string,
    name: string,
    seqId: number,
  ): MockChatEventInput {
    return {
      id: runId,
      eventType: "input.automation",
      runId,
      seqId,
      createdAt: "2026-08-01T10:00:00Z",
      content: null,
      userMessage: {
        version: 1,
        parts: [
          { type: "automation", workflowName: name, automationBrief: name },
        ],
      },
    };
  }
  for (const [
    index,
    { runId, name, evidence, result },
  ] of workflows.entries()) {
    const first = 1 + index * 4;
    history.push(
      workflowInput(runId, name, first),
      assistantEvent({
        id: runId + "-evidence",
        seqId: first + 1,
        runId,
        text: evidence,
      }),
      assistantEvent({
        id: runId + "-result",
        seqId: first + 2,
        runId,
        text: result,
      }),
      completedEvent({ id: runId + "-done", seqId: first + 3, runId }),
    );
  }
  history.push(workflowInput(active, "Current digest", 9));
  createChatRunFixtures(context).installRunChat({
    chatEvents: history,
    activeRunIds: [active],
  });
  await setupPage({ context, path: RUN_PATH });
  await screen.findByText("Thinking...");
  const [policy, launch] = workflows;
  const policyTurn = screen
    .getByText(policy.result)
    .closest<HTMLElement>('[data-role="assistant"]')!;
  const launchTurn = screen
    .getByText(launch.result)
    .closest<HTMLElement>('[data-role="assistant"]')!;
  expect(screen.queryByText(policy.evidence)).toBeNull();
  expect(screen.queryByText(launch.evidence)).toBeNull();
  expect(getWorkHistoryToggle("collapsed", launchTurn)).toBeVisible();
  click(getWorkHistoryToggle("collapsed", policyTurn));
  await expect(
    within(policyTurn).findByText(policy.evidence),
  ).resolves.toBeVisible();
  expect(screen.queryByText(launch.evidence)).toBeNull();
  expect(screen.getByText("Thinking...")).toBeVisible();
});
