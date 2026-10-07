import {
  agentsByIdContract,
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();
const CURRENT_ORG_AGENT_ID = "c0000000-0000-4000-a000-000000000005";

function mockCurrentOrganizationAgents() {
  const agent: AgentResponse = {
    isDefaultAgent: false,
    agentId: CURRENT_ORG_AGENT_ID,
    ownerId: "test-user-123",
    displayName: "Current organization agent",
    description: null,
    sound: null,
    avatarUrl: null,
    visibility: "private",
  };
  const agents: AgentResponse[] = [
    {
      ...agent,
      agentId: "c0000000-0000-4000-a000-000000000004",
      displayName: "Research agent",
    },
    agent,
  ];
  context.mocks.data.onboardingStatus({
    defaultAgentId: CURRENT_ORG_AGENT_ID,
  });
  context.mocks.api(agentsMainContract.list, ({ respond }) => {
    return respond(200, agents);
  });
  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    const requestedAgent = agents.find((candidate) => {
      return candidate.agentId === params.id;
    });
    return requestedAgent
      ? respond(200, requestedAgent)
      : respond(404, {
          error: {
            code: "NOT_FOUND",
            message: `Agent not found: ${params.id}`,
          },
        });
  });
}

test("Home opens the current organization's default agent", async () => {
  mockCurrentOrganizationAgents();

  await setupPage({
    context,
    path: "/",
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      organization: {
        activeOrg: { id: "org_current", name: "Current organization" },
        memberships: [{ id: "org_current" }, { id: "org_previous" }],
      },
    },
  });

  await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${CURRENT_ORG_AGENT_ID}/chat`);
    expect(document.title).toContain("Current organization agent");
  });
});

test("Home preserves a prompt handoff when opening the default agent", async () => {
  mockCurrentOrganizationAgents();

  await setupPage({
    context,
    path: "/?prompt=Draft%20a%20launch%20plan",
  });

  await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${CURRENT_ORG_AGENT_ID}/chat`);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Draft a launch plan",
    );
  });
});
