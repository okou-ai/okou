import type {
  ChatThreadEvent,
  ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  cachedChatListEvents,
  chatListEvent,
  chatListThread,
  installChatListStream,
  sidebarThreadTitles,
  sidebarThreadLinks,
} from "./chat-list-test-helpers.ts";

const context = testContext();
async function openCachedList(
  caseId: number,
  threads: ChatThreadSnapshotProjection[],
) {
  const remote = context.mocks.deferred<void>();
  const stream = installChatListStream(context, {
    caseId,
    snapshot: threads,
    remoteGate: remote.promise,
  });
  const page = await startPage({
    context,
    path: "/",
    cachedChatThreadEvents: cachedChatListEvents(caseId, threads),
  });
  await page.content;
  const list = within(await screen.findByTestId("chat-list-column"));
  return {
    list,
    deliver(events: ChatThreadEvent[]) {
      stream.setEvents(events);
      remote.resolve();
    },
  };
}

test("chat-list-event-order-001 replaces the removed conversation with the newly created chat destination", async () => {
  const old = chatListThread(9, "Old conversation");
  const current = chatListThread(12, "Current conversation");
  const { list, deliver } = await openCachedList(283, [old]);
  await list.findByText("Old conversation");
  deliver([
    chatListEvent(283, 2, "renamed", old.id, { title: "Closing" }),
    chatListEvent(283, 3, "sort_touched", old.id),
    chatListEvent(283, 4, "created", current.id, { title: current.title }),
    chatListEvent(283, 5, "deleted", old.id),
  ]);
  await list.findByText("Current conversation");
  expect(sidebarThreadTitles()).toStrictEqual(["Current conversation"]);
  expect(sidebarThreadLinks()[0]).toHaveAttribute(
    "href",
    `/chats/${current.id}`,
  );
});

test("chat-list-event-order-002 promotes the oldest chat ahead of the two newer regular chats", async () => {
  const old = chatListThread(1, "Oldest conversation");
  const middle = chatListThread(4, "Middle conversation");
  const recent = chatListThread(7, "Newest conversation");
  const { list, deliver } = await openCachedList(284, [middle, old, recent]);
  await list.findByText("Newest conversation");
  expect(sidebarThreadTitles()).toStrictEqual([
    recent.title,
    middle.title,
    old.title,
  ]);
  deliver([chatListEvent(284, 2, "pinned", old.id)]);
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      old.title,
      recent.title,
      middle.title,
    ]);
  });
});

test("chat-list-event-order-003 retains pin-time ordering when activity reorders regular chats", async () => {
  const first = chatListThread(1, "First pin", {
    pinnedAt: "2026-08-01T00:50:00.000Z",
  });
  const second = chatListThread(2, "Second pin", {
    pinnedAt: "2026-08-01T00:51:00.000Z",
  });
  const tied = chatListThread(3, "Tied pin", { pinnedAt: second.pinnedAt });
  const older = chatListThread(4, "Older regular chat");
  const newer = chatListThread(5, "Newer regular chat");
  const { list, deliver } = await openCachedList(285, [
    older,
    second,
    newer,
    tied,
    first,
  ]);
  const pinned = [tied.title, second.title, first.title];
  await list.findByText("Tied pin");
  expect(sidebarThreadTitles()).toStrictEqual([
    ...pinned,
    newer.title,
    older.title,
  ]);
  deliver([
    chatListEvent(285, 2, "sort_touched", second.id),
    chatListEvent(285, 3, "sort_touched", first.id),
    chatListEvent(285, 4, "sort_touched", older.id),
    chatListEvent(285, 5, "renamed", newer.id, {
      title: "Updated regular chat",
    }),
  ]);
  await list.findByText("Updated regular chat");
  expect(sidebarThreadTitles()).toStrictEqual([
    ...pinned,
    older.title,
    "Updated regular chat",
  ]);
});
