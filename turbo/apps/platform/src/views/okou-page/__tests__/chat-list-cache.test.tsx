import { chatSearchContract } from "@okouai/api-contracts/contracts/chat-threads";
import userEvent from "@testing-library/user-event";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
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

  context.mocks.api(chatSearchContract.search, ({ query, respond }) => {
    return respond(200, {
      results: Array.from({ length: 30 }, (_, index) => {
        const source = history[(index + 2) % history.length]!;
        return {
          chatThreadId: source.id,
          matchedMessage: {
            role: "assistant" as const,
            chatThreadId: source.id,
            seqId: index + 2,
            runId: null,
            createdAt: source.updatedAt,
            content: query.keyword + " entry " + (index + 1),
          },
          matchedRanges: [{ start: 0, end: query.keyword.length }],
        };
      }),
    });
  });
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
    const input = dialog.getByRole("combobox");
    return {
      input,
      dialog,
      history,
      keys,
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
test("Blank queries leave cached chats hidden and typing shares twenty-five places between title and message matches", async () => {
  const { input, dialog, finish } = await openCachedSearch(26);
  try {
    expect(dialog.queryByRole("listbox")).toBeNull();
    await fill(input, "   ");
    expect(dialog.queryByRole("status")).toBeNull();
    expect(dialog.queryByRole("listbox")).toBeNull();
    await fill(input, "letter");
    const only = await dialog.findByRole("group", { name: "Messages" });
    expect(queryAllByRoleFast("option", only)).toHaveLength(25);
    expect(dialog.queryByRole("group", { name: "Threads" })).toBeNull();
    await fill(input, "Chat");
    await dialog.findByLabelText("chat entry 22");
    const titles = dialog.getByRole("group", { name: "Threads" });
    const messages = dialog.getByRole("group", { name: "Messages" });
    const groups = dialog.getAllByRole("group");
    expect(groups.indexOf(titles)).toBeLessThan(groups.indexOf(messages));
    const shown = queryAllByRoleFast("option", titles);
    expect(shown).toHaveLength(3);
    expect(shown[0]).toHaveTextContent("Chat 26");
    expect(shown[1]).toHaveTextContent("Chat 25");
    expect(shown[2]).toHaveTextContent("Chat 24");
    expect(queryAllByRoleFast("option", messages)).toHaveLength(22);
  } finally {
    await finish();
  }
});
test.each([
  { digit: 4, message: 1 },
  { digit: 9, message: 6 },
])(
  "Command+$digit opens matching message $message after three titles with the sidebar hidden",
  async ({ digit, message }) => {
    const { input, dialog, history, keys, finish } = await openCachedSearch(
      10,
      true,
    );
    try {
      expect(dialog.queryByRole("listbox")).toBeNull();
      await fill(input, "Chat");
      await dialog.findByLabelText("chat entry 22");
      const options = dialog.getAllByRole("option");
      expect(options[digit - 1]).toHaveTextContent("entry " + message);
      await keys.keyboard("{Meta>}");
      await waitFor(() => {
        return expect(options[0]).toHaveTextContent("⌘1");
      });
      expect(options).toHaveLength(25);
      for (const [index, row] of options.slice(0, 9).entries()) {
        expect(row).toHaveTextContent("⌘" + (index + 1));
      }
      expect(options[9]).not.toHaveTextContent(/⌘/);
      await keys.keyboard(String(digit) + "{/Meta}");
      await waitFor(() => {
        return expect(location.pathname).toBe(
          "/chats/" + history[message + 1]!.id,
        );
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      await expect(
        findFastControl("button", "Show chat list"),
      ).resolves.toBeEnabled();
    } finally {
      await finish();
    }
  },
);

test("Leaving the member session keeps its saved conversation out of the signed-out sign-in page", async () => {
  const member = createTestRuntime(context);
  const thread = chatListThread(91, "Private financing draft");
  installChatListStream(context, { caseId: 902, snapshot: [thread] });
  await setupPage({ context: member, path: "/" });
  await screen.findByText("Private financing draft");
  cleanup();
  member.dispose();
  await setupPage({ context, path: "/sign-in", auth: null });
  await expect(screen.findByTestId("clerk-sign-in")).resolves.toBeVisible();
  expect(location.pathname).toBe("/sign-in");
  expect(screen.queryByText("Private financing draft")).not.toBeInTheDocument();
});
