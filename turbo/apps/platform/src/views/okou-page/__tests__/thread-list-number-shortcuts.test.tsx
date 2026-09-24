import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { now } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";
import {
  CHAT_LIST_AGENT_ID,
  chatListThread,
  sidebarThreadLinks,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";

const context = testContext();

function hintKeys(container: ParentNode): string[] {
  return [...container.querySelectorAll("kbd")]
    .map((keycap) => {
      return keycap.textContent ?? "";
    })
    .filter((label) => {
      return /^(?:Ctrl\+|⌘⌃?)[1-9]$/.test(label);
    });
}

const MAC_CHROME_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

async function openNumberShortcutPage() {
  context.mocks.browser.userAgent(MAC_CHROME_USER_AGENT);
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
    );
  });
  const threads = Array.from({ length: 11 }, (_, index) => {
    return chatListThread(index + 1, `Thread ${index + 1}`, {
      pinnedAt: index < 2 ? `2026-08-01T00:5${2 - index}:00.000Z` : null,
    });
  });
  const remoteChatList = context.mocks.deferred<void>();
  const workspace = installContinuityWorkspace(context, {
    caseId: 40,
    threads,
    chatListRemoteGate: remoteChatList.promise,
  });
  // Exercise cached shortcuts while canonical synchronization is pending.
  await startPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    ...workspace.pageOptions,
  });
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "Thread 1",
      "Thread 2",
      "Thread 11",
      "Thread 10",
      "Thread 9",
      "Thread 8",
      "Thread 7",
      "Thread 6",
      "Thread 5",
      "Thread 4",
      "Thread 3",
    ]);
  });
  expect(remoteChatList.settled()).toBeFalsy();
  return { threads, list: screen.getByTestId("chat-list-column") };
}

test("Reveal only the first nine hints after a 500 ms hold", async () => {
  const { list } = await openNumberShortcutPage();
  const user = userEvent.setup();
  await user.hover(sidebarThreadLinks()[0]!);
  expect(hintKeys(list)).toStrictEqual([]);
  const pressedAt = now();
  await user.keyboard("{Meta>}");
  expect(hintKeys(list)).toStrictEqual([]);
  await waitFor(() => {
    expect(hintKeys(list)).toHaveLength(9);
  });
  expect(now() - pressedAt).toBeGreaterThanOrEqual(500);
  expect(hintKeys(list)).toStrictEqual(
    Array.from({ length: 9 }, (_, index) => {
      return `⌘${index + 1}`;
    }),
  );
  await user.keyboard("{/Meta}");
  expect(hintKeys(list)).toStrictEqual([]);
});

test("Open the ninth chat using its visible hint", async () => {
  const { threads, list } = await openNumberShortcutPage();
  const user = userEvent.setup();
  await user.keyboard("{Meta>}");
  await waitFor(() => {
    expect(hintKeys(list)).toHaveLength(9);
  });
  await user.keyboard("9{/Meta}");
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${threads[4]!.id}`);
  });
  expect(hintKeys(list)).toStrictEqual([]);
});

test("Keep browser mode free of number shortcuts", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 48rem)";
  });
  const first = chatListThread(1, "Browser mode chat");
  const second = chatListThread(2, "Another chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 42,
    threads: [first, second],
  });
  await setupPage({
    context,
    path: `/chats/${first.id}`,
    ...workspace.pageOptions,
  });
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "Another chat",
      "Browser mode chat",
    ]);
  });
  const list = screen.getByTestId("chat-list-column");
  const shortcut = new KeyboardEvent("keydown", {
    key: "1",
    code: "Digit1",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(shortcut);
  expect(shortcut.defaultPrevented).toBeFalsy();
  expect(pathname()).toBe(`/chats/${first.id}`);
  expect(hintKeys(list)).toStrictEqual([]);
});
