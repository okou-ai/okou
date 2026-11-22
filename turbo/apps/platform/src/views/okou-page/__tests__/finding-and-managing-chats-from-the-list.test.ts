import {
  chatThreadsContract,
  chatThreadRenameContract,
  chatThreadPinContract,
  chatThreadUnpinContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, within, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { chatListThread } from "./chat-list-test-helpers.ts";
import {
  installContinuityWorkspace,
  textContinuityDraft,
} from "./chat-continuity-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  threadLinkByTitle,
  openThreadMenu,
  openChatListMenu,
} from "./sidebar-test-helpers.tsx";
const context = testContext();
const catalog = [
  "Release plan",
  "Incident notes",
  "Running analysis",
  "Draft brief",
  "Research kickoff",
  "Support escalation",
  "Waiting for review",
  "Archived chat",
] as const;
async function conversations(selected?: number, split = false) {
  const threads = catalog.map((title, i) => {
    return chatListThread(i + 1, title, { archived: i >= 6 });
  });
  const { pageOptions } = installContinuityWorkspace(context, {
    caseId: 817,
    threads,
    drafts: new Map([
      [threads[3]!.id, textContinuityDraft("Unsent paragraph")],
    ]),
  });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      threads: { [threads[2]!.id]: "active", [threads[5]!.id]: "active" },
      unreadAt: { [threads[1]!.id]: threads[1]!.updatedAt },
    });
  });
  context.mocks.api(chatThreadRenameContract.rename, ({ respond }) => {
    return respond(204);
  });
  context.mocks.api(chatThreadPinContract.pin, ({ respond }) => {
    return respond(204);
  });
  context.mocks.api(chatThreadUnpinContract.unpin, ({ respond }) => {
    return respond(204);
  });
  const path = selected === undefined ? "/" : "/chats/" + threads[selected]!.id;
  await setupPage({
    context,
    ...pageOptions,
    path: path + (split ? "?sidebar=" + threads[7]!.id : ""),
  });
  await within(screen.getByTestId("chat-list-column")).findByText(
    "Release plan",
  );
  return threads;
}
async function title(value: string) {
  await waitFor(() => {
    return expect(document.title).toBe(value + " | Okou");
  });
}
async function search() {
  fireEvent.keyDown(document, {
    key: "F",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
  });
  const dialog = await screen.findByRole("dialog");
  const input = within(dialog).getByRole("combobox");
  return { dialog, input };
}
test("sidebar-controls-002 Keyboard selection of a support search result closes search and opens the conversation", async () => {
  await conversations();
  const { dialog, input } = await search();
  await fill(input, "support");
  await within(dialog).findByText("Support escalation");
  await userEvent.setup({ delay: null }).keyboard("{ArrowDown}{Enter}");
  await title("Support escalation");
  expect(screen.queryByRole("dialog")).toBeNull();
});
test("sidebar-chat-history-024 Switching search terms replaces research with a running support chat and opens its page", async () => {
  await conversations();
  const { dialog, input } = await search();
  await fill(input, "research");
  await within(dialog).findByText("Research kickoff");
  expect(within(dialog).queryByText("Support escalation")).toBeNull();
  await fill(input, "support");
  const result = await within(dialog).findByText("Support escalation");
  const option = result.closest('[role="option"]');
  expect(option).toHaveAccessibleName(
    /Support escalation.*Running|Running.*Support escalation/i,
  );
  click(result);
  await title("Support escalation");
  expect(screen.queryByRole("dialog")).toBeNull();
});
test("sidebar-controls-007 State labels leave menus available and pinning a regular conversation can be reversed", async () => {
  await conversations();
  const expected = [
    "Release plan",
    "Incident notes Unread",
    "Running analysis Running",
    "Draft brief Draft",
  ];
  await waitFor(() => {
    for (const [i, name] of expected.entries()) {
      expect(threadLinkByTitle(catalog[i]!)).toHaveAccessibleName(name);
    }
  });
  openThreadMenu("Release plan");
  let menu = await screen.findByRole("menu");
  const pin = within(menu).getByText("Pin chat").closest('[role="menuitem"]')!;
  expect(pin).toHaveAttribute(
    "aria-keyshortcuts",
    expect.stringContaining("Control+Shift+D"),
  );
  click(pin);
  openThreadMenu("Release plan");
  menu = await screen.findByRole("menu");
  const unpin = within(menu)
    .getByText("Unpin chat")
    .closest('[role="menuitem"]')!;
  expect(unpin).toHaveAttribute(
    "aria-keyshortcuts",
    expect.stringContaining("Control+Shift+D"),
  );
  click(unpin);
  openThreadMenu("Running analysis");
  menu = await screen.findByRole("menu");
  expect(
    within(menu).getByText("Rename chat").closest('[role="menuitem"]'),
  ).toHaveAttribute("aria-keyshortcuts", "F2");
  expect(within(menu).getByText("Delete chat")).toBeVisible();
  expect(
    threadLinkByTitle("Running analysis").parentElement!.querySelector(
      '[aria-label="Open chat menu"]',
    ),
  ).toBeInTheDocument();
});
test("sidebar-controls-014 A double-click opens and renames a chat while a later menu rename leaves the other conversation active", async () => {
  await conversations(1);
  await title("Incident notes");
  const user = userEvent.setup({ delay: null });
  await user.dblClick(threadLinkByTitle("Release plan"));
  await title("Release plan");
  let input = await screen.findByRole("textbox", { name: /Rename/ });
  await fill(input, "Launch plan");
  await user.keyboard("{Enter}");
  await within(screen.getByTestId("chat-list-column")).findByText(
    "Launch plan",
  );
  click(threadLinkByTitle("Incident notes"));
  await title("Incident notes");
  openThreadMenu("Launch plan");
  click(await screen.findByText("Rename chat"));
  const dialog = await screen.findByRole("dialog");
  input = within(dialog).getByRole("textbox");
  await fill(input, "Final launch plan");
  await user.keyboard("{Enter}");
  await within(screen.getByTestId("chat-list-column")).findByText(
    "Final launch plan",
  );
  expect(threadLinkByTitle("Incident notes")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await title("Incident notes");
});
test("sidebar-chat-history-009 Archived skips the right pane's existing conversation when choosing the next chat", async () => {
  const threads = await conversations(0, true);
  await title("Release plan");
  expect(new URLSearchParams(location.search).get("sidebar")).toBe(
    threads[7]!.id,
  );
  openChatListMenu();
  click(await within(await screen.findByRole("menu")).findByText("Archived"));
  await title("Waiting for review");
  expect(location.pathname).toBe("/chats/" + threads[6]!.id);
});
test("sidebar-chat-history-026 The list header opens and dismisses project creation and switches the leading New chat page to Archived", async () => {
  await conversations();
  const list = screen.getByTestId("chat-list-column");
  for (const name of [
    "Hide chat list",
    "Search workspace",
    "Create Project",
    "Open chat list menu",
  ]) {
    await expect(findFastControl("button", name, list)).resolves.toBeVisible();
  }
  expect(within(list).queryByRole("heading", { name: /agent/i })).toBeNull();
  const link = await findFastControl("link", /^New chat/, list);
  expect(link).toHaveAttribute("aria-current", "page");
  expect(link).toHaveAttribute(
    "aria-keyshortcuts",
    expect.stringContaining("Control+Shift+O"),
  );
  expect(link).toHaveAttribute(
    "aria-keyshortcuts",
    expect.stringContaining("Meta+Shift+O"),
  );
  expect(
    link.compareDocumentPosition(threadLinkByTitle("Release plan")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const create = await findFastControl("button", "Create Project", list);
  await userEvent.setup({ delay: null }).hover(create);
  await waitFor(() => {
    return expect(
      screen.getByText("Create Project", { exact: true }),
    ).toBeVisible();
  });
  click(create);
  await screen.findByRole("textbox", { name: "Project name" });
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  openChatListMenu();
  click(await within(await screen.findByRole("menu")).findByText("Archived"));
  await within(list).findByText("Waiting for review");
});
