import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { chatThreadPinOrderContract } from "@okouai/api-contracts/contracts/chat-threads";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";
import {
  CHAT_LIST_AGENT_ID,
  chatListThread,
  sidebarThreadLinks,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";
import { menuItemByText } from "./sidebar-test-helpers.tsx";

const context = testContext();
const INITIAL_ORDER = [
  "First pin",
  "Middle pin",
  "Last pin",
  "Regular chat",
] as const;
const MOVED_UP_ORDER = [
  "Middle pin",
  "First pin",
  "Last pin",
  "Regular chat",
] as const;

async function prepare(main: number | null = 1, side = false) {
  const pinnedAt = "2026-10-01T00:00:00Z";
  const threads = [
    chatListThread(3, "First pin", { pinnedAt, pinOrder: "a0" }),
    chatListThread(2, "Middle pin", { pinnedAt, pinOrder: "a1" }),
    chatListThread(1, "Last pin", { pinnedAt, pinOrder: "a2" }),
    chatListThread(4, "Regular chat"),
  ];
  const workspace = installContinuityWorkspace(context, {
    caseId: 71,
    threads,
  });
  context.mocks.api(chatThreadPinOrderContract.reorder, ({ respond }) => {
    return respond(204);
  });
  const path =
    main === null
      ? `/agents/${CHAT_LIST_AGENT_ID}/chat`
      : `/chats/${threads[main]!.id}${side ? `?sidebar=${threads[2]!.id}` : ""}`;
  await setupPage({
    context,
    path,
    ...workspace.pageOptions,
    featureSwitches: {
      [FeatureSwitchKey.ChatThreadArchiving]: true,
      [FeatureSwitchKey.ChatThreadMuting]: true,
      [FeatureSwitchKey.ChatThreadInlineRename]: true,
    },
  });
  await expectOrder(INITIAL_ORDER);
  await screen.findAllByRole("textbox", { name: "Message" });
  if (side) {
    await within(threadPane(threads[2]!.id)).findByRole("textbox", {
      name: "Message",
    });
  }
  return { threads, path };
}

async function expectOrder(titles: readonly string[]) {
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(titles);
  });
}

function threadLink(title: string): HTMLElement {
  const link = sidebarThreadLinks().find((candidate) => {
    return candidate.textContent?.includes(title);
  });
  if (!link) {
    throw new Error(`Expected chat link: ${title}`);
  }
  return link;
}

function threadPane(threadId: string): HTMLElement {
  const pane = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${threadId}"]`,
  );
  if (!pane) {
    throw new Error(`Expected chat pane: ${threadId}`);
  }
  return pane;
}

function menuButton(title: string): HTMLElement {
  const row = threadLink(title).parentElement;
  if (!row) {
    throw new Error(`Expected chat row: ${title}`);
  }
  return within(row).getByLabelText("Open chat menu");
}

function dispatchMove(
  target: HTMLElement,
  options: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "ArrowUp",
    code: "ArrowUp",
    altKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  fireEvent(target, event);
  return event;
}

test("Move the current pin one position in either direction without navigating", async () => {
  const { path } = await prepare();
  const user = userEvent.setup();
  const outsidePane = screen.getByLabelText("Open chat list menu");
  outsidePane.focus();
  await user.keyboard("{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}");
  await expectOrder(MOVED_UP_ORDER);
  expect(pathname()).toBe(path);
  expect(threadLink("Middle pin")).toHaveAttribute("aria-current", "page");
  expect(outsidePane).toHaveFocus();

  await user.keyboard("{Alt>}{Shift>}{ArrowDown}{/Shift}{/Alt}");
  await expectOrder(INITIAL_ORDER);
  expect(pathname()).toBe(path);
});

test("Stop at the first and last pinned positions", async () => {
  await prepare();
  const user = userEvent.setup();
  threadLink("First pin").focus();
  await user.keyboard("{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}");
  expect(sidebarThreadTitles()).toStrictEqual(INITIAL_ORDER);
  expect(threadLink("First pin")).toHaveFocus();

  await user.keyboard("{Alt>}{Shift>}{ArrowDown}{/Shift}{/Alt}");
  await expectOrder(MOVED_UP_ORDER);
  threadLink("Last pin").focus();
  await user.keyboard("{Alt>}{Shift>}{ArrowDown}{/Shift}{/Alt}");
  expect(sidebarThreadTitles()).toStrictEqual(MOVED_UP_ORDER);
  expect(threadLink("Last pin")).toHaveFocus();
});

test.each(["row", "menu trigger", "menu item"])(
  "Reorder the focused sidebar %s on the new-chat page",
  async (target) => {
    const { path } = await prepare(null);
    const user = userEvent.setup();
    let focusedTarget: HTMLElement;
    if (target === "row") {
      focusedTarget = threadLink("Middle pin");
    } else if (target === "menu trigger") {
      focusedTarget = menuButton("Middle pin");
    } else {
      click(menuButton("Middle pin"));
      await screen.findByRole("menu");
      focusedTarget = menuItemByText("Move up");
    }
    focusedTarget.focus();
    await user.keyboard("{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}");
    await expectOrder(MOVED_UP_ORDER);
    expect(pathname()).toBe(path);
    expect(focusedTarget).toHaveFocus();
  },
);

test("Reorder the focused side pane while keeping the main chat selected", async () => {
  const { threads } = await prepare(1, true);
  const pane = threadPane(threads[2]!.id);
  pane.focus();
  const user = userEvent.setup();
  await user.keyboard("{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}");
  await expectOrder(["First pin", "Last pin", "Middle pin", "Regular chat"]);
  expect(pathname()).toBe(`/chats/${threads[1]!.id}`);
  expect(threadLink("Middle pin")).toHaveAttribute("aria-current", "page");
  expect(pane).toHaveFocus();
});

test("Keep composer editing and inline rename input in control of their keys", async () => {
  await prepare();
  const composer = await screen.findByRole("textbox", { name: "Message" });
  composer.focus();
  expect(dispatchMove(composer).defaultPrevented).toBeFalsy();
  expect(sidebarThreadTitles()).toStrictEqual(INITIAL_ORDER);

  const user = userEvent.setup();
  await user.dblClick(threadLink("Middle pin"));
  const input = await screen.findByRole("textbox", { name: "Rename chat" });
  expect(input).toHaveFocus();
  expect(dispatchMove(input).defaultPrevented).toBeFalsy();
  expect(input).toHaveValue("Middle pin");
  await user.keyboard("{Escape}");
  expect(threadLink("Middle pin")).toHaveFocus();
  await user.keyboard("{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}");
  await expectOrder(MOVED_UP_ORDER);
});

test("Leave composition, held keys, and different modifiers unhandled", async () => {
  await prepare();
  document.body.focus();
  for (const options of [
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { altKey: false },
    { shiftKey: false },
    { ctrlKey: true },
    { metaKey: true },
  ]) {
    expect(dispatchMove(document.body, options).defaultPrevented).toBeFalsy();
  }
  expect(sidebarThreadTitles()).toStrictEqual(INITIAL_ORDER);
  const user = userEvent.setup();
  await user.keyboard("{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}");
  await expectOrder(MOVED_UP_ORDER);
});

test("Do not reorder an unpinned chat or the main chat from another menu", async () => {
  await prepare();
  threadLink("Regular chat").focus();
  expect(dispatchMove(threadLink("Regular chat")).defaultPrevented).toBeFalsy();
  click(screen.getByLabelText("Open chat list menu"));
  await screen.findByRole("menu");
  const inbox = menuItemByText("Inbox");
  inbox.focus();
  const user = userEvent.setup();
  await user.keyboard("{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}");
  await user.keyboard("{Escape}");
  await expectOrder(INITIAL_ORDER);
});

test.each([
  ["Unread", "No unread chats"],
  ["Archived", "No archived chats"],
  ["Muted", "No muted chats"],
])("Keep the %s filter from reordering hidden pins", async (filter, empty) => {
  await prepare();
  click(screen.getByLabelText("Open chat list menu"));
  await screen.findByRole("menu");
  click(menuItemByText(filter));
  const list = screen.getByTestId("chat-list-column");
  await expect(within(list).findByText(empty)).resolves.toBeInTheDocument();
  document.body.focus();
  expect(dispatchMove(document.body).defaultPrevented).toBeFalsy();

  click(screen.getByLabelText("Open chat list menu"));
  await screen.findByRole("menu");
  click(menuItemByText("Inbox"));
  await expectOrder(INITIAL_ORDER);
});

test.each([
  [
    "Windows",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Shift+Alt+↑",
    "Shift+Alt+↓",
  ],
  ["Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "⇧⌥↑", "⇧⌥↓"],
])(
  "Show %s menu hints and pinned shortcut help",
  async (_platform, userAgent, up, down) => {
    context.mocks.browser.userAgent(userAgent);
    await prepare();
    click(menuButton("Middle pin"));
    await screen.findByRole("menu");
    expect(menuItemByText("Move up")).toHaveTextContent(up);
    expect(menuItemByText("Move up")).toHaveAttribute(
      "aria-keyshortcuts",
      "Alt+Shift+ArrowUp",
    );
    expect(menuItemByText("Move down")).toHaveTextContent(down);
    expect(menuItemByText("Move down")).toHaveAttribute(
      "aria-keyshortcuts",
      "Alt+Shift+ArrowDown",
    );
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    document.body.focus();
    await user.keyboard("{Shift>}?{/Shift}");
    const dialog = await screen.findByRole("dialog", {
      name: "Keyboard Shortcuts",
    });
    expect(within(dialog).getByText("Pinned")).toBeInTheDocument();
    expect(within(dialog).getByText("Move up")).toBeInTheDocument();
    expect(within(dialog).getByText("Move down")).toBeInTheDocument();
    expect(dispatchMove(document.body).defaultPrevented).toBeFalsy();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    await expectOrder(INITIAL_ORDER);
  },
);
