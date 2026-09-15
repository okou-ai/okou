import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  agentsByIdContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();
const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const RESEARCH_AGENT_ID = "c0000000-0000-4000-a000-000000000002";
const SUPPORT_AGENT_ID = "c0000000-0000-4000-a000-000000000003";
const SEARCH_LABEL = "Search workspace...";
const MAC_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

function prepareAgents() {
  context.mocks.browser.userAgent(MAC_USER_AGENT);
  const agents: AgentResponse[] = [
    { agentId: DEFAULT_AGENT_ID, displayName: "Nova" },
    { agentId: RESEARCH_AGENT_ID, displayName: "Research Agent" },
    {
      agentId: SUPPORT_AGENT_ID,
      displayName: "Support Agent",
      description: "Research customer questions",
    },
    {
      agentId: "c0000000-0000-4000-a000-000000000004",
      displayName: null,
      description: "Research without a display name",
    },
  ].map((agent) => {
    return {
      isDefaultAgent: agent.agentId === DEFAULT_AGENT_ID,
      ownerId: "test-user-123",
      description: null,
      sound: null,
      avatarUrl: null,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
      ...agent,
    };
  });
  context.mocks.data.agents(agents);
  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    const agent = agents.find((candidate) => {
      return candidate.agentId === params.id;
    });
    if (!agent) {
      throw new Error(`Unexpected agent ${params.id}`);
    }
    return respond(200, agent);
  });
}

async function openSearch() {
  await screen.findByTestId("chat-list-column");
  fireEvent.keyDown(document.body, {
    key: "f",
    code: "KeyF",
    metaKey: true,
    shiftKey: true,
  });
  const dialog = await screen.findByRole("dialog", { name: SEARCH_LABEL });
  return {
    dialog,
    search: within(dialog).getByPlaceholderText(SEARCH_LABEL),
  };
}

test("Find workspace agents by name with case and whitespace normalization", async () => {
  prepareAgents();
  await setupPage({
    context,
    path: `/agents/${DEFAULT_AGENT_ID}/chat`,
  });
  const { dialog, search } = await openSearch();

  await fill(search, "  REseaRCH  ");
  await expect(
    within(dialog).findByRole("option", { name: "Research Agent" }),
  ).resolves.toBeVisible();
  expect(within(dialog).getByText("1 result")).toBeVisible();
  expect(within(dialog).queryByText("Support Agent")).toBeNull();

  const agentsTab = queryAllByRoleFast("tab", dialog).find((tab) => {
    return tab.textContent === "Agents";
  });
  if (!agentsTab) {
    throw new Error("Expected Agents search filter");
  }
  click(agentsTab);
  expect(agentsTab).toHaveAttribute("aria-selected", "true");
  expect(
    within(dialog).getByRole("option", { name: "Research Agent" }),
  ).toBeVisible();
});

test("Agent search excludes IDs and blank queries but includes Nova", async () => {
  prepareAgents();
  await setupPage({ context, path: `/agents/${DEFAULT_AGENT_ID}/chat` });
  const { dialog, search } = await openSearch();
  await fill(search, RESEARCH_AGENT_ID);
  await expect(
    within(dialog).findByText("No results found"),
  ).resolves.toBeVisible();
  expect(within(dialog).getByText("0 results")).toBeVisible();

  await fill(search, "nova");
  await expect(
    within(dialog).findByRole("option", { name: "Nova" }),
  ).resolves.toBeVisible();

  await fill(search, " ");
  await expect(
    within(dialog).findByText("No results found"),
  ).resolves.toBeVisible();
  expect(within(dialog).queryByRole("option")).toBeNull();
});

test("Selecting a workspace agent search result opens its chat", async () => {
  prepareAgents();
  await setupPage({ context, path: `/agents/${DEFAULT_AGENT_ID}/chat` });
  const { dialog, search } = await openSearch();
  await fill(search, "Support");
  const result = await within(dialog).findByRole("option", {
    name: "Support Agent",
  });
  click(result);
  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${SUPPORT_AGENT_ID}/chat`);
  });
  await expect(
    screen.findByText("Chats with Support Agent"),
  ).resolves.toBeVisible();
  expect(screen.queryByRole("dialog", { name: SEARCH_LABEL })).toBeNull();
});

test("Limit matching agents to the workspace search result size", async () => {
  context.mocks.browser.userAgent(MAC_USER_AGENT);
  context.mocks.data.agents([
    { agentId: DEFAULT_AGENT_ID, displayName: "Nova" },
    ...Array.from({ length: 30 }, (_, index) => {
      return {
        agentId: `c1000000-0000-4000-a000-${(index + 1).toString().padStart(12, "0")}`,
        displayName: `Analyst ${index + 1}`,
      };
    }),
  ]);
  await setupPage({
    context,
    path: `/agents/${DEFAULT_AGENT_ID}/chat`,
  });
  const { dialog, search } = await openSearch();

  await fill(search, "analyst");
  await expect(within(dialog).findByText("25 results")).resolves.toBeVisible();
  expect(within(dialog).getAllByRole("option")).toHaveLength(25);
  expect(within(dialog).getByText("Analyst 25")).toBeVisible();
  expect(within(dialog).queryByText("Analyst 26")).toBeNull();
});
