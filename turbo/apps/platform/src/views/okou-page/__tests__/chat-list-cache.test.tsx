import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  cachedChatListEvents,
  chatListEvent,
  chatListThread,
  installChatListAgent,
  installChatListStream,
  sidebarThreadLinks,
} from "./chat-list-test-helpers.ts";

const context = testContext();

test("chat-list-cache-001 displays the cached rename while both remote sources are pending", async () => {
  const old = chatListThread(6, "Unreviewed budget");
  const revision = chatListEvent(281, 2, "renamed", old.id, {
    title: "Approved autumn budget",
  });
  const hold = context.mocks.deferred<void>();
  installChatListAgent(context, hold.promise);
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
  installChatListAgent(context);
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
