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
      return { agentId };
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

test("A missing agent falls back to the recorded default agent that is visible", async () => {
  visibleAgents([DEFAULT_AGENT_ID, VISIBLE_AGENT_ID]);
  recordedDefaultAgent(DEFAULT_AGENT_ID);

  const destination = `/agents/${DEFAULT_AGENT_ID}/chat`;
  await expect(recoveredPathname(destination)).resolves.toBe(destination);
});

test("A missing agent never falls back to a default the user cannot reach", async () => {
  visibleAgents([VISIBLE_AGENT_ID]);
  recordedDefaultAgent(UNREACHABLE_DEFAULT_ID);

  const destination = `/agents/${VISIBLE_AGENT_ID}/chat`;
  await expect(recoveredPathname(destination)).resolves.toBe(destination);
});

test("A missing agent falls back to a visible agent when no default is recorded", async () => {
  visibleAgents([VISIBLE_AGENT_ID]);
  recordedDefaultAgent(null);

  const destination = `/agents/${VISIBLE_AGENT_ID}/chat`;
  await expect(recoveredPathname(destination)).resolves.toBe(destination);
});

test("A missing agent with no visible agent and no recorded default opens home", async () => {
  visibleAgents([]);
  recordedDefaultAgent(null);

  const destination = "/";
  await expect(recoveredPathname(destination)).resolves.toBe(destination);
});

test("A missing agent with no visible agent opens the agent list instead of bouncing through home", async () => {
  // Home redirects to the recorded default, which is the page that just failed,
  // so recovering through home here would navigate back and forth forever.
  visibleAgents([]);
  recordedDefaultAgent(UNREACHABLE_DEFAULT_ID);

  const destination = "/agents";
  await expect(recoveredPathname(destination)).resolves.toBe(destination);
});

test("A resolvable agent still opens its chat page", async () => {
  context.mocks.data.agents([
    { agentId: VISIBLE_AGENT_ID, displayName: "Scout" },
  ]);
  recordedDefaultAgent(VISIBLE_AGENT_ID);

  await setupPage({ context, path: `/agents/${VISIBLE_AGENT_ID}/chat` });

  expect(window.location.pathname).toBe(`/agents/${VISIBLE_AGENT_ID}/chat`);
  expect(document.title).toContain("Scout");
  expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
});
