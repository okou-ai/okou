import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  chatThreadArchiveContract,
  chatThreadMuteContract,
  chatThreadPinContract,
  chatThreadUnpinContract,
  chatThreadsContract,
  type ChatThreadEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { mailContract } from "@okouai/api-contracts/contracts/mail";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { chatListEvent } from "./chat-list-test-helpers.ts";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();
const THREAD_ID = "b0000000-0000-4000-a000-000000000951";
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";

async function setupHeaderPage(
  threadEvents: readonly ChatThreadEvent[] = [],
  options: {
    readonly singleAgent?: boolean;
  } = {},
) {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "😀 Header planning",
    chatEvents: [
      {
        id: "header-planning-prompt",
        role: "user",
        content: "Review the header layout",
        runId: "header-planning-run",
        createdAt: "2026-09-01T10:00:00Z",
      },
      {
        id: "header-planning-answer",
        role: "assistant",
        content: "The header layout is ready.",
        runId: "header-planning-run",
        createdAt: "2026-09-01T10:00:01Z",
      },
    ],
  });
  context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: threadEvents.filter((event) => {
        return event.seqId > (query.sinceSeqId ?? 0);
      }),
      hasMore: false,
    });
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    featureSwitches:
      options.singleAgent === undefined
        ? {}
        : { [FeatureSwitchKey.SingleAgent]: options.singleAgent },
  });
  await screen.findByText("Review the header layout");
  await waitFor(() => {
    expect(screen.getByLabelText("Change icon")).toHaveTextContent("😀");
  });
}

function buttonNamed(name: string, container: ParentNode = document.body) {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!button) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

function menuItemNamed(name: string) {
  const item = queryAllByRoleFast("menuitem").find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!item) {
    throw new Error(`Menu item not found: ${name}`);
  }
  return item;
}

function menuItemNames() {
  return queryAllByRoleFast("menuitem").map((item) => {
    return item.textContent?.trim();
  });
}

test("Keep menu pin changes responsive across resize and save", async () => {
  const viewport = context.mocks.browser.matchMedia(false);
  const pinResponse = context.mocks.deferred<void>();
  const events: ChatThreadEvent[] = [];
  context.mocks.api(
    chatThreadPinContract.pin,
    async ({ params, query, respond }) => {
      await pinResponse.promise;
      events.push(
        chatListEvent(951, events.length + 1, "pinned", params.id, {
          id: query?.eventId,
          agentId: "c0000000-0000-4000-a000-000000000001",
          pinOrder: query?.pinOrder,
        }),
      );
      return respond(204);
    },
  );
  context.mocks.api(
    chatThreadUnpinContract.unpin,
    ({ params, query, respond }) => {
      events.push(
        chatListEvent(951, events.length + 1, "unpinned", params.id, {
          id: query?.eventId,
          agentId: "c0000000-0000-4000-a000-000000000001",
        }),
      );
      // A following server event makes completed reconciliation observable.
      events.push(
        chatListEvent(951, events.length + 1, "renamed", params.id, {
          agentId: "c0000000-0000-4000-a000-000000000001",
          title: "😀 Pin changes saved",
        }),
      );
      changeChatThreadList();
      return respond(204);
    },
  );
  await setupHeaderPage(events);
  click(buttonNamed("More actions"));
  await screen.findByRole("menu");
  click(menuItemNamed("Pin chat"));
  act(() => {
    viewport.setMatches(true);
  });
  await waitFor(() => {
    expect(
      screen.getByTestId("chat-thread-header-title").closest("header"),
    ).toContainElement(buttonNamed("Share messages"));
  });
  act(() => {
    viewport.setMatches(false);
  });
  await waitFor(() => {
    expect(buttonNamed("More actions")).toBeInTheDocument();
  });

  click(buttonNamed("More actions"));
  await waitFor(() => {
    expect(menuItemNamed("Unpin chat")).toBeEnabled();
  });
  click(menuItemNamed("Unpin chat"));

  pinResponse.resolve();
  await waitFor(() => {
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      "Pin changes saved",
    );
  });
  click(buttonNamed("More actions"));
  await waitFor(() => {
    expect(menuItemNamed("Pin chat")).toBeEnabled();
  });
});

test("Keep Share and More in the header and match the sidebar menu order", async () => {
  context.mocks.browser.matchMedia(false);
  context.mocks.api(mailContract.listThreadMail, ({ respond }) => {
    return respond(200, {
      mails: [
        {
          mailDraftId: "e0000000-0000-4000-a000-000000000951",
          status: "draft",
          subject: "Header planning",
          from: "sender@example.com",
          createdAt: "2026-09-01T10:00:00Z",
        },
      ],
    });
  });
  await setupHeaderPage();
  await waitFor(() => {
    expect(buttonNamed("Manage emails")).toHaveAttribute("aria-busy", "false");
  });
  const more = buttonNamed("More actions");
  const group = more.parentElement;
  if (!group) {
    throw new Error("Header action group is missing");
  }
  expect(
    queryAllByRoleFast("button", group).map((button) => {
      return button.getAttribute("aria-label");
    }),
  ).toStrictEqual([
    "Share messages",
    "Manage emails",
    "Artifacts and chats",
    "More actions",
  ]);
  expect(screen.getByLabelText("Back to chats")).toBeInTheDocument();

  click(more);
  await screen.findByRole("menu");
  expect(menuItemNames()).toStrictEqual([
    "Pin chat",
    "Rename chat",
    "Mute chat",
    "Archive chat",
    "Automations",
    "Open browser",
  ]);
  click(menuItemNamed("Rename chat"));
  const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
  expect(within(dialog).getByPlaceholderText("Chat title")).toHaveValue(
    "😀 Header planning",
  );
});

test("Report sidebar toggles as pressed and popup triggers as expanded in the desktop header", async () => {
  context.mocks.browser.matchMedia(true);
  await setupHeaderPage();
  await waitFor(() => {
    expect(buttonNamed("Manage emails")).toHaveAttribute("aria-busy", "false");
  });
  expect(buttonNamed("Automations")).toHaveAttribute("aria-pressed", "false");
  expect(buttonNamed("Open browser")).toHaveAttribute("aria-pressed", "false");
  const mail = buttonNamed("Manage emails");
  expect(mail).toHaveAttribute("aria-expanded", "false");
  click(mail);
  await screen.findByRole("dialog", { name: "Emails" });
  expect(mail).toHaveAttribute("aria-expanded", "true");
});

test.each([
  {
    name: "the thread's agent",
    singleAgent: false,
    leavesTo: `/agents/${AGENT_ID}/chat`,
  },
  { name: "My Okou's chat page", singleAgent: true, leavesTo: "/" },
])(
  "Archive from the mobile header and return to $name before saving",
  async ({ singleAgent, leavesTo }) => {
    context.mocks.browser.matchMedia(false);
    const archiveResponse = context.mocks.deferred<void>();
    const events: ChatThreadEvent[] = [];
    let archiveRequestAborted = false;
    context.mocks.api(
      chatThreadArchiveContract.archive,
      async ({ params, query, request, respond }) => {
        request.signal.addEventListener("abort", () => {
          archiveRequestAborted = true;
        });
        await archiveResponse.promise;
        events.push(
          chatListEvent(951, 1, "archived", params.id, {
            id: query?.eventId,
            agentId: AGENT_ID,
          }),
        );
        changeChatThreadList();
        return respond(204);
      },
    );
    await setupHeaderPage(events, { singleAgent });
    click(buttonNamed("More actions"));
    await screen.findByRole("menu");
    click(menuItemNamed("Archive chat"));
    await waitFor(() => {
      expect(pathname()).toBe(leavesTo);
    });
    expect(
      screen.queryByText("Review the header layout"),
    ).not.toBeInTheDocument();

    archiveResponse.resolve();
    await waitFor(() => {
      expect(events).toHaveLength(1);
    });
    expect(archiveRequestAborted).toBeFalsy();
  },
);

test("Undo a header archive from its toast and return to the thread", async () => {
  context.mocks.browser.matchMedia(false);
  const events: ChatThreadEvent[] = [];
  context.mocks.api(
    chatThreadArchiveContract.archive,
    ({ params, query, respond }) => {
      events.push(
        chatListEvent(951, 1, "archived", params.id, {
          id: query?.eventId,
          agentId: AGENT_ID,
        }),
      );
      changeChatThreadList();
      return respond(204);
    },
  );
  context.mocks.api(
    chatThreadArchiveContract.unarchive,
    ({ params, query, respond }) => {
      events.push(
        chatListEvent(951, 2, "unarchived", params.id, {
          id: query?.eventId,
          agentId: AGENT_ID,
        }),
      );
      changeChatThreadList();
      return respond(204);
    },
  );
  await setupHeaderPage(events);
  click(buttonNamed("More actions"));
  await screen.findByRole("menu");
  click(menuItemNamed("Archive chat"));

  await expect(
    screen.findByText("Chat archived."),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);

  click(buttonNamed("Undo"));
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${THREAD_ID}`);
  });
  await expect(
    screen.findByText("Review the header layout"),
  ).resolves.toBeInTheDocument();
  click(buttonNamed("More actions"));
  await screen.findByRole("menu");
  await waitFor(() => {
    expect(menuItemNames()).toContain("Archive chat");
  });
});

function mockMuteRequests(events: ChatThreadEvent[]) {
  for (const [route, muted] of [
    [chatThreadMuteContract.mute, true],
    [chatThreadMuteContract.unmute, false],
  ] as const) {
    context.mocks.api(route, ({ params, query, respond }) => {
      events.push(
        chatListEvent(951, events.length + 1, "sort_touched", params.id, {
          id: query?.eventId,
          agentId: AGENT_ID,
          muted,
        }),
      );
      changeChatThreadList();
      return respond(204);
    });
  }
}

test("Mute from the mobile header and unmute from the desktop header", async () => {
  const viewport = context.mocks.browser.matchMedia(false);
  const events: ChatThreadEvent[] = [];
  mockMuteRequests(events);
  await setupHeaderPage(events);
  click(buttonNamed("More actions"));
  await screen.findByRole("menu");
  expect(menuItemNames()).toStrictEqual([
    "Pin chat",
    "Rename chat",
    "Mute chat",
    "Archive chat",
    "Automations",
    "Open browser",
  ]);
  click(menuItemNamed("Mute chat"));
  await expect(
    screen.findByText(
      "Chat muted. New replies won't show as unread or send push notifications.",
    ),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(`/chats/${THREAD_ID}`);
  click(buttonNamed("More actions"));
  await waitFor(() => {
    expect(menuItemNames()).toContain("Unmute chat");
  });

  act(() => {
    viewport.setMatches(true);
  });
  const unmute = await waitFor(() => {
    return buttonNamed("Unmute chat");
  });
  expect(
    screen.getByTestId("chat-thread-header-title").closest("header"),
  ).toContainElement(unmute);
  click(unmute);
  await expect(screen.findByText("Chat unmuted")).resolves.toBeInTheDocument();
  expect(screen.queryByLabelText("Unmute chat")).not.toBeInTheDocument();
});

test("Show the archive API error after leaving the thread", async () => {
  context.mocks.browser.matchMedia(false);
  context.mocks.api(chatThreadArchiveContract.archive, ({ respond }) => {
    return respond(500, { error: { message: "Archive request failed" } });
  });
  await setupHeaderPage();
  click(buttonNamed("More actions"));
  await screen.findByRole("menu");
  click(menuItemNamed("Archive chat"));
  await expect(
    screen.findByText("Archive request failed"),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
});

test("Unarchive from the mobile header and stay in the current thread", async () => {
  context.mocks.browser.matchMedia(false);
  const unarchiveResponse = context.mocks.deferred<void>();
  const events: ChatThreadEvent[] = [
    chatListEvent(951, 1, "archived", THREAD_ID, { agentId: AGENT_ID }),
  ];
  context.mocks.api(
    chatThreadArchiveContract.unarchive,
    async ({ params, query, respond }) => {
      await unarchiveResponse.promise;
      events.push(
        chatListEvent(951, 2, "unarchived", params.id, {
          id: query?.eventId,
          agentId: AGENT_ID,
        }),
      );
      changeChatThreadList();
      return respond(204);
    },
  );
  await setupHeaderPage(events);
  click(buttonNamed("More actions"));
  await screen.findByRole("menu");
  expect(menuItemNames()).toStrictEqual([
    "Pin chat",
    "Rename chat",
    "Mute chat",
    "Unarchive chat",
    "Automations",
    "Open browser",
  ]);
  click(menuItemNamed("Unarchive chat"));
  click(buttonNamed("More actions"));
  await screen.findByRole("menu");
  expect(menuItemNamed("Archive chat")).toHaveAttribute(
    "aria-disabled",
    "true",
  );

  unarchiveResponse.resolve();
  await waitFor(() => {
    expect(menuItemNamed("Archive chat")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  expect(pathname()).toBe(`/chats/${THREAD_ID}`);
  expect(screen.getByText("Review the header layout")).toBeInTheDocument();
});

test("Stay in the archived thread and show the unarchive API error", async () => {
  context.mocks.browser.matchMedia(false);
  context.mocks.api(chatThreadArchiveContract.unarchive, ({ respond }) => {
    return respond(500, { error: { message: "Unarchive request failed" } });
  });
  await setupHeaderPage([
    chatListEvent(951, 1, "archived", THREAD_ID, { agentId: AGENT_ID }),
  ]);
  click(buttonNamed("More actions"));
  await screen.findByRole("menu");
  click(menuItemNamed("Unarchive chat"));
  await expect(
    screen.findByText("Unarchive request failed"),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(`/chats/${THREAD_ID}`);
  expect(screen.getByText("Review the header layout")).toBeInTheDocument();
});

test("Open linked automations from the mobile menu", async () => {
  context.mocks.browser.matchMedia(false);
  context.mocks.api(
    workflowAutomationsContract.listForChatThread,
    ({ respond }) => {
      return respond(200, [
        {
          id: "a0000000-0000-4000-a000-000000000951",
          ownerUserId: "test-user-123",
          enabled: true,
          chatThreadId: THREAD_ID,
          nextRunAt: null,
          lastRunAt: null,
          official: null,
          kind: "schedule",
          schedule: { type: "loop", intervalSeconds: 7200 },
          scheduleSummary: "Every two hours",
          workflow: {
            id: "a0000000-0000-4000-a000-000000000952",
            agentId: "c0000000-0000-4000-a000-000000000001",
            name: "header-check",
            displayName: "Header check",
            description: null,
          },
        },
      ]);
    },
  );
  await setupHeaderPage();
  expect(screen.queryByLabelText("Open mobile automations")).toBeNull();
  click(buttonNamed("More actions"));
  await waitFor(() => {
    expect(menuItemNames()).toStrictEqual([
      "Pin chat",
      "Rename chat",
      "Mute chat",
      "Archive chat",
      "Automations",
      "Open browser",
    ]);
  });
  click(menuItemNamed("Automations"));
  const panel = await screen.findByRole("complementary", {
    name: "Automations",
  });
  const automation = await within(panel).findByText("Header check");
  expect(automation).toBeVisible();
});

test("Retain message selection and restore mobile actions after sharing", async () => {
  context.mocks.browser.matchMedia(false);
  await setupHeaderPage();
  click(buttonNamed("Share messages"));
  await screen.findAllByText("0 selected");
  expect(screen.queryByLabelText("More actions")).not.toBeInTheDocument();
  click(screen.getAllByText("Select message group")[0]!);
  await screen.findAllByText("1 selected");
  click(buttonNamed("Cancel"));
  await waitFor(() => {
    expect(buttonNamed("Share messages")).toBeInTheDocument();
    expect(buttonNamed("More actions")).toBeInTheDocument();
  });
  click(buttonNamed("Change icon"));
  const search = await screen.findByLabelText("Search emoji");
  expect(search).toBeInTheDocument();
});

test("Show the existing API error without undoing an optimistic pin", async () => {
  context.mocks.browser.matchMedia(true);
  context.mocks.api(chatThreadPinContract.pin, ({ respond }) => {
    return respond(500, { error: { message: "Pin request failed" } });
  });
  await setupHeaderPage();
  click(screen.getByTestId("chat-thread-menu-trigger"));
  await screen.findByRole("menu");
  click(menuItemNamed("Pin chat"));
  const error = await screen.findByText("Pin request failed");
  expect(error).toBeInTheDocument();
  click(screen.getByTestId("chat-thread-menu-trigger"));
  await screen.findByRole("menu");
  expect(menuItemNamed("Unpin chat")).toBeEnabled();
});

test("Continue saving the next pin change after an earlier request fails", async () => {
  context.mocks.browser.matchMedia(false);
  const pinResponse = context.mocks.deferred<void>();
  context.mocks.api(chatThreadPinContract.pin, async ({ respond }) => {
    await pinResponse.promise;
    return respond(500, { error: { message: "Pin request failed" } });
  });
  context.mocks.api(chatThreadUnpinContract.unpin, ({ respond }) => {
    return respond(500, { error: { message: "Unpin request failed" } });
  });
  await setupHeaderPage();
  click(buttonNamed("More actions"));
  await screen.findByRole("menu");
  click(menuItemNamed("Pin chat"));
  click(buttonNamed("More actions"));
  await waitFor(() => {
    expect(menuItemNamed("Unpin chat")).toBeEnabled();
  });
  click(menuItemNamed("Unpin chat"));

  pinResponse.resolve();
  await screen.findByText("Unpin request failed");
  expect(screen.getByText("Pin request failed")).toBeInTheDocument();
  click(buttonNamed("More actions"));
  await waitFor(() => {
    expect(menuItemNamed("Pin chat")).toBeEnabled();
  });
});
