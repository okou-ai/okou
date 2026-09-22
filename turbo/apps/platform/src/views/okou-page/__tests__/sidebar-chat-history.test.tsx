import {
  AGENT_ID,
  agentRowByName,
  ARCHIVED_THREAD_ID,
  AUTOMATION_THREAD_ID,
  buttonByLabel,
  buttonByText,
  chatListNewChatButton,
  context,
  createThread,
  EXISTING_THREAD_ID,
  INCIDENT_THREAD_ID,
  menuItemByText,
  mobileSidebar,
  mountedComposer,
  mockChatThreadSnapshot,
  mockLongSidebarHistory,
  mockMobileLayout,
  mockSidebarThreadStory,
  mockSidebarViewport,
  mockUnreadAgents,
  openChatListMenu,
  openThreadMenu,
  pinnedAgentLink,
  prepareAgents,
  prepareDefaultAgent,
  prepareOverflowingPinnedAgents,
  queryMenuItemByText,
  queryMobileSidebar,
  RESEARCH_AGENT_ID,
  RESEARCH_THREAD_ID,
  scrollToArchivedContext,
  setupSidebarPage,
  sidebar,
  type SidebarThread,
  stubSidebarTitleLayout,
  SUPPORT_AGENT_ID,
  threadLinkByTitle,
  threadRowByTitle,
  titleFadeBox,
  visibleThreadTitles,
} from "./sidebar-test-helpers.tsx";

import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import {
  click,
  fill,
  queryAllByRoleFast,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { chatEventRowsResponse } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { CHAT_THREAD_VIRTUAL_ROW_HEIGHT } from "../../../signals/okou-page/sidebar-state.ts";
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

test("Refresh a long sidebar after deleting an offscreen chat", async () => {
  const remote = context.mocks.deferred<void>();
  const cachedChatThreadEvents = mockLongSidebarHistory(remote.promise);
  mockSidebarViewport(200, 1000);

  const page = await startPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    cachedChatThreadEvents,
  });

  // The existing-list scene must be usable before remote synchronization.
  const scrollArea = await scrollToArchivedContext();
  remote.resolve();
  await page.ready;
  openThreadMenu("Archived context");
  click(menuItemByText("Delete chat"));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete chat?",
  });
  click(buttonByText("Delete", dialog));

  // Model a browser-clamped live offset without another scroll event.
  scrollArea.scrollTop = 0;

  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    expect(
      within(sidebar()).queryByText("Archived context"),
    ).not.toBeInTheDocument();
  });
});

test("Align the current virtualized chat row with the sidebar scroll area top", async () => {
  prepareDefaultAgent();
  const leadingThreads = Array.from({ length: 24 }, (_, index) => {
    return createThread(
      `b3100000-0000-4000-a000-${String(index).padStart(12, "0")}`,
      `Leading precise chat ${index + 1}`,
    );
  });
  mockSidebarThreadStory([
    ...leadingThreads,
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(AUTOMATION_THREAD_ID, "Scheduled launch"),
  ]);

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
  });

  const scrollArea = within(sidebar()).getByTestId("sidebar-scroll-area");
  const currentRow = threadLinkByTitle("Release plan").closest(
    '[data-testid="sidebar-chat-thread-virtual-row"]',
  );
  if (!(currentRow instanceof HTMLElement)) {
    throw new Error("Release plan virtual row not found");
  }
  const currentIndex = Number(currentRow.dataset.index);

  expect(scrollArea.scrollTop).toBe(
    currentIndex * CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
  );
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

test("Filter the chat list to unread conversations", async () => {
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
    });
  });
  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    return respond(200, {
      unreads: [
        {
          threadId: AUTOMATION_THREAD_ID,
          unreadAt: "2026-03-10T00:04:00Z",
        },
        { threadId: INCIDENT_THREAD_ID, unreadAt: "2026-03-10T00:05:00Z" },
      ],
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

test("Keep unread conversations visible while remote read cursors refresh", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "New unread conversation"),
    createThread(INCIDENT_THREAD_ID, "Previously unread conversation"),
    createThread(AUTOMATION_THREAD_ID, "Read conversation"),
  ]);
  const indicatorRefreshStarted = context.mocks.deferred<void>();
  const releaseIndicatorRefresh = context.mocks.deferred<void>();
  let refreshing = false;
  let unreadThreadId = INCIDENT_THREAD_ID;
  context.mocks.api(
    chatThreadsContract.indicators,
    async ({ respond, withSignal }) => {
      if (refreshing) {
        indicatorRefreshStarted.resolve();
        await withSignal(releaseIndicatorRefresh.promise);
      }
      return respond(200, {
        agents: { [AGENT_ID]: "unread" },
        threads: { [unreadThreadId]: "unread" },
      });
    },
  );
  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    return respond(200, {
      unreads: [{ threadId: unreadThreadId, unreadAt: "2026-03-10T00:05:00Z" }],
    });
  });
  await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });
  await within(sidebar()).findByText("Read conversation");
  openChatListMenu();
  click(menuItemByText("Unread"));
  await waitFor(() => {
    expect(
      visibleThreadTitles([
        "New unread conversation",
        "Previously unread conversation",
        "Read conversation",
      ]),
    ).toStrictEqual(["Previously unread conversation"]);
  });

  unreadThreadId = EXISTING_THREAD_ID;
  refreshing = true;
  await act(async () => {
    changeChatThreadReadCursor({
      agentId: AGENT_ID,
      threadIds: [],
      scope: "agent",
    });
    await indicatorRefreshStarted.promise;
  });

  expect(
    visibleThreadTitles([
      "New unread conversation",
      "Previously unread conversation",
      "Read conversation",
    ]),
  ).toStrictEqual(["Previously unread conversation"]);
  expect(within(sidebar()).queryAllByTestId("sidebar-skeleton")).toHaveLength(
    0,
  );
  expect(
    within(sidebar()).queryByText("No unread chats"),
  ).not.toBeInTheDocument();

  releaseIndicatorRefresh.resolve();
  await within(sidebar()).findByText("New unread conversation");
  expect(
    visibleThreadTitles([
      "New unread conversation",
      "Previously unread conversation",
      "Read conversation",
    ]),
  ).toStrictEqual(["New unread conversation"]);
  expect(within(sidebar()).queryAllByTestId("sidebar-skeleton")).toHaveLength(
    0,
  );
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
    });
  });
  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    return respond(200, {
      unreads: [
        {
          threadId: INCIDENT_THREAD_ID,
          unreadAt: "2026-03-10T00:05:00Z",
        },
      ],
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
});

test("Find archived chats in All and Chats workspace search results", async () => {
  prepareDefaultAgent();
  const currentThread = createThread(EXISTING_THREAD_ID, "Release plan");
  const archivedThread = createThread(
    ARCHIVED_THREAD_ID,
    "✅ Archived context",
  );
  mockSidebarThreadStory([currentThread, archivedThread]);
  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    return respond(200, { unreads: [] });
  });

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
  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    return respond(200, {
      unreads: [
        {
          threadId: EXISTING_THREAD_ID,
          unreadAt: "2026-03-10T00:05:00Z",
        },
      ],
    });
  });

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
      within(agentRowByName(dialog, "Support escalation")).getByLabelText(
        "Running",
      ),
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

test("Hide and show the chat list without losing workspace search", async () => {
  prepareDefaultAgent();

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  await screen.findByPlaceholderText(PLACEHOLDER);
  const rail = await screen.findByTestId("labeled-nav-rail");
  const list = screen.getByTestId("chat-list-column");
  const hideButton = within(list).getByLabelText("Hide chat list");
  expect(hideButton).toHaveAttribute("aria-keyshortcuts", "Meta+B Control+B");

  click(hideButton);

  await waitFor(() => {
    expect(screen.queryByTestId("chat-list-column")).not.toBeInTheDocument();
  });
  expect(rail).toBeInTheDocument();
  const showButton = within(rail).getByLabelText("Show chat list");
  expect(showButton).toHaveAttribute("aria-keyshortcuts", "Meta+B Control+B");

  const composer = mountedComposer();
  composer.focus();
  const searchEvent = new KeyboardEvent("keydown", {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  composer.dispatchEvent(searchEvent);

  expect(searchEvent.defaultPrevented).toBeTruthy();
  const dialog = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });
  fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", {
        name: "Search workspace...",
      }),
    ).not.toBeInTheDocument();
  });

  const restoredComposer = mountedComposer();
  restoredComposer.focus();
  fireEvent.keyDown(restoredComposer, {
    key: "b",
    code: "KeyB",
    keyCode: 66,
    ctrlKey: true,
  });

  await waitFor(() => {
    expect(screen.getByTestId("chat-list-column")).toBeInTheDocument();
    expect(
      within(rail).queryByLabelText("Show chat list"),
    ).not.toBeInTheDocument();
  });
});

test("Keep chat navigation usable while secondary data is unavailable", async () => {
  prepareDefaultAgent();
  const indicatorResponse = context.mocks.deferred<void>();
  const draftResponse = context.mocks.deferred<void>();
  const draftRequestStarted = context.mocks.deferred<void>();
  const draftResponseReturned = context.mocks.deferred<void>();
  const cachedChatThreadEvents = mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Existing conversation"),
  ]);
  context.mocks.api(chatThreadsContract.indicators, async ({ respond }) => {
    await indicatorResponse.promise;
    return respond(200, { agents: {}, threads: {} });
  });
  context.mocks.api(chatThreadsContract.drafts, async ({ respond }) => {
    draftRequestStarted.resolve();
    await draftResponse.promise;
    const response = respond(401, {
      error: {
        code: "UNAUTHORIZED",
        message: "Draft membership unavailable",
      },
    });
    draftResponseReturned.resolve();
    return response;
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    cachedChatThreadEvents,
  });

  await waitFor(() => {
    expect(
      within(sidebar()).getByText("Existing conversation"),
    ).toBeInTheDocument();
    expect(
      sidebar().querySelectorAll('[data-testid="sidebar-skeleton"]'),
    ).toHaveLength(0);
  });
  expect(
    within(threadRowByTitle("Existing conversation")).queryByLabelText(
      "Running",
    ),
  ).not.toBeInTheDocument();

  indicatorResponse.resolve();
  await draftRequestStarted.promise;
  draftResponse.resolve();
  await draftResponseReturned.promise;
  await waitFor(() => {
    expect(
      within(sidebar()).getByText("Existing conversation"),
    ).toBeInTheDocument();
  });
  expect(chatListNewChatButton()).toBeInTheDocument();
  openChatListMenu();
  expect(queryMenuItemByText("New chat")).not.toBeInTheDocument();
  expect(menuItemByText("All chats")).toBeInTheDocument();
  expect(menuItemByText("Unread")).toBeInTheDocument();
});

test("Mount only the sidebar for the current viewport", async () => {
  prepareDefaultAgent();
  const mediaQuery = mockMobileLayout();

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  await waitFor(() => {
    expect(mobileSidebar()).toBeInTheDocument();
  });
  expect(screen.queryByTestId("labeled-nav-rail")).not.toBeInTheDocument();
  expect(screen.queryByTestId("chat-list-column")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Open menu")).toBeInTheDocument();
  expect(screen.getAllByTestId("sidebar-scroll-area")).toHaveLength(1);

  act(() => {
    mediaQuery.setMatches(true);
  });

  await waitFor(() => {
    expect(screen.getByTestId("labeled-nav-rail")).toBeInTheDocument();
    expect(screen.getByTestId("chat-list-column")).toBeInTheDocument();
  });
  expect(queryMobileSidebar()).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Open menu")).not.toBeInTheDocument();
  expect(screen.getAllByTestId("sidebar-scroll-area")).toHaveLength(1);

  act(() => {
    mediaQuery.setMatches(false);
  });

  await waitFor(() => {
    expect(mobileSidebar()).toBeInTheDocument();
  });
  expect(screen.queryByTestId("labeled-nav-rail")).not.toBeInTheDocument();
  expect(screen.queryByTestId("chat-list-column")).not.toBeInTheDocument();
  expect(screen.getAllByTestId("sidebar-scroll-area")).toHaveLength(1);
});

test("Keep pin management usable with many pinned agents", async () => {
  const pinnedAgentIds = prepareOverflowingPinnedAgents();
  const preferencesGate = context.mocks.deferred<void>();
  context.mocks.api(userPreferencesContract.get, async ({ respond }) => {
    await preferencesGate.promise;
    return respond(200, {
      timezone: null,
      locale: null,
      supportedLocales: [
        "en-US",
        "pt-BR",
        "ja-JP",
        "ko-KR",
        "id-ID",
        "de-DE",
        "es-ES",
        "it-IT",
        "fr-FR",
        "hi-IN",
        "zh-Hans",
        "zh-Hant",
      ],
      pinnedAgentIds,
      sendMode: "enter",
      cloudBrowserEnabledByDefault: true,
      theme: "system",
      colorTheme: "blue-horizon",
      captureNetworkBodiesRemaining: 0,
      voiceInputModel: null,
    });
  });

  const page = await startPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const pinnedSection = await screen.findByTestId("pinned-agents-horizontal");
  const grid = within(pinnedSection).getByTestId("pinned-agents-grid");
  expect(within(pinnedSection).getByText("Pinned agents")).toBeVisible();
  expect(within(grid).getByTestId("pinned-agent-skeleton")).toBeVisible();
  expect(within(grid).queryByTestId("pinned-agent-card")).toBeNull();
  expect(within(grid).queryByLabelText("Pin an agent")).toBeNull();

  preferencesGate.resolve();
  await page.ready;

  await waitFor(() => {
    expect(within(grid).queryByTestId("pinned-agent-skeleton")).toBeNull();
    expect(within(grid).getAllByTestId("pinned-agent-card")).toHaveLength(6);
    expect(buttonByLabel("Pin an agent", grid)).toBeVisible();
  });
  expect(
    queryAllByRoleFast("link", grid).map((link) => {
      return link.textContent?.trim();
    }),
  ).toStrictEqual([
    "Nova",
    "Research Agent",
    "Support Agent",
    "Operations Agent",
    "Analytics Agent",
    "Billing Agent",
  ]);

  const pinAgent = queryAllByRoleFast("button", grid).find((candidate) => {
    return candidate.getAttribute("aria-label") === "Pin an agent";
  });
  if (!pinAgent) {
    throw new Error("Pin agent button not found");
  }
  // Cards render as Nova, Research, Support, Operations, Pin, Analytics,
  // Billing, so Pin closes the first row and the rest wrap after it.
  const fourthAgent = pinnedAgentLink(grid, "Operations Agent");
  const fifthAgent = pinnedAgentLink(grid, "Analytics Agent");

  expect(
    fourthAgent.compareDocumentPosition(pinAgent) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(
    pinAgent.compareDocumentPosition(fifthAgent) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});

test("Keep pinned agents and the chat heading visible while conversations scroll", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID],
  });
  const overflowThreads = Array.from({ length: 23 }, (_, index) => {
    return createThread(
      `b2500000-0000-4000-a000-${String(index).padStart(12, "0")}`,
      `Switched overflow ${index + 1}`,
    );
  });
  mockSidebarThreadStory(
    [
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(AUTOMATION_THREAD_ID, "Scheduled launch"),
    ],
    [...overflowThreads, createThread(ARCHIVED_THREAD_ID, "Archived context")],
  );

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Research Agent")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    expect(
      within(sidebar()).getByTestId("sidebar-chat-threads-virtual-list"),
    ).toBeInTheDocument();
  });

  const scrollArea = within(sidebar()).getByTestId("sidebar-scroll-area");
  const pinnedHeader = within(sidebar()).getByTestId(
    "pinned-agents-horizontal",
  );
  const pinnedAgent = within(pinnedHeader).getByText("Research Agent");
  const chatTitle = within(sidebar()).getByText("Chats with Nova");
  expect(scrollArea).not.toContainElement(pinnedHeader);
  expect(scrollArea).not.toContainElement(pinnedAgent);
  expect(scrollArea).not.toContainElement(chatTitle);
  expect(scrollArea).toContainElement(threadLinkByTitle("Release plan"));

  Object.defineProperty(scrollArea, "clientHeight", {
    configurable: true,
    value: 200,
  });
  Object.defineProperty(scrollArea, "scrollHeight", {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(scrollArea, "scrollTop", {
    configurable: true,
    value: 780,
  });
  fireEvent.scroll(scrollArea);

  await waitFor(() => {
    expect(within(sidebar()).getByText("Archived context")).toBeInTheDocument();
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

test("Locate the current chat in a long sidebar history", async () => {
  prepareDefaultAgent();
  const leadingThreads = Array.from({ length: 24 }, (_, index) => {
    return createThread(
      `b3050000-0000-4000-a000-${String(index).padStart(12, "0")}`,
      `Three-column leading chat ${index + 1}`,
    );
  });
  mockSidebarThreadStory([
    ...leadingThreads,
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(AUTOMATION_THREAD_ID, "Scheduled launch"),
  ]);

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  const desktopList = await screen.findByTestId("chat-list-column");
  await waitFor(() => {
    expect(within(desktopList).getByText("Release plan")).toBeInTheDocument();
    expect(
      within(desktopList).getByTestId("sidebar-scroll-area").scrollTop,
    ).toBeGreaterThan(0);
  });
});

test("Keep the chat-list menu closed when navigating with a shortcut", async () => {
  const user = userEvent.setup({ delay: null });
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Existing conversation"),
  ]);

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const list = await screen.findByTestId("chat-list-column");
  const menuTrigger = within(list).getByLabelText("Open chat list menu");
  await user.click(menuTrigger);
  await expect(screen.findByRole("menu")).resolves.toBeInTheDocument();
  expect(within(list).getByText("Existing conversation")).toBeInTheDocument();

  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(menuTrigger).toHaveFocus();
  });

  await user.keyboard("{Control>}{Shift>}{ArrowDown}{/Shift}{/Control}");
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${EXISTING_THREAD_ID}`);
  });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
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
    });
  });
  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    return respond(200, {
      unreads: hasUnread
        ? [
            {
              threadId: INCIDENT_THREAD_ID,
              unreadAt: "2026-03-10T00:05:00Z",
            },
          ]
        : [],
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
    expect(within(list).getAllByLabelText("Unread").length).toBeGreaterThan(0);
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
    expect(within(list).queryByLabelText("Unread")).not.toBeInTheDocument();
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

test("Show mark all read in the mobile chat-list menu before conversations load", async () => {
  mockMobileLayout();
  prepareDefaultAgent();
  const remote = context.mocks.deferred<void>();
  mockSidebarThreadStory(
    [createThread(INCIDENT_THREAD_ID, "Unread conversation")],
    [],
    [],
    context,
    remote.promise,
  );
  mockUnreadAgents(() => {
    return [AGENT_ID];
  });

  const page = await startPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const list = await screen.findByRole("complementary", {
    name: "Sidebar",
  });
  expect(
    within(list).queryByText("Unread conversation"),
  ).not.toBeInTheDocument();
  click(within(list).getByLabelText("Open chat list menu"));

  await waitFor(() => {
    expect(menuItemByText("Mark all read")).toBeInTheDocument();
  });
  expect(
    within(list).queryByText("Unread conversation"),
  ).not.toBeInTheDocument();
  remote.resolve();
  await page.ready;
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
  const markReadDeferred = context.mocks.deferred<void>();
  const markReadStarted = context.mocks.deferred<void>();
  const markReadCompleted = context.mocks.deferred<void>();
  const unreadThreadIds = new Set<string>();
  const state = {
    holdReleaseRead: false,
    unreadAt: "2026-03-10T00:05:00Z",
  };
  const serverUnreads = () => {
    return [...unreadThreadIds].map((threadId) => {
      return { threadId, unreadAt: state.unreadAt };
    });
  };
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Incident notes"),
  ]);
  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    const unreads = serverUnreads();
    if (
      unreadThreadIds.has(EXISTING_THREAD_ID) &&
      !unreadSnapshotRefreshed.settled()
    ) {
      unreadSnapshotRefreshed.resolve();
    }
    return respond(200, { unreads });
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
    async ({ params, respond }) => {
      unreadThreadIds.delete(params.id);
      if (params.id === EXISTING_THREAD_ID && state.holdReleaseRead) {
        markReadStarted.resolve();
        await markReadDeferred.promise;
        markReadCompleted.resolve();
      }
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
  return {
    markReadCompleted,
    markReadDeferred,
    markReadStarted,
    state,
    unreadSnapshotRefreshed,
    unreadThreadIds,
  };
}

async function markReleasePlanUnread(
  scenario: Awaited<ReturnType<typeof setupReadUnreadSidebar>>,
) {
  openThreadMenu("Release plan");
  click(menuItemByText("Mark unread"));
  await scenario.unreadSnapshotRefreshed.promise;
  expect(
    within(threadRowByTitle("Release plan")).queryByLabelText("Unread"),
  ).not.toBeInTheDocument();
  click(threadLinkByTitle("Incident notes"));
  await waitFor(() => {
    expect(
      within(threadRowByTitle("Release plan")).getByLabelText("Unread"),
    ).toBeInTheDocument();
  });
}

async function completeHeldReleaseRead(
  scenario: Awaited<ReturnType<typeof setupReadUnreadSidebar>>,
) {
  scenario.state.holdReleaseRead = true;
  click(threadLinkByTitle("Release plan"));
  await scenario.markReadStarted.promise;
  click(threadLinkByTitle("Incident notes"));
  await waitFor(() => {
    expect(
      within(threadRowByTitle("Release plan")).queryByLabelText("Unread"),
    ).not.toBeInTheDocument();
  });
  scenario.markReadDeferred.resolve();
  await scenario.markReadCompleted.promise;
}

test("Mark the current conversation unread after navigating away", async () => {
  const scenario = await setupReadUnreadSidebar();
  await markReleasePlanUnread(scenario);
  expect(
    within(threadRowByTitle("Release plan")).getByLabelText("Unread"),
  ).toBeInTheDocument();
});

test("Clear an unread conversation while its read request is pending", async () => {
  const scenario = await setupReadUnreadSidebar();
  await markReleasePlanUnread(scenario);
  await completeHeldReleaseRead(scenario);
  expect(
    within(threadRowByTitle("Release plan")).queryByLabelText("Unread"),
  ).not.toBeInTheDocument();
});

test("Restore a conversation when a later realtime unread arrives", async () => {
  const scenario = await setupReadUnreadSidebar();
  await markReleasePlanUnread(scenario);
  await completeHeldReleaseRead(scenario);
  scenario.state.unreadAt = "2026-03-10T00:06:00Z";
  scenario.unreadThreadIds.add(EXISTING_THREAD_ID);
  context.mocks.ably.trigger("chatThreadReadCursorUpdated", {
    threadId: EXISTING_THREAD_ID,
    agentId: AGENT_ID,
    lastReadAt: null,
  });
  await waitFor(() => {
    expect(
      within(threadRowByTitle("Release plan")).getByLabelText("Unread"),
    ).toBeInTheDocument();
  });
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

  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    unreadRequests += 1;
    return respond(200, {
      unreads:
        unreadAt === null ? [] : [{ threadId: EXISTING_THREAD_ID, unreadAt }],
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
    expect(
      within(threadRowByTitle("Native brief")).queryByLabelText("Unread"),
    ).not.toBeInTheDocument();
  });
});
