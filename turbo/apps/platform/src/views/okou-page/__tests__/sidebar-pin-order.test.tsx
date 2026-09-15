import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import userEvent from "@testing-library/user-event";
import {
  chatThreadPinOrderContract,
  chatThreadPinContract,
  type ChatThreadEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
import {
  CHAT_LIST_AGENT_ID,
  cachedChatListEvents,
  chatListAuth,
  chatListEvent,
  chatListThread,
  installChatListAgent,
  installChatListStream,
  sidebarThreadLinks,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";

const context = testContext();

async function prepare(caseId: number, tied = false) {
  const auth = chatListAuth(caseId);
  const pinnedAt = "2026-09-01T00:00:00Z";
  const snapshot = [
    chatListThread(3, "First pin", {
      pinnedAt,
      pinOrder: "a0",
    }),
    chatListThread(2, "Second pin", { pinnedAt, pinOrder: tied ? "a0" : "a1" }),
    chatListThread(1, "Last pin", {
      pinnedAt,
      pinOrder: "a2",
    }),
    chatListThread(4, "Regular thread"),
  ];
  installChatListAgent(context);
  const stream = installChatListStream(context, { caseId, snapshot });
  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    auth,
    cachedChatThreadEvents: cachedChatListEvents(caseId, snapshot),
  });
  await screen.findByText("First pin");
  expect(sidebarThreadTitles()).toStrictEqual([
    "First pin",
    "Second pin",
    "Last pin",
    "Regular thread",
  ]);
  return { stream, snapshot };
}
function threadLink(title: string) {
  const link = sidebarThreadLinks().find((item) => {
    return item.textContent?.includes(title);
  });
  if (!link) {
    throw new Error(`Missing thread link: ${title}`);
  }
  return link;
}

function menuButton(title: string) {
  const row = threadLink(title).parentElement;
  const button =
    row &&
    queryAllByRoleFast("button", row).find((item) => {
      return item.getAttribute("aria-label") === "Open chat menu";
    });
  if (!button) {
    throw new Error(`Missing thread menu: ${title}`);
  }
  return button;
}

function menuItem(title: string) {
  const item = queryAllByRoleFast("menuitem").find((element) => {
    return (
      element.getAttribute("aria-label") === title ||
      element.textContent?.trim() === title
    );
  });
  if (!item) {
    throw new Error(`Missing menu item: ${title}`);
  }
  return item;
}

test("keyboard menu reordering survives the matching persisted event", async () => {
  const caseId = 61;
  const requested = context.mocks.deferred<ChatThreadEvent>();
  context.mocks.api(
    chatThreadPinOrderContract.reorder,
    ({ params, body, respond }) => {
      requested.resolve(
        chatListEvent(caseId, 2, "sort_touched", params.id, {
          id: body.eventId,
          pinOrder: body.pinOrder,
        }),
      );
      return respond(204);
    },
  );
  const { stream } = await prepare(caseId);
  const user = userEvent.setup();
  act(() => {
    threadLink("Last pin").focus();
  });
  await user.keyboard("{Tab}");
  expect(menuButton("Last pin")).toHaveFocus();
  await user.keyboard("{Enter}");
  await screen.findByRole("menu");
  await user.keyboard("{ArrowDown}");
  expect(menuItem("Move up")).toHaveFocus();
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "First pin",
      "Last pin",
      "Second pin",
      "Regular thread",
    ]);
  });
  const event = await requested.promise;
  stream.setEvents([
    event,
    chatListEvent(caseId, 3, "renamed", event.chatThreadId, {
      title: "Persisted last pin",
    }),
  ]);
  changeChatThreadList();
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "First pin",
      "Persisted last pin",
      "Second pin",
      "Regular thread",
    ]);
  });
});

test("moving a pin between equal ranks preserves the requested order", async () => {
  context.mocks.api(chatThreadPinOrderContract.reorder, ({ respond }) => {
    return respond(204);
  });
  await prepare(63, true);
  click(menuButton("Last pin"));
  await screen.findByRole("menu");
  click(menuItem("Move up"));
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "First pin",
      "Last pin",
      "Second pin",
      "Regular thread",
    ]);
  });
});

test("new pins receive a rank ahead of all existing pins", async () => {
  const pending = context.mocks.deferred<void>();
  const requested = context.mocks.deferred<string | undefined>();
  context.mocks.api(chatThreadPinContract.pin, async ({ query, respond }) => {
    requested.resolve(query?.pinOrder);
    await pending.promise;
    return respond(204);
  });
  await prepare(64);
  const row = sidebarThreadLinks().find((link) => {
    return link.textContent?.includes("Regular thread");
  })?.parentElement;
  if (!row) {
    throw new Error("Missing regular thread");
  }
  const menuButton = queryAllByRoleFast("button", row).find((item) => {
    return item.getAttribute("aria-label") === "Open chat menu";
  });
  if (!menuButton) {
    throw new Error("Missing thread menu");
  }
  click(menuButton);
  click(menuItem("Pin chat"));
  expect((await requested.promise)! < "a0").toBeTruthy();
  await waitFor(() => {
    return expect(sidebarThreadTitles()).toStrictEqual([
      "Regular thread",
      "First pin",
      "Second pin",
      "Last pin",
    ]);
  });
  pending.resolve();
});

test("touch users can move a pin up and down through the thread menu", async () => {
  context.mocks.api(chatThreadPinOrderContract.reorder, ({ respond }) => {
    return respond(204);
  });
  await prepare(66);
  const user = userEvent.setup();
  await user.pointer([
    { keys: "[TouchA>]", target: menuButton("Last pin") },
    { keys: "[/TouchA]" },
  ]);
  await screen.findByRole("menu");
  click(menuItem("Move up"));
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "First pin",
      "Last pin",
      "Second pin",
      "Regular thread",
    ]);
  });
  await user.pointer([
    { keys: "[TouchA>]", target: menuButton("Last pin") },
    { keys: "[/TouchA]" },
  ]);
  await screen.findByRole("menu");
  click(menuItem("Move down"));
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "First pin",
      "Second pin",
      "Last pin",
      "Regular thread",
    ]);
  });
});
