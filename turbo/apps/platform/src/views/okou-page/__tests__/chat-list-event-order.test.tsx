import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
import {
  CHAT_LIST_AGENT_ID,
  cachedChatListEvents,
  chatListAuth,
  chatListEvent,
  chatListThread,
  chatListThreadId,
  installChatListAgent,
  installChatListStream,
  sidebarThreadLinks,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";

const context = testContext();

test("Conversation lifecycle events produce the current list", async () => {
  const auth = chatListAuth(5);
  const oldThread = chatListThread(31, "Old conversation");
  const newThreadId = chatListThreadId(32);
  const remote = context.mocks.deferred<void>();
  installChatListAgent(context);
  installChatListStream(context, {
    caseId: 5,
    snapshot: [oldThread],
    events: [
      chatListEvent(5, 2, "renamed", oldThread.id, {
        title: "Renamed old conversation",
      }),
      chatListEvent(5, 3, "sort_touched", oldThread.id),
      chatListEvent(5, 4, "created", newThreadId, {
        title: "Current conversation",
        selectedModel: "claude-sonnet-4-6",
      }),
      chatListEvent(5, 5, "deleted", oldThread.id),
    ],
    remoteGate: remote.promise,
  });

  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth,
    cachedChatThreadEvents: cachedChatListEvents(5, [oldThread]),
  });

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(["Old conversation"]);
  });

  remote.resolve();
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(["Current conversation"]);
  });
  const links = sidebarThreadLinks();
  expect(links).toHaveLength(1);
  expect(links[0]).toHaveAttribute("data-sidebar-chat-thread-id", newThreadId);
  expect(links[0]).toHaveAttribute("href", `/chats/${newThreadId}`);
});

test("A pinned conversation stays above newer unpinned items", async () => {
  const auth = chatListAuth(10);
  const oldest = chatListThread(33, "Oldest conversation");
  const middle = chatListThread(34, "Middle conversation");
  const newest = chatListThread(35, "Newest conversation");
  const remote = context.mocks.deferred<void>();
  installChatListAgent(context);
  installChatListStream(context, {
    caseId: 10,
    snapshot: [oldest, middle, newest],
    events: [chatListEvent(10, 2, "pinned", oldest.id)],
    remoteGate: remote.promise,
  });

  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth,
    cachedChatThreadEvents: cachedChatListEvents(10, [oldest, middle, newest]),
  });

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "Newest conversation",
      "Middle conversation",
      "Oldest conversation",
    ]);
  });
  remote.resolve();

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "Oldest conversation",
      "Newest conversation",
      "Middle conversation",
    ]);
  });
  expect(sidebarThreadLinks()[0]).toHaveAttribute(
    "data-sidebar-chat-thread-id",
    oldest.id,
  );
});

test("Pinned ordering follows pin time through activity updates", async () => {
  const caseId = 11;
  const auth = chatListAuth(caseId);
  const firstPin = chatListThread(36, "First pin", {
    pinnedAt: "2026-08-01T00:50:00.000Z",
    sortAt: "2026-08-01T00:59:00.000Z",
  });
  const secondPin = chatListThread(37, "Second pin", {
    pinnedAt: "2026-08-01T00:51:00.000Z",
  });
  const tiedPin = chatListThread(38, "Tied pin", {
    pinnedAt: secondPin.pinnedAt,
  });
  const older = chatListThread(39, "Older regular chat");
  const newer = chatListThread(40, "Newer regular chat");
  const snapshot = [firstPin, secondPin, tiedPin, older, newer];
  const remote = context.mocks.deferred<void>();
  installChatListAgent(context);
  installChatListStream(context, {
    caseId,
    snapshot,
    events: [
      chatListEvent(caseId, 2, "sort_touched", secondPin.id),
      chatListEvent(caseId, 3, "sort_touched", firstPin.id),
      chatListEvent(caseId, 4, "sort_touched", older.id),
      chatListEvent(caseId, 5, "renamed", newer.id, {
        title: "Updated regular chat",
      }),
    ],
    remoteGate: remote.promise,
  });

  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth,
    cachedChatThreadEvents: cachedChatListEvents(caseId, snapshot),
  });

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "Tied pin",
      "Second pin",
      "First pin",
      "Newer regular chat",
      "Older regular chat",
    ]);
  });
  remote.resolve();

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "Tied pin",
      "Second pin",
      "First pin",
      "Older regular chat",
      "Updated regular chat",
    ]);
  });
});

test("Unpinning restores activity order and repinning uses the new pin time", async () => {
  const caseId = 13;
  const auth = chatListAuth(caseId);
  const firstPin = chatListThread(41, "First pin", {
    pinnedAt: "2026-08-01T00:50:00.000Z",
  });
  const secondPin = chatListThread(42, "Second pin", {
    pinnedAt: "2026-08-01T00:51:00.000Z",
  });
  const regular = chatListThread(43, "Regular chat");
  const snapshot = [firstPin, secondPin, regular];
  const remote = context.mocks.deferred<void>();
  const unpin = chatListEvent(caseId, 2, "unpinned", firstPin.id);
  installChatListAgent(context);
  const stream = installChatListStream(context, {
    caseId,
    snapshot,
    events: [unpin],
    remoteGate: remote.promise,
  });

  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth,
    cachedChatThreadEvents: cachedChatListEvents(caseId, snapshot),
  });

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "Second pin",
      "First pin",
      "Regular chat",
    ]);
  });
  remote.resolve();

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "Second pin",
      "Regular chat",
      "First pin",
    ]);
  });
  stream.setEvents([unpin, chatListEvent(caseId, 3, "pinned", firstPin.id)]);
  changeChatThreadList();

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "First pin",
      "Second pin",
      "Regular chat",
    ]);
  });
});
