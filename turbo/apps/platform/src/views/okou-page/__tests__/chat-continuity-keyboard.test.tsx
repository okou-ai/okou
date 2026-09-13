import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  chatThreadRenameContract,
  chatThreadPinContract,
  chatThreadUnpinContract,
  type ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { search } from "../../../signals/location.ts";
import {
  continuitySidebarLink,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();

interface RenameRequest {
  readonly threadId: string;
  readonly title: string;
}

function threadContainer(threadId: string): HTMLElement {
  const container = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${threadId}"]`,
  );
  if (!container) {
    throw new Error(`Expected chat pane ${threadId}`);
  }
  return container;
}

function composerIn(threadId: string): HTMLElement {
  const composer = threadContainer(threadId).querySelector<HTMLElement>(
    '[role="textbox"][aria-label="Message"]',
  );
  if (!composer) {
    throw new Error(`Expected composer for ${threadId}`);
  }
  return composer;
}

function pinnedIndicator(threadId: string): HTMLElement | null {
  const row = continuitySidebarLink(threadId).parentElement;
  if (!row) {
    throw new Error(`Expected sidebar row for ${threadId}`);
  }
  return within(row).queryByLabelText("Pinned");
}

function openThreadMenu(threadId: string): void {
  const row = continuitySidebarLink(threadId).parentElement;
  if (!row) {
    throw new Error(`Expected sidebar row for ${threadId}`);
  }
  click(within(row).getByLabelText("Open chat menu"));
}

function menuItemNamedOrNull(name: string): HTMLElement | null {
  return (
    queryAllByRoleFast("menuitem").find((candidate) => {
      return candidate.getAttribute("aria-label") === name;
    }) ?? null
  );
}

function menuItemNamed(name: string): HTMLElement {
  const item = menuItemNamedOrNull(name);
  if (!item) {
    throw new Error(`Expected ${name} menu item`);
  }
  return item;
}

function dispatchPinShortcut(
  target: HTMLElement,
  options: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "D",
    code: "KeyD",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  fireEvent(target, event);
  return event;
}

function installRenameBoundary(requests: RenameRequest[]): void {
  context.mocks.api(
    chatThreadRenameContract.rename,
    ({ body, params, respond }) => {
      requests.push({ threadId: params.id, title: body.title });
      return respond(204);
    },
  );
}

function expectPaneTitle(
  thread: ChatThreadSnapshotProjection,
  title: string,
): void {
  expect(threadContainer(thread.id)).toHaveTextContent(title);
}

async function openNeighboringChatPanes(mainThread: "current" | "newest") {
  const current = continuityThread(16, 2, "Current keyboard chat");
  const side = continuityThread(16, 3, "Side keyboard chat");
  const newest = continuityThread(16, 4, "Newest neighboring chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 16,
    threads: [current, side, newest],
  });

  const main = mainThread === "current" ? current : newest;
  await setupPage({
    context,
    path: `/chats/${main.id}?sidebar=${side.id}`,
    locale: "en-US",
    ...workspace.pageOptions,
  });

  await waitFor(() => {
    expect(composerIn(main.id)).toBeVisible();
    expect(composerIn(side.id)).toBeVisible();
    expect(threadContainer(side.id)).toBeVisible();
  });
  return { current, side, newest };
}

test("Move to a newer chat from the main pane without changing the side pane", async () => {
  const user = userEvent.setup({ delay: null });
  const { current, side, newest } = await openNeighboringChatPanes("current");
  const mainComposer = composerIn(current.id);
  mainComposer.focus();
  expect(mainComposer).toHaveFocus();
  await user.keyboard("{Control>}{Shift>}{ArrowUp}{/Shift}{/Control}");

  await waitFor(() => {
    expect(threadContainer(newest.id)).toBeVisible();
    expect(continuitySidebarLink(newest.id)).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  expect(continuitySidebarLink(newest.id)).toHaveAttribute(
    "aria-current",
    "page",
  );
  expectPaneTitle(side, "Side keyboard chat");
});

test("Move to an older chat from the side pane without changing the main pane", async () => {
  const user = userEvent.setup({ delay: null });
  const { current, side, newest } = await openNeighboringChatPanes("newest");
  expect(continuitySidebarLink(newest.id)).toHaveAttribute(
    "aria-current",
    "page",
  );
  const sideContainer = threadContainer(side.id);
  sideContainer.focus();
  expect(sideContainer).toHaveFocus();
  await user.keyboard("{Control>}{Shift>}{ArrowDown}{/Shift}{/Control}");

  await waitFor(() => {
    expect(threadContainer(current.id)).toBeVisible();
    expect(
      document.querySelector(`[data-chat-thread-container-id="${side.id}"]`),
    ).toBeNull();
    expect(continuitySidebarLink(newest.id)).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  expectPaneTitle(newest, "Newest neighboring chat");
  expectPaneTitle(current, "Current keyboard chat");
});

test("Open the emoji picker for the focused chat", async () => {
  const current = continuityThread(17, 1, "Project plan");
  const workspace = installContinuityWorkspace(context, {
    caseId: 17,
    threads: [current],
  });

  await setupPage({
    context,
    path: `/chats/${current.id}`,
    ...workspace.pageOptions,
  });

  await waitFor(() => {
    expect(composerIn(current.id)).toBeVisible();
  });
  composerIn(current.id).focus();
  await userEvent.keyboard("{Shift>}{F2}{/Shift}");
  const searchInput = await screen.findByLabelText("Search emoji");
  await waitFor(() => {
    expect(searchInput).toHaveFocus();
  });
});

test("Add, replace, or remove the focused chat icon with shortcuts", async () => {
  const current = continuityThread(18, 1, "Project plan");
  const emojiOnlySide = continuityThread(18, 2, "❓");
  const workspace = installContinuityWorkspace(context, {
    caseId: 18,
    threads: [current, emojiOnlySide],
  });
  const renameRequests: RenameRequest[] = [];
  installRenameBoundary(renameRequests);

  await setupPage({
    context,
    path: `/chats/${current.id}?sidebar=${emojiOnlySide.id}`,
    ...workspace.pageOptions,
  });

  await waitFor(() => {
    expect(composerIn(current.id)).toBeVisible();
    expect(composerIn(emojiOnlySide.id)).toBeVisible();
  });
  const currentLink = continuitySidebarLink(current.id);
  composerIn(current.id).focus();
  await userEvent.keyboard("{Control>}{Shift>}1{/Shift}{/Control}");
  await waitFor(() => {
    expect(renameRequests.at(-1)).toStrictEqual({
      threadId: current.id,
      title: "✅ Project plan",
    });
    expect(currentLink).toHaveTextContent("✅ Project plan");
  });
  expect(screen.queryByLabelText("Search emoji")).toBeNull();

  composerIn(current.id).focus();
  await userEvent.keyboard("{Control>}{Shift>}2{/Shift}{/Control}");
  await waitFor(() => {
    expect(renameRequests.at(-1)).toStrictEqual({
      threadId: current.id,
      title: "🔥 Project plan",
    });
    expect(currentLink).toHaveTextContent("🔥 Project plan");
  });

  composerIn(current.id).focus();
  await userEvent.keyboard("{Control>}{Shift>}0{/Shift}{/Control}");
  await waitFor(() => {
    expect(renameRequests.at(-1)).toStrictEqual({
      threadId: current.id,
      title: "Project plan",
    });
    expect(currentLink).toHaveTextContent("Project plan");
  });

  const requestCountBeforeDeclinedRemoval = renameRequests.length;
  threadContainer(emojiOnlySide.id).focus();
  await userEvent.keyboard("{Control>}{Shift>}0{/Shift}{/Control}");
  expect(continuitySidebarLink(emojiOnlySide.id)).toHaveTextContent("❓");
  expect(threadContainer(emojiOnlySide.id)).toHaveTextContent("❓");
  expect(renameRequests).toHaveLength(requestCountBeforeDeclinedRemoval);
});

test("Show keyboard help without stealing composer input", async () => {
  const thread = continuityThread(19, 1, "Keyboard help chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 19,
    threads: [thread],
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  await userEvent.type(composer, "?!");
  expect(composer).toHaveTextContent("?!");
  expect(document.body).not.toHaveTextContent("Keyboard Shortcuts");

  const container = threadContainer(thread.id);
  container.focus();
  fireEvent.keyDown(container, {
    key: "?",
    code: "Slash",
    shiftKey: true,
  });

  const heading = await screen.findByText("Keyboard Shortcuts");
  const dialog = heading.closest<HTMLElement>('[role="dialog"]');
  if (!dialog) {
    throw new Error("Expected keyboard shortcut dialog");
  }
  expect(dialog).toHaveTextContent("Previous thread");
  expect(dialog).toHaveTextContent("Next thread");
  expect(dialog).toHaveTextContent("Rename chat");
  expect(dialog).toHaveTextContent("Change icon");
  expect(composer).toHaveTextContent("?!");
});

test.each([
  {
    platform: "Mac",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    modifier: "Meta",
  },
  {
    platform: "Windows",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    modifier: "Control",
  },
])(
  "Pin and unpin the focused chat optimistically on $platform",
  async ({ userAgent, modifier }) => {
    context.mocks.browser.userAgent(userAgent);
    const main = continuityThread(70, 1, "Main pin shortcut chat");
    const side = continuityThread(70, 2, "Side pin shortcut chat");
    const workspace = installContinuityWorkspace(context, {
      caseId: 70,
      threads: [main, side],
    });
    const pinRequested = context.mocks.deferred<void>();
    const pinResponse = context.mocks.deferred<void>();
    const unpinRequested = context.mocks.deferred<void>();
    context.mocks.api(chatThreadPinContract.pin, async ({ respond }) => {
      pinRequested.resolve();
      await pinResponse.promise;
      return respond(204);
    });
    context.mocks.api(chatThreadUnpinContract.unpin, ({ respond }) => {
      unpinRequested.resolve();
      return respond(204);
    });

    await setupPage({
      context,
      path: `/chats/${main.id}?sidebar=${side.id}`,
      ...workspace.pageOptions,
    });
    await waitFor(() => {
      expect(composerIn(main.id)).toBeVisible();
      expect(composerIn(side.id)).toBeVisible();
    });

    const sideComposer = composerIn(side.id);
    await userEvent.type(sideComposer, "Keep this draft");
    const event = dispatchPinShortcut(sideComposer, {
      metaKey: modifier === "Meta",
      ctrlKey: modifier === "Control",
    });
    expect(event.defaultPrevented).toBeTruthy();
    await pinRequested.promise;
    await waitFor(() => {
      expect(pinnedIndicator(side.id)).toBeVisible();
    });
    expect(pinnedIndicator(main.id)).toBeNull();
    expect(sideComposer).toHaveFocus();
    expect(sideComposer).toHaveTextContent("Keep this draft");
    pinResponse.resolve();

    await userEvent.keyboard(`{${modifier}>}{Shift>}D{/Shift}{/${modifier}}`);
    await unpinRequested.promise;
    await waitFor(() => {
      expect(pinnedIndicator(side.id)).toBeNull();
    });
    expect(sideComposer).toHaveTextContent("Keep this draft");

    threadContainer(main.id).focus();
    await userEvent.keyboard(`{${modifier}>}{Shift>}D{/Shift}{/${modifier}}`);
    await waitFor(() => {
      expect(pinnedIndicator(main.id)).toBeVisible();
    });
    expect(pinnedIndicator(side.id)).toBeNull();
  },
);

test("Pin the main chat when neither pane owns keyboard focus", async () => {
  const main = continuityThread(71, 1, "Default pin shortcut chat");
  const side = continuityThread(71, 2, "Other pin shortcut chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 71,
    threads: [main, side],
  });
  context.mocks.api(chatThreadPinContract.pin, ({ respond }) => {
    return respond(204);
  });
  await setupPage({
    context,
    path: `/chats/${main.id}?sidebar=${side.id}`,
    ...workspace.pageOptions,
  });
  await waitFor(() => {
    expect(composerIn(side.id)).toBeVisible();
  });
  const sideComposer = composerIn(side.id);
  sideComposer.focus();
  sideComposer.blur();
  expect(document.body).toHaveFocus();

  const event = dispatchPinShortcut(document.body);
  expect(event.defaultPrevented).toBeTruthy();
  await waitFor(() => {
    expect(pinnedIndicator(main.id)).toBeVisible();
  });
  expect(pinnedIndicator(side.id)).toBeNull();
});

test("Apply displayed shortcuts to the chat whose menu is open", async () => {
  const main = continuityThread(72, 1, "Focused shortcut chat");
  const menuTarget = continuityThread(72, 2, "Menu shortcut chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 72,
    threads: [main, menuTarget],
  });
  context.mocks.api(chatThreadPinContract.pin, ({ respond }) => {
    return respond(204);
  });

  await setupPage({
    context,
    path: `/chats/${main.id}`,
    ...workspace.pageOptions,
  });
  await waitFor(() => {
    expect(composerIn(main.id)).toBeVisible();
    expect(continuitySidebarLink(menuTarget.id)).toBeVisible();
  });
  composerIn(main.id).focus();

  openThreadMenu(menuTarget.id);
  const pinItem = menuItemNamed("Pin chat");
  await waitFor(() => {
    expect(pinItem).toHaveFocus();
  });
  await userEvent.keyboard("{Control>}{Shift>}D{/Shift}{/Control}");

  await waitFor(() => {
    expect(pinnedIndicator(menuTarget.id)).toBeVisible();
  });
  expect(pinnedIndicator(main.id)).toBeNull();

  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(menuItemNamedOrNull("Unpin chat")).toBeNull();
  });

  openThreadMenu(menuTarget.id);
  const unpinItem = menuItemNamed("Unpin chat");
  await waitFor(() => {
    expect(unpinItem).toHaveFocus();
  });
  await userEvent.keyboard("{F2}");

  const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
  expect(within(dialog).getByPlaceholderText("Chat title")).toHaveValue(
    "Menu shortcut chat",
  );
});

test("Respect composition, held keys, dialogs, and navigation for pin shortcuts", async () => {
  const thread = continuityThread(73, 1, "Scoped pin shortcut chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 73,
    threads: [thread],
  });
  context.mocks.api(chatThreadPinContract.pin, ({ respond }) => {
    return respond(204);
  });
  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  composer.focus();

  expect(
    dispatchPinShortcut(composer, { isComposing: true }).defaultPrevented,
  ).toBeFalsy();
  expect(
    dispatchPinShortcut(composer, { keyCode: 229 }).defaultPrevented,
  ).toBeFalsy();

  await userEvent.keyboard("{Control>}{Shift>}D{/Shift}{/Control}");
  await waitFor(() => {
    expect(pinnedIndicator(thread.id)).toBeVisible();
  });
  expect(
    dispatchPinShortcut(composer, { repeat: true }).defaultPrevented,
  ).toBeTruthy();
  expect(pinnedIndicator(thread.id)).toBeVisible();

  threadContainer(thread.id).focus();
  await userEvent.keyboard("{Shift>}?{/Shift}");
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("Pin / unpin chat");
  expect(dispatchPinShortcut(dialog).defaultPrevented).toBeFalsy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(pinnedIndicator(thread.id)).toBeVisible();

  const agentsLink = queryAllByRoleFast("link").find((link) => {
    return link.textContent?.trim() === "Agents";
  });
  if (!agentsLink) {
    throw new Error("Expected Agents navigation link");
  }
  click(agentsLink);
  await screen.findByRole("heading", { name: "Agents" });
  expect(dispatchPinShortcut(document.body).defaultPrevented).toBeFalsy();
});

test("Close the split view by selecting its chat again in the sidebar", async () => {
  const main = continuityThread(78, 1, "Split view main chat");
  const side = continuityThread(78, 2, "Split view side chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 78,
    threads: [main, side],
  });
  await setupPage({
    context,
    path: `/chats/${main.id}?sidebar=${side.id}`,
    ...workspace.pageOptions,
  });
  await waitFor(() => {
    expect(threadContainer(side.id)).toBeVisible();
  });

  // Alt-selecting the chat already shown beside the main one closes that pane.
  fireEvent.click(continuitySidebarLink(side.id), { altKey: true });

  await waitFor(() => {
    expect(
      document.querySelector(`[data-chat-thread-container-id="${side.id}"]`),
    ).toBeNull();
  });
  expect(threadContainer(main.id)).toBeVisible();
  expect(new URLSearchParams(search()).has("sidebar")).toBeFalsy();
});
