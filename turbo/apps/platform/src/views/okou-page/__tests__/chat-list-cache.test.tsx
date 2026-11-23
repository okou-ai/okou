import userEvent from "@testing-library/user-event";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  cachedChatListEvents,
  chatListEvent,
  chatListThread,
  installChatListStream,
  sidebarThreadLinks,
} from "./chat-list-test-helpers.ts";

const context = testContext();

test("A cached rename appears while member chat synchronization is pending", async () => {
  const old = chatListThread(6, "Unreviewed budget");
  const revision = chatListEvent(281, 2, "renamed", old.id, {
    title: "Approved autumn budget",
  });
  const hold = context.mocks.deferred<void>();
  installChatListStream(context, {
    caseId: 281,
    snapshot: [],
    remoteGate: hold.promise,
  });
  const page = await startPage({
    context,
    path: "/",
    cachedChatThreadEvents: cachedChatListEvents(281, [old], [revision]),
  });
  try {
    await page.content;
    await waitFor(() => {
      expect(
        sidebarThreadLinks().map((link) => {
          return [link.pathname, link.textContent?.trim()];
        }),
      ).toStrictEqual([[`/chats/${old.id}`, revision.title]]);
    });
  } finally {
    hold.resolve();
  }
  await page.ready;
});

test("chat-list-cache-002 exposes a chat destination for every cached conversation in descending order", async () => {
  const records = Array.from({ length: 26 }, (_, i) => {
    return chatListThread(i + 1, `Planning session ${i + 1}`);
  });
  const sync = context.mocks.deferred<void>();
  installChatListStream(context, {
    caseId: 282,
    snapshot: [],
    remoteGate: sync.promise,
  });
  const page = await startPage({
    context,
    path: "/",
    cachedChatThreadEvents: cachedChatListEvents(282, records),
  });
  try {
    await page.content;
    const newestFirst = [...records].reverse().map((thread) => {
      return [thread.title, `/chats/${thread.id}`];
    });
    await waitFor(() => {
      expect(
        sidebarThreadLinks().map((link) => {
          return [link.textContent?.trim(), link.pathname];
        }),
      ).toStrictEqual(newestFirst);
    });
  } finally {
    sync.resolve();
  }
  await page.ready;
});

async function openCachedSearch(count: number, standalone = false) {
  const history = Array.from({ length: count }, (_, index) => {
    return chatListThread(
      index + 1,
      "Chat " + (index + 1),
      index < 2
        ? { pinnedAt: "2026-08-01T00:00:00Z", pinOrder: "a" + index }
        : {},
    );
  });
  if (standalone) {
    const media = window.matchMedia.bind(window);
    context.mocks.browser.matchMedia((query) => {
      return query === "(display-mode: standalone)" || media(query).matches;
    });
  }
  const gate = context.mocks.deferred<void>();
  const requested = context.mocks.deferred<void>();
  installChatListStream(context, {
    caseId: 821,
    snapshot: [],
    remoteGate: gate.promise,
    onRemoteRead: () => {
      if (!requested.settled()) {
        requested.resolve();
      }
    },
  });
  context.mocks.browser.userAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36",
  );
  const page = await startPage({
    context,
    path: "/",
    cachedChatThreadEvents: cachedChatListEvents(821, history),
  });
  try {
    await Promise.all([page.content, requested.promise]);
    await waitFor(() => {
      return expect(
        sidebarThreadLinks().some((link) => {
          return link.textContent?.includes("Chat 1");
        }),
      ).toBeTruthy();
    });
    click(await findFastControl("button", "Hide chat list"));
    const keys = userEvent.setup();
    await keys.keyboard("{Meta>}{Shift>}f{/Shift}{/Meta}");
    const dialog = within(await screen.findByRole("dialog"));
    const options = await dialog.findAllByRole("option");
    return {
      options,
      keys,
      history,
      finish: async () => {
        gate.resolve();
        await page.ready;
      },
    };
  } catch (error) {
    gate.resolve();
    await page.ready;
    throw error;
  }
}
test("search-result-number-shortcuts-001 empty search lists the first 25 cached conversations in sidebar order", async () => {
  const { options, finish } = await openCachedSearch(26);
  try {
    const order = [
      1,
      2,
      ...Array.from({ length: 23 }, (_, offset) => {
        return 26 - offset;
      }),
    ];
    expect(options).toHaveLength(order.length);
    for (const [i, n] of order.entries()) {
      expect(options[i]).toHaveTextContent(
        new RegExp("Chat " + n + "(?![0-9])"),
      );
    }
  } finally {
    await finish();
  }
});
test("search-result-number-shortcuts-002 Command+9 opens the ninth cached conversation without showing the sidebar", async () => {
  const { options, keys, history, finish } = await openCachedSearch(10, true);
  try {
    await keys.keyboard("{Meta>}");
    await waitFor(() => {
      return expect(options[0]).toHaveTextContent("⌘1");
    });
    expect(options).toHaveLength(10);
    for (const [index, row] of options.slice(0, 9).entries()) {
      expect(row).toHaveTextContent("⌘" + (index + 1));
    }
    expect(options[9]).not.toHaveTextContent(/⌘/);
    await keys.keyboard("9{/Meta}");
    await waitFor(() => {
      return expect(location.pathname).toBe("/chats/" + history[3]!.id);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    await expect(
      findFastControl("button", "Show chat list"),
    ).resolves.toBeEnabled();
  } finally {
    await finish();
  }
});
