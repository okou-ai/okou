import {
  chatThreadMetadataContract,
  chatThreadPinOrderContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chatListThread,
  installChatListStream,
  installActiveChatBoundaries,
  sidebarThreadLinks,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";
import {
  installContinuityWorkspace,
  textContinuityDraft,
  continuitySidebarLink,
} from "./chat-continuity-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { getButtonByName } from "../../artifacts-page/__tests__/artifact-catalog-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import { completedMarkdownReply } from "./markdown-page-test-helpers.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";

const context = testContext();

const history = [
  chatListThread(2, "Field notes"),
  chatListThread(7, "Design notes"),
  chatListThread(19, "Release notes"),
] as const;

const [older, middle, newest] = history;

async function openHistory(path: string, hideEmptyForYou = false) {
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 48rem)";
  });
  installActiveChatBoundaries(context);
  context.mocks.api(chatThreadMetadataContract.get, ({ params, respond }) => {
    const row = history.find((item) => {
      return item.id === params.id;
    });
    if (!row) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Unknown thread" },
      });
    }
    return respond(200, {
      ...row,
      selectedModel: row.selectedModel ?? null,
      serviceTier: null,
      modelSettings: {},
      muted: false,
      computerUseHostId: null,
      cloudBrowserEnabled: false,
    });
  });
  installChatListStream(context, { caseId: 288, snapshot: history });
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.HideEmptyForYou]: hideEmptyForYou },
  });
  await waitFor(() => {
    expect(sidebarThreadLinks()[0]).toHaveAttribute(
      "href",
      `/chats/${newest.id}`,
    );
  });
}

const up = "{Control>}{Shift>}{ArrowUp}{/Shift}{/Control}";

const down = "{Control>}{Shift>}{ArrowDown}{/Shift}{/Control}";

test("chat-list-entry-navigation-002 traverses New chat, For you and the most recent thread in both directions", async () => {
  await openHistory(`/chats/${newest.id}`);
  const user = userEvent.setup({ delay: null });
  await screen.findByText("Release notes", {
    selector: '[data-testid="chat-thread-header-title"]',
  });
  await user.keyboard(up);
  await waitFor(() => {
    return expect(location.pathname).toBe("/for-you");
  });
  await user.keyboard(up);
  await waitFor(() => {
    expect(location.pathname).toBe("/");
    expect(
      screen.getByText("New chat", { selector: '[aria-current="page"] *' }),
    ).toBeInTheDocument();
  });
  await user.keyboard(down);
  await waitFor(() => {
    return expect(location.pathname).toBe("/for-you");
  });
  await user.keyboard(down);
  await waitFor(() => {
    expect(sidebarThreadLinks()[0]).toHaveAttribute("aria-current", "page");
    expect(location.pathname).toBe(`/chats/${newest.id}`);
  });
});

test("An empty For you feed leaves New chat and the newest thread adjacent", async () => {
  await openHistory(`/chats/${newest.id}`, true);
  const user = userEvent.setup({ delay: null });
  await user.keyboard(up);
  await waitFor(() => {
    expect(location.pathname).toBe("/");
  });
  expect(queryFastControl("link", /For you/)).toBeNull();
  await user.keyboard(down);
  await waitFor(() => {
    expect(location.pathname).toBe(`/chats/${newest.id}`);
  });
});

test("chat-list-entry-navigation-003 moves the focused side chat while keeping the main conversation open", async () => {
  const path = `/chats/${older.id}`;
  await openHistory(`${path}?sidebar=${newest.id}`);
  const user = userEvent.setup({ delay: null });
  const sideTitle = await screen.findByText("Release notes", {
    selector: '[data-testid="chat-thread-header-title"]',
  });
  const pane = sideTitle.closest<HTMLElement>('[aria-label="Chat thread"]')!;
  const composer = await within(pane).findByRole("textbox", {
    name: "Message",
  });
  await user.click(composer);
  await user.keyboard(up);
  expect(location.pathname).toBe(path);
  expect(new URL(location.href).searchParams.get("sidebar")).toBe(newest.id);
  await user.keyboard(down);
  await waitFor(() => {
    expect(new URL(location.href).searchParams.get("sidebar")).toBe(middle.id);
    expect(
      screen.getByText("Design notes", {
        selector: '[data-testid="chat-thread-header-title"]',
      }),
    ).toBeInTheDocument();
  });
  expect(location.pathname).toBe(path);
  expect(
    sidebarThreadLinks().find((link) => {
      return link.pathname === path;
    }),
  ).toHaveAttribute("aria-current", "page");
});

async function sidebar(size: number, standalone: boolean) {
  context.mocks.browser.userAgent(
    standalone
      ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/135.0 Safari/537.36"
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/135.0",
  );
  context.mocks.browser.platform(standalone ? "MacIntel" : "Win32");
  context.mocks.browser.matchMedia((q) => {
    return (
      q.includes("min-width") ||
      (standalone && q === "(display-mode: standalone)")
    );
  });
  const threads = Array.from({ length: size }, (_, i) => {
    return chatListThread(i + 1, "Chat " + (i + 1));
  });
  const { pageOptions } = installContinuityWorkspace(context, {
    caseId: 800,
    threads,
  });
  await setupPage({
    context,
    ...pageOptions,
    path: "/chats/" + threads[0]!.id,
  });
  await findFastControl("link", "Chat 1");
  return threads;
}

test("thread-list-number-shortcuts-002 The standalone Mac shortcut opens the ninth visible chat and clears its hints", async () => {
  const threads = await sidebar(9, true);
  const user = userEvent.setup({ delay: null });
  // The chat list orders unpinned conversations newest first.
  const ninth = await findFastControl("link", "Chat 1");
  click(await findFastControl("link", "Chat 9"));
  await waitFor(() => {
    return expect(location.pathname).toBe("/chats/" + threads[8]!.id);
  });
  await user.keyboard("{Meta>}");
  await within(ninth).findByText("⌘9", { selector: "kbd" });
  await user.keyboard("9{/Meta}");
  await waitFor(() => {
    return expect(location.pathname).toBe("/chats/" + threads[0]!.id);
  });
  expect(screen.queryByText("⌘9", { selector: "kbd" })).toBeNull();
});

test("thread-list-number-shortcuts-003 The browser retains its Ctrl+1 shortcut while a chat is open", async () => {
  const threads = await sidebar(2, false);
  const event = new KeyboardEvent("keydown", {
    key: "1",
    code: "Digit1",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  fireEvent(document.body, event);
  expect(event.defaultPrevented).toBeFalsy();
  expect(location.pathname).toBe("/chats/" + threads[0]!.id);
  expect(screen.queryByText(/(?:Ctrl\+|⌘)1/, { selector: "kbd" })).toBeNull();
});

const titles = ["First pin", "Middle pin", "Last pin"] as const;
const raised = ["Middle pin", "First pin", "Last pin"] as const;
async function pins(middleDraft?: string) {
  const threads = titles.map((title, i) => {
    return chatListThread(i + 1, title, {
      pinOrder: `a${i}`,
      pinnedAt: "2026-06-07T12:00:00Z",
    });
  });
  const world = installContinuityWorkspace(context, {
    caseId: 179,
    threads,
    drafts: middleDraft
      ? new Map([[threads[1]!.id, textContinuityDraft(middleDraft)]])
      : undefined,
  });
  context.mocks.api(chatThreadPinOrderContract.reorder, ({ respond }) => {
    return respond(204);
  });
  await setupPage({ context, path: "/?compose=1", ...world.pageOptions });
  await order(titles);
  return threads.map((row) => {
    return row.id;
  });
}
async function order(expected: readonly string[]) {
  await waitFor(() => {
    return expect(sidebarThreadTitles()).toStrictEqual(expected);
  });
}
function shortcut(direction: "Up" | "Down") {
  if (!document.activeElement) {
    throw new Error("No keyboard target");
  }
  fireEvent.keyDown(document.activeElement, {
    key: "Arrow" + direction,
    altKey: true,
    shiftKey: true,
  });
}
function chatMenu(thread: string) {
  const row = continuitySidebarLink(thread).closest<HTMLElement>(
    "[data-sidebar-chat-thread-row-id]",
  );
  if (!row) {
    throw new Error("Missing sidebar row");
  }
  return getButtonByName("Open chat menu", row);
}
test.each([
  ["chat-pin-shortcuts-005", "link"],
  ["chat-pin-shortcuts-006", "menu"],
] as const)(
  "%s Moving a pin from its %s keeps the new chat and focused control",
  async (_id, control) => {
    const [, middle] = await pins();
    const locationBefore = location.href;
    const target =
      control === "link" ? continuitySidebarLink(middle!) : chatMenu(middle!);
    target.focus();
    shortcut("Up");
    await order(raised);
    expect(target).toHaveFocus();
    expect(location.href).toBe(locationBefore);
  },
);
test("chat-pin-shortcuts-004 The outer pins stop at their boundaries and the middle pin can still move", async () => {
  const [first, middle, last] = await pins();
  const firstLink = continuitySidebarLink(first!);
  firstLink.focus();
  shortcut("Up");
  expect(sidebarThreadTitles()).toStrictEqual(titles);
  expect(firstLink).toHaveFocus();
  const middleLink = continuitySidebarLink(middle!);
  middleLink.focus();
  shortcut("Up");
  await order(raised);
  const end = continuitySidebarLink(last!);
  end.focus();
  shortcut("Down");
  expect(sidebarThreadTitles()).toStrictEqual(raised);
  expect(end).toHaveFocus();
});
test("chat-pin-shortcuts-002 Reordering the open thread keeps its draft and composer focus through both moves", async () => {
  const [, middle] = await pins("Unsent draft");
  click(continuitySidebarLink(middle!));
  await waitFor(() => {
    return expect(location.pathname).toBe("/chats/" + middle);
  });
  const editor = await findComposerEditor();
  await waitFor(() => {
    expect(editor).toHaveTextContent("Unsent draft");
  });
  expect(editor).toHaveFocus();
  shortcut("Up");
  await order(raised);
  expect(editor).toHaveFocus();
  expect(editor).toHaveTextContent("Unsent draft");
  shortcut("Down");
  await order(titles);
  expect(editor).toHaveFocus();
  expect(editor).toHaveTextContent("Unsent draft");
  expect(location.pathname).toBe("/chats/" + middle);
});
test("chat-pin-shortcuts-009 Moving a pin preserves inline rename until Escape returns focus to that chat", async () => {
  const [, middle] = await pins();
  fireEvent.doubleClick(continuitySidebarLink(middle!));
  const input = await screen.findByRole("textbox", { name: /Rename/i });
  await fill(input, "Uncommitted title");
  shortcut("Up");
  expect(input).toHaveFocus();
  expect(input).toHaveValue("Uncommitted title");
  fireEvent.keyDown(input, { key: "Escape" });
  await order(raised);
  expect(continuitySidebarLink(middle!)).toHaveFocus();
  expect(screen.queryByRole("textbox", { name: /Rename/i })).toBeNull();
});

test("chat-pin-shortcuts-003 Moving the selected pin from the list menu keeps both its location and the menu focus", async () => {
  const [, middle] = await pins();
  click(continuitySidebarLink(middle!));
  await waitFor(() => {
    return expect(location.pathname).toBe("/chats/" + middle);
  });
  const menu = getButtonByName("Open chat list menu");
  menu.focus();
  for (const [direction, expected] of [
    ["Up", raised],
    ["Down", titles],
  ] as const) {
    shortcut(direction);
    await order(expected);
    expect(menu).toHaveFocus();
    expect(location.pathname).toBe("/chats/" + middle);
    expect(continuitySidebarLink(middle!)).toHaveAttribute(
      "aria-current",
      "page",
    );
  }
});
test("chat-pin-shortcuts-008 Reordering from a side conversation retains the main selection and that side's draft", async () => {
  const [main, side] = await pins();
  click(continuitySidebarLink(main!));
  await waitFor(() => {
    return expect(location.pathname).toBe("/chats/" + main);
  });
  fireEvent.click(continuitySidebarLink(side!), { altKey: true });
  const pane = await waitFor(() => {
    const pane = document.querySelector<HTMLElement>(
      `[data-chat-thread-container-id="${side}"]`,
    );
    if (!pane) {
      throw new Error("Side conversation not yet visible");
    }
    return pane;
  });
  const editor = await waitFor(() => {
    const el = pane.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!el) {
      throw new Error("Side composer not mounted");
    }
    return el;
  });
  await fill(editor, "Side pane draft");
  shortcut("Up");
  await order(raised);
  expect(location.pathname).toBe("/chats/" + main);
  expect(editor).toHaveFocus();
  expect(editor).toHaveTextContent("Side pane draft");
});

test("chat-pin-shortcuts-015 Windows exposes both pin hints and the shortcuts dialog without reordering from outside the chat", async () => {
  context.mocks.browser.platform("Win32");
  context.mocks.browser.userAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  const [, middle] = await pins();
  const menu = chatMenu(middle!);
  click(menu);
  const popup = await screen.findByRole("menu");
  const up = await within(popup).findByText("Move up");
  const down = await within(popup).findByText("Move down");
  expect(up.closest('[role="menuitem"]')).toHaveTextContent("Shift+Alt+↑");
  expect(down.closest('[role="menuitem"]')).toHaveTextContent("Shift+Alt+↓");
  fireEvent.keyDown(popup, { key: "Escape" });
  const editor = await findComposerEditor();
  editor.focus();
  shortcut("Up");
  expect(sidebarThreadTitles()).toStrictEqual(titles);
  fireEvent.keyDown(document.body, { key: "?", code: "Slash", shiftKey: true });
  const help = await screen.findByRole("dialog", {
    name: /Keyboard shortcuts/i,
  });
  for (const label of ["Pinned", "Move up", "Move down"]) {
    expect(within(help).getByText(label)).toBeVisible();
  }
  fireEvent.keyDown(help, { key: "ArrowDown", altKey: true, shiftKey: true });
  fireEvent.keyDown(help, { key: "Escape" });
  await order(titles);
});

test("sidebar-mac-shortcut-001 Command-B collapses the open chat list from the focused composer", async () => {
  context.mocks.browser.platform("MacIntel");
  context.mocks.browser.userAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  );
  await setupPage({
    context,
    path: completedMarkdownReply(context, "Compare the two estimates."),
  });
  await screen.findByText("Compare the two estimates.");
  await expect(screen.findByLabelText("Chat threads")).resolves.toBeVisible();
  const hide = await findAction("button", "Hide chat list");
  expect(hide).toBeVisible();
  const user = userEvent.setup({ delay: null });
  const editor = await screen.findByLabelText("Message");
  await user.click(editor);
  expect(editor).toHaveFocus();
  await user.keyboard("{Meta>}b{/Meta}");
  await expect(findAction("button", "Show chat list")).resolves.toBeVisible();
  expect(hide).not.toBeInTheDocument();
  const visibleLists = screen
    .queryAllByLabelText("Chat threads")
    .filter((list) => {
      return !list.closest("[inert],[hidden]");
    });
  expect(visibleLists).toHaveLength(0);
});
