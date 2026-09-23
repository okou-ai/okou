import {
  AGENT_ID,
  agentRowByName,
  ARCHIVED_THREAD_ID,
  AUTOMATION_THREAD_ID,
  buttonByText,
  commandItemByText,
  context,
  createDataTransferStub,
  createThread,
  dialogAgentOrder,
  EXISTING_THREAD_ID,
  INCIDENT_THREAD_ID,
  LAYERED_AVATAR_URL,
  menuItemByText,
  mobileSidebar,
  mockChatThreadSnapshot,
  mockMobileLayout,
  mockSidebarThreadStory,
  mockUnreadAgents,
  mountedComposer,
  openThreadMenu,
  pinnedAgentLink,
  pinnedAgentNames,
  prepareAgents,
  prepareDefaultAgent,
  prepareOverflowingPinnedAgents,
  RESEARCH_AGENT_ID,
  RESEARCH_THREAD_ID,
  renderTailwindUtilities,
  setupSidebarPage,
  sidebar,
  SUPPORT_AGENT_ID,
  threadLinkByTitle,
  threadRowByTitle,
} from "./sidebar-test-helpers.tsx";

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { DEFAULT_AGENT_AVATAR_URL } from "@okouai/core/agent-avatar";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  fill,
  holdElementAnimations,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";
import {
  changeChatThreadList,
  changeChatThreadReadCursor,
} from "../../../mocks/mock-helpers.ts";

test("Move to the next relevant agent with a shortcut", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID],
  });
  mockSidebarThreadStory([
    createThread(INCIDENT_THREAD_ID, "Support escalation", {
      agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
    }),
  ]);
  mockUnreadAgents(() => {
    return [SUPPORT_AGENT_ID];
  });

  await setupSidebarPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}/chat`,
  });

  const nav = await waitFor(() => {
    const current = sidebar();
    expect(within(current).getByText("Support Agent")).toBeInTheDocument();
    return current;
  });
  expect(
    within(agentRowByName(nav, "Support Agent")).getByLabelText("Unread"),
  ).toBeInTheDocument();

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
  });
});

test("Navigate pinned agents from the mobile sidebar", async () => {
  mockMobileLayout();
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID],
  });
  context.mocks.browser.open();

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  await waitFor(() => {
    expect(
      pinnedAgentLink(mobileSidebar(), "Research Agent"),
    ).toBeInTheDocument();
  });

  click(screen.getByLabelText("Open menu"));
  await waitFor(() => {
    expect(mobileSidebar()).toHaveAttribute("data-sidebar-expanded", "true");
  });

  const researchLink = pinnedAgentLink(mobileSidebar(), "Research Agent");
  expect(researchLink).toHaveAttribute(
    "href",
    `/agents/${RESEARCH_AGENT_ID}/chat`,
  );
  fireEvent.click(researchLink, { metaKey: true });
  expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
  expect(mobileSidebar()).toHaveAttribute("data-sidebar-expanded", "true");

  click(pinnedAgentLink(mobileSidebar(), "Nova"));
  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    expect(mobileSidebar()).not.toHaveAttribute("data-sidebar-expanded");
  });

  click(screen.getByLabelText("Open menu"));
  await waitFor(() => {
    expect(mobileSidebar()).toHaveAttribute("data-sidebar-expanded", "true");
  });

  click(pinnedAgentLink(mobileSidebar(), "Research Agent"));
  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${RESEARCH_AGENT_ID}/chat`);
    expect(mobileSidebar()).not.toHaveAttribute("data-sidebar-expanded");
  });
});

test("The mobile chat-list menu closes on Escape and returns focus before the sidebar collapses", async () => {
  const user = userEvent.setup({ delay: null });
  mockMobileLayout();
  prepareDefaultAgent();

  await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

  const openMenu = screen.getByLabelText("Open menu");
  click(openMenu);
  await waitFor(() => {
    expect(mobileSidebar()).toHaveAttribute("data-sidebar-expanded", "true");
  });

  const menuTrigger = within(mobileSidebar()).getByLabelText(
    "Open chat list menu",
  );
  await user.click(menuTrigger);
  expect(await screen.findByRole("menu")).toBeInTheDocument();

  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(menuTrigger).toHaveFocus();
  });

  click(within(mobileSidebar()).getByLabelText("Collapse sidebar"));
  await waitFor(() => {
    expect(mobileSidebar()).not.toHaveAttribute("data-sidebar-expanded");
  });
  click(openMenu);
  await waitFor(() => {
    expect(mobileSidebar()).toHaveAttribute("data-sidebar-expanded", "true");
  });
});

test.each([
  { name: "Agents", route: "/agents" },
  { name: "Works", route: "/works" },
])(
  "Mobile $name navigation closes the drawer on primary activation",
  async ({ name, route }) => {
    mockMobileLayout();
    prepareDefaultAgent();
    context.mocks.browser.open();
    await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });
    click(screen.getByLabelText("Open menu"));
    await waitFor(() => {
      expect(mobileSidebar()).toHaveAttribute("data-sidebar-expanded", "true");
    });
    const link = queryAllByRoleFast("link", mobileSidebar()).find(
      (candidate) => {
        return candidate.getAttribute("href") === route;
      },
    );
    if (!link) {
      throw new Error(`Expected the ${name} sidebar link`);
    }

    fireEvent.click(link, { altKey: true });
    expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    expect(mobileSidebar()).toHaveAttribute("data-sidebar-expanded", "true");

    click(link);
    await waitFor(() => {
      expect(pathname()).toBe(route);
      expect(mobileSidebar()).not.toHaveAttribute("data-sidebar-expanded");
    });
  },
);

test("Open and use workspace search with the keyboard", async () => {
  prepareAgents();
  mockSidebarThreadStory([
    createThread(INCIDENT_THREAD_ID, "Support escalation", {
      agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
    }),
  ]);

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

  await fill(search, "support");

  await waitFor(() => {
    expect(within(dialog).getByText("Support escalation")).toBeInTheDocument();
  });

  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "Enter" });

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", {
        name: "Search workspace...",
      }),
    ).not.toBeInTheDocument();
    expect(document.title).toBe("Support escalation | Okou");
  });
});

test("Show current shortcuts without stacking help over workspace search", async () => {
  prepareAgents();

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  await waitFor(() => {
    expect(sidebar()).toBeInTheDocument();
  });

  fireEvent.keyDown(document.body, { key: "?", shiftKey: true });

  const shortcutDialog = await screen.findByRole("dialog", {
    name: "Keyboard Shortcuts",
  });
  expect(
    within(shortcutDialog).getByText("Show shortcuts"),
  ).toBeInTheDocument();
  expect(within(shortcutDialog).getByText("Search workspace")).toBeVisible();
  expect(within(shortcutDialog).getByText("Voice input")).toBeVisible();
  click(within(shortcutDialog).getByLabelText("Close keyboard shortcuts"));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Keyboard Shortcuts" }),
    ).not.toBeInTheDocument();
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

  fireEvent.keyDown(document.body, { key: "?", shiftKey: true });

  expect(
    screen.queryByRole("dialog", { name: "Keyboard Shortcuts" }),
  ).not.toBeInTheDocument();
  expect(screen.getAllByRole("dialog")).toStrictEqual([dialog]);
});

test("Open workspace search once from a focused composer shortcut", async () => {
  prepareAgents();

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  await screen.findByPlaceholderText(PLACEHOLDER);
  const composer = mountedComposer();
  composer.focus();
  const repeatedEvent = new KeyboardEvent("keydown", {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
    repeat: true,
    bubbles: true,
    cancelable: true,
  });
  composer.dispatchEvent(repeatedEvent);

  expect(repeatedEvent.defaultPrevented).toBeFalsy();
  expect(
    screen.queryByRole("dialog", {
      name: "Search workspace...",
    }),
  ).not.toBeInTheDocument();

  const event = new KeyboardEvent("keydown", {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  composer.dispatchEvent(event);

  expect(event.defaultPrevented).toBeTruthy();
  const dialog = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });
  expect(dialog).toBeInTheDocument();
});

test("Open workspace search from a mobile viewport", async () => {
  mockMobileLayout();
  prepareAgents();

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  await waitFor(() => {
    expect(mobileSidebar()).toBeInTheDocument();
  });
  expect(screen.queryByTestId("chat-list-column")).not.toBeInTheDocument();

  fireEvent.keyDown(document.body, {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
  });

  const dialog = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });
  expect(dialog).toBeInTheDocument();
});

test("Pin and unpin agents without closing the pin manager", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({ pinnedAgentIds: [RESEARCH_AGENT_ID] });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const grid = await screen.findByTestId("pinned-agents-grid");
  await waitFor(() => {
    expect(within(grid).getAllByTestId("pinned-agent-card")).toHaveLength(2);
  });

  click(screen.getByLabelText("Pin an agent"));

  const dialogList = await screen.findByTestId("pin-agent-dialog-list");
  click(
    within(commandItemByText(dialogList, "Support Agent")).getByText("Pin"),
  );

  await waitFor(() => {
    expect(pinnedAgentNames(grid)).toStrictEqual([
      "Nova",
      "Research Agent",
      "Support Agent",
    ]);
  });
  expect(dialogList).toBeInTheDocument();
  await expect(
    screen.findByText("Support Agent pinned"),
  ).resolves.toBeInTheDocument();

  click(
    within(commandItemByText(dialogList, "Support Agent")).getByText("Unpin"),
  );

  await waitFor(() => {
    expect(pinnedAgentNames(grid)).toStrictEqual(["Nova", "Research Agent"]);
  });
  expect(dialogList).toBeInTheDocument();
  expect(
    within(commandItemByText(dialogList, "Support Agent")).getByText("Pin"),
  ).toBeInTheDocument();
  await expect(
    screen.findByText("Support Agent unpinned"),
  ).resolves.toBeInTheDocument();
});

test("Show pinned agents before unread indicators finish loading", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID],
  });
  const indicatorRequestStarted = context.mocks.deferred<void>();
  const releaseIndicators = context.mocks.deferred<void>();
  context.mocks.api(chatThreadsContract.indicators, async ({ respond }) => {
    if (!indicatorRequestStarted.settled()) {
      indicatorRequestStarted.resolve(undefined);
    }
    await releaseIndicators.promise;
    return respond(200, {
      agents: { [SUPPORT_AGENT_ID]: "unread" },
      threads: {},
      unreadAt: {},
    });
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });
  await indicatorRequestStarted.promise;

  const grid = await screen.findByTestId("pinned-agents-grid");
  await waitFor(() => {
    expect(pinnedAgentNames(grid)).toStrictEqual(["Nova", "Research Agent"]);
  });

  releaseIndicators.resolve(undefined);
  await waitFor(() => {
    expect(pinnedAgentNames(grid)).toStrictEqual([
      "Nova",
      "Research Agent",
      "Support Agent",
    ]);
  });
});

test("Preserve the user’s pinned-agent order", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [SUPPORT_AGENT_ID, RESEARCH_AGENT_ID],
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const grid = await screen.findByTestId("pinned-agents-grid");
  await waitFor(() => {
    expect(pinnedAgentNames(grid)).toStrictEqual([
      "Nova",
      "Support Agent",
      "Research Agent",
    ]);
  });

  click(screen.getByLabelText("Pin an agent"));

  const dialogList = await screen.findByTestId("pin-agent-dialog-list");
  expect(
    dialogAgentOrder(dialogList, ["Research Agent", "Support Agent"]),
  ).toStrictEqual(["Support Agent", "Research Agent"]);
});

test("Highlight the current thread’s agent in the pinned grid", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID],
  });
  mockSidebarThreadStory([
    createThread(RESEARCH_THREAD_ID, "Research kickoff", {
      agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
    }),
  ]);

  await setupSidebarPage({
    context,
    path: `/chats/${RESEARCH_THREAD_ID}`,
  });

  const grid = await screen.findByTestId("pinned-agents-grid");
  await waitFor(() => {
    expect(pinnedAgentLink(grid, "Research Agent")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  expect(pinnedAgentLink(grid, "Nova")).not.toHaveAttribute("aria-current");
});

test("Recognize and pin sidebar conversation states", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory(
    [
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(INCIDENT_THREAD_ID, "Incident notes"),
      createThread(AUTOMATION_THREAD_ID, "Running analysis"),
      createThread(ARCHIVED_THREAD_ID, "Draft brief"),
    ],
    [],
    [AUTOMATION_THREAD_ID],
  );
  context.mocks.api(chatThreadsContract.drafts, ({ respond }) => {
    return respond(200, { draftThreadIds: [ARCHIVED_THREAD_ID] });
  });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: { [AGENT_ID]: "unread" },
      threads: {
        [INCIDENT_THREAD_ID]: "unread",
        [AUTOMATION_THREAD_ID]: "active",
      },
      unreadAt: { [INCIDENT_THREAD_ID]: "2026-03-10T00:05:00Z" },
    });
  });

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
    expect(threadLinkByTitle("Incident notes")).toHaveAccessibleName(
      "Incident notes Unread",
    );
    expect(threadLinkByTitle("Running analysis")).toHaveAccessibleName(
      "Running analysis Running",
    );
    expect(threadLinkByTitle("Draft brief")).toHaveAccessibleName(
      "Draft brief Draft",
    );
  });
  expect(threadLinkByTitle("Release plan")).toHaveAccessibleName(
    "Release plan",
  );

  // Touch rows never hover, so the state indicator has to be the menu trigger
  // itself; otherwise running, unread, and draft chats lose every row action.
  for (const title of [
    "Incident notes",
    "Running analysis",
    "Draft brief",
  ] as const) {
    const row = threadRowByTitle(title);
    const menu = within(row).getByTestId("chat-thread-menu-trigger");
    const indicator = within(menu).getByTestId("chat-thread-state-indicator");
    expect(indicator).toHaveAttribute("aria-hidden", "true");
    expect(menu).toHaveAccessibleName("Open chat menu");
  }

  openThreadMenu("Release plan");
  const pinItem = menuItemByText("Pin chat");
  expect(pinItem).toHaveTextContent("Ctrl+Shift+D");
  expect(pinItem).toHaveAttribute(
    "aria-keyshortcuts",
    "Meta+Shift+D Control+Shift+D",
  );
  click(pinItem);

  await waitFor(() => {
    expect(threadLinkByTitle("Release plan")).toHaveAccessibleName(
      "Release plan Pinned",
    );
    expect(
      within(threadRowByTitle("Release plan")).getByTestId(
        "chat-thread-pinned-indicator",
      ),
    ).toBeInTheDocument();
  });

  click(
    within(threadRowByTitle("Release plan")).getByTestId(
      "chat-thread-pinned-indicator",
    ),
  );
  const unpinItem = menuItemByText("Unpin chat");
  expect(unpinItem).toHaveTextContent("Ctrl+Shift+D");
  click(unpinItem);

  await waitFor(() => {
    expect(threadLinkByTitle("Release plan")).toHaveAccessibleName(
      "Release plan",
    );
    expect(
      within(threadRowByTitle("Release plan")).queryByTestId(
        "chat-thread-pinned-indicator",
      ),
    ).not.toBeInTheDocument();
  });

  openThreadMenu("Running analysis");
  const renameItem = menuItemByText("Rename chat");
  expect(renameItem).toHaveTextContent("F2");
  expect(renameItem).toHaveAttribute("aria-keyshortcuts", "F2");
  expect(menuItemByText("Delete chat")).toBeInTheDocument();
});

test("Expose localized conversation states in sidebar and workspace search", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory(
    [
      createThread(EXISTING_THREAD_ID, "发布计划", {
        pinnedAt: "2026-03-10T12:00:00Z",
      }),
      createThread(INCIDENT_THREAD_ID, "故障记录"),
      createThread(AUTOMATION_THREAD_ID, "竞品分析"),
      createThread(ARCHIVED_THREAD_ID, "方案草稿"),
    ],
    [],
    [AUTOMATION_THREAD_ID],
  );
  context.mocks.api(chatThreadsContract.drafts, ({ respond }) => {
    return respond(200, { draftThreadIds: [ARCHIVED_THREAD_ID] });
  });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: {},
      threads: {
        [INCIDENT_THREAD_ID]: "unread",
        [AUTOMATION_THREAD_ID]: "active",
      },
      unreadAt: { [INCIDENT_THREAD_ID]: "2026-03-10T00:05:00Z" },
    });
  });
  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    locale: "zh-Hans",
  });

  await waitFor(() => {
    expect(threadLinkByTitle("竞品分析")).toHaveAccessibleName(
      "竞品分析 运行中",
    );
    expect(threadLinkByTitle("故障记录")).toHaveAccessibleName("故障记录 未读");
    expect(threadLinkByTitle("方案草稿")).toHaveAccessibleName("方案草稿 草稿");
    expect(threadLinkByTitle("发布计划")).toHaveAccessibleName(
      "发布计划 已置顶",
    );
  });
  expect(
    within(threadRowByTitle("竞品分析")).getByTestId(
      "chat-thread-menu-trigger",
    ),
  ).toHaveAccessibleName("打开聊天菜单");

  fireEvent.keyDown(document.body, {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
  });
  const dialog = await screen.findByRole("dialog", { name: "搜索工作区…" });
  const search = within(dialog).getByRole("combobox");
  await fill(search, "竞品");
  await expect(
    within(dialog).findByRole("option", { name: /^竞品分析 运行中 /u }),
  ).resolves.toBeInTheDocument();

  await fill(search, "故障");
  await expect(
    within(dialog).findByRole("option", { name: /^故障记录 未读 /u }),
  ).resolves.toBeInTheDocument();
});

test.each(["agent", "thread"] as const)(
  "Refresh the %s unread indicator",
  async (indicator) => {
    mockMobileLayout();
    // Both consumers observe Nova and its thread; unrelated agents add no coverage.
    context.mocks.data.agents(
      prepareAgents().filter((agent) => {
        return agent.agentId === AGENT_ID;
      }),
    );
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Remote unread conversation"),
    ]);
    let hasUnread = false;
    context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
      return respond(200, {
        agents: hasUnread ? { [AGENT_ID]: "unread" } : {},
        threads: hasUnread ? { [EXISTING_THREAD_ID]: "unread" } : {},
        unreadAt: hasUnread
          ? { [EXISTING_THREAD_ID]: "2026-03-10T00:05:00Z" }
          : {},
      });
    });

    await setupSidebarPage({
      context,
      path: "/agents",
      sharedWorkerTestTransport: "message-port",
    });

    await waitFor(() => {
      const current = mobileSidebar();
      expect(within(current).getByText("Nova")).toBeInTheDocument();
    });
    // Both indicator consumers must finish loading before the external refresh.
    await waitFor(() => {
      expect(
        threadRowByTitle("Remote unread conversation", mobileSidebar()),
      ).toBeInTheDocument();
    });
    const indicatorRow = () => {
      return indicator === "agent"
        ? agentRowByName(mobileSidebar(), "Nova")
        : threadRowByTitle("Remote unread conversation", mobileSidebar());
    };
    const unreadIndicator = () => {
      return indicator === "agent"
        ? within(indicatorRow()).queryByLabelText("Unread")
        : within(indicatorRow()).queryByText("Unread");
    };
    await waitFor(() => {
      expect(unreadIndicator()).toBeNull();
    });

    hasUnread = true;
    changeChatThreadList();

    await waitFor(() => {
      expect(unreadIndicator()).toBeInTheDocument();
    });
  },
);

test.each(["thread list", "read cursor"] as const)(
  "Refresh the running indicator after a %s change without warming chats",
  async (notification) => {
    mockMobileLayout();
    prepareDefaultAgent();
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Remote running conversation"),
    ]);
    let running = false;
    context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
      return respond(200, {
        agents: {},
        threads: { [EXISTING_THREAD_ID]: running ? "active" : "unread" },
        unreadAt: running
          ? {}
          : { [EXISTING_THREAD_ID]: "2026-03-10T00:05:00Z" },
      });
    });

    await setupSidebarPage({
      context,
      path: "/agents",
      sharedWorkerTestTransport: "message-port",
    });
    const threadLink = () => {
      return threadLinkByTitle("Remote running conversation", mobileSidebar());
    };
    await waitFor(() => {
      expect(threadLink()).toHaveAccessibleName(
        "Remote running conversation Unread",
      );
    });

    const changeIndicator = () => {
      if (notification === "thread list") {
        changeChatThreadList();
      } else {
        changeChatThreadReadCursor({
          threadId: EXISTING_THREAD_ID,
          lastReadAt: null,
        });
      }
    };
    running = true;
    changeIndicator();
    await waitFor(() => {
      expect(threadLink()).toHaveAccessibleName(
        "Remote running conversation Running",
      );
    });

    running = false;
    changeIndicator();
    await waitFor(() => {
      expect(threadLink()).toHaveAccessibleName(
        "Remote running conversation Unread",
      );
    });
  },
);

test("Rename a conversation from the sidebar", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Incident notes"),
  ]);

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
  });

  openThreadMenu("Release plan");
  click(menuItemByText("Rename chat"));

  const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
  const titleInput = within(dialog).getByPlaceholderText("Chat title");
  expect(titleInput).toHaveValue("Release plan");
  await fill(titleInput, "Launch plan");
  click(buttonByText("Rename", dialog));

  await waitFor(() => {
    expect(within(sidebar()).getByText("Launch plan")).toBeInTheDocument();
    expect(
      within(sidebar()).queryByText("Release plan"),
    ).not.toBeInTheDocument();
  });

  openThreadMenu("Incident notes");
  click(menuItemByText("Rename chat"));

  const draftDialog = await screen.findByRole("dialog", {
    name: "Rename chat",
  });
  const draftInput = within(draftDialog).getByPlaceholderText("Chat title");
  expect(draftInput).toHaveValue("Incident notes");
  await fill(draftInput, "Unsaved title");
  const finishCloseAnimation = holdElementAnimations(draftDialog);
  click(buttonByText("Cancel", draftDialog));

  expect(draftInput).toBeInTheDocument();
  expect(draftInput).toBeVisible();
  expect(draftInput).toHaveValue("Unsaved title");

  finishCloseAnimation();

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Rename chat" }),
    ).not.toBeInTheDocument();
  });

  openThreadMenu("Incident notes");
  click(menuItemByText("Rename chat"));

  const reopenedDialog = await screen.findByRole("dialog", {
    name: "Rename chat",
  });
  expect(within(reopenedDialog).getByPlaceholderText("Chat title")).toHaveValue(
    "Incident notes",
  );
});

test("Reorder pinned agents while keeping Nova first", async () => {
  const pinnedAgentIds = prepareOverflowingPinnedAgents();
  context.mocks.data.userPreferences({ pinnedAgentIds });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const grid = await screen.findByTestId("pinned-agents-grid");
  await waitFor(() => {
    expect(within(grid).getAllByTestId("pinned-agent-card")).toHaveLength(6);
  });
  expect(pinnedAgentNames(grid)).toStrictEqual([
    "Nova",
    "Research Agent",
    "Support Agent",
    "Operations Agent",
    "Analytics Agent",
    "Billing Agent",
  ]);

  const dragged = pinnedAgentLink(grid, "Support Agent");
  const target = pinnedAgentLink(grid, "Billing Agent");
  const dataTransfer = createDataTransferStub({
    "text/uri-list": dragged.href,
    "text/plain": dragged.href,
  });
  fireEvent.dragStart(dragged, { dataTransfer });
  expect(dataTransfer.getData("text/uri-list")).toBe("");
  expect(dataTransfer.getData("text/plain")).toBe("");
  expect(dataTransfer.getData("application/x-okou-pinned-agent")).toBe(
    SUPPORT_AGENT_ID,
  );
  fireEvent.dragOver(target, { dataTransfer });
  await waitFor(() => {
    expect(
      within(target).getByTestId("pinned-agent-drop-caret"),
    ).toBeInTheDocument();
  });
  expect(
    within(target).getByTestId("pinned-agent-drop-caret").className,
  ).toContain("-right-");
  fireEvent.drop(target, { dataTransfer });

  await waitFor(() => {
    expect(pinnedAgentNames(grid)).toStrictEqual([
      "Nova",
      "Research Agent",
      "Operations Agent",
      "Analytics Agent",
      "Billing Agent",
      "Support Agent",
    ]);
  });

  const orderAfterReorder = pinnedAgentNames(grid);
  const lead = pinnedAgentLink(grid, "Nova");
  const leadDropTransfer = createDataTransferStub();
  fireEvent.dragStart(pinnedAgentLink(grid, "Research Agent"), {
    dataTransfer: leadDropTransfer,
  });
  expect(
    fireEvent.dragOver(lead, { dataTransfer: leadDropTransfer }),
  ).toBeFalsy();
  expect(fireEvent.drop(lead, { dataTransfer: leadDropTransfer })).toBeFalsy();
  fireEvent.dragEnd(pinnedAgentLink(grid, "Research Agent"), {
    dataTransfer: leadDropTransfer,
  });
  expect(pinnedAgentNames(grid)).toStrictEqual(orderAfterReorder);
  expect(pinnedAgentLink(grid, "Nova")).toBeInTheDocument();
});

test("Keep the default Okou sweater outside a circular mask", async () => {
  prepareDefaultAgent(context, DEFAULT_AGENT_AVATAR_URL);

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const grid = await screen.findByTestId("pinned-agents-grid");
  const avatar = grid.querySelector(`img[src="${DEFAULT_AGENT_AVATAR_URL}"]`);
  if (!(avatar instanceof HTMLImageElement)) {
    throw new Error("Default Okou avatar not found");
  }
  await renderTailwindUtilities(context.signal, avatar);
  expect(getComputedStyle(avatar).borderRadius).toBe("");
});

test("Render the complete layered drag image with grab feedback", async () => {
  const pinnedAgentIds = prepareOverflowingPinnedAgents(
    context,
    LAYERED_AVATAR_URL,
  );
  context.mocks.data.userPreferences({ pinnedAgentIds });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.AvatarNeckSweater]: true,
    },
  });

  const grid = await screen.findByTestId("pinned-agents-grid");
  await waitFor(() => {
    expect(within(grid).getAllByTestId("pinned-agent-card")).toHaveLength(6);
  });

  const dragged = pinnedAgentLink(grid, "Support Agent");
  const avatar = dragged.querySelector('[data-slot="pinned-agent-avatar"]');
  if (!(avatar instanceof HTMLElement)) {
    throw new Error("Pinned-agent avatar not found");
  }
  const avatarLayers = avatar.querySelectorAll("img");
  const topAvatarLayer = avatarLayers.item(avatarLayers.length - 1);
  if (!(topAvatarLayer instanceof HTMLImageElement)) {
    throw new Error("Layered pinned-agent avatar not found");
  }
  await renderTailwindUtilities(context.signal, dragged, avatar);
  const dataTransfer = createDataTransferStub();

  expect(getComputedStyle(dragged).cursor).toBe("grab");

  fireEvent.dragStart(topAvatarLayer, { dataTransfer });

  expect(dataTransfer.dragImage).toStrictEqual({
    width: "36px",
    height: "36px",
    renderedImageLayerCount: avatarLayers.length,
  });
  expect(dataTransfer.dragImage?.renderedImageLayerCount).toBeGreaterThan(1);
});

test("Search, pin, and open an agent from the pin manager", async () => {
  prepareAgents();
  const researchThread = createThread(RESEARCH_THREAD_ID, "Research kickoff", {
    agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
  });

  mockChatThreadSnapshot(() => {
    return [researchThread];
  });

  await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

  const grid = await screen.findByTestId("pinned-agents-grid");
  click(screen.getByLabelText("Pin an agent"));

  const dialog = await screen.findByRole("dialog", { name: "Pin an agent" });
  expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
  expect(within(dialog).getByText("Support Agent")).toBeInTheDocument();

  await fill(
    within(dialog).getByPlaceholderText("Search agents..."),
    "support",
  );

  await waitFor(() => {
    expect(
      within(dialog).queryByText("Research Agent"),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByText("Support Agent")).toBeInTheDocument();
  });

  await fill(within(dialog).getByPlaceholderText("Search agents..."), "ops");

  await waitFor(() => {
    expect(within(dialog).getByText("No results found")).toBeInTheDocument();
    expect(within(dialog).queryByText("Support Agent")).not.toBeInTheDocument();
  });

  click(within(dialog).getByLabelText("Clear search"));

  await waitFor(() => {
    expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
  });

  const researchRow = commandItemByText(dialog, "Research Agent");
  click(researchRow);

  await waitFor(() => {
    expect(
      within(commandItemByText(dialog, "Research Agent")).getByText("Unpin"),
    ).toBeInTheDocument();
    expect(pinnedAgentNames(grid)).toContain("Research Agent");
  });

  click(within(dialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Pin an agent" }),
    ).not.toBeInTheDocument();
  });
  click(pinnedAgentLink(grid, "Research Agent"));

  await waitFor(() => {
    expect(
      within(sidebar()).getByText("Chats with Research Agent"),
    ).toBeInTheDocument();
    expect(within(sidebar()).getByText("Research kickoff")).toBeInTheDocument();
  });
});
