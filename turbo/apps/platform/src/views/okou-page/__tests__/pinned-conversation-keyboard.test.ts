import { getButtonByName } from "../../artifacts-page/__tests__/artifact-catalog-test-helpers.ts";
import { chatThreadPinOrderContract } from "@okouai/api-contracts/contracts/chat-threads";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage, fill, click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chatListThread,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";
import {
  textContinuityDraft,
  installContinuityWorkspace,
  continuitySidebarLink,
} from "./chat-continuity-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";

const context = testContext();
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
