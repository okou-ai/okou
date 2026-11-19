import type {
  ChatThreadEvent,
  ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  CHAT_LIST_AGENT_ID,
  cachedChatListEvents,
  chatListAuth,
  chatListEvent,
  chatListThread,
  chatListThreadId,
  installActiveChatBoundaries,
  installChatListAgent,
  installChatListRunModels,
  installChatListStream,
  sidebarThreadLinks,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";

const context = testContext();

interface ChatListStory {
  readonly caseId: number;
  readonly cached: readonly ChatThreadSnapshotProjection[];
  readonly remoteEvents: readonly ChatThreadEvent[];
}

async function openCachedChatList(story: ChatListStory): Promise<{
  readonly releaseRemote: () => void;
}> {
  const remoteGate = context.mocks.deferred<void>();
  installChatListAgent(context);
  installChatListRunModels(context);
  installChatListStream(context, {
    caseId: story.caseId,
    snapshot: story.cached,
    events: story.remoteEvents,
    remoteGate: remoteGate.promise,
  });
  installActiveChatBoundaries(context);
  await startPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth: chatListAuth(story.caseId),
    cachedChatThreadEvents: cachedChatListEvents(story.caseId, story.cached),
  });
  return {
    releaseRemote: () => {
      remoteGate.resolve();
    },
  };
}

test("Conversation lifecycle events produce the current list", async () => {
  const caseId = 401;
  const old = chatListThread(1, "Old conversation");
  const currentId = chatListThreadId(2);
  const { releaseRemote } = await openCachedChatList({
    caseId,
    cached: [old],
    remoteEvents: [
      chatListEvent(caseId, 2, "renamed", old.id, {
        title: "Renamed old conversation",
      }),
      chatListEvent(caseId, 3, "sort_touched", old.id),
      chatListEvent(caseId, 4, "created", currentId, {
        title: "Current conversation",
      }),
      chatListEvent(caseId, 5, "deleted", old.id),
    ],
  });

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(["Old conversation"]);
  });

  releaseRemote();

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(["Current conversation"]);
  });
  expect(sidebarThreadLinks()[0]).toHaveAttribute(
    "href",
    `/chats/${currentId}`,
  );
});

test("A pinned conversation stays above newer unpinned items", async () => {
  const caseId = 402;
  const oldest = chatListThread(1, "Oldest conversation");
  const middle = chatListThread(2, "Middle conversation");
  const newest = chatListThread(3, "Newest conversation");
  const { releaseRemote } = await openCachedChatList({
    caseId,
    cached: [oldest, middle, newest],
    remoteEvents: [chatListEvent(caseId, 2, "pinned", oldest.id)],
  });

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "Newest conversation",
      "Middle conversation",
      "Oldest conversation",
    ]);
  });

  releaseRemote();

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "Oldest conversation",
      "Newest conversation",
      "Middle conversation",
    ]);
  });
});

test("Pinned ordering follows pin time through activity updates", async () => {
  const caseId = 403;
  const firstPin = chatListThread(1, "First pin", {
    pinnedAt: "2026-08-01T00:50:00.000Z",
  });
  const secondPin = chatListThread(2, "Second pin", {
    pinnedAt: "2026-08-01T00:51:00.000Z",
  });
  const tiedPin = chatListThread(3, "Tied pin", {
    pinnedAt: "2026-08-01T00:51:00.000Z",
  });
  const olderRegular = chatListThread(4, "Older regular chat");
  const newerRegular = chatListThread(5, "Newer regular chat");
  const { releaseRemote } = await openCachedChatList({
    caseId,
    cached: [firstPin, secondPin, tiedPin, olderRegular, newerRegular],
    remoteEvents: [
      chatListEvent(caseId, 2, "sort_touched", secondPin.id),
      chatListEvent(caseId, 3, "sort_touched", firstPin.id),
      chatListEvent(caseId, 4, "sort_touched", olderRegular.id),
      chatListEvent(caseId, 5, "renamed", newerRegular.id, {
        title: "Updated regular chat",
      }),
    ],
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

  releaseRemote();

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
