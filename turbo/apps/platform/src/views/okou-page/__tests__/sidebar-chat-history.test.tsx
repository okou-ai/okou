import {
  AGENT_ID,
  ARCHIVED_THREAD_ID,
  buttonByText,
  createSidebarHelpers,
  createThread,
  EXISTING_THREAD_ID,
  INCIDENT_THREAD_ID,
  menuItemByText,
  mockSidebarViewport,
  openChatListMenu,
  openThreadMenu,
  RESEARCH_AGENT_ID,
  RESEARCH_THREAD_ID,
  scrollToArchivedContext,
  setupSidebarPage,
  sidebar,
  SUPPORT_AGENT_ID,
  threadLinkByTitle,
  visibleThreadTitles,
} from "./sidebar-test-helpers.tsx";

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";

const context = testContext();
const {
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
    featureSwitches: { [FeatureSwitchKey.SingleAgent]: true },
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

test.each([true])(
  "Deleting the last chat opens a new chat (My Okou: %s)",
  async (singleAgent) => {
    prepareDefaultAgent();
    mockSidebarThreadStory([createThread(EXISTING_THREAD_ID, "Release plan")]);

    await setupSidebarPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.SingleAgent]: singleAgent },
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

    await expect(
      screen.findByText("Chat deleted"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(pathname()).toBe(singleAgent ? "/" : `/agents/${AGENT_ID}/chat`);
    });
    await expect(
      screen.findByRole("textbox", { name: "Message" }),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Chat thread not found")).not.toBeInTheDocument();
  },
);

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
      agents: { [AGENT_ID]: "unread" },
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

function mockUnreadThreads(threadIds: readonly string[]): void {
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: { [AGENT_ID]: "unread" },
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
    featureSwitches: {
      [FeatureSwitchKey.SingleAgent]: true,
    },
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
    featureSwitches: { [FeatureSwitchKey.SingleAgent]: true },
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
    featureSwitches: { [FeatureSwitchKey.SingleAgent]: true },
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
      [FeatureSwitchKey.SingleAgent]: true,
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
