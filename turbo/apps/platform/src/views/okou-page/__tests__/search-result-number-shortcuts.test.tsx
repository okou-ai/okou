import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";

import {
  CHAT_LIST_AGENT_ID,
  chatListThread,
  fastButton,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";

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

test("Limit empty search to 25 cached chats in sidebar order", async () => {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
    );
  });
  const threads = Array.from({ length: 26 }, (_, index) => {
    return chatListThread(index + 1, `Chat ${index + 1}`, {
      pinnedAt: index < 2 ? `2026-08-01T00:5${2 - index}:00.000Z` : null,
    });
  });
  const remoteChatList = context.mocks.deferred<void>();
  const workspace = installContinuityWorkspace(context, {
    caseId: 77,
    threads,
    chatListRemoteGate: remoteChatList.promise,
  });
  await startPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    ...workspace.pageOptions,
  });
  const expectedTitles = [
    "Chat 1",
    "Chat 2",
    ...Array.from({ length: 23 }, (_, index) => {
      return `Chat ${26 - index}`;
    }),
  ];
  const chatThreads = await screen.findByLabelText("Chat threads");
  await within(chatThreads).findByText(expectedTitles[0]!);
  expect(sidebarThreadTitles().slice(0, 3)).toStrictEqual(
    expectedTitles.slice(0, 3),
  );
  click(fastButton("Hide chat list"));
  await waitFor(() => {
    expect(screen.queryByTestId("chat-list-column")).toBeNull();
  });
  const { dialog } = await openSearch();
  await waitFor(() => {
    expect(searchResultTitles(dialog)).toStrictEqual(expectedTitles);
  });
  expect(remoteChatList.settled()).toBeFalsy();
});

test.each([
  {
    caseId: 74,
    platform: "Mac Chrome",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    modifiers: { metaKey: true, ctrlKey: false },
    numberModifiers: { metaKey: true, ctrlKey: false },
    firstHint: ["⌘1"],
  },
])(
  "Number only the first nine search results and open the ninth on $platform",
  async ({ caseId, userAgent, modifiers, numberModifiers, firstHint }) => {
    context.mocks.browser.userAgent(userAgent);
    context.mocks.browser.matchMedia((query) => {
      return (
        query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
      );
    });
    // Keep one result beyond the nine shortcuts; the 25-result cap is separate.
    const threads = Array.from({ length: 10 }, (_, index) => {
      return chatListThread(index + 1, `Chat ${index + 1}`, {
        pinnedAt: index < 2 ? `2026-08-01T00:5${2 - index}:00.000Z` : null,
      });
    });
    const remoteChatList = context.mocks.deferred<void>();
    const workspace = installContinuityWorkspace(context, {
      caseId,
      threads,
      chatListRemoteGate: remoteChatList.promise,
    });
    await startPage({
      context,
      path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
      ...workspace.pageOptions,
    });
    const expectedTitles = [
      "Chat 1",
      "Chat 2",
      ...Array.from({ length: 8 }, (_, index) => {
        return `Chat ${10 - index}`;
      }),
    ];
    const chatThreads = await screen.findByLabelText("Chat threads");
    await within(chatThreads).findByText(expectedTitles[0]!);
    expect(sidebarThreadTitles().slice(0, 3)).toStrictEqual(
      expectedTitles.slice(0, 3),
    );
    expect(remoteChatList.settled()).toBeFalsy();
    click(fastButton("Hide chat list"));
    const { dialog, search } = await openSearch(modifiers);
    await waitFor(() => {
      expect(searchResultTitles(dialog)).toStrictEqual(expectedTitles);
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
    expect(
      [...queryAllByRoleFast("option", dialog)[0]!.querySelectorAll("kbd")].map(
        (keycap) => {
          return keycap.textContent;
        },
      ),
    ).toStrictEqual(firstHint);
    expect(
      queryAllByRoleFast("option", dialog)[9]!.querySelector("kbd"),
    ).toBeNull();
    fireEvent.keyDown(search, {
      key: "9",
      code: "Digit9",
      ...numberModifiers,
      shiftKey: false,
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(pathname()).toBe(`/chats/${threads[3]!.id}`);
    });
    expect(screen.queryByTestId("chat-list-column")).toBeNull();
  },
);
