import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { chatSearchContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";
import { chatListThread } from "./chat-list-test-helpers.ts";

const context = testContext();
const SEARCH_LABEL = "Search workspace...";

async function openSearch(modifiers = { ctrlKey: true, metaKey: false }) {
  fireEvent.keyDown(document.body, {
    key: modifiers.metaKey ? "Meta" : "Control",
    ...modifiers,
  });
  fireEvent.keyDown(document.body, {
    key: "f",
    code: "KeyF",
    shiftKey: true,
    ...modifiers,
  });
  const dialog = await screen.findByRole("dialog", { name: SEARCH_LABEL });
  const search = within(dialog).getByPlaceholderText(SEARCH_LABEL);
  fireEvent.keyUp(search, { key: "Shift", ...modifiers, shiftKey: false });
  return { dialog, search };
}

function numberedHints(dialog: HTMLElement): string[] {
  return [...dialog.querySelectorAll("kbd")]
    .map((keycap) => {
      return keycap.textContent?.match(/[1-9]$/)?.[0];
    })
    .filter((text): text is string => {
      return text !== undefined;
    });
}

function searchResultTitles(dialog: HTMLElement): string[] {
  return queryAllByRoleFast("option", dialog).map((option) => {
    return option.querySelector(".truncate")?.textContent ?? "";
  });
}

test("Group matching chats before messages and open the first message with its shortcut", async () => {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
    );
  });
  const threads = Array.from({ length: 5 }, (_, index) => {
    return chatListThread(
      index + 1,
      index === 0 ? "Planning" : `Budget ${index}`,
    );
  });
  const workspace = installContinuityWorkspace(context, {
    caseId: 29,
    threads,
  });
  const target = threads[0]!;
  context.mocks.api(chatSearchContract.search, ({ query, respond }) => {
    return respond(200, {
      results: Array.from({ length: 26 }, (_, index) => {
        return {
          chatThreadId: target.id,
          matchedMessage: {
            chatThreadId: target.id,
            role: "user" as const,
            content: `${query.keyword} note ${index + 1}`,
            seqId: index + 1,
            createdAt: target.sortAt,
            runId: null,
          },
          matchedRanges: [{ start: 0, end: query.keyword.length }],
        };
      }),
    });
  });
  await setupPage({ context, path: "/", ...workspace.pageOptions });
  const { dialog, search } = await openSearch();
  expect(within(dialog).queryByRole("listbox")).toBeNull();
  expect(within(dialog).queryByRole("status")).toBeNull();
  await fill(search, "   ");
  expect(within(dialog).queryByRole("listbox")).toBeNull();
  await fill(search, "note");
  const messageOnly = await within(dialog).findByRole("group", {
    name: "Messages",
  });
  expect(queryAllByRoleFast("option", messageOnly)).toHaveLength(25);
  expect(within(dialog).queryByRole("group", { name: "Chats" })).toBeNull();

  await fill(search, "budget");
  const messages = await within(dialog).findByRole("group", {
    name: "Messages",
  });
  const chats = within(dialog).getByRole("group", { name: "Chats" });
  expect(searchResultTitles(chats)).toStrictEqual([
    "Budget 4",
    "Budget 3",
    "Budget 2",
  ]);
  expect(queryAllByRoleFast("option", messages)).toHaveLength(22);
  fireEvent.keyDown(search, { key: "Control", ctrlKey: true });
  await waitFor(() => {
    expect(numberedHints(dialog)).toStrictEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
  });
  fireEvent.keyDown(search, { key: "4", code: "Digit4", ctrlKey: true });
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${target.id}`);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
