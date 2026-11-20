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
  openThreadMenu,
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
import { click, fill } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import {
  changeChatIndicators,
  changeChatThreadReadCursor,
} from "../../../mocks/mock-helpers.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const { mockSidebarThreadStory, prepareAgents, prepareDefaultAgent } =
  createSidebarHelpers(context);

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

test("Refresh the thread unread indicator", async () => {
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
    path: "/",
    sharedWorkerTestTransport: "message-port",
  });

  await waitFor(() => {
    expect(
      threadRowByTitle("Remote unread conversation", sidebar()),
    ).toBeInTheDocument();
  });
  const unreadIndicator = () =>
    within(
      threadRowByTitle("Remote unread conversation", sidebar()),
    ).queryByText("Unread");
  await waitFor(() => {
    expect(unreadIndicator()).toBeNull();
  });

  hasUnread = true;
  changeChatIndicators();

  await waitFor(() => {
    expect(unreadIndicator()).toBeInTheDocument();
  });
});

test.each(["indicator", "read cursor"] as const)(
  "Refresh the running indicator after the %s notification without warming chats",
  async (notification) => {
    mockNow(0, context.signal);
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
      path: "/",
      sharedWorkerTestTransport: "message-port",
    });
    const threadLink = () => {
      return threadLinkByTitle("Remote running conversation", sidebar());
    };
    await waitFor(() => {
      expect(threadLink()).toHaveAccessibleName(
        "Remote running conversation Unread",
      );
    });

    const changeIndicator = () => {
      if (notification === "indicator") {
        changeChatIndicators();
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

    // Keep the terminal notification outside the previous refresh's throttle window.
    mockNow(1000, context.signal);
    running = false;
    changeIndicator();
    await waitFor(() => {
      expect(threadLink()).toHaveAccessibleName(
        "Remote running conversation Unread",
      );
    });
  },
);

test.each([false, true])(
  "Refresh the latest unread state after an indicator burst with a failed leading fetch: %s",
  async (failLeadingRefresh) => {
    prepareDefaultAgent();
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Burst conversation"),
    ]);
    mockNow(0, context.signal);
    const refreshStarted = context.mocks.deferred<void>();
    const releaseRefresh = context.mocks.deferred<void>();
    let hasUnread = false;
    let blockRefresh = false;
    context.mocks.api(chatThreadsContract.indicators, async ({ respond }) => {
      // Capture the external server state before the request is delayed.
      const unread = hasUnread;
      if (blockRefresh) {
        blockRefresh = false;
        refreshStarted.resolve();
        await releaseRefresh.promise;
        if (failLeadingRefresh) {
          return respond(503, { error: "Indicators temporarily unavailable" });
        }
      }
      return respond(200, {
        agents: unread ? { [AGENT_ID]: "unread" } : {},
        threads: unread ? { [EXISTING_THREAD_ID]: "unread" } : {},
        unreadAt: unread
          ? { [EXISTING_THREAD_ID]: "2026-03-10T00:05:00Z" }
          : {},
      });
    });

    // The direct transport runs the production Worker handler synchronously,
    // so the entire burst is delivered before releasing the in-flight fetch.
    await setupSidebarPage({
      context,
      path: "/",
    });
    const threadLink = () => {
      return threadLinkByTitle("Burst conversation", sidebar());
    };
    await waitFor(() => {
      expect(threadLink()).toHaveAccessibleName("Burst conversation");
    });

    blockRefresh = true;
    changeChatIndicators();
    await refreshStarted.promise;
    hasUnread = true;
    for (let index = 0; index < 20; index++) {
      changeChatIndicators();
    }

    // Advance the scheduling clock before unblocking the request: no sleeps
    // or timer mocks are needed to exercise the single trailing execution.
    mockNow(1000, context.signal);
    releaseRefresh.resolve();
    await waitFor(() => {
      expect(threadLink()).toHaveAccessibleName("Burst conversation Unread");
    });
  },
);

test("Open a conversation with double-click and rename it from the sidebar menu", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Incident notes"),
  ]);

  await setupSidebarPage({
    context,
    path: `/chats/${INCIDENT_THREAD_ID}`,
  });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
  });

  await userEvent
    .setup()
    .dblClick(threadLinkByTitle("Release plan", sidebar()));
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${EXISTING_THREAD_ID}`);
    expect(threadLinkByTitle("Release plan", sidebar())).toHaveAttribute(
      "aria-current",
      "page",
    );
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

  // Reopen the same row's menu after another page lifetime starts. Rename
  // must bind the current page signal, even when the row was kept mounted.
  click(threadLinkByTitle("Incident notes", sidebar()));
  await waitFor(() => {
    expect(threadLinkByTitle("Incident notes", sidebar())).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  openThreadMenu("Launch plan");
  click(menuItemByText("Rename chat"));
  const reopened = await screen.findByRole("dialog", { name: "Rename chat" });
  const reopenedInput = within(reopened).getByPlaceholderText("Chat title");
  expect(reopenedInput).toHaveValue("Launch plan");
  await fill(reopenedInput, "Final launch plan");
  click(buttonByText("Rename", reopened));
  await within(sidebar()).findByText("Final launch plan");
  expect(threadLinkByTitle("Incident notes", sidebar())).toHaveAttribute(
    "aria-current",
    "page",
  );
});
