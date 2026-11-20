import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

// The agent the URL points at, which never appears in the visible agent list.
const MISSING_AGENT_ID = "c9000000-0000-4000-a000-000000000009";
const MISSING_AGENT_CHAT_PATH = `/agents/${MISSING_AGENT_ID}/chat`;
const DEFAULT_AGENT_ID = "c9000000-0000-4000-a000-000000000001";
const VISIBLE_AGENT_ID = "c9000000-0000-4000-a000-000000000002";
// A recorded default the current user cannot reach: deleted, or private to
// another member, so it is absent from this user's agent list.
const UNREACHABLE_DEFAULT_ID = "c9000000-0000-4000-a000-000000000003";

function visibleAgents(agentIds: readonly string[]): void {
  context.mocks.data.agents(
    agentIds.map((agentId) => {
      return { agentId, isDefaultAgent: agentId === DEFAULT_AGENT_ID };
    }),
  );
}

function recordedDefaultAgent(defaultAgentId: string | null): void {
  context.mocks.data.onboardingStatus({
    defaultAgentId,
    hasDefaultAgent: defaultAgentId !== null,
  });
}

/**
 * Opens the unreachable agent's chat URL and reports the path the user is left
 * on. Recovery navigates after the page renders, so wait for the destination,
 * then flush queued navigation work: a recovery that bounced between routes
 * would move away again instead of settling here.
 */
async function recoveredPathname(destination: string): Promise<string> {
  await setupPage({ context, path: MISSING_AGENT_CHAT_PATH });
  await waitFor(() => {
    expect(window.location.pathname).toBe(destination);
  });
  await Promise.resolve();
  return window.location.pathname;
}

test("A historical agent chat opens My Okou with the recorded default executor", async () => {
  visibleAgents([DEFAULT_AGENT_ID, VISIBLE_AGENT_ID]);
  recordedDefaultAgent(DEFAULT_AGENT_ID);
  await expect(recoveredPathname("/")).resolves.toBe("/");
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeVisible();
});

test.each([UNREACHABLE_DEFAULT_ID, null])(
  "A historical agent chat opens settings when the default executor is unavailable (%s)",
  async (defaultAgentId) => {
    visibleAgents([VISIBLE_AGENT_ID]);
    recordedDefaultAgent(defaultAgentId);
    await expect(recoveredPathname("/connectors")).resolves.toBe("/connectors");
    await expect(
      screen.findByRole("dialog", { name: "Settings" }),
    ).resolves.toBeVisible();
  },
);
