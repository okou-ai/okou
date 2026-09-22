import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import {
  context,
  createThread,
  EXISTING_THREAD_ID,
  mockSidebarThreadStory,
  openChatListMenu,
  prepareDefaultAgent,
  setupSidebarPage,
} from "./sidebar-test-helpers.tsx";

const platforms = [
  {
    name: "macOS",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36",
    metaKey: true,
    ctrlKey: false,
    label: "⌘⇧U",
    helpParts: ["⌘", "⇧", "u"],
  },
  {
    name: "Windows",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    metaKey: false,
    ctrlKey: true,
    label: "Ctrl+Shift+U",
    helpParts: ["Ctrl", "Shift", "u"],
  },
] as const;

function unreadShortcutEvent({
  ctrlKey,
  isComposing = false,
  keyCode = 0,
  metaKey,
  repeat = false,
}: {
  ctrlKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  metaKey: boolean;
  repeat?: boolean;
}): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    code: "KeyU",
    ctrlKey,
    isComposing,
    key: "u",
    keyCode,
    metaKey,
    repeat,
    shiftKey: true,
  });
}

function chatListTitleRow(list: HTMLElement): HTMLElement {
  const menuButton = within(list).getByLabelText("Open chat list menu");
  const titleRow = menuButton.parentElement?.parentElement;
  if (!(titleRow instanceof HTMLElement)) {
    throw new Error("Chat list title row not found");
  }
  return titleRow;
}

function unreadOnlyMenuItem(): HTMLElement {
  const item = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent
      ?.replace(/\s+/gu, " ")
      .trim()
      .startsWith("Unread");
  });
  if (!item) {
    throw new Error("Unread menu item not found");
  }
  return item;
}

function preparePage(userAgent: string, enabled: boolean): Promise<void> {
  context.mocks.browser.userAgent(userAgent);
  prepareDefaultAgent();
  mockSidebarThreadStory([createThread(EXISTING_THREAD_ID, "Release plan")]);
  return setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
    featureSwitches: {
      [FeatureSwitchKey.ChatUnreadOnlyShortcut]: enabled,
    },
  });
}

test.each(platforms)(
  "Toggle unread-only chats and expose the shortcut on $name",
  async ({ ctrlKey, helpParts, label, metaKey, userAgent }) => {
    await preparePage(userAgent, true);

    const list = await screen.findByTestId("chat-list-column");
    await expect(
      within(list).findByText("Release plan"),
    ).resolves.toBeInTheDocument();

    openChatListMenu();
    const menuItem = unreadOnlyMenuItem();
    expect(menuItem).toHaveAttribute(
      "aria-keyshortcuts",
      "Meta+Shift+U Control+Shift+U",
    );
    expect(menuItem).toHaveTextContent(label);
    click(menuItem);
    await expect(
      within(list).findByText("No unread chats"),
    ).resolves.toBeInTheDocument();

    const composer = await screen.findByRole("textbox", { name: "Message" });
    composer.focus();
    const showAllEvent = unreadShortcutEvent({ ctrlKey, metaKey });
    composer.dispatchEvent(showAllEvent);
    expect(showAllEvent.defaultPrevented).toBeTruthy();
    await expect(
      within(list).findByText("Release plan"),
    ).resolves.toBeInTheDocument();

    for (const composition of [
      { isComposing: true },
      { keyCode: 229 },
    ] as const) {
      const compositionEvent = unreadShortcutEvent({
        ctrlKey,
        metaKey,
        ...composition,
      });
      composer.dispatchEvent(compositionEvent);
      expect(compositionEvent.defaultPrevented).toBeFalsy();
      expect(within(list).getByText("Release plan")).toBeInTheDocument();
    }

    click(chatListTitleRow(list));
    await waitFor(() => {
      expect(within(list).queryByText("Release plan")).not.toBeInTheDocument();
    });

    const repeatedEvent = unreadShortcutEvent({
      ctrlKey,
      metaKey,
      repeat: true,
    });
    composer.dispatchEvent(repeatedEvent);
    expect(repeatedEvent.defaultPrevented).toBeFalsy();
    expect(within(list).queryByText("No unread chats")).not.toBeInTheDocument();

    const showUnreadEvent = unreadShortcutEvent({ ctrlKey, metaKey });
    composer.dispatchEvent(showUnreadEvent);
    expect(showUnreadEvent.defaultPrevented).toBeTruthy();
    await expect(
      within(list).findByText("No unread chats"),
    ).resolves.toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    const dialog = await screen.findByRole("dialog", {
      name: "Keyboard Shortcuts",
    });
    const helpLabel = within(dialog).getByText("Unread");
    expect(helpLabel).toBeInTheDocument();
    const helpRow = helpLabel.parentElement;
    if (!helpRow) {
      throw new Error("Unread shortcut row not found");
    }
    for (const part of helpParts) {
      expect(within(helpRow).getByText(part)).toBeInTheDocument();
    }
  },
);

test("Show all chats from the empty unread state", async () => {
  await preparePage(platforms[0].userAgent, true);

  const list = await screen.findByTestId("chat-list-column");
  await expect(
    within(list).findByText("Release plan"),
  ).resolves.toBeInTheDocument();

  openChatListMenu();
  click(unreadOnlyMenuItem());
  await expect(
    within(list).findByText("No unread chats"),
  ).resolves.toBeInTheDocument();

  click(within(list).getByText("Show all chats"));
  await expect(
    within(list).findByText("Release plan"),
  ).resolves.toBeInTheDocument();
  expect(within(list).queryByText("No unread chats")).not.toBeInTheDocument();
});

test("Leave the browser shortcut and hints untouched when the rollout is off", async () => {
  const { userAgent, metaKey, ctrlKey, label } = platforms[0];
  await preparePage(userAgent, false);

  const list = await screen.findByTestId("chat-list-column");
  await expect(
    within(list).findByText("Release plan"),
  ).resolves.toBeInTheDocument();

  openChatListMenu();
  const menuItem = unreadOnlyMenuItem();
  expect(menuItem).not.toHaveAttribute("aria-keyshortcuts");
  expect(menuItem).not.toHaveTextContent(label);
  fireEvent.keyDown(menuItem, { key: "Escape" });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  composer.focus();
  const event = unreadShortcutEvent({ ctrlKey, metaKey });
  composer.dispatchEvent(event);
  expect(event.defaultPrevented).toBeFalsy();
  expect(within(list).getByText("Release plan")).toBeInTheDocument();

  fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
  const dialog = await screen.findByRole("dialog", {
    name: "Keyboard Shortcuts",
  });
  expect(within(dialog).queryByText("Unread")).not.toBeInTheDocument();
});

test("Preserve Linux Unicode input while allowing the shortcut outside editors", async () => {
  await preparePage(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36",
    true,
  );

  const list = await screen.findByTestId("chat-list-column");
  await expect(
    within(list).findByText("Release plan"),
  ).resolves.toBeInTheDocument();
  const composer = await screen.findByRole("textbox", { name: "Message" });
  composer.focus();

  const editorEvent = unreadShortcutEvent({ ctrlKey: true, metaKey: false });
  composer.dispatchEvent(editorEvent);
  expect(editorEvent.defaultPrevented).toBeFalsy();
  expect(within(list).getByText("Release plan")).toBeInTheDocument();

  const documentEvent = unreadShortcutEvent({ ctrlKey: true, metaKey: false });
  document.dispatchEvent(documentEvent);
  expect(documentEvent.defaultPrevented).toBeTruthy();
  await expect(
    within(list).findByText("No unread chats"),
  ).resolves.toBeInTheDocument();
});
