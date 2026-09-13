import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { now } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";
import {
  CHAT_LIST_AGENT_ID,
  chatListThread,
  fastButton,
  sidebarThreadLinks,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";

const context = testContext();
const SEARCH_LABEL = "Search workspace...";

function hintKeys(container: ParentNode): string[] {
  return [...container.querySelectorAll("kbd")]
    .map((keycap) => {
      return keycap.textContent ?? "";
    })
    .filter((label) => {
      return /^(?:Ctrl\+|⌘⌃?)[1-9]$/.test(label);
    });
}

const NUMBER_SHORTCUT_PLATFORMS = [
  {
    platform: "Mac Chrome",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    maxTouchPoints: 0,
    modifier: "Meta",
    additionalModifier: "",
    releaseModifiers: "{/Meta}",
    label: "⌘",
  },
  {
    platform: "Mac Safari",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.2 Safari/605.1.15",
    maxTouchPoints: 0,
    modifier: "Meta",
    additionalModifier: "{Control>}",
    releaseModifiers: "{/Control}{/Meta}",
    label: "⌘⌃",
  },
  {
    platform: "iPad Safari with a desktop user agent",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.2 Safari/605.1.15",
    maxTouchPoints: 5,
    modifier: "Meta",
    additionalModifier: "",
    releaseModifiers: "{/Meta}",
    label: "⌘",
  },
  {
    platform: "Windows",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    maxTouchPoints: 0,
    modifier: "Control",
    additionalModifier: "",
    releaseModifiers: "{/Control}",
    label: "Ctrl+",
  },
] as const;

async function openNumberShortcutPage(
  { userAgent, maxTouchPoints }: (typeof NUMBER_SHORTCUT_PLATFORMS)[number],
  initialChat: "new" | "ninth",
) {
  context.mocks.browser.userAgent(userAgent);
  context.mocks.browser.maxTouchPoints(maxTouchPoints);
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
  await setupPage({
    context,
    path:
      initialChat === "ninth"
        ? `/chats/${threads[4]!.id}`
        : `/agents/${CHAT_LIST_AGENT_ID}/chat`,
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

test.each(NUMBER_SHORTCUT_PLATFORMS)(
  "Reveal only the first nine hints after a 500 ms hold on $platform",
  async (platform) => {
    const { modifier, additionalModifier, releaseModifiers, label } = platform;
    const { list } = await openNumberShortcutPage(platform, "new");
    const user = userEvent.setup();
    await user.hover(sidebarThreadLinks()[0]!);
    expect(hintKeys(list)).toStrictEqual([]);
    const pressedAt = now();
    await user.keyboard(`{${modifier}>}`);
    expect(hintKeys(list)).toStrictEqual([]);
    await waitFor(() => {
      expect(hintKeys(list)).toHaveLength(9);
    });
    expect(now() - pressedAt).toBeGreaterThanOrEqual(500);
    expect(hintKeys(list)).toStrictEqual(
      Array.from({ length: 9 }, (_, index) => {
        return `${label}${index + 1}`;
      }),
    );
    if (additionalModifier) {
      await user.keyboard(additionalModifier);
    }
    expect(hintKeys(list)).toHaveLength(9);
    await user.keyboard(releaseModifiers);
    expect(hintKeys(list)).toStrictEqual([]);
  },
);

test.each(NUMBER_SHORTCUT_PLATFORMS)(
  "Open the ninth chat using its visible hint on $platform",
  async (platform) => {
    const { modifier, additionalModifier, releaseModifiers } = platform;
    const { threads, list } = await openNumberShortcutPage(platform, "new");
    const user = userEvent.setup();
    await user.keyboard(`{${modifier}>}`);
    await waitFor(() => {
      expect(hintKeys(list)).toHaveLength(9);
    });
    if (additionalModifier) {
      await user.keyboard(additionalModifier);
    }
    await user.keyboard(`9${releaseModifiers}`);
    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${threads[4]!.id}`);
    });
    expect(hintKeys(list)).toStrictEqual([]);
  },
);

test.each(NUMBER_SHORTCUT_PLATFORMS)(
  "Open the first chat immediately from the ninth chat without waiting for hints on $platform",
  async (platform) => {
    const { modifier, additionalModifier, releaseModifiers } = platform;
    const { threads, list } = await openNumberShortcutPage(platform, "ninth");
    const user = userEvent.setup();
    expect(pathname()).toBe(`/chats/${threads[4]!.id}`);
    expect(hintKeys(list)).toStrictEqual([]);
    await user.keyboard(
      `{${modifier}>}${additionalModifier}1${releaseModifiers}`,
    );
    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${threads[0]!.id}`);
    });
    expect(hintKeys(list)).toStrictEqual([]);
  },
);

test("Cancel a short hold and clear hints on release or window blur", async () => {
  context.mocks.browser.userAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  );
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
    );
  });
  const thread = chatListThread(1, "Hold lifecycle");
  const workspace = installContinuityWorkspace(context, {
    caseId: 41,
    threads: [thread],
  });
  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(["Hold lifecycle"]);
  });
  const list = screen.getByTestId("chat-list-column");
  fireEvent.keyDown(document, { key: "Meta", code: "MetaLeft", metaKey: true });
  fireEvent.keyUp(document, { key: "Meta", code: "MetaLeft" });
  expect(hintKeys(list)).toStrictEqual([]);
  const pressedAt = now();
  fireEvent.keyDown(document, { key: "Meta", code: "MetaLeft", metaKey: true });
  await waitFor(() => {
    expect(hintKeys(list)).toStrictEqual(["⌘1"]);
  });
  expect(now() - pressedAt).toBeGreaterThanOrEqual(500);
  fireEvent.blur(window);
  await waitFor(() => {
    expect(hintKeys(list)).toStrictEqual([]);
  });
  fireEvent.keyDown(document, { key: "Meta", code: "MetaLeft", metaKey: true });
  await waitFor(() => {
    expect(hintKeys(list)).toStrictEqual(["⌘1"]);
  });
  fireEvent.keyUp(document, { key: "Meta", code: "MetaLeft" });
  await waitFor(() => {
    expect(hintKeys(list)).toStrictEqual([]);
  });
});

test("Keep browser mode free of number shortcuts and react to display mode changes", async () => {
  const media = context.mocks.browser.matchMedia((query) => {
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

  const user = userEvent.setup();
  await user.keyboard("{Control>}{Shift>}f{/Shift}");
  const dialog = await screen.findByRole("dialog", { name: SEARCH_LABEL });
  await waitFor(() => {
    expect(queryAllByRoleFast("option", dialog)).toHaveLength(2);
  });
  const search = within(dialog).getByPlaceholderText(SEARCH_LABEL);
  const searchShortcut = new KeyboardEvent("keydown", {
    key: "1",
    code: "Digit1",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  search.dispatchEvent(searchShortcut);
  expect(searchShortcut.defaultPrevented).toBeFalsy();
  expect(hintKeys(dialog)).toStrictEqual([]);
  expect(dialog).toBeInTheDocument();
  await user.keyboard("{/Control}{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  media.setMatches((query) => {
    return (
      query === "(display-mode: window-controls-overlay)" ||
      query === "(min-width: 48rem)"
    );
  });
  await user.keyboard("{Control>}");
  await waitFor(() => {
    expect(hintKeys(list)).toStrictEqual(["Ctrl+1", "Ctrl+2"]);
  });
  media.setMatches((query) => {
    return query === "(min-width: 48rem)";
  });
  await waitFor(() => {
    expect(hintKeys(list)).toStrictEqual([]);
  });
  await user.keyboard("1{/Control}");
  expect(pathname()).toBe(`/chats/${first.id}`);
  click(sidebarThreadLinks()[0]!);
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${second.id}`);
  });
});

test("Number filtered threads and give the search dialog priority over the list", async () => {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
    );
  });
  const first = chatListThread(1, "Unread target");
  const second = chatListThread(2, "Read target");
  const workspace = installContinuityWorkspace(context, {
    caseId: 43,
    threads: [first, second],
  });
  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    return respond(200, {
      unreads: [{ threadId: first.id, unreadAt: "2026-08-01T01:00:00.000Z" }],
    });
  });
  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    ...workspace.pageOptions,
  });
  await waitFor(() => {
    expect(sidebarThreadTitles()).toHaveLength(2);
  });
  click(fastButton("Open chat list menu"));
  const unreadOnly = queryAllByRoleFast("menuitem").find((item) => {
    return item.textContent?.trim() === "Unread only";
  });
  if (!unreadOnly) {
    throw new Error("Expected unread filter");
  }
  click(unreadOnly);
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(["Unread target"]);
  });
  const list = screen.getByTestId("chat-list-column");
  const user = userEvent.setup();
  await user.keyboard("{Control>}");
  await waitFor(() => {
    expect(hintKeys(list)).toStrictEqual(["Ctrl+1"]);
  });
  await user.keyboard("{Shift>}f{/Shift}");
  const dialog = await screen.findByRole("dialog", { name: SEARCH_LABEL });
  await waitFor(() => {
    expect(hintKeys(dialog)).toStrictEqual(["Ctrl+1"]);
  });
  expect(hintKeys(list)).toStrictEqual([]);
  await user.keyboard("1{/Control}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pathname()).toBe(`/chats/${first.id}`);
  });
});
