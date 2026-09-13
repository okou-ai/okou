import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import {
  chatThreadMetadataContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  CHAT_LIST_AGENT_ID,
  cachedChatListEvents,
  chatListAuth,
  chatListEvent,
  chatListThread,
  fastButton,
  installChatListAgent,
  installChatListStream,
  sidebarThreadLinks,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";

const context = testContext();

test("Cached conversations appear before remote synchronization", async () => {
  const auth = chatListAuth(1);
  const cached = chatListThread(1, "Original cached title");
  const rename = chatListEvent(1, 2, "renamed", cached.id, {
    title: "Latest cached title",
  });
  const remote = context.mocks.deferred<void>();
  const agents = context.mocks.deferred<void>();
  installChatListStream(context, {
    caseId: 1,
    snapshot: [cached],
    events: [rename],
    remoteGate: remote.promise,
  });
  installChatListAgent(context, agents.promise);

  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth,
    cachedChatThreadEvents: cachedChatListEvents(1, [cached], [rename]),
  });
  await screen.findByText("Latest cached title");
  expect(sidebarThreadTitles()).toStrictEqual(["Latest cached title"]);
  expect(remote.settled()).toBeFalsy();
  expect(agents.settled()).toBeFalsy();
});

test("A complete cached conversation list remains navigable", async () => {
  const auth = chatListAuth(3);
  const cached = Array.from({ length: 26 }, (_, offset) => {
    const index = offset + 1;
    return chatListThread(index, `Cached conversation ${index}`);
  });
  const remote = context.mocks.deferred<void>();
  installChatListStream(context, {
    caseId: 3,
    snapshot: cached,
    remoteGate: remote.promise,
  });
  installChatListAgent(context);

  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth,
    cachedChatThreadEvents: cachedChatListEvents(3, cached),
  });
  const expected = Array.from({ length: 26 }, (_, offset) => {
    return `Cached conversation ${26 - offset}`;
  });
  await screen.findByText("Cached conversation 26");
  expect(sidebarThreadTitles()).toStrictEqual(expected);
  const links = sidebarThreadLinks();
  expect(links).toHaveLength(26);
  expect(
    links.every((link) => {
      return link.getAttribute("href")?.startsWith("/chats/");
    }),
  ).toBeTruthy();
  expect(remote.settled()).toBeFalsy();
});

test("Rename dialog uses the latest cached title", async () => {
  const auth = chatListAuth(11);
  const cached = chatListThread(11, "Original title");
  const rename = chatListEvent(11, 2, "renamed", cached.id, {
    title: "Cached renamed title",
  });
  const remote = context.mocks.deferred<void>();
  const detail = context.mocks.deferred<void>();
  installChatListStream(context, {
    caseId: 11,
    snapshot: [cached],
    events: [rename],
    remoteGate: remote.promise,
  });
  installChatListAgent(context);
  context.mocks.api(chatThreadMetadataContract.get, async ({ respond }) => {
    await detail.promise;
    return respond(404, {
      error: {
        code: "CHAT_THREAD_NOT_FOUND",
        message: "Chat thread not found",
      },
    });
  });

  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth,
    cachedChatThreadEvents: cachedChatListEvents(11, [cached], [rename]),
  });
  await screen.findByText("Cached renamed title");
  expect(sidebarThreadTitles()).toStrictEqual(["Cached renamed title"]);
  const row = sidebarThreadLinks()[0]?.closest(".group");
  if (!(row instanceof HTMLElement)) {
    throw new Error("Expected the cached conversation row");
  }
  const link = row.querySelector<HTMLAnchorElement>(
    "[data-sidebar-chat-thread-id]",
  );
  if (!link) {
    throw new Error("Expected the cached conversation link");
  }
  await userEvent.dblClick(link);

  const input = await screen.findByRole("textbox");
  expect(input).toHaveValue("Cached renamed title");
  expect(detail.settled()).toBeFalsy();
  expect(remote.settled()).toBeFalsy();
});

test("Signed-out pages do not sync private conversations", async () => {
  let snapshotRequested = false;
  let eventsRequested = false;
  let unreadRequested = false;
  let agentsRequested = false;
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    snapshotRequested = true;
    return respond(401, {
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    eventsRequested = true;
    return respond(401, {
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    });
  });
  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    unreadRequested = true;
    return respond(401, {
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    });
  });
  context.mocks.api(agentsMainContract.list, ({ respond }) => {
    agentsRequested = true;
    return respond(401, {
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    });
  });

  await setupPage({ context, path: "/sign-in", auth: null });

  // Hosted Clerk owns the form, so the mounted component marks readiness.
  await screen.findByTestId("clerk-sign-in");
  expect(window.location.pathname).toBe("/sign-in");
  expect(snapshotRequested).toBeFalsy();
  expect(eventsRequested).toBeFalsy();
  expect(unreadRequested).toBeFalsy();
  expect(agentsRequested).toBeFalsy();
});

test("The unread filter applies to cached conversations", async () => {
  const auth = chatListAuth(16);
  const unread = chatListThread(15, "Unread cached conversation");
  const read = chatListThread(16, "Read cached conversation");
  const remote = context.mocks.deferred<void>();
  installChatListStream(context, {
    caseId: 16,
    snapshot: [unread, read],
    remoteGate: remote.promise,
  });
  installChatListAgent(context);
  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    return respond(200, {
      unreads: [{ threadId: unread.id, unreadAt: "2026-08-01T02:00:00.000Z" }],
    });
  });

  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth,
    cachedChatThreadEvents: cachedChatListEvents(16, [unread, read]),
  });
  await screen.findByText("Read cached conversation");
  expect(sidebarThreadTitles()).toStrictEqual([
    "Read cached conversation",
    "Unread cached conversation",
  ]);
  await userEvent.click(fastButton("Open chat list menu"));
  const unreadOnly = queryAllByRoleFast("menuitem", document).find((item) => {
    return item.textContent?.trim() === "Unread only";
  });
  expect(unreadOnly).toBeDefined();
  await userEvent.click(unreadOnly!);

  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual(["Unread cached conversation"]);
  });
  expect(
    screen.queryByText("Read cached conversation"),
  ).not.toBeInTheDocument();
  expect(remote.settled()).toBeFalsy();
});
