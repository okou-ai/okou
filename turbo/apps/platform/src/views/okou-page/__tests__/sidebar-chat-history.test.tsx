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
  mockChatThreadSnapshot,
  mockLongSidebarHistory,
  mockMobileLayout,
  mockSidebarThreadStory,
  mockSidebarViewport,
  mockUnreadAgents,
  openChatListMenu,
  openThreadMenu,
  prepareAgents,
  prepareDefaultAgent,
  queryMenuItemByText,
  RESEARCH_AGENT_ID,
  RESEARCH_THREAD_ID,
  scrollToArchivedContext,
  setupSidebarPage,
  sidebar,
  type SidebarThread,
  stubSidebarTitleLayout,
  SUPPORT_AGENT_ID,
  threadLinkByTitle,
  titleFadeBox,
  visibleThreadTitles,
} from "./sidebar-test-helpers.tsx";

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  chatThreadByIdContract,
  chatThreadEventsContract,
  chatThreadMarkAgentReadContract,
  chatThreadMarkReadContract,
  chatThreadMarkUnreadContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { chatEventRowsResponse } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";
import { mockChatEventRows } from "./chat-event-test-helpers.ts";
import {
  changeChatThreadReadCursor,
  createChatEvent,
} from "../../../mocks/mock-helpers.ts";

test("Browse a long sidebar chat history", async () => {
  const cachedChatThreadEvents = mockLongSidebarHistory();
  mockSidebarViewport(200, 1000);

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
    cachedChatThreadEvents,
  });

  const scrollArea = await scrollToArchivedContext();
  expect(scrollArea).toBeInTheDocument();
});

test("Toggle the chat list from its title with pointer and keyboard", async () => {
  const user = userEvent.setup({ delay: null });
  prepareDefaultAgent();
  mockSidebarThreadStory([createThread(EXISTING_THREAD_ID, "Release plan")]);

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const list = await screen.findByTestId("chat-list-column");
  await within(list).findByText("Release plan");
  const titleButton = buttonByText("Chats with Okou", list);
  const contentId = titleButton.getAttribute("aria-controls");
  if (!contentId) {
    throw new Error("Chat list title does not control its content");
  }
  const content = document.getElementById(contentId);
  if (!content) {
    throw new Error("Controlled chat list content not found");
  }

  expect(titleButton).toHaveAttribute("aria-expanded", "true");
  expect(content).toBeVisible();
  titleButton.focus();
  await user.keyboard("{Enter}");

  expect(titleButton).toHaveFocus();
  expect(titleButton).toHaveAttribute("aria-expanded", "false");
  expect(content).not.toBeVisible();
  expect(within(list).queryByText("Release plan")).not.toBeInTheDocument();

  click(titleButton);
  await within(list).findByText("Release plan");
  expect(titleButton).toHaveAttribute("aria-expanded", "true");
  expect(content).toBeVisible();
});

test("Delete a chat after reviewing the impact", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Incident notes"),
  ]);

  await setupSidebarPage({ context, path: `/chats/${EXISTING_THREAD_ID}` });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
  });

  openThreadMenu("Release plan");
  click(menuItemByText("Delete chat"));

  const dialog = await screen.findByRole("dialog", {
    name: "Delete chat?",
  });
  expect(
    within(dialog).getByText(
      "This will permanently delete this chat. Any task currently running in this chat will be stopped immediately. Any linked automations will be paused. This action cannot be undone.",
    ),
  ).toBeInTheDocument();

  click(buttonByText("Cancel", dialog));

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
  });

  openThreadMenu("Release plan");
  click(menuItemByText("Delete chat"));

  const confirmDialog = await screen.findByRole("dialog", {
    name: "Delete chat?",
  });
  click(buttonByText("Delete", confirmDialog));

  await waitFor(() => {
    expect(
      within(sidebar()).queryByText("Release plan"),
    ).not.toBeInTheDocument();
    expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
  });
});

/**
 * Deliberate exception to `docs/testing/testing-external-behavior.md`. The fade
 * and the hover travel are a mask and a transform derived from measured text
 * width, and happy-dom has no layout engine: it reports every box as
 * zero-width and paints nothing, so neither the state nor the result exists on
 * the page surface here. The measured distance is the only place the behavior
 * is observable, and it is worth pinning because both the fade and the travel
 * are derived from it — a wrong distance fades a title that fits, or stops the
 * scroll before the end.
 */
test("Fade a clipped chat title and pace its scroll by the hidden distance", async () => {
  stubSidebarTitleLayout();
  prepareDefaultAgent();
  mockSidebarThreadStory([
    // 26 characters, so 234px of text in a 160px box.
    createThread(EXISTING_THREAD_ID, "Quarterly launch narrative"),
    createThread(AUTOMATION_THREAD_ID, "Release plan"),
  ]);

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  await expect(
    within(sidebar()).findByText("Release plan"),
  ).resolves.toBeInTheDocument();

  const clipped = titleFadeBox("Quarterly launch narrative");
  expect(clipped.style.getPropertyValue("--okou-nav-title-overflow")).toBe(
    "74px",
  );
  expect(clipped.style.getPropertyValue("--okou-nav-title-duration")).toBe(
    "2000ms",
  );

  const fitting = titleFadeBox("Release plan");
  expect(fitting.style.getPropertyValue("--okou-nav-title-overflow")).toBe(
    "0px",
  );
  expect(fitting.style.getPropertyValue("--okou-nav-title-duration")).toBe(
    "780ms",
  );
});

test("Filter unread conversations using indicator timestamps", async () => {
  prepareDefaultAgent();
  const pinnedUnreadThread = createThread(
    AUTOMATION_THREAD_ID,
    "Pinned incident",
    {
      pinnedAt: "2026-03-10T12:00:00Z",
    },
  );
  const currentThread = createThread(EXISTING_THREAD_ID, "Release plan");
  const unreadThread = createThread(INCIDENT_THREAD_ID, "Incident notes");
  const archivedThread = createThread(ARCHIVED_THREAD_ID, "Archived context");
  const allThreads = [
    pinnedUnreadThread,
    currentThread,
    unreadThread,
    archivedThread,
  ];
  mockChatThreadSnapshot(() => {
    return allThreads;
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: { [AGENT_ID]: "unread" },
      threads: {
        [AUTOMATION_THREAD_ID]: "unread",
        [INCIDENT_THREAD_ID]: "unread",
        [EXISTING_THREAD_ID]: "active",
      },
      unreadAt: {
        [AUTOMATION_THREAD_ID]: "2026-03-10T00:04:00Z",
        [INCIDENT_THREAD_ID]: "2026-03-10T00:05:00Z",
      },
    });
  });

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Archived context")).toBeInTheDocument();
  });

  openChatListMenu();
  click(menuItemByText("Unread"));

  await waitFor(() => {
    expect(
      visibleThreadTitles(["Pinned incident", "Incident notes"]),
    ).toStrictEqual(["Pinned incident", "Incident notes"]);
    expect(
      within(sidebar()).queryByText("Release plan"),
    ).not.toBeInTheDocument();
    expect(
      within(sidebar()).queryByText("Archived context"),
    ).not.toBeInTheDocument();
  });
});

test("Keep check-mark chats and archive controls unchanged when archiving is disabled", async () => {
  prepareDefaultAgent();
  const completedThread = createThread(
    EXISTING_THREAD_ID,
    "✅ Completed release",
  );
  mockSidebarThreadStory([completedThread]);

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ChatThreadArchiving]: false },
  });

  await waitFor(() => {
    expect(
      within(sidebar()).getByText("✅ Completed release"),
    ).toBeInTheDocument();
  });

  openChatListMenu();
  expect(menuItemByText("All chats")).toBeInTheDocument();
  expect(queryMenuItemByText("Archived")).not.toBeInTheDocument();
  fireEvent.keyDown(document, { code: "Escape", key: "Escape" });

  openThreadMenu("✅ Completed release");
  expect(menuItemByText("Rename chat")).toBeInTheDocument();
  expect(queryMenuItemByText("Archive chat")).not.toBeInTheDocument();
  expect(queryMenuItemByText("Unarchive chat")).not.toBeInTheDocument();
});

test("Filter chats by All chats, Unread, or Archived", async () => {
  prepareDefaultAgent();
  const currentThread = createThread(EXISTING_THREAD_ID, "Release plan");
  const archivedReadThread = createThread(
    ARCHIVED_THREAD_ID,
    "✅ Archived context",
  );
  const archivedUnreadThread = createThread(
    INCIDENT_THREAD_ID,
    "✅ Waiting for review",
  );
  mockSidebarThreadStory([
    currentThread,
    archivedReadThread,
    archivedUnreadThread,
  ]);
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: { [AGENT_ID]: "unread" },
      threads: { [INCIDENT_THREAD_ID]: "unread" },
      unreadAt: { [INCIDENT_THREAD_ID]: "2026-03-10T00:05:00Z" },
    });
  });

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ChatThreadArchiving]: true },
  });

  await waitFor(() => {
    expect(
      visibleThreadTitles([
        "Release plan",
        "✅ Archived context",
        "✅ Waiting for review",
      ]),
    ).toStrictEqual(["Release plan"]);
  });

  openChatListMenu();
  expect(menuItemByText("Archived")).toBeInTheDocument();
  expect(
    screen
      .getByRole("menu")
      .querySelectorAll('[data-slot="dropdown-menu-separator"]'),
  ).toHaveLength(1);
  click(menuItemByText("Unread"));

  await waitFor(() => {
    expect(
      visibleThreadTitles([
        "Release plan",
        "✅ Archived context",
        "✅ Waiting for review",
      ]),
    ).toStrictEqual(["✅ Waiting for review"]);
  });
  expect(within(sidebar()).getByText("Show all chats")).toBeInTheDocument();

  openChatListMenu();
  click(menuItemByText("Archived"));

  await waitFor(() => {
    expect(
      visibleThreadTitles([
        "Release plan",
        "✅ Archived context",
        "✅ Waiting for review",
      ]),
    ).toStrictEqual(["✅ Archived context", "✅ Waiting for review"]);
  });
  expect(within(sidebar()).getByText("Show all chats")).toBeInTheDocument();

  openChatListMenu();
  click(menuItemByText("All chats"));

  await waitFor(() => {
    expect(
      visibleThreadTitles([
        "Release plan",
        "✅ Archived context",
        "✅ Waiting for review",
      ]),
    ).toStrictEqual(["Release plan"]);
  });
  expect(
    within(sidebar()).queryByText("Show all chats"),
  ).not.toBeInTheDocument();
});

test("Hide the current chat after archiving it", async () => {
  prepareDefaultAgent();
  const untitledThread: SidebarThread = {
    ...createThread(EXISTING_THREAD_ID, "Unused title"),
    title: null,
  };
  mockSidebarThreadStory([untitledThread]);

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ChatThreadArchiving]: true },
  });

  await waitFor(() => {
    expect(within(sidebar()).getByText("New chat")).toBeInTheDocument();
  });
  openThreadMenu("New chat");
  click(menuItemByText("Archive chat"));

  await waitFor(() => {
    expect(within(sidebar()).getByText("All caught up")).toBeInTheDocument();
    expect(
      within(sidebar()).getByText("All your chats are archived"),
    ).toBeInTheDocument();
    expect(within(sidebar()).queryByText("New chat")).not.toBeInTheDocument();
  });
  click(buttonByText("Show archived chats", sidebar()));

  await waitFor(() => {
    expect(within(sidebar()).getByText("✅")).toBeInTheDocument();
  });
  openThreadMenu("✅");
  click(menuItemByText("Unarchive chat"));

  await waitFor(() => {
    expect(
      within(sidebar()).getByText("No archived chats"),
    ).toBeInTheDocument();
    expect(within(sidebar()).queryByText("New Thread")).not.toBeInTheDocument();
    expect(within(sidebar()).queryByText("✅")).not.toBeInTheDocument();
  });

  click(buttonByText("Show all chats", sidebar()));
  await expect(
    within(sidebar()).findByText("New Thread"),
  ).resolves.toBeInTheDocument();
  expect(
    within(sidebar()).queryByText("No archived chats"),
  ).not.toBeInTheDocument();
});

test("Find archived chats in All and Chats workspace search results", async () => {
  prepareDefaultAgent();
  const currentThread = createThread(EXISTING_THREAD_ID, "Release plan");
  const archivedThread = createThread(
    ARCHIVED_THREAD_ID,
    "✅ Archived context",
  );
  mockSidebarThreadStory([currentThread, archivedThread]);
  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ChatThreadArchiving]: true },
  });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    expect(
      within(sidebar()).queryByText("✅ Archived context"),
    ).not.toBeInTheDocument();
  });

  click(within(sidebar()).getByLabelText("Search workspace"));
  const dialog = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });
  await fill(
    within(dialog).getByPlaceholderText("Search workspace..."),
    "archived context",
  );

  await waitFor(() => {
    expect(buttonByText("All", dialog)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(dialog).getByText("✅ Archived context")).toBeInTheDocument();
  });

  click(buttonByText("Chats", dialog));
  await waitFor(() => {
    expect(buttonByText("Chats", dialog)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(dialog).getByText("✅ Archived context")).toBeInTheDocument();
  });
});

test("Find conversations by title in workspace search", async () => {
  prepareAgents();
  const defaultThread = createThread(EXISTING_THREAD_ID, "Incident notes");
  const researchThread = createThread(RESEARCH_THREAD_ID, "Research kickoff", {
    agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
  });
  const supportThread = createThread(INCIDENT_THREAD_ID, "Support escalation", {
    agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
  });
  mockSidebarThreadStory(
    [defaultThread, researchThread, supportThread],
    [],
    [INCIDENT_THREAD_ID],
  );
  await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

  await waitFor(() => {
    expect(sidebar()).toBeInTheDocument();
  });

  fireEvent.keyDown(document.body, {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
  });

  const dialog = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });
  const search = within(dialog).getByPlaceholderText("Search workspace...");

  await fill(search, "research");

  await waitFor(() => {
    expect(within(dialog).getByText("Research kickoff")).toBeInTheDocument();
    expect(
      within(dialog).queryByText("Support escalation"),
    ).not.toBeInTheDocument();
  });

  await fill(search, "support");
  await waitFor(() => {
    expect(
      within(dialog).getByRole("option", {
        name: /^Support escalation Running /u,
      }),
    ).toBeInTheDocument();
  });
  click(within(dialog).getByText("Support escalation"));

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", {
        name: "Search workspace...",
      }),
    ).not.toBeInTheDocument();
    expect(document.title).toBe("Support escalation | Okou");
  });
});

test("Route New chat to the current agent and Chat to the default agent", async () => {
  prepareAgents();
  mockSidebarThreadStory([
    createThread(RESEARCH_THREAD_ID, "Research conversation", {
      agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
    }),
  ]);

  await setupSidebarPage({
    context,
    path: `/chats/${RESEARCH_THREAD_ID}`,
  });

  const rail = await screen.findByTestId("labeled-nav-rail");
  await screen.findByPlaceholderText(PLACEHOLDER);
  expect(
    within(screen.getByTestId("chat-list-column")).getByText(
      "Research conversation",
    ),
  ).toBeInTheDocument();
  await screen.findByText("Chats with Research Agent");

  const list = screen.getByTestId("chat-list-column");
  const searchButton = within(list).getByLabelText("Search workspace");
  if (!searchButton.parentElement) {
    throw new Error("Chat header not found");
  }
  click(within(searchButton.parentElement).getByLabelText("New chat"));

  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${RESEARCH_AGENT_ID}/chat`);
  });

  const chatLink = within(rail).getByLabelText("Chat");
  expect(chatLink).toHaveAttribute("href", `/agents/${AGENT_ID}/chat`);
  click(chatLink);

  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
  });
});

test("Mark all current-agent chats read from the chat-list menu", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Existing conversation"),
    createThread(INCIDENT_THREAD_ID, "Unread conversation"),
  ]);

  let hasUnread = true;
  const markedAgentIds: string[] = [];
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: hasUnread ? { [AGENT_ID]: "unread" } : {},
      threads: hasUnread ? { [INCIDENT_THREAD_ID]: "unread" } : {},
      unreadAt: hasUnread
        ? { [INCIDENT_THREAD_ID]: "2026-03-10T00:05:00Z" }
        : {},
    });
  });
  context.mocks.api(
    chatThreadMarkAgentReadContract.markAgentRead,
    ({ body, respond }) => {
      markedAgentIds.push(body.agentId);
      hasUnread = false;
      // More cursors moved than one payload carries, so the server publishes an
      // agent-scoped invalidation with no ids. Authoritative indicators still
      // have to reload from it: this list never depends on the id array.
      changeChatThreadReadCursor({
        agentId: AGENT_ID,
        threadIds: [],
        scope: "agent",
      });
      return respond(204);
    },
  );

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const list = await screen.findByTestId("chat-list-column");
  await waitFor(() => {
    expect(within(list).getByText("Unread conversation")).toBeInTheDocument();
    expect(threadLinkByTitle("Unread conversation", list)).toHaveAccessibleName(
      "Unread conversation Unread",
    );
  });

  click(within(list).getByLabelText("Open chat list menu"));
  await waitFor(() => {
    expect(
      queryAllByRoleFast("menuitem").map((item) => {
        return item.textContent?.replace(/\s+/g, " ").trim();
      }),
    ).toStrictEqual([
      "Mark all read",
      "All chats",
      expect.stringMatching(/^Unread/u),
    ]);
  });
  const menuWithMarkAllRead =
    document.querySelector<HTMLElement>('[role="menu"]');
  if (!menuWithMarkAllRead) {
    throw new Error("Open chat list menu not found");
  }
  expect(
    menuWithMarkAllRead.querySelectorAll('[role="separator"]'),
  ).toHaveLength(1);
  click(menuItemByText("Unread"));
  await waitFor(() => {
    expect(
      visibleThreadTitles(["Existing conversation", "Unread conversation"]),
    ).toStrictEqual(["Unread conversation"]);
  });
  click(within(list).getByLabelText("Open chat list menu"));
  click(menuItemByText("Mark all read"));

  await within(list).findByText("No unread chats");
  await waitFor(() => {
    expect(markedAgentIds).toStrictEqual([AGENT_ID]);
    expect(
      within(list).queryByText("Unread conversation"),
    ).not.toBeInTheDocument();
  });

  click(within(list).getByLabelText("Open chat list menu"));
  await waitFor(() => {
    expect(queryMenuItemByText("Mark all read")).not.toBeInTheDocument();
    expect(
      queryAllByRoleFast("menuitem").map((item) => {
        return item.textContent?.replace(/\s+/g, " ").trim();
      }),
    ).toStrictEqual(["All chats", expect.stringMatching(/^Unread/u)]);
    const menuWithoutMarkAllRead =
      document.querySelector<HTMLElement>('[role="menu"]');
    if (!menuWithoutMarkAllRead) {
      throw new Error("Open chat list menu not found");
    }
    expect(
      menuWithoutMarkAllRead.querySelectorAll('[role="separator"]'),
    ).toHaveLength(0);
  });
});

test("Mark all of an agent’s chats read", async () => {
  mockMobileLayout();
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID],
  });

  let unreadAgentIds = [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID];
  const markedAgentIds: string[] = [];
  mockUnreadAgents(() => {
    return unreadAgentIds;
  });
  context.mocks.api(
    chatThreadMarkAgentReadContract.markAgentRead,
    ({ body, respond }) => {
      markedAgentIds.push(body.agentId);
      unreadAgentIds = unreadAgentIds.filter((id) => {
        return id !== body.agentId;
      });
      changeChatThreadReadCursor();
      return respond(204);
    },
  );

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const nav = await waitFor(() => {
    const current = mobileSidebar();
    expect(within(current).getByText("Research Agent")).toBeInTheDocument();
    return current;
  });
  const researchSidebarRow = agentRowByName(nav, "Research Agent");
  // Unpinned agents appear after the Worker finishes loading unread indicators,
  // independently of the pinned-agent list above.
  const supportSidebarRow = await waitFor(() => {
    return agentRowByName(nav, "Support Agent");
  });
  await waitFor(() => {
    expect(
      within(researchSidebarRow).getByLabelText("Unread"),
    ).toBeInTheDocument();
    expect(
      within(supportSidebarRow).getByLabelText("Unread"),
    ).toBeInTheDocument();
  });

  click(within(researchSidebarRow).getByLabelText("Open agent menu"));
  click(menuItemByText("Mark all read"));

  await waitFor(() => {
    expect(markedAgentIds).toStrictEqual([RESEARCH_AGENT_ID]);
    expect(
      within(researchSidebarRow).queryByLabelText("Unread"),
    ).not.toBeInTheDocument();
    expect(
      within(supportSidebarRow).getByLabelText("Unread"),
    ).toBeInTheDocument();
  });

  click(within(researchSidebarRow).getByLabelText("Open agent menu"));
  expect(queryMenuItemByText("Mark all read")).not.toBeInTheDocument();
  expect(menuItemByText("Unpin")).toBeInTheDocument();
});

async function setupReadUnreadSidebar() {
  prepareDefaultAgent();
  const unreadSnapshotRefreshed = context.mocks.deferred<void>();
  const unreadThreadIds = new Set<string>();
  const unreadAt = "2026-03-10T00:05:00Z";
  const serverUnreads = () => {
    return [...unreadThreadIds].map((threadId) => {
      return { threadId, unreadAt };
    });
  };
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Incident notes"),
  ]);
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    const unreads = serverUnreads();
    if (
      unreadThreadIds.has(EXISTING_THREAD_ID) &&
      !unreadSnapshotRefreshed.settled()
    ) {
      unreadSnapshotRefreshed.resolve();
    }
    return respond(200, {
      agents: unreads.length > 0 ? { [AGENT_ID]: "unread" } : {},
      threads: Object.fromEntries(
        unreads.map(({ threadId }) => {
          return [threadId, "unread" as const];
        }),
      ),
      unreadAt: Object.fromEntries(
        unreads.map(({ threadId, unreadAt }) => {
          return [threadId, unreadAt];
        }),
      ),
    });
  });
  context.mocks.api(
    chatThreadMarkUnreadContract.markUnread,
    ({ params, respond }) => {
      unreadThreadIds.add(params.id);
      changeChatThreadReadCursor({
        threadId: params.id,
        agentId: AGENT_ID,
        lastReadAt: null,
      });
      return respond(200, {
        lastReadAt: null,
        unreads: serverUnreads(),
      });
    },
  );
  context.mocks.api(
    chatThreadMarkReadContract.markRead,
    ({ params, respond }) => {
      unreadThreadIds.delete(params.id);
      return respond(200, {
        lastReadAt: "2026-03-10T00:05:00Z",
        unreads: serverUnreads(),
      });
    },
  );
  context.mocks.api(
    chatThreadEventsContract.rows,
    ({ params, query, respond }) => {
      return respond(
        200,
        chatEventRowsResponse(
          mockChatEventRows(
            params.threadId === EXISTING_THREAD_ID
              ? [
                  {
                    id: "release-message-1",
                    threadId: EXISTING_THREAD_ID,
                    eventType: "run.completed" as const,
                    runId: "mock-run",
                    content: null,
                    runLifecycleEvent: "completed" as const,
                    seqId: 1,
                    createdAt: "2026-03-10T00:05:00Z",
                  },
                ]
              : [],
          ).filter((row) => {
            return row.seqId > query.sinceSeqId;
          }),
          query,
        ),
      );
    },
  );
  await setupSidebarPage({ context, path: `/chats/${EXISTING_THREAD_ID}` });
  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
  });
  return { unreadSnapshotRefreshed };
}

async function markReleasePlanUnread(
  scenario: Awaited<ReturnType<typeof setupReadUnreadSidebar>>,
) {
  openThreadMenu("Release plan");
  click(menuItemByText("Mark unread"));
  await scenario.unreadSnapshotRefreshed.promise;
  expect(threadLinkByTitle("Release plan")).toHaveAccessibleName(
    "Release plan",
  );
  click(threadLinkByTitle("Incident notes"));
  await waitFor(() => {
    expect(threadLinkByTitle("Release plan")).toHaveAccessibleName(
      "Release plan Unread",
    );
  });
}

test("Mark the current conversation unread after navigating away", async () => {
  const scenario = await setupReadUnreadSidebar();
  await markReleasePlanUnread(scenario);
  expect(threadLinkByTitle("Release plan")).toHaveAccessibleName(
    "Release plan Unread",
  );
});

test("An open native-only thread reads each newer delivery without a terminal Run", async () => {
  const firstAt = "2026-03-10T00:04:00Z";
  const secondAt = "2026-03-10T00:05:00Z";
  const thirdAt = "2026-03-10T00:06:00Z";
  mockNow(Date.parse("2026-03-10T00:04:30Z"), context.signal);
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Native brief"),
    createThread(INCIDENT_THREAD_ID, "Other conversation"),
  ]);

  const rows = mockChatEventRows([
    {
      id: "native-brief-1",
      threadId: EXISTING_THREAD_ID,
      eventType: "output.message" as const,
      content: "First native brief",
      seqId: 1,
      createdAt: firstAt,
    },
  ]);
  let unreadAt: string | null = firstAt;
  let historyRequests = 0;
  let unreadRequests = 0;
  const markedThrough: string[] = [];
  const secondMarkStarted = context.mocks.deferred<void>();
  const releaseSecondMark = context.mocks.deferred<void>();

  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    unreadRequests += 1;
    return respond(200, {
      agents: unreadAt === null ? {} : { [AGENT_ID]: "unread" },
      threads: unreadAt === null ? {} : { [EXISTING_THREAD_ID]: "unread" },
      unreadAt: unreadAt === null ? {} : { [EXISTING_THREAD_ID]: unreadAt },
    });
  });
  context.mocks.api(
    chatThreadEventsContract.rows,
    ({ params, query, respond }) => {
      historyRequests += 1;
      return respond(
        200,
        chatEventRowsResponse(
          rows.filter((row) => {
            return (
              row.chatThreadId === params.threadId &&
              row.seqId > query.sinceSeqId
            );
          }),
          query,
        ),
      );
    },
  );
  context.mocks.api(
    chatThreadMarkReadContract.markRead,
    async ({ params, respond }) => {
      expect(params.id).toBe(EXISTING_THREAD_ID);
      expect(historyRequests).toBeGreaterThan(0);
      const target = unreadAt;
      if (target === null) {
        throw new Error("mark-read started without a server unread");
      }
      markedThrough.push(target);
      unreadAt = null;
      if (target === secondAt) {
        secondMarkStarted.resolve();
        await releaseSecondMark.promise;
      }
      // This response snapshot is intentionally stale when the third delivery
      // arrives while the second request is in flight.
      return respond(200, { lastReadAt: target, unreads: [] });
    },
  );

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });
  await expect(screen.findByText("First native brief")).resolves.toBeVisible();
  await waitFor(() => {
    expect(markedThrough).toStrictEqual([firstAt]);
  });

  mockNow(Date.parse("2026-03-10T00:05:30Z"), context.signal);
  unreadAt = secondAt;
  rows.push(
    ...mockChatEventRows([
      {
        id: "native-brief-2",
        threadId: EXISTING_THREAD_ID,
        eventType: "output.message" as const,
        content: "Second native brief",
        seqId: 2,
        createdAt: secondAt,
      },
    ]),
  );
  createChatEvent(EXISTING_THREAD_ID);
  await expect
    .poll(() => {
      return {
        historyRequests,
        unreadRequests,
        markedThrough: [...markedThrough],
        secondMarkStarted: secondMarkStarted.settled(),
      };
    })
    .toMatchObject({
      markedThrough: [firstAt, secondAt],
      secondMarkStarted: true,
    });
  await expect(screen.findByText("Second native brief")).resolves.toBeVisible();

  unreadAt = thirdAt;
  rows.push(
    ...mockChatEventRows([
      {
        id: "native-brief-3",
        threadId: EXISTING_THREAD_ID,
        eventType: "output.message" as const,
        content: "Third native brief",
        seqId: 3,
        createdAt: thirdAt,
      },
    ]),
  );
  createChatEvent(EXISTING_THREAD_ID);
  releaseSecondMark.resolve();

  await expect(screen.findByText("Third native brief")).resolves.toBeVisible();
  await waitFor(() => {
    expect(markedThrough).toStrictEqual([firstAt, secondAt, thirdAt]);
    expect(unreadRequests).toBeGreaterThanOrEqual(3);
  });
  expect(
    rows.map((row) => {
      return [row.eventType, row.runId];
    }),
  ).toStrictEqual([
    ["output.message", null],
    ["output.message", null],
    ["output.message", null],
  ]);

  click(threadLinkByTitle("Other conversation"));
  await waitFor(() => {
    expect(threadLinkByTitle("Native brief")).toHaveAccessibleName(
      "Native brief",
    );
  });
});
