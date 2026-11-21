import {
  AGENT_ID,
  ARCHIVED_THREAD_ID,
  AUTOMATION_THREAD_ID,
  buttonByText,
  createSidebarHelpers,
  createThread,
  EXISTING_THREAD_ID,
  INCIDENT_THREAD_ID,
  menuItemByText,
  mockSidebarTitleLayout,
  mockSidebarViewport,
  openChatListMenu,
  openThreadMenu,
  queryMenuItemByText,
  RESEARCH_AGENT_ID,
  RESEARCH_THREAD_ID,
  scrollToArchivedContext,
  setupSidebarPage,
  sidebar,
  type SidebarThread,
  SUPPORT_AGENT_ID,
  threadLinkByTitle,
  titleRevealClip,
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
import {
  click,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  chatEventRowsResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";
import { mockChatEventRows } from "./chat-event-test-helpers.ts";
import {
  changeChatIndicators,
  changeChatThreadReadCursor,
} from "../../../mocks/mock-helpers.ts";

const context = testContext();
const {
  mockChatThreadSnapshot,
  mockLongSidebarHistory,
  mockSidebarThreadStory,
  prepareAgents,
  prepareDefaultAgent,
} = createSidebarHelpers(context);

function pressArchiveShortcut(): void {
  fireEvent.keyDown(document, {
    key: "X",
    code: "KeyX",
    ctrlKey: true,
    shiftKey: true,
  });
}

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

test("Delete a chat after reviewing the impact", async () => {
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

  await expect(screen.findByText("Chat deleted")).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(pathname()).toBe("/");
  });
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(
      within(sidebar()).queryByText("Release plan"),
    ).not.toBeInTheDocument();
    expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
  });
});

test("Deleting the last chat opens a new chat", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([createThread(EXISTING_THREAD_ID, "Release plan")]);

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
  });
  openThreadMenu("Release plan");
  click(menuItemByText("Delete chat"));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete chat?",
  });
  click(buttonByText("Delete", dialog));

  await expect(screen.findByText("Chat deleted")).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(pathname()).toBe("/");
  });
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Chat thread not found")).not.toBeInTheDocument();
});

test("Deleting another chat keeps the current chat open", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Incident notes"),
  ]);

  await setupSidebarPage({ context, path: `/chats/${EXISTING_THREAD_ID}` });
  await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
  });

  openThreadMenu("Incident notes");
  click(menuItemByText("Delete chat"));
  const dialog = await screen.findByRole("dialog", { name: "Delete chat?" });
  click(buttonByText("Delete", dialog));

  await expect(screen.findByText("Chat deleted")).resolves.toBeInTheDocument();
  expect(pathname()).toBe(`/chats/${EXISTING_THREAD_ID}`);
  expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
  expect(
    within(sidebar()).queryByText("Incident notes"),
  ).not.toBeInTheDocument();
});

/**
 * Deliberate exception to `docs/testing.md#external-behavior`: happy-dom has
 * no layout or painting and cannot show CSS fades or animated title travel.
 * Exercise the real page's link hover and keyboard focus with explicit pixel
 * geometry, then assert only the intent's DOM-to-CSS reveal state and duration.
 * Fade painting, CSS timing and pointer/focus overlap need real-browser checks.
 */
test("Reveal chat titles from whole-link pointer and keyboard intent", async () => {
  const user = userEvent.setup({ delay: null });
  const titles = [
    {
      id: EXISTING_THREAD_ID,
      title: "Quarterly launch narrative",
      textWidth: 234,
      clipWidth: 160,
      duration: "925ms",
    },
    {
      id: AUTOMATION_THREAD_ID,
      title: "Release plan",
      textWidth: 123,
      clipWidth: 160,
      duration: "0ms",
    },
    {
      id: INCIDENT_THREAD_ID,
      title: "Customer feedback synthesis",
      textWidth: 530,
      clipWidth: 160,
      duration: "3000ms",
    },
    {
      id: RESEARCH_THREAD_ID,
      title: "Weekly decisions",
      textWidth: 170,
      clipWidth: 160,
      duration: "780ms",
    },
  ];
  mockSidebarTitleLayout(
    Object.fromEntries(
      titles.map((fixture) => {
        return [fixture.title, fixture] as const;
      }),
    ),
  );
  prepareDefaultAgent();
  mockSidebarThreadStory(
    titles.map(({ id, title }) => {
      return createThread(id, title);
    }),
  );

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  await expect(
    within(sidebar()).findByText("Customer feedback synthesis"),
  ).resolves.toBeInTheDocument();

  for (const { title, duration } of titles) {
    const link = threadLinkByTitle(title);
    const clip = titleRevealClip(link);

    await user.hover(link);

    expect(clip).toHaveAttribute("data-title-revealing", "");
    expect(clip.style.getPropertyValue("--okou-nav-title-duration")).toBe(
      duration,
    );

    await user.unhover(link);

    expect(clip).not.toHaveAttribute("data-title-revealing");
  }

  const clippedLink = threadLinkByTitle("Quarterly launch narrative");
  const clipped = titleRevealClip(clippedLink);
  act(() => {
    clippedLink.focus();
  });

  expect(clippedLink).toHaveFocus();
  expect(clipped).toHaveAttribute("data-title-revealing", "");
  expect(clipped.style.getPropertyValue("--okou-nav-title-duration")).toBe(
    "925ms",
  );

  act(() => {
    clippedLink.blur();
  });

  expect(clippedLink).not.toHaveFocus();
  expect(clipped).not.toHaveAttribute("data-title-revealing");
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

test("Filter chats by Inbox, Unread, or Archived", async () => {
  prepareDefaultAgent();
  const currentThread = createThread(EXISTING_THREAD_ID, "Release plan");
  // A check-mark icon is an ordinary emoji; only the archived flag archives.
  const checkMarkThread = createThread(RESEARCH_THREAD_ID, "✅ Shipped notes");
  const archivedReadThread = createThread(
    ARCHIVED_THREAD_ID,
    "Archived context",
    { archived: true },
  );
  const archivedUnreadThread = createThread(
    INCIDENT_THREAD_ID,
    "Waiting for review",
    { archived: true },
  );
  mockSidebarThreadStory([
    currentThread,
    checkMarkThread,
    archivedReadThread,
    archivedUnreadThread,
  ]);
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      threads: { [INCIDENT_THREAD_ID]: "unread" },
      unreadAt: { [INCIDENT_THREAD_ID]: "2026-03-10T00:05:00Z" },
    });
  });

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  const titles = [
    "Release plan",
    "✅ Shipped notes",
    "Archived context",
    "Waiting for review",
  ];
  await waitFor(() => {
    expect(visibleThreadTitles(titles)).toStrictEqual([
      "Release plan",
      "✅ Shipped notes",
    ]);
  });

  openChatListMenu();
  expect(menuItemByText("Inbox")).toBeInTheDocument();
  expect(menuItemByText("Archived")).toBeInTheDocument();
  expect(
    screen
      .getByRole("menu")
      .querySelectorAll('[data-slot="dropdown-menu-separator"]'),
  ).toHaveLength(1);
  click(menuItemByText("Unread"));

  await waitFor(() => {
    expect(visibleThreadTitles(titles)).toStrictEqual(["Waiting for review"]);
  });
  expect(within(sidebar()).getByText("Show all chats")).toBeInTheDocument();
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${INCIDENT_THREAD_ID}`);
  });

  openChatListMenu();
  click(menuItemByText("Archived"));

  await waitFor(() => {
    expect(visibleThreadTitles(titles)).toStrictEqual([
      "Archived context",
      "Waiting for review",
    ]);
  });
  expect(within(sidebar()).getByText("Show all chats")).toBeInTheDocument();
  expect(pathname()).toBe(`/chats/${INCIDENT_THREAD_ID}`);

  openChatListMenu();
  click(menuItemByText("Inbox"));

  await waitFor(() => {
    expect(visibleThreadTitles(titles)).toStrictEqual([
      "Release plan",
      "✅ Shipped notes",
    ]);
  });
  expect(
    within(sidebar()).queryByText("Show all chats"),
  ).not.toBeInTheDocument();
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${EXISTING_THREAD_ID}`);
  });
});

test("Selecting a filter skips the chat open in the right pane", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(ARCHIVED_THREAD_ID, "Archived context", { archived: true }),
    createThread(INCIDENT_THREAD_ID, "Waiting for review", { archived: true }),
  ]);

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}?sidebar=${ARCHIVED_THREAD_ID}`,
  });
  await waitFor(() => {
    expect(visibleThreadTitles(["Release plan"])).toStrictEqual([
      "Release plan",
    ]);
  });

  openChatListMenu();
  click(menuItemByText("Archived"));

  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${INCIDENT_THREAD_ID}`);
  });
});

test("Mute and unmute a chat without hiding or reordering it", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Quiet task"),
  ]);
  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });
  await within(sidebar()).findByText("Quiet task");
  openThreadMenu("Quiet task");
  click(menuItemByText("Mute chat"));
  await waitFor(() => {
    expect(within(sidebar()).getByText("Muted")).toBeInTheDocument();
    expect(visibleThreadTitles(["Release plan", "Quiet task"])).toStrictEqual([
      "Release plan",
      "Quiet task",
    ]);
  });
  openThreadMenu("Quiet task");
  click(menuItemByText("Unmute chat"));
  await waitFor(() => {
    expect(within(sidebar()).queryByText("Muted")).not.toBeInTheDocument();
  });
});

function mockUnreadThreads(threadIds: readonly string[]): void {
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      threads: Object.fromEntries(
        threadIds.map((threadId) => {
          return [threadId, "unread"] as const;
        }),
      ),
      unreadAt: Object.fromEntries(
        threadIds.map((threadId) => {
          return [threadId, "2026-03-10T00:05:00Z"] as const;
        }),
      ),
    });
  });
}

test("Archive an unread chat without changing reading state", async () => {
  prepareAgents();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Review later"),
  ]);
  // Keep the old indicator response to cover the optimistic metadata projection.
  mockUnreadThreads([INCIDENT_THREAD_ID]);
  await setupSidebarPage({ context, path: `/chats/${EXISTING_THREAD_ID}` });
  const list = await screen.findByTestId("chat-list-column");
  await waitFor(() => {
    expect(threadLinkByTitle("Review later", list)).toHaveAccessibleName(
      "Review later Unread",
    );
  });
  openChatListMenu();
  expect(menuItemByText("Mark all read")).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  openChatListMenu();

  openThreadMenu("Review later");
  click(menuItemByText("Archive chat"));
  await expect(
    screen.findByText("Chat archived."),
  ).resolves.toBeInTheDocument();
  openChatListMenu();
  await waitFor(() => {
    expect(menuItemByText("Mark all read")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  openChatListMenu();
  click(buttonByText("Undo"));
  await waitFor(() => {
    expect(threadLinkByTitle("Review later", list)).toHaveAccessibleName(
      "Review later Unread",
    );
  });
  openChatListMenu();
  await waitFor(() => {
    expect(menuItemByText("Mark all read")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});

test("Mute an unread chat with feedback and undo it from the toast", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Quiet task"),
  ]);
  mockUnreadThreads([INCIDENT_THREAD_ID]);
  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });
  await waitFor(() => {
    expect(threadLinkByTitle("Quiet task")).toHaveAccessibleName(
      "Quiet task Unread",
    );
  });

  openThreadMenu("Quiet task");
  click(menuItemByText("Mute chat"));
  await expect(
    screen.findByText(
      "Chat muted. New replies won't show as unread or send push notifications.",
    ),
  ).resolves.toBeInTheDocument();
  expect(threadLinkByTitle("Quiet task")).toHaveAccessibleName(
    "Quiet task Muted",
  );

  // Undo puts the chat back as it was, unread included.
  click(buttonByText("Undo"));
  await waitFor(() => {
    expect(threadLinkByTitle("Quiet task")).toHaveAccessibleName(
      "Quiet task Unread",
    );
  });
});

test("Unmute a chat without resurfacing replies that arrived while it was muted", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(RESEARCH_THREAD_ID, "Incident notes"),
    createThread(INCIDENT_THREAD_ID, "Quiet task", { muted: true }),
  ]);
  // The server counts the muted chat's replies as unread once it is unmuted.
  mockUnreadThreads([RESEARCH_THREAD_ID, INCIDENT_THREAD_ID]);
  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });
  await waitFor(() => {
    expect(threadLinkByTitle("Incident notes")).toHaveAccessibleName(
      "Incident notes Unread",
    );
    expect(threadLinkByTitle("Quiet task")).toHaveAccessibleName(
      "Quiet task Muted",
    );
  });

  openThreadMenu("Quiet task");
  expect(queryMenuItemByText("Mark unread")).not.toBeInTheDocument();
  click(menuItemByText("Unmute chat"));
  await expect(screen.findByText("Chat unmuted")).resolves.toBeInTheDocument();
  expect(threadLinkByTitle("Quiet task")).toHaveAccessibleName("Quiet task");
  expect(threadLinkByTitle("Incident notes")).toHaveAccessibleName(
    "Incident notes Unread",
  );
});

async function prepareMutedChatFilter() {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(RESEARCH_THREAD_ID, "Quiet task", { muted: true }),
    createThread(ARCHIVED_THREAD_ID, "Archived quiet task", {
      archived: true,
      muted: true,
    }),
    createThread(INCIDENT_THREAD_ID, "Archived task", { archived: true }),
  ]);
  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });
  const titles = [
    "Release plan",
    "Quiet task",
    "Archived quiet task",
    "Archived task",
  ];
  await within(sidebar()).findByText("Quiet task");
  openChatListMenu();
  click(menuItemByText("Muted"));
  await waitFor(() => {
    expect(visibleThreadTitles(titles)).toStrictEqual([
      "Quiet task",
      "Archived quiet task",
    ]);
    expect(pathname()).toBe(`/chats/${RESEARCH_THREAD_ID}`);
  });
  expect(within(sidebar()).getByText("Show all chats")).toBeInTheDocument();
  return { titles };
}

test("Switch from muted chats to Archived without losing filter state", async () => {
  const { titles } = await prepareMutedChatFilter();
  openChatListMenu();
  click(menuItemByText("Archived"));
  await waitFor(() => {
    expect(visibleThreadTitles(titles)).toStrictEqual([
      "Archived quiet task",
      "Archived task",
    ]);
  });
  openChatListMenu();
  click(menuItemByText("Muted"));
  await waitFor(() => {
    expect(visibleThreadTitles(titles)).toStrictEqual([
      "Quiet task",
      "Archived quiet task",
    ]);
  });
});

test("Switch from muted chats to Unmute without losing filter state", async () => {
  const { titles } = await prepareMutedChatFilter();
  openThreadMenu("Quiet task");
  click(menuItemByText("Unmute chat"));
  await waitFor(() => {
    expect(visibleThreadTitles(titles)).toStrictEqual(["Archived quiet task"]);
  });
});

test("Switch from muted chats to Unread without losing filter state", async () => {
  await prepareMutedChatFilter();
  openChatListMenu();
  click(menuItemByText("Unread"));
  await expect(
    within(sidebar()).findByText("No unread chats"),
  ).resolves.toBeInTheDocument();
});

test("Switch from muted chats to Inbox without losing filter state", async () => {
  const { titles } = await prepareMutedChatFilter();
  openThreadMenu("Quiet task");
  click(menuItemByText("Unmute chat"));
  await waitFor(() => {
    expect(visibleThreadTitles(titles)).toStrictEqual(["Archived quiet task"]);
  });
  openChatListMenu();
  click(menuItemByText("Inbox"));
  await waitFor(() => {
    expect(visibleThreadTitles(titles)).toStrictEqual([
      "Release plan",
      "Quiet task",
    ]);
  });
  expect(
    within(sidebar()).queryByText("Show all chats"),
  ).not.toBeInTheDocument();
});

test("Show an empty muted filter after unmuting its last chat", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Quiet task", { muted: true }),
  ]);
  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });
  await within(sidebar()).findByText("Quiet task");
  openChatListMenu();
  click(menuItemByText("Muted"));
  await waitFor(() => {
    expect(visibleThreadTitles(["Release plan", "Quiet task"])).toStrictEqual([
      "Quiet task",
    ]);
    expect(pathname()).toBe(`/chats/${INCIDENT_THREAD_ID}`);
  });
  openThreadMenu("Quiet task");
  click(menuItemByText("Unmute chat"));
  await within(sidebar()).findByText("No muted chats");
  expect(visibleThreadTitles(["Release plan", "Quiet task"])).toStrictEqual([]);
  click(buttonByText("Show all chats", sidebar()));
  await waitFor(() => {
    expect(visibleThreadTitles(["Release plan", "Quiet task"])).toStrictEqual([
      "Release plan",
      "Quiet task",
    ]);
  });
});

test("Running indicators take precedence over the muted icon", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory(
    [
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(INCIDENT_THREAD_ID, "Running muted task", { muted: true }),
    ],
    [],
    [INCIDENT_THREAD_ID],
  );
  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });
  await within(sidebar()).findByText("Running muted task");
  await waitFor(() => {
    expect(within(sidebar()).getByText("Running")).toBeInTheDocument();
  });
  expect(within(sidebar()).queryByText("Muted")).not.toBeInTheDocument();
});

test("Hide the current chat after archiving it without changing its title", async () => {
  prepareDefaultAgent();
  const untitledThread: SidebarThread = {
    ...createThread(EXISTING_THREAD_ID, "Unused title"),
    title: null,
  };
  mockSidebarThreadStory([untitledThread]);

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  await waitFor(() => {
    expect(threadLinkByTitle("New chat", sidebar())).toBeInTheDocument();
  });
  openThreadMenu("New chat");
  click(menuItemByText("Archive chat"));

  await waitFor(() => {
    expect(
      within(sidebar()).getByText("Your inbox is empty"),
    ).toBeInTheDocument();
    expect(
      sidebar().querySelector('a[href="/chats/' + EXISTING_THREAD_ID + '"]'),
    ).not.toBeInTheDocument();
  });
  expect(pathname()).toBe(`/chats/${EXISTING_THREAD_ID}`);
  await expect(
    screen.findByText("Chat archived."),
  ).resolves.toBeInTheDocument();
  click(buttonByText("Show archived chats", sidebar()));

  await waitFor(() => {
    expect(threadLinkByTitle("New chat", sidebar())).toBeInTheDocument();
  });
  expect(within(sidebar()).getByText("Archived")).toBeInTheDocument();
  openThreadMenu("New chat");
  click(menuItemByText("Unarchive chat"));

  await waitFor(() => {
    expect(
      within(sidebar()).getByText("No archived chats"),
    ).toBeInTheDocument();
    expect(
      sidebar().querySelector('a[href="/chats/' + EXISTING_THREAD_ID + '"]'),
    ).not.toBeInTheDocument();
  });

  click(buttonByText("Show all chats", sidebar()));
  await expect(
    within(sidebar()).findByText("New chat"),
  ).resolves.toBeInTheDocument();
  expect(
    within(sidebar()).queryByText("No archived chats"),
  ).not.toBeInTheDocument();
});

test("Archive and unarchive the current chat with the keyboard shortcut", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([createThread(EXISTING_THREAD_ID, "Release plan")]);

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
  });
  openThreadMenu("Release plan");
  const archiveItem = menuItemByText("Archive chat");
  expect(archiveItem).toHaveTextContent("Ctrl+Shift+X");
  expect(archiveItem).toHaveAttribute(
    "aria-keyshortcuts",
    "Meta+Shift+X Control+Shift+X",
  );
  fireEvent.keyDown(document, { code: "Escape", key: "Escape" });

  pressArchiveShortcut();

  await waitFor(() => {
    expect(
      within(sidebar()).getByText("Your inbox is empty"),
    ).toBeInTheDocument();
    expect(
      within(sidebar()).queryByText("Release plan"),
    ).not.toBeInTheDocument();
  });
  await expect(
    screen.findByText("Chat archived."),
  ).resolves.toBeInTheDocument();

  pressArchiveShortcut();

  await expect(
    within(sidebar()).findByText("Release plan"),
  ).resolves.toBeInTheDocument();
  expect(
    within(sidebar()).queryByText("Your inbox is empty"),
  ).not.toBeInTheDocument();
  await expect(
    screen.findByText("Chat moved to Inbox"),
  ).resolves.toBeInTheDocument();
});

test("Undo an archive from its toast and explain the muted exception", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Quiet task", { muted: true }),
  ]);

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  await within(sidebar()).findByText("Quiet task");
  openThreadMenu("Quiet task");
  click(menuItemByText("Archive chat"));
  await expect(
    screen.findByText(
      "Chat archived. It's muted, so new replies won't bring it back.",
    ),
  ).resolves.toBeInTheDocument();
  expect(within(sidebar()).queryByText("Quiet task")).not.toBeInTheDocument();

  click(buttonByText("Undo"));
  await expect(
    within(sidebar()).findByText("Quiet task"),
  ).resolves.toBeInTheDocument();
});

test("Find archived chats in All and Chats workspace search results", async () => {
  prepareDefaultAgent();
  const currentThread = createThread(EXISTING_THREAD_ID, "Release plan");
  const archivedThread = createThread(ARCHIVED_THREAD_ID, "Archived context", {
    archived: true,
  });
  mockSidebarThreadStory([currentThread, archivedThread]);
  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    expect(
      within(sidebar()).queryByText("Archived context"),
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
    expect(buttonByText("All", dialog)).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByText("Archived context")).toBeInTheDocument();
  });

  click(buttonByText("Chats", dialog));
  await waitFor(() => {
    expect(buttonByText("Chats", dialog)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(dialog).getByText("Archived context")).toBeInTheDocument();
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

test("Open a new My Okou Chat from a retained conversation", async () => {
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

  const list = screen.getByTestId("chat-list-column");
  click(newChatRow(list));
  await waitFor(() => {
    expect(pathname()).toBe("/");
  });

  const chatLink = within(rail).getByLabelText("Chat");
  expect(chatLink).toHaveAttribute("href", "/");
  click(chatLink);

  await waitFor(() => {
    expect(pathname()).toBe("/");
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
  });
});

// The New chat row leads My Okou's chat list.
function newChatRow(list: HTMLElement): HTMLElement {
  const found = queryAllByRoleFast("link", list).find((link) => {
    return link.getAttribute("href") === "/";
  });
  if (!found) {
    throw new Error("New chat row not found");
  }
  return found;
}
test("My Okou's header holds the toggle, search, New Project and list menu while New chat leads the list", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([createThread(EXISTING_THREAD_ID, "Release plan")]);

  await setupSidebarPage({
    context,
    path: "/",
  });

  const list = await screen.findByTestId("chat-list-column");
  await within(list).findByText("Release plan");
  const header = within(list).getByLabelText("Hide chat list").closest("div");
  if (!header) {
    throw new Error("Chat list header not found");
  }
  expect(
    queryAllByRoleFast("button", header).map((button) => {
      return button.getAttribute("aria-label");
    }),
  ).toStrictEqual([
    "Hide chat list",
    "Search workspace",
    "Create Project",
    "Open chat list menu",
  ]);
  expect(header).toHaveTextContent(/^$/);
  expect(within(list).queryByText(/^Chats with/)).not.toBeInTheDocument();

  // Home is the new chat, so the row leading the list opens it.
  const newChat = newChatRow(list);
  expect(newChat).toHaveTextContent(/^New chat/);
  expect(newChat).toHaveAttribute(
    "aria-keyshortcuts",
    "Meta+Shift+O Control+Shift+O",
  );
  await waitFor(() => {
    expect(newChat).toHaveAttribute("aria-current", "page");
  });
  expect(
    newChat.compareDocumentPosition(
      within(list).getByTestId("sidebar-scroll-area"),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  // The icon-only button names itself on hover like its header neighbours.
  await userEvent
    .setup()
    .hover(within(header).getByLabelText("Create Project"));
  await expect(screen.findByText("Create Project")).resolves.toBeVisible();

  click(within(header).getByLabelText("Create Project"));
  await expect(
    screen.findByRole("textbox", { name: "Project name" }),
  ).resolves.toBeInTheDocument();
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
  await waitFor(() => {
    expect(
      screen.queryByRole("textbox", { name: "Project name" }),
    ).not.toBeInTheDocument();
  });

  click(within(header).getByLabelText("Open chat list menu"));
  click(menuItemByText("Archived"));
  await expect(within(header).findByText("Archived")).resolves.toBeVisible();
});

test("My Okou's Chat link and new chat shortcut open its chat page at /", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Existing conversation"),
  ]);

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  const rail = await screen.findByTestId("labeled-nav-rail");
  await screen.findByPlaceholderText(PLACEHOLDER);
  const chatLink = within(rail).getByLabelText("Chat");
  expect(chatLink).toHaveAttribute("href", "/");

  fireEvent.keyDown(document, {
    key: "O",
    code: "KeyO",
    ctrlKey: true,
    shiftKey: true,
  });
  await waitFor(() => {
    expect(pathname()).toBe("/");
  });
  await expect(
    screen.findByPlaceholderText(PLACEHOLDER),
  ).resolves.toBeInTheDocument();

  click(within(sidebar()).getByText("Existing conversation"));
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${EXISTING_THREAD_ID}`);
  });
  click(chatLink);
  await waitFor(() => {
    expect(pathname()).toBe("/");
  });
});

test("My Okou's Chat link returns a filtered chat list to the inbox", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(ARCHIVED_THREAD_ID, "Archived context", { archived: true }),
  ]);

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  const rail = await screen.findByTestId("labeled-nav-rail");
  const titles = ["Release plan", "Archived context"];
  await waitFor(() => {
    expect(visibleThreadTitles(titles)).toStrictEqual(["Release plan"]);
  });
  const header = within(sidebar())
    .getByLabelText("Hide chat list")
    .closest("div");
  if (!header) {
    throw new Error("Chat list header not found");
  }

  openChatListMenu();
  click(menuItemByText("Archived"));
  await waitFor(() => {
    expect(visibleThreadTitles(titles)).toStrictEqual(["Archived context"]);
  });
  expect(header).toHaveTextContent("Archived");

  click(within(rail).getByLabelText("Chat"));

  await waitFor(() => {
    expect(pathname()).toBe("/");
    expect(visibleThreadTitles(titles)).toStrictEqual(["Release plan"]);
  });
  expect(header).toHaveTextContent(/^$/);
});

test("The Okou rail entry opens My Okou's chat page at /", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Existing conversation"),
  ]);

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
    featureSwitches: {
      [FeatureSwitchKey.OkouRailEntry]: true,
    },
  });

  const rail = await screen.findByTestId("labeled-nav-rail");
  await screen.findByPlaceholderText(PLACEHOLDER);
  const okouLink = within(rail).getByLabelText("Okou");
  expect(okouLink).toHaveTextContent("Okou");
  expect(okouLink).toHaveAttribute("href", "/");
  expect(within(rail).queryByLabelText("Chat")).toBeNull();

  click(okouLink);
  await waitFor(() => {
    expect(pathname()).toBe("/");
  });
  const newChat = queryAllByRoleFast("link", sidebar()).find((link) => {
    return link.textContent?.startsWith("New chat");
  });
  expect(newChat).toHaveAttribute("aria-current", "page");
});

test("Mark all workspace chats read from the chat-list menu", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Existing conversation"),
    createThread(INCIDENT_THREAD_ID, "Unread conversation"),
  ]);

  let hasUnread = true;
  let markReadRequests = 0;
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      threads: hasUnread ? { [INCIDENT_THREAD_ID]: "unread" } : {},
      unreadAt: hasUnread
        ? { [INCIDENT_THREAD_ID]: "2026-03-10T00:05:00Z" }
        : {},
    });
  });
  context.mocks.api(
    chatThreadMarkAgentReadContract.markAgentRead,
    ({ respond }) => {
      markReadRequests += 1;
      hasUnread = false;
      changeChatIndicators();
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
      "Inbox",
      expect.stringMatching(/^Unread/u),
      "Archived",
      "Muted",
    ]);
  });
  expect(menuItemByText("Mark all read")).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
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
    expect(markReadRequests).toBe(1);
    expect(
      within(list).queryByText("Unread conversation"),
    ).not.toBeInTheDocument();
  });

  click(within(list).getByLabelText("Open chat list menu"));
  await waitFor(() => {
    expect(menuItemByText("Mark all read")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(
      queryAllByRoleFast("menuitem").map((item) => {
        return item.textContent?.replace(/\s+/g, " ").trim();
      }),
    ).toStrictEqual([
      "Mark all read",
      "Inbox",
      expect.stringMatching(/^Unread/u),
      "Archived",
      "Muted",
    ]);
    const menuWithDisabledMarkAllRead =
      document.querySelector<HTMLElement>('[role="menu"]');
    if (!menuWithDisabledMarkAllRead) {
      throw new Error("Open chat list menu not found");
    }
    expect(
      menuWithDisabledMarkAllRead.querySelectorAll('[role="separator"]'),
    ).toHaveLength(1);
  });
});

async function setupReadUnreadSidebar() {
  prepareDefaultAgent();
  const unreadIndicatorsRefreshed = context.mocks.deferred<void>();
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
      !unreadIndicatorsRefreshed.settled()
    ) {
      unreadIndicatorsRefreshed.resolve();
    }
    return respond(200, {
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
      });
    },
  );
  context.mocks.api(
    chatThreadMarkReadContract.markRead,
    ({ params, respond }) => {
      unreadThreadIds.delete(params.id);
      return respond(200, {
        lastReadAt: "2026-03-10T00:05:00Z",
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
  return { unreadIndicatorsRefreshed };
}

async function markReleasePlanUnread(
  scenario: Awaited<ReturnType<typeof setupReadUnreadSidebar>>,
) {
  openThreadMenu("Release plan");
  click(menuItemByText("Mark unread"));
  await scenario.unreadIndicatorsRefreshed.promise;
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
