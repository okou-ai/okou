import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  const agentsFilter = queryAllByRoleFast("button", dialog).find((button) => {
    return button.textContent === "Agents";
  });
  if (!agentsFilter) {
    throw new Error("Expected Agents search filter");
  }
  click(agentsFilter);
  expect(agentsFilter).toHaveAttribute("aria-pressed", "true");
  click(agentsFilter);
  expect(agentsFilter).toHaveAttribute("aria-pressed", "true");
  expect(search).toHaveValue("  REseaRCH  ");
  expect(
    within(dialog).getByRole("option", { name: "Research Agent" }),
  ).toBeVisible();
});

test("Navigate workspace search filters without changing the query or clearing selection", async () => {
  const user = userEvent.setup({ delay: null });
  prepareAgents();
  await setupPage({ context, path: `/agents/${DEFAULT_AGENT_ID}/chat` });
  const trigger = screen.getByLabelText("Search workspace", {
    selector: "button",
  });
  await user.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: SEARCH_LABEL });
  const search = within(dialog).getByRole("combobox");
  await user.click(search);
  await user.type(search, "Research");
  await within(dialog).findByRole("option", { name: "Research Agent" });

  const group = within(dialog).getByRole("group", { name: SEARCH_LABEL });
  const filters = queryAllByRoleFast("button", group);
  expect(
    filters.map((button) => {
      return button.textContent;
    }),
  ).toStrictEqual([
    "All",
    "Chats",
    "Messages",
    "Agents",
    "Workflows",
    "Artifacts",
  ]);
  await user.click(filters[0]!);
  expect(filters[0]).toHaveFocus();
  expect(filters[0]).toHaveAttribute("aria-pressed", "true");
  await user.keyboard(" ");
  expect(filters[0]).toHaveAttribute("aria-pressed", "true");
  expect(within(dialog).getByText("1 result")).toBeInTheDocument();

  for (const [offset, filter] of filters.slice(1).entries()) {
    const index = offset + 1;
    await user.keyboard("{ArrowRight}");
    expect(filter).toHaveFocus();
    expect(filter).toHaveAttribute("aria-pressed", "false");
    expect(filters[offset]).toHaveAttribute("aria-pressed", "true");
    await user.keyboard(index % 2 === 0 ? " " : "{Enter}");
    expect(filter).toHaveAttribute("aria-pressed", "true");
    expect(search).toHaveValue("Research");
    const hasResult = index === 3;
    await waitFor(() => {
      expect(
        within(dialog).getByText(hasResult ? "1 result" : "0 results"),
      ).toBeInTheDocument();
      expect(queryAllByRoleFast("option", dialog)).toHaveLength(
        hasResult ? 1 : 0,
      );
    });
  }

  await user.keyboard(" ");
  expect(filters[5]).toHaveAttribute("aria-pressed", "true");
  await user.click(search);
  expect(search).toHaveFocus();
  expect(search).toHaveValue("Research");
  await user.click(filters[5]!);
  expect(filters[5]).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: SEARCH_LABEL })).toBeNull();
    expect(trigger).toHaveFocus();
  });
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
