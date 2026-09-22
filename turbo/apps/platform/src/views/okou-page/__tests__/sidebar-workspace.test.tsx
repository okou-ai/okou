import {
  AGENT_ID,
  agentRowByName,
  ARCHIVED_THREAD_ID,
  AUTOMATION_THREAD_ID,
  buttonByText,
  context,
  createThread,
  EXISTING_THREAD_ID,
  INCIDENT_THREAD_ID,
  menuItemByText,
  mobileSidebar,
  mockMobileLayout,
  mockSidebarThreadStory,
  mockUnreadAgents,
  openChatListMenu,
  pinnedAgentLink,
  prepareAgents,
  prepareDefaultAgent,
  queryMenuItemByText,
  RESEARCH_AGENT_ID,
  RESEARCH_THREAD_ID,
  setupSidebarPage,
  sidebar,
  SUPPORT_AGENT_ID,
} from "./sidebar-test-helpers.tsx";

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  chatSearchContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { click, fill } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { emptySearchImg } from "../platform-assets.ts";
import { pathname } from "../../../signals/location.ts";
import { changeChatThreadReadCursor } from "../../../mocks/mock-helpers.ts";

async function setupWorkspaceSearch() {
  prepareAgents();
  mockSidebarThreadStory([
    createThread(RESEARCH_THREAD_ID, "Deployment notes", {
      agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
    }),
    createThread(INCIDENT_THREAD_ID, "Incident response", {
      agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
    }),
  ]);
  context.mocks.api(chatSearchContract.search, ({ query, respond }) => {
    return respond(200, {
      results:
        query.keyword === "deploy"
          ? [
              {
                chatThreadId: INCIDENT_THREAD_ID,
                agentName: "Support Agent",
                matchedMessage: {
                  chatThreadId: INCIDENT_THREAD_ID,
                  role: "user" as const,
                  content: "Production deploy completed successfully",
                  createdAt: "2026-03-10T00:10:00Z",
                  seqId: 1,
                  runId: null,
                },
                matchedRanges: [{ start: 11, end: 17 }],
              },
            ]
          : [],
    });
  });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [], nextCursor: null });
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const list = await screen.findByTestId("chat-list-column");
  click(within(list).getByLabelText("Search workspace"));

  const dialog = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });
  await fill(
    within(dialog).getByPlaceholderText("Search workspace..."),
    "deploy",
  );

  return dialog;
}

test("Show matching workspace chats and messages", async () => {
  const dialog = await setupWorkspaceSearch();
  await waitFor(() => {
    expect(within(dialog).getByText("2 results")).toBeInTheDocument();
    expect(within(dialog).getByText("Deployment notes")).toBeInTheDocument();
    expect(within(dialog).getByText("Incident response")).toBeInTheDocument();
    expect(
      within(dialog).queryByText("Research Agent"),
    ).not.toBeInTheDocument();
  });
});

test("Filter workspace search to matching messages", async () => {
  const dialog = await setupWorkspaceSearch();
  await waitFor(() => {
    expect(within(dialog).getByText("2 results")).toBeInTheDocument();
  });
  click(buttonByText("Messages", dialog));
  expect(
    within(dialog).queryByText("Deployment notes"),
  ).not.toBeInTheDocument();
  expect(within(dialog).getByText("Incident response")).toBeInTheDocument();
});

test("Show an empty workspace-search result", async () => {
  const dialog = await setupWorkspaceSearch();
  await fill(
    within(dialog).getByPlaceholderText("Search workspace..."),
    "missing",
  );
  await waitFor(() => {
    expect(within(dialog).getByText("No results found")).toBeInTheDocument();
    expect(within(dialog).getByText("0 results")).toBeInTheDocument();
  });
});

test("Filter workspace search to chats and navigate", async () => {
  const dialog = await setupWorkspaceSearch();
  click(buttonByText("Chats", dialog));
  await waitFor(() => {
    expect(within(dialog).getByText("Deployment notes")).toBeInTheDocument();
    expect(
      within(dialog).queryByText("Incident response"),
    ).not.toBeInTheDocument();
  });
  click(within(dialog).getByText("Deployment notes"));
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${RESEARCH_THREAD_ID}`);
    expect(
      screen.queryByRole("dialog", {
        name: "Search workspace...",
      }),
    ).not.toBeInTheDocument();
  });
});

test("Show unread agents and contextual actions in the pinned section", async () => {
  mockMobileLayout();
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID],
  });

  let unreadAgentIds = [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID];
  mockUnreadAgents(() => {
    return unreadAgentIds;
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    sharedWorkerTestTransport: "message-port",
  });

  const nav = await waitFor(() => {
    const current = mobileSidebar();
    expect(within(current).getByText("Research Agent")).toBeInTheDocument();
    return current;
  });
  const researchSidebarRow = agentRowByName(nav, "Research Agent");
  const supportSidebarRow = await waitFor(() => {
    return agentRowByName(nav, "Support Agent");
  });
  await waitFor(() => {
    expect(
      within(researchSidebarRow).getByLabelText("Unread"),
    ).toBeInTheDocument();
    expect(
      within(researchSidebarRow).getByLabelText("Open agent menu"),
    ).toBeInTheDocument();
    expect(
      within(researchSidebarRow).queryByLabelText("Unpin"),
    ).not.toBeInTheDocument();
    expect(
      within(supportSidebarRow).getByLabelText("Unread"),
    ).toBeInTheDocument();
  });

  click(within(supportSidebarRow).getByLabelText("Open agent menu"));
  expect(menuItemByText("Mark all read")).toBeInTheDocument();
  expect(menuItemByText("Pin to sidebar")).toBeInTheDocument();
  expect(queryMenuItemByText("Unpin")).not.toBeInTheDocument();
  fireEvent.keyDown(document, { code: "Escape", key: "Escape" });

  click(within(researchSidebarRow).getByLabelText("Open agent menu"));
  expect(menuItemByText("Unpin")).toBeInTheDocument();
  fireEvent.keyDown(document, { code: "Escape", key: "Escape" });

  unreadAgentIds = [SUPPORT_AGENT_ID];
  changeChatThreadReadCursor({
    agentId: RESEARCH_AGENT_ID,
  });

  await waitFor(() => {
    expect(
      within(researchSidebarRow).queryByLabelText("Unread"),
    ).not.toBeInTheDocument();
    expect(
      within(supportSidebarRow).getByLabelText("Unread"),
    ).toBeInTheDocument();
  });
});

test("Show useful search-result ages and an illustrated empty state", async () => {
  const now = Date.parse("2026-03-10T12:00:00.000Z");
  mockNow(now, context.signal);
  prepareAgents();
  mockSidebarThreadStory([
    createThread(RESEARCH_THREAD_ID, "Minutes old", {
      sortAt: new Date(now - 5 * 60 * 1000).toISOString(),
    }),
    createThread(INCIDENT_THREAD_ID, "Hours old", {
      sortAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
    }),
    createThread(AUTOMATION_THREAD_ID, "Days old", {
      sortAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
    }),
    createThread(ARCHIVED_THREAD_ID, "Older than a month", {
      sortAt: new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString(),
    }),
  ]);
  context.mocks.api(chatSearchContract.search, ({ respond }) => {
    return respond(200, { results: [] });
  });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [], nextCursor: null });
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const list = await screen.findByTestId("chat-list-column");
  click(within(list).getByLabelText("Search workspace"));

  const dialog = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });

  const rowFor = async (title: string): Promise<HTMLElement> => {
    const row = (await within(dialog).findByText(title)).closest(
      '[role="option"]',
    );
    if (!(row instanceof HTMLElement)) {
      throw new Error(`no spotlight row for ${title}`);
    }
    return row;
  };

  const minutesRow = await rowFor("Minutes old");
  expect(minutesRow).toHaveTextContent("5 minutes ago");
  const hoursRow = await rowFor("Hours old");
  expect(hoursRow).toHaveTextContent("3 hours ago");
  const daysRow = await rowFor("Days old");
  expect(daysRow).toHaveTextContent("2 days ago");

  // Past a month a relative phrase stops helping, so the row shows the
  // absolute date instead. Assert the shape rather than an exact string so
  // the expectation does not depend on the runner's timezone.
  const archived = await rowFor("Older than a month");
  expect(archived).not.toHaveTextContent("ago");
  expect(archived).toHaveTextContent(/[A-Z][a-z]{2} \d{1,2},/u);

  await fill(
    within(dialog).getByPlaceholderText("Search workspace..."),
    "nothing matches this",
  );

  await waitFor(() => {
    expect(within(dialog).getByText("No results found")).toBeInTheDocument();
  });
  expect(within(dialog).queryByText("Minutes old")).not.toBeInTheDocument();
  const emptyState = within(dialog)
    .getByText("No results found")
    .closest("div");
  expect(emptyState?.querySelector("img")).toHaveAttribute(
    "src",
    emptySearchImg,
  );
});

test("Show only the selected agent’s unread conversations when switching agents", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID],
  });
  const researchThread = createThread(RESEARCH_THREAD_ID, "Research kickoff", {
    agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
  });
  const supportThread = createThread(INCIDENT_THREAD_ID, "Support escalation", {
    agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
  });
  const olderSupportThread = createThread(
    AUTOMATION_THREAD_ID,
    "Support archive",
    {
      agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
    },
  );
  mockSidebarThreadStory([researchThread, supportThread, olderSupportThread]);
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: {
        [RESEARCH_AGENT_ID]: "unread",
        [SUPPORT_AGENT_ID]: "unread",
      },
      threads: {
        [RESEARCH_THREAD_ID]: "unread",
        [INCIDENT_THREAD_ID]: "unread",
        [AUTOMATION_THREAD_ID]: "active",
      },
    });
  });
  context.mocks.api(chatThreadsContract.unreads, ({ query, respond }) => {
    const threadId =
      query.agentId === SUPPORT_AGENT_ID
        ? INCIDENT_THREAD_ID
        : RESEARCH_THREAD_ID;
    return respond(200, {
      unreads: [
        {
          threadId,
          unreadAt: "2026-03-10T00:05:00Z",
        },
      ],
    });
  });

  await setupSidebarPage({
    context,
    path: `/chats/${RESEARCH_THREAD_ID}`,
  });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Research kickoff")).toBeInTheDocument();
  });
  openChatListMenu();
  click(menuItemByText("Unread only"));
  await waitFor(() => {
    expect(within(sidebar()).getByText("Research kickoff")).toBeInTheDocument();
  });
  expect(
    within(sidebar()).queryByText("Support escalation"),
  ).not.toBeInTheDocument();

  fireEvent.keyDown(document.body, {
    key: "}",
    ctrlKey: true,
    shiftKey: true,
  });

  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${SUPPORT_AGENT_ID}/chat`);
    expect(
      within(sidebar()).getByText("Support escalation"),
    ).toBeInTheDocument();
    expect(
      within(sidebar()).queryByText("Research kickoff"),
    ).not.toBeInTheDocument();
    expect(
      within(sidebar()).queryByText("Support archive"),
    ).not.toBeInTheDocument();
  });
});

test("Toggle unread chats by reselecting an unread pinned agent", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID],
  });
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Default unread"),
    createThread(RESEARCH_THREAD_ID, "Default read"),
    createThread(INCIDENT_THREAD_ID, "Support unread", {
      agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
    }),
    createThread(AUTOMATION_THREAD_ID, "Support read", {
      agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
    }),
  ]);
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: {
        [AGENT_ID]: "unread",
        [SUPPORT_AGENT_ID]: "unread",
      },
      threads: {
        [EXISTING_THREAD_ID]: "unread",
        [INCIDENT_THREAD_ID]: "unread",
      },
    });
  });
  context.mocks.api(chatThreadsContract.unreads, ({ query, respond }) => {
    const threadId =
      query.agentId === SUPPORT_AGENT_ID
        ? INCIDENT_THREAD_ID
        : query.agentId === AGENT_ID
          ? EXISTING_THREAD_ID
          : null;
    return respond(200, {
      unreads: threadId ? [{ threadId, unreadAt: "2026-03-10T00:05:00Z" }] : [],
    });
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Default unread")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Default read")).toBeInTheDocument();
  });
  openChatListMenu();
  click(menuItemByText("Unread only"));
  await waitFor(() => {
    expect(within(sidebar()).getByText("Default unread")).toBeInTheDocument();
    expect(
      within(sidebar()).queryByText("Default read"),
    ).not.toBeInTheDocument();
  });

  const pinnedAgent = (name: string): HTMLAnchorElement => {
    return pinnedAgentLink(screen.getByTestId("pinned-agents-grid"), name);
  };

  click(pinnedAgent("Support Agent"));
  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${SUPPORT_AGENT_ID}/chat`);
    expect(within(sidebar()).getByText("Support unread")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Support read")).toBeInTheDocument();
  });

  const navigationCount = vi.mocked(window.history.pushState).mock.calls.length;
  click(pinnedAgent("Support Agent"));
  await waitFor(() => {
    expect(within(sidebar()).getByText("Support unread")).toBeInTheDocument();
    expect(
      within(sidebar()).queryByText("Support read"),
    ).not.toBeInTheDocument();
  });
  expect(pathname()).toBe(`/agents/${SUPPORT_AGENT_ID}/chat`);
  expect(vi.mocked(window.history.pushState)).toHaveBeenCalledTimes(
    navigationCount,
  );

  click(pinnedAgent("Support Agent"));
  await waitFor(() => {
    expect(within(sidebar()).getByText("Support unread")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Support read")).toBeInTheDocument();
  });
  expect(pathname()).toBe(`/agents/${SUPPORT_AGENT_ID}/chat`);
  expect(vi.mocked(window.history.pushState)).toHaveBeenCalledTimes(
    navigationCount,
  );
});

test("Keep all chats when reselecting a pinned agent without unread", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [SUPPORT_AGENT_ID],
  });
  mockSidebarThreadStory([
    createThread(INCIDENT_THREAD_ID, "Support recent", {
      agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
    }),
    createThread(AUTOMATION_THREAD_ID, "Support older", {
      agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
    }),
  ]);
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, { agents: {}, threads: {} });
  });

  await setupSidebarPage({
    context,
    path: `/agents/${SUPPORT_AGENT_ID}/chat`,
  });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Support recent")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Support older")).toBeInTheDocument();
  });
  const navigationCount = vi.mocked(window.history.pushState).mock.calls.length;
  const supportAgent = pinnedAgentLink(
    screen.getByTestId("pinned-agents-grid"),
    "Support Agent",
  );

  click(supportAgent);

  expect(within(sidebar()).getByText("Support recent")).toBeInTheDocument();
  expect(within(sidebar()).getByText("Support older")).toBeInTheDocument();
  expect(pathname()).toBe(`/agents/${SUPPORT_AGENT_ID}/chat`);
  expect(vi.mocked(window.history.pushState)).toHaveBeenCalledTimes(
    navigationCount,
  );
});

test("Use context actions on pinned agents", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID],
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const grid = await screen.findByTestId("pinned-agents-grid");
  const researchAgent = await waitFor(() => {
    return pinnedAgentLink(grid, "Research Agent");
  });

  fireEvent.contextMenu(researchAgent);
  expect(menuItemByText("Unpin")).toBeInTheDocument();
  click(menuItemByText("Unpin"));
  await waitFor(() => {
    expect(within(grid).queryByText("Research Agent")).toBeNull();
  });

  const supportAgent = pinnedAgentLink(grid, "Support Agent");
  fireEvent.touchStart(supportAgent, {
    touches: [{ identifier: 1, clientX: 12, clientY: 12 }],
  });
  await waitFor(() => {
    expect(menuItemByText("Unpin")).toBeInTheDocument();
  });
  fireEvent.touchEnd(supportAgent, {
    touches: [],
    changedTouches: [{ identifier: 1, clientX: 12, clientY: 12 }],
  });
  fireEvent.keyDown(document, { code: "Escape", key: "Escape" });
  await waitFor(() => {
    expect(queryMenuItemByText("Unpin")).toBeNull();
  });

  click(supportAgent);
  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${SUPPORT_AGENT_ID}/chat`);
  });
});

test("Show the three-column chat navigation and actions", async () => {
  prepareDefaultAgent();

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const rail = await waitFor(() => {
    return screen.getByTestId("labeled-nav-rail");
  });

  const chatLink = within(rail).getByLabelText("Chat");
  expect(within(rail).getByText("Chat")).toBeInTheDocument();
  expect(chatLink.querySelector(".lucide-message-circle")).toBeInTheDocument();
  expect(within(rail).getByText("Agents")).toBeInTheDocument();
  expect(within(rail).getByText("Connectors")).toBeInTheDocument();

  const list = screen.getByTestId("chat-list-column");
  expect(within(list).getByText("Chat")).toBeInTheDocument();
  const searchButton = within(list).getByLabelText("Search workspace");
  const chatThreadsTitle = within(list).getByText("Chats with Okou");
  if (!searchButton.parentElement || !chatThreadsTitle.parentElement) {
    throw new Error("Chat action headers not found");
  }
  const headerNewChat = within(searchButton.parentElement).getByLabelText(
    "New chat",
  );
  const threadNewChat = within(chatThreadsTitle.parentElement).getByLabelText(
    "New chat",
  );
  expect(searchButton).toHaveAttribute(
    "aria-keyshortcuts",
    "Meta+Shift+F Control+Shift+F",
  );
  expect(headerNewChat.querySelector(".lucide-square-pen")).toBeInTheDocument();
  expect(threadNewChat.querySelector(".lucide-plus")).toBeInTheDocument();
  expect(
    within(list).getByTestId("pinned-agents-horizontal"),
  ).toBeInTheDocument();
});
