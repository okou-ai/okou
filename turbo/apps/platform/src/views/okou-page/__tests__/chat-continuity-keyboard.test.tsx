import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  chatThreadRenameContract,
  chatThreadPinContract,
  chatThreadUnpinContract,
  type ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import { expect, test, describe, beforeEach, it } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
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

function expectPinned(threadId: string, title: string): void {
  expect(continuitySidebarLink(threadId)).toHaveAccessibleName(
    `${title} Pinned`,
  );
}

function expectNotPinned(threadId: string, title: string): void {
  expect(continuitySidebarLink(threadId)).toHaveAccessibleName(title);
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

describe("with neighboring chat panes", () => {
  async function prepareScenario() {
    const user = userEvent.setup({ delay: null });
    const { current, side, newest } = await openNeighboringChatPanes("current");
    const mainComposer = composerIn(current.id);
    mainComposer.focus();
    return { mainComposer, user, newest, side };
  }
  let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
  beforeEach(async () => {
    preparedScenario = await prepareScenario();
  });
  it("move to a newer chat from the main pane without changing the side pane", async () => {
    const { mainComposer, user, newest, side } = preparedScenario;
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
});

test("Add or remove the focused chat icon with shortcuts", async () => {
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
  await userEvent.keyboard("{Control>}{Shift>}0{/Shift}{/Control}");
  await waitFor(() => {
    expect(renameRequests.at(-1)).toStrictEqual({
      threadId: current.id,
      title: "Project plan",
    });
    expect(currentLink).toHaveTextContent("Project plan");
  });
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
])(
  "Pin and unpin the focused chat optimistically on $platform",
  async ({ userAgent, modifier }) => {
    context.mocks.browser.userAgent(userAgent);
    const mainTitle = "Main pin shortcut chat";
    const sideTitle = "Side pin shortcut chat";
    const main = continuityThread(70, 1, mainTitle);
    const side = continuityThread(70, 2, sideTitle);
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
      expectPinned(side.id, sideTitle);
    });
    expectNotPinned(main.id, mainTitle);
    expect(sideComposer).toHaveFocus();
    expect(sideComposer).toHaveTextContent("Keep this draft");
    pinResponse.resolve();

    await userEvent.keyboard(`{${modifier}>}{Shift>}D{/Shift}{/${modifier}}`);
    await unpinRequested.promise;
    await waitFor(() => {
      expectNotPinned(side.id, sideTitle);
    });
    expect(sideComposer).toHaveTextContent("Keep this draft");

    threadContainer(main.id).focus();
    await userEvent.keyboard(`{${modifier}>}{Shift>}D{/Shift}{/${modifier}}`);
    await waitFor(() => {
      expectPinned(main.id, mainTitle);
    });
    expectNotPinned(side.id, sideTitle);
  },
);
