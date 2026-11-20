import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
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

test("Cached conversations appear before remote synchronization", async () => {
  const caseId = 501;
  const thread = chatListThread(1, "Original cached title");
  const remoteGate = context.mocks.deferred<void>();
  const agentGate = context.mocks.deferred<void>();
  installChatListAgent(context, agentGate.promise);
  installChatListRunModels(context);
  installChatListStream(context, {
    caseId,
    snapshot: [thread],
    remoteGate: remoteGate.promise,
  });
  installActiveChatBoundaries(context);

  const page = await startPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth: chatListAuth(caseId),
    cachedChatThreadEvents: cachedChatListEvents(
      caseId,
      [thread],
      [
        chatListEvent(caseId, 2, "renamed", thread.id, {
          title: "Latest cached title",
        }),
      ],
    ),
  });
  // First page content is the startup boundary before any page query.
  await page.content;

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(["Latest cached title"]);
  });
  // Both gates are still closed, so neither remote source has answered.
  expect(remoteGate.settled()).toBeFalsy();
  expect(agentGate.settled()).toBeFalsy();
});

test("A complete cached conversation list remains navigable", async () => {
  const caseId = 502;
  const threads = Array.from({ length: 26 }, (_, offset) => {
    return chatListThread(offset + 1, `Cached conversation ${offset + 1}`);
  });
  const remoteGate = context.mocks.deferred<void>();
  installChatListAgent(context);
  installChatListRunModels(context);
  installChatListStream(context, {
    caseId,
    snapshot: threads,
    remoteGate: remoteGate.promise,
  });
  installActiveChatBoundaries(context);

  const page = await startPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth: chatListAuth(caseId),
    cachedChatThreadEvents: cachedChatListEvents(caseId, threads),
  });
  // First page content is the startup boundary before any page query.
  await page.content;

  const expectedTitles = threads
    .map((thread) => {
      return thread.title;
    })
    .reverse();
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(expectedTitles);
  });
  expect(
    sidebarThreadLinks().map((link) => {
      return link.getAttribute("href");
    }),
  ).toStrictEqual(
    Array.from({ length: 26 }, (_, offset) => {
      return `/chats/${chatListThreadId(26 - offset)}`;
    }),
  );
  expect(remoteGate.settled()).toBeFalsy();
});

test("Signed-out pages do not sync private conversations", async () => {
  const privateRequests: string[] = [];
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    privateRequests.push("snapshot");
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "Unexpected snapshot read" },
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    privateRequests.push("events");
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "Unexpected events read" },
    });
  });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    privateRequests.push("indicators");
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "Unexpected indicators read" },
    });
  });
  context.mocks.api(agentsMainContract.list, ({ respond }) => {
    privateRequests.push("agents");
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "Unexpected agent list read" },
    });
  });

  await setupPage({ context, auth: null, path: "/sign-in" });

  await expect(screen.findByTestId("app-sign-in")).resolves.toBeVisible();
  expect(window.location.pathname).toBe("/sign-in");
  expect(privateRequests).toStrictEqual([]);
});
