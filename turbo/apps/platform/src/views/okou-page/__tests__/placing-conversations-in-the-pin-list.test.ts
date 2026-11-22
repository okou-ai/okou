import { waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import {
  chatThreadPinContract,
  chatThreadPinOrderContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chatListThread,
  chatListAuth,
  installChatListStream,
  installActiveChatBoundaries,
  sidebarThreadTitles,
  sidebarThreadLinks,
} from "./chat-list-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
async function arrange() {
  const rows = [
    "First pin",
    "Hidden archive",
    "Last pin",
    "Regular thread",
  ].map((name, i) => {
    return chatListThread(
      i + 1,
      name,
      i === 3
        ? {}
        : {
            pinOrder: "a" + i,
            pinnedAt: "2026-06-17T12:00:00Z",
            archived: i === 1,
          },
    );
  });
  installChatListStream(context, { caseId: 81, snapshot: rows });
  installActiveChatBoundaries(context);
  await setupPage({ context, auth: chatListAuth(81), path: "/?compose=1" });
  await waitFor(() => {
    return expect(sidebarThreadTitles()).toStrictEqual([
      "First pin",
      "Last pin",
      "Regular thread",
    ]);
  });
  return rows;
}
async function action(id: string, label: string) {
  const link = sidebarThreadLinks().find((node) => {
    return node.dataset.sidebarChatThreadId === id;
  })!;
  const row = link.closest<HTMLElement>("[data-sidebar-chat-thread-row-id]")!;
  const user = userEvent.setup({ delay: null });
  await user.click(await findFastControl("button", "Open chat menu", row));
  const choice = await waitFor(() => {
    const item = queryAllByRoleFast("menuitem").find((node) => {
      return node.textContent?.includes(label);
    });
    expect(item).toBeDefined();
    return item!;
  });
  await user.click(choice);
}
test("sidebar-pin-order-003 Moving the last visible pin up crosses the archived rank without revealing the archived conversation", async () => {
  context.mocks.api(chatThreadPinOrderContract.reorder, ({ respond }) => {
    return respond(204);
  });
  const rows = await arrange();
  await action(rows[2]!.id, "Move up");
  await waitFor(() => {
    return expect(sidebarThreadTitles()).toStrictEqual([
      "Last pin",
      "First pin",
      "Regular thread",
    ]);
  });
});
test("sidebar-pin-order-006 Pinning a regular conversation places it ahead of the earliest pin while the server confirmation is withheld", async () => {
  const waiting = context.mocks.deferred<void>(),
    sent = context.mocks.deferred<{ id: string; rank: string | undefined }>();
  context.mocks.api(
    chatThreadPinContract.pin,
    async ({ params, query, respond }) => {
      sent.resolve({ id: params.id, rank: query?.pinOrder });
      await waiting.promise;
      return respond(204);
    },
  );
  try {
    const rows = await arrange();
    await action(rows[3]!.id, "Pin chat");
    const received = await sent.promise;
    expect(received.id).toBe(rows[3]!.id);
    expect(typeof received.rank).toBe("string");
    expect(received.rank! < "a0").toBeTruthy();
    await waitFor(() => {
      return expect(sidebarThreadTitles()).toStrictEqual([
        "Regular thread",
        "First pin",
        "Last pin",
      ]);
    });
  } finally {
    waiting.resolve();
  }
});
