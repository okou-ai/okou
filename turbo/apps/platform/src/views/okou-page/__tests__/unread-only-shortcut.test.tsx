import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

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

const MAC_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36";

function unreadShortcutEvent(): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    code: "KeyU",
    ctrlKey: false,
    key: "u",
    metaKey: true,
    shiftKey: true,
  });
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

function preparePage(): Promise<void> {
  context.mocks.browser.userAgent(MAC_USER_AGENT);
  prepareDefaultAgent();
  mockSidebarThreadStory([createThread(EXISTING_THREAD_ID, "Release plan")]);
  return setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });
}

test("Toggle unread-only chats and expose the shortcut", async () => {
  await preparePage();

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
  expect(menuItem).toHaveTextContent("⌘⇧U");
  click(menuItem);
  await expect(
    within(list).findByText("No unread chats"),
  ).resolves.toBeInTheDocument();

  const composer = await screen.findByRole("textbox", { name: "Message" });
  composer.focus();
  const showAllEvent = unreadShortcutEvent();
  composer.dispatchEvent(showAllEvent);
  expect(showAllEvent.defaultPrevented).toBeTruthy();
  await expect(
    within(list).findByText("Release plan"),
  ).resolves.toBeInTheDocument();
});

test("Show all chats from the empty unread state", async () => {
  await preparePage();

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
