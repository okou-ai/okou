import { chatRelationsContract } from "@okouai/api-contracts/contracts/chat-relations";
import { screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chatListThread,
  chatListEvent,
  installChatListStream,
} from "./chat-list-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { openResources } from "./chat-resources-test-helpers.ts";

const context = testContext();
const parent = chatListThread(11, "Release planning");
const child = chatListThread(12, "Release notes");
const launchId = "2cfed9db-f2ee-4180-9722-b0e72ee6c740";
function relatedChats(respondToRelationship?: () => Promise<void> | undefined) {
  context.mocks.browser.matchMedia(true);
  mockChatLifecycle(context, {
    threadId: child.id,
    threadTitle: child.title,
    chatEvents: [
      {
        id: launchId,
        runId: launchId,
        role: "user",
        createdAt: child.createdAt,
        content: null,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "chat_thread",
              runId: launchId,
              threadId: parent.id,
              titleSnapshot: "Release draft",
            },
            { type: "text", text: "Prepare release notes" },
          ],
        },
      },
    ],
  });
  const stream = installChatListStream(context, {
    caseId: 291,
    snapshot: [parent, child],
  });
  context.mocks.api(chatRelationsContract.children, ({ respond }) => {
    return respond(200, { items: [] });
  });

  context.mocks.api(
    chatRelationsContract.communications,
    async ({ respond }) => {
      await respondToRelationship?.();
      return respond(200, {
        items: [
          {
            threadId: parent.id,
            title: "Release draft",
            status: "idle",
            sentCount: 0,
            receivedCount: 1,
            lastMessageAt: child.createdAt,
          },
        ],
      });
    },
  );
  return stream;
}

test("chat-relations-rename-001 shows the current parent as one linked source with a collapsed message history", async () => {
  relatedChats();
  await setupPage({ context, path: `/chats/${child.id}` });
  await screen.findByText("Prepare release notes");
  const panel = await openResources();
  const chats = await within(panel).findByRole("region", { name: "Chats" });
  const current = await within(chats).findByText("Release planning");
  const link = current.closest("a");
  expect(link).toHaveAttribute("href", `/chats/${parent.id}`);
  expect(within(link!).getByText("From")).toBeInTheDocument();
  const parentLinks = queryAllByRoleFast("link", panel).filter((candidate) => {
    return candidate.getAttribute("href") === `/chats/${parent.id}`;
  });
  expect(parentLinks).toHaveLength(1);
  const row = current.closest("li")!;
  expect(within(row).getByLabelText(/messages/i)).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(
    within(panel).queryByRole("region", { name: "From" }),
  ).not.toBeInTheDocument();
});

test("chat-relations-rename-003 applies the cross-tab rename while the relationship refresh is held", async () => {
  const refreshing = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  let holdRefresh = false;
  const feed = relatedChats(() => {
    if (holdRefresh) {
      refreshing.resolve();
      return response.promise;
    }
    return undefined;
  });
  await setupPage({ context, path: `/chats/${child.id}` });
  const panel = await openResources();
  const chats = await within(panel).findByRole("region", { name: "Chats" });
  await within(chats).findByText("Release planning");
  holdRefresh = true;
  try {
    feed.setEvents([
      chatListEvent(291, 2, "renamed", parent.id, {
        title: "November release",
      }),
    ]);
    context.mocks.ably.trigger("threadListChanged");
    await refreshing.promise;
    await waitFor(() => {
      return expect(
        within(chats).getByText("November release").closest("a"),
      ).toHaveAttribute("href", `/chats/${parent.id}`);
    });
  } finally {
    response.resolve();
  }
});
