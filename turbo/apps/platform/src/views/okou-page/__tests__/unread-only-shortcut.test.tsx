import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import {
  context,
  createThread,
  EXISTING_THREAD_ID,
  INCIDENT_THREAD_ID,
  menuItemByText,
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
  expect(pathname()).toBe(`/chats/${EXISTING_THREAD_ID}`);

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

test("Open the first unread chat from the shortcut", async () => {
  context.mocks.browser.userAgent(MAC_USER_AGENT);
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Incident follow-up"),
  ]);
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: {},
      threads: { [INCIDENT_THREAD_ID]: "unread" },
      unreadAt: { [INCIDENT_THREAD_ID]: "2026-03-10T00:05:00Z" },
    });
  });
  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  const list = await screen.findByTestId("chat-list-column");
  await expect(
    within(list).findByText("Incident follow-up"),
  ).resolves.toBeInTheDocument();

  document.dispatchEvent(unreadShortcutEvent());

  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${INCIDENT_THREAD_ID}`);
  });
});

test("Only the latest shortcut toggle navigates", async () => {
  context.mocks.browser.userAgent(MAC_USER_AGENT);
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Incident follow-up"),
  ]);
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: {},
      threads: { [INCIDENT_THREAD_ID]: "unread" },
      unreadAt: { [INCIDENT_THREAD_ID]: "2026-03-10T00:05:00Z" },
    });
  });
  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  const list = await screen.findByTestId("chat-list-column");
  await expect(
    within(list).findByText("Incident follow-up"),
  ).resolves.toBeInTheDocument();

  document.dispatchEvent(unreadShortcutEvent());
  document.dispatchEvent(unreadShortcutEvent());

  await expect(
    within(list).findByText("Release plan"),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(`/chats/${EXISTING_THREAD_ID}`);
});

test("Keep the current chat when the selected filter lists it", async () => {
  context.mocks.browser.userAgent(MAC_USER_AGENT);
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Incident follow-up"),
  ]);
  await setupSidebarPage({
    context,
    path: `/chats/${INCIDENT_THREAD_ID}`,
  });

  const list = await screen.findByTestId("chat-list-column");
  await expect(
    within(list).findByText("Release plan"),
  ).resolves.toBeInTheDocument();

  openChatListMenu();
  click(unreadOnlyMenuItem());
  await expect(
    within(list).findByText("No unread chats"),
  ).resolves.toBeInTheDocument();

  openChatListMenu();
  click(menuItemByText("All chats"));
  await expect(
    within(list).findByText("Release plan"),
  ).resolves.toBeInTheDocument();
  expect(pathname()).toBe(`/chats/${INCIDENT_THREAD_ID}`);
});
