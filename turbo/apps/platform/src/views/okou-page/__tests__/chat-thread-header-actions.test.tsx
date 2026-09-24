import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  chatThreadPinContract,
  chatThreadUnpinContract,
  chatThreadsContract,
  type ChatThreadEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { chatListEvent } from "./chat-list-test-helpers.ts";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";

const context = testContext();
const THREAD_ID = "b0000000-0000-4000-a000-000000000951";

async function setupHeaderPage(
  enabled = true,
  threadEvents: readonly ChatThreadEvent[] = [],
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
    featureSwitches: {
      [FeatureSwitchKey.ChatThreadHeaderActions]: enabled,
    },
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
    return candidate.textContent?.trim() === name;
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

test.each([true, false])(
  "Keep the existing header when the switch is off (desktop: %s)",
  async (desktop) => {
    context.mocks.browser.matchMedia(desktop);
    await setupHeaderPage(false);
    expect(screen.queryByLabelText("Pin chat")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("More actions")).not.toBeInTheDocument();
    expect(buttonNamed("Share messages")).toBeInTheDocument();
    expect(
      buttonNamed(desktop ? "Open artifacts" : "Open mobile artifacts"),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("chat-thread-header-title")).toHaveLength(1);
  },
);

test("Keep rapid pin changes responsive across resize and save without a success toast", async () => {
  const viewport = context.mocks.browser.matchMedia(true);
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
  await setupHeaderPage(true, events);
  const title = screen.getByTestId("chat-thread-header-title");
  expect(title.closest("header")).toContainElement(buttonNamed("Pin chat"));

  click(buttonNamed("Pin chat"));
  await waitFor(() => {
    expect(buttonNamed("Unpin chat")).toBeEnabled();
    expect(buttonNamed("Unpin chat")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("chat-thread-menu-trigger")).toHaveAttribute(
      "data-pinned",
      "true",
    );
  });
  act(() => {
    viewport.setMatches(false);
  });
  await waitFor(() => {
    expect(buttonNamed("More actions")).toBeInTheDocument();
    expect(screen.queryByLabelText("Unpin chat")).not.toBeInTheDocument();
  });

  click(buttonNamed("More actions"));
  await waitFor(() => {
    expect(menuItemNamed("Unpin chat")).toBeEnabled();
  });
  click(menuItemNamed("Unpin chat"));
  await waitFor(() => {
    expect(screen.getByTestId("chat-thread-menu-trigger")).toHaveAttribute(
      "data-pinned",
      "false",
    );
  });

  pinResponse.resolve();
  await waitFor(() => {
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      "Pin changes saved",
    );
  });
  expect(screen.getByTestId("chat-thread-menu-trigger")).toHaveAttribute(
    "data-pinned",
    "false",
  );
  expect(screen.queryByText("Chat pinned")).not.toBeInTheDocument();
  expect(screen.queryByText("Chat unpinned")).not.toBeInTheDocument();
  expect(screen.queryByText("Undo")).not.toBeInTheDocument();
});

test("Keep Share and More in the header and match the sidebar menu order", async () => {
  context.mocks.browser.matchMedia(false);
  await setupHeaderPage();
  const more = buttonNamed("More actions");
  const group = more.parentElement;
  if (!group) {
    throw new Error("Header action group is missing");
  }
  expect(
    queryAllByRoleFast("button", group).map((button) => {
      return button.getAttribute("aria-label");
    }),
  ).toStrictEqual(["Share messages", "More actions"]);
  expect(buttonNamed("Open menu")).toBeInTheDocument();
  expect(screen.queryByLabelText("Pin chat")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Open artifacts")).not.toBeInTheDocument();

  click(more);
  await screen.findByRole("menu");
  expect(menuItemNames()).toStrictEqual([
    "Pin chat",
    "Rename chat",
    "Artifacts",
  ]);
  click(menuItemNamed("Rename chat"));
  const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
  expect(within(dialog).getByPlaceholderText("Chat title")).toHaveValue(
    "😀 Header planning",
  );
});

test("Open artifacts from the mobile menu", async () => {
  context.mocks.browser.matchMedia(false);
  await setupHeaderPage();
  click(buttonNamed("More actions"));
  await screen.findByRole("menu");
  click(menuItemNamed("Artifacts"));
  const artifacts = await screen.findByTestId("thread-sidebar-artifacts");
  expect(artifacts).toBeVisible();
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
      "Automations",
      "Artifacts",
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
  expect(screen.queryByLabelText("Pin chat")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("More actions")).not.toBeInTheDocument();
  click(screen.getByText("Review the header layout"));
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
  click(buttonNamed("Pin chat"));
  const error = await screen.findByText("Pin request failed");
  expect(error).toBeInTheDocument();
  expect(buttonNamed("Unpin chat")).toBeEnabled();
  expect(buttonNamed("Unpin chat")).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByText("Chat pinned")).not.toBeInTheDocument();
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
  await waitFor(() => {
    expect(screen.getByTestId("chat-thread-menu-trigger")).toHaveAttribute(
      "data-pinned",
      "true",
    );
  });
  click(buttonNamed("More actions"));
  await waitFor(() => {
    expect(menuItemNamed("Unpin chat")).toBeEnabled();
  });
  click(menuItemNamed("Unpin chat"));
  await waitFor(() => {
    expect(screen.getByTestId("chat-thread-menu-trigger")).toHaveAttribute(
      "data-pinned",
      "false",
    );
  });

  pinResponse.resolve();
  await screen.findByText("Unpin request failed");
  expect(screen.getByText("Pin request failed")).toBeInTheDocument();
  click(buttonNamed("More actions"));
  await waitFor(() => {
    expect(menuItemNamed("Pin chat")).toBeEnabled();
  });
  expect(screen.queryByText("Chat pinned")).not.toBeInTheDocument();
  expect(screen.queryByText("Chat unpinned")).not.toBeInTheDocument();
});
