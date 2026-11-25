import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  mockChatGeometry,
  messageOffset,
  requiredElement,
  conversationEvents,
  messageAnchor,
} from "./chat-conversation-locator-test-helpers.ts";
import {
  chatRelationsContract,
  type CreatedChatRelation,
  type ChatCommunication,
  type ChatRelationMessage,
} from "@okouai/api-contracts/contracts/chat-relations";
import {
  chatThreadEventsContract,
  type UserMessagePart,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, within, waitFor, fireEvent } from "@testing-library/react";
import { test, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import styleText from "./chat-relation-title-fixture.css?inline";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  chatEventRowsResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
} from "./chat-event-test-helpers.ts";
import {
  createChatRunFixtures,
  promptEvent,
  queryButton,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-run-test-fixtures.ts";
import {
  chatListThread,
  chatListEvent,
  installChatListStream,
} from "./chat-list-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { openResources } from "./chat-resources-test-helpers.ts";

const context = testContext();

const date = (day: number) => {
  return new Date(Date.UTC(2026, 9, day)).toISOString();
};
const path = (id: string) => {
  return "/chats/" + id;
};
function child(title: string, day = 1): CreatedChatRelation {
  return {
    id: crypto.randomUUID(),
    threadId: crypto.randomUUID(),
    sourceRunId: crypto.randomUUID(),
    title,
    createdAt: date(day),
    status: "idle",
  };
}
function contact(title: string): ChatCommunication & { title: string } {
  return {
    threadId: crypto.randomUUID(),
    title,
    sentCount: 1,
    receivedCount: 1,
    lastMessageAt: date(20),
    status: "idle",
  };
}
function origin(peer: ChatCommunication & { title: string }) {
  const runId = crypto.randomUUID();
  return {
    type: "chat_thread",
    threadId: peer.threadId,
    runId,

    titleSnapshot: peer.title,
  } as const;
}
function message(
  peer: ChatCommunication,
  text: string,
  direction: "sent" | "received",
  targetRunId: string | null,
): ChatRelationMessage {
  return {
    id: crypto.randomUUID(),
    messageEventId: crypto.randomUUID(),
    sourceRunId: crypto.randomUUID(),
    direction,
    sourceChatThreadId: direction === "sent" ? RUN_THREAD_ID : peer.threadId,
    targetChatThreadId: direction === "sent" ? peer.threadId : RUN_THREAD_ID,
    targetRunId,
    createdAt: date(22),
    userMessage: { version: 1, parts: [{ type: "text", text }] },
  };
}
type Listing = {
  children?: CreatedChatRelation[];
  contacts?: ChatCommunication[];
  history?: ChatRelationMessage[];
  childrenGate?: Promise<unknown>;
  contactsGate?: Promise<unknown>;
};
function install(
  current: Listing,
  source?: UserMessagePart,
  destination?: {
    id: string;
    title: string;
    listing: Listing;
    runId?: string;
    followingTurns?: number;
  },
) {
  const received = current.history?.find((item) => {
    return item.targetChatThreadId === RUN_THREAD_ID && item.targetRunId;
  });
  const runId = received?.targetRunId ?? crypto.randomUUID();
  const prompt = "Trace the origin of this review";
  const event = promptEvent({ id: runId, runId, seqId: 1, text: prompt });
  const original = {
    ...event,
    userMessage: {
      version: 1 as const,
      parts: [
        { type: "text" as const, text: prompt },
        ...(source ? [source] : []),
      ],
    },
  };
  const control = createChatRunFixtures(context).installRunChat({
    chatEvents: [original],
  });
  if (destination) {
    const targetRun = destination.runId ?? crypto.randomUUID();
    const target = promptEvent({
      id: targetRun,
      runId: targetRun,
      seqId: 1,
      text: "Work in " + destination.title,
    });
    const nextTurns = Array.from(
      { length: destination.followingTurns ?? 0 },
      (_, i) => {
        const id = crypto.randomUUID();
        return promptEvent({
          id,
          runId: id,
          seqId: i + 2,
          text: "Follow-up survey " + (i + 1),
        });
      },
    );
    context.mocks.api(
      chatThreadEventsContract.rows,
      ({ params, query, respond }) => {
        const events =
          params.threadId === destination.id
            ? [target, ...nextTurns]
            : params.threadId === RUN_THREAD_ID
              ? [original]
              : [];
        const rows = mockChatEventRows(
          normalizeMockChatEvents(events, params.threadId),
        ).filter((row) => {
          return row.seqId > query.sinceSeqId;
        });
        return respond(200, chatEventRowsResponse(rows, query));
      },
    );
    control.setThreadList(
      [{ id: RUN_THREAD_ID, title: "Origin review" }, destination].map(
        ({ id, title }) => {
          return {
            id,
            title,

            createdAt: date(1),
            updatedAt: date(5),
          };
        },
      ),
    );
  }
  function listing(id: string): Listing {
    return id === RUN_THREAD_ID
      ? current
      : id === destination?.id
        ? destination.listing
        : {};
  }
  context.mocks.api(
    chatRelationsContract.children,
    async ({ params, respond }) => {
      const data = listing(params.id);
      await data.childrenGate;
      return respond(200, { items: data.children ?? [] });
    },
  );
  context.mocks.api(
    chatRelationsContract.communications,
    async ({ params, respond }) => {
      const data = listing(params.id);
      await data.contactsGate;
      return respond(200, { items: data.contacts ?? [] });
    },
  );
  context.mocks.api(chatRelationsContract.messages, ({ params, respond }) => {
    return respond(200, {
      items: (listing(params.id).history ?? []).filter((m) => {
        return [m.targetChatThreadId, m.sourceChatThreadId].includes(
          params.peerId,
        );
      }),
    });
  });
  return control;
}
async function openChat() {
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await screen.findByText("Trace the origin of this review");
}
async function openPanel() {
  const button = await waitFor(() => {
    const el = queryButton("Artifacts and chats");
    expect(el).toBeEnabled();
    expect(el).not.toHaveAttribute("aria-disabled", "true");
    return el!;
  });
  click(button);
  return screen.findByRole("dialog", { name: "Artifacts and chats" });
}
function anchor(el: HTMLElement) {
  const link = el.closest("a");
  if (!link) {
    throw new Error("Expected a chat link");
  }
  return link;
}
function chats(panel: HTMLElement) {
  return within(panel).findByRole("region", { name: "Chats" });
}
test("chat-relations-001 the pending children response holds back the source and related chat", async () => {
  const gate = context.mocks.deferred<void>(),
    created = child("Inventory audit"),
    href = "https://example.slack.com/archives/C123/p12345";
  install(
    { childrenGate: gate.promise, children: [created] },
    { type: "source", kind: "slack", href },
  );
  await openChat();
  const panel = await openPanel();
  const view = within(panel);
  await expect(
    view.findByRole("status", { name: "Loading artifacts" }),
  ).resolves.toBeVisible();
  expect(panel.querySelector('a[href="' + href + '"]')).toBeNull();
  gate.resolve();
  expect(anchor(await view.findByText("Inventory audit"))).toHaveAttribute(
    "href",
    path(created.threadId),
  );
  expect(panel.querySelector('a[href="' + href + '"]')).toBeVisible();
  expect(view.queryByRole("status", { name: "Loading artifacts" })).toBeNull();
});
test("chat-relations-004 opening a related chat waits for that chat's own relationships", async () => {
  const next = child("Second review"),
    leaf = child("Review addendum"),
    gate = context.mocks.deferred<void>();
  install({ children: [next] }, undefined, {
    id: next.threadId,
    title: "Second review",
    listing: { children: [leaf], contactsGate: gate.promise },
  });
  await openChat();
  const first = await openPanel();
  click(anchor(await within(await chats(first)).findByText("Second review")));
  await screen.findByText("Work in Second review");
  expect(location.pathname).toBe(path(next.threadId));
  const nextPanel = await openPanel();
  const nextView = within(nextPanel);
  await expect(
    nextView.findByRole("status", { name: "Loading artifacts" }),
  ).resolves.toBeVisible();
  expect(nextView.queryByText("Second review")).toBeNull();
  gate.resolve();
  const section = await chats(nextPanel);
  expect(
    anchor(await within(section).findByText("Review addendum")),
  ).toHaveAttribute("href", path(leaf.threadId));
  expect(within(section).queryByText("Second review")).toBeNull();
});
test("chat-relations-008 a listed parent occupies a single marked row next to its child", async () => {
  const parent = contact("Quarterly plan"),
    leaf = child("Produce estimates");
  install({ contacts: [parent], children: [leaf] }, origin(parent));
  await openChat();
  const panel = await openPanel(),
    section = await chats(panel);
  const list = within(section);
  expect(list.getAllByRole("listitem")).toHaveLength(2);
  const parentLink = anchor(list.getByText("Quarterly plan"));
  expect(parentLink).toHaveAttribute("href", path(parent.threadId));
  expect(within(parentLink).getByText("From")).toBeVisible();
  expect(anchor(list.getByText("Produce estimates"))).toHaveAttribute(
    "href",
    path(leaf.threadId),
  );
  expect(within(panel).queryByRole("region", { name: "From" })).toBeNull();
});
test("chat-relations-009 the origin leads the three-chat preview and expanding adds the last child", async () => {
  const parent = contact("Original brief"),
    children = [
      child("First update", 5),
      child("Second update", 4),
      child("Third update", 3),
    ];
  const directory = install({ contacts: [parent], children }, origin(parent));
  directory.setThreadList([
    {
      id: RUN_THREAD_ID,
      title: "Origin review",
      createdAt: date(2),
      updatedAt: date(2),
    },
    {
      id: parent.threadId,
      title: parent.title,
      createdAt: date(1),
      updatedAt: parent.lastMessageAt,
    },
    ...children.map((item) => {
      return {
        id: item.threadId,
        title: item.title,
        createdAt: item.createdAt,
        updatedAt: item.createdAt,
      };
    }),
  ]);
  await openChat();
  const section = await chats(await openPanel());
  const list = within(section);
  const rows = list.getAllByRole("listitem");
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveTextContent("Original brief");
  expect(within(rows[0]!).getByText("From")).toBeVisible();
  expect(list.queryByText("Third update")).toBeNull();
  click(queryButton("Show more", section)!);
  await expect(list.findByText("Third update")).resolves.toBeVisible();
  expect(list.getAllByRole("listitem")).toHaveLength(4);
});
test("chat-relations-010 each message opens its destination and closing history hides its cards", async () => {
  const peer = contact("Field notes"),
    sent = message(peer, "Inspect batch A", "sent", crypto.randomUUID()),
    received = message(
      peer,
      "Batch A inspected",
      "received",
      crypto.randomUUID(),
    ),
    queued = message(peer, "Inspect batch B", "sent", null);
  install({ contacts: [peer], history: [sent, received, queued] });
  await openChat();
  const section = await chats(await openPanel());
  const toggle = queryButton("Messages with Field notes", section)!;
  click(toggle);
  for (const [text, item, marker] of [
    ["Inspect batch A", sent, "Sent"],
    ["Batch A inspected", received, "Received"],
    ["Inspect batch B", queued, "Sent"],
  ] as const) {
    const card = anchor(await within(section).findByText(text));
    expect(card).toHaveAttribute(
      "href",
      path(item.targetChatThreadId) +
        (item.targetRunId ? "#run-" + item.targetRunId : ""),
    );
    expect(within(card).getByText(marker)).toBeVisible();
  }
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  click(toggle);
  await waitFor(() => {
    return expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
  for (const text of [
    "Inspect batch A",
    "Batch A inspected",
    "Inspect batch B",
  ]) {
    expect(within(section).queryByText(text)).toBeNull();
  }
});
test("chat-relations-011 the sent card opens its launched run in the receiving chat", async () => {
  const peer = contact("Dispatch desk"),
    run = crypto.randomUUID();
  install(
    {
      contacts: [peer],
      history: [message(peer, "Send invoice for dispatch", "sent", run)],
    },
    undefined,
    { id: peer.threadId, title: "Dispatch desk", listing: {}, runId: run },
  );
  await openChat();
  const section = await chats(await openPanel());
  click(queryButton("Messages with Dispatch desk", section)!);
  click(anchor(await within(section).findByText("Send invoice for dispatch")));
  const target = await screen.findByText("Work in Dispatch desk");
  expect(target.closest("[data-chat-scroll-anchor-event-id]")).toHaveAttribute(
    "data-chat-scroll-anchor-event-id",
    run,
  );
  expect(location.pathname + location.hash).toBe(
    path(peer.threadId) + "#run-" + run,
  );
});
test("chat-relations-012 the received card links here and the row opens the peer directly", async () => {
  const peer = contact("Harbor inspection"),
    run = crypto.randomUUID();
  install(
    {
      contacts: [peer],
      history: [message(peer, "Cleared the north pier", "received", run)],
    },
    undefined,
    { id: peer.threadId, title: "Harbor inspection", listing: {} },
  );
  await openChat();
  const section = await chats(await openPanel());
  click(queryButton("Messages with Harbor inspection", section)!);
  const incoming = anchor(
    await within(section).findByText("Cleared the north pier"),
  );
  expect(incoming).toHaveAttribute("href", RUN_PATH + "#run-" + run);
  const row = anchor(within(section).getByText("Harbor inspection"));
  expect(row).toHaveAttribute("href", path(peer.threadId));
  click(row);
  const target = await screen.findByText("Work in Harbor inspection");
  expect(target.closest("[data-chat-thread-container-id]")).toHaveAttribute(
    "data-chat-thread-container-id",
    peer.threadId,
  );
  expect(location.pathname + location.hash).toBe(path(peer.threadId));
});
test("chat-relations-017 the queued peer is labeled queued in its own row", async () => {
  const peer = {
    ...contact("Manifest checker"),
    status: "queued" as const,
    sentCount: 21,
    receivedCount: 0,
  };
  install({ contacts: [peer] });
  await openChat();
  const section = await chats(await openPanel());
  const link = anchor(within(section).getByText("Manifest checker"));
  expect(within(link).getByText("Queued")).toBeVisible();
  expect(within(link).queryByText("Running")).toBeNull();
});
test("chat-relations-020 collapsing the chat list closes its expanded message history", async () => {
  const peer = contact("Receiving dock"),
    history = message(
      peer,
      "Shipment arrived",
      "received",
      crypto.randomUUID(),
    );
  const created = { ...child("Receiving dock", 7), threadId: peer.threadId };
  install({
    children: [
      created,
      child("Loading bay", 6),
      child("East gate", 5),
      child("West gate", 4),
    ],
    contacts: [peer],
    history: [history],
  });
  await openChat();
  const section = await chats(await openPanel());
  click(queryButton("Show more", section)!);
  await within(section).findByText("West gate");
  const toggle = queryButton("Messages with Receiving dock", section)!;
  click(toggle);
  await within(section).findByText("Shipment arrived");
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  click(queryButton("Collapse", section)!);
  await waitFor(() => {
    return expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
  expect(within(section).queryByText("Shipment arrived")).toBeNull();
});
async function revealClippedTitle(link: HTMLAnchorElement, label: string) {
  const sheet = document.createElement("style");
  sheet.textContent = styleText;
  document.head.append(sheet);
  context.signal.addEventListener(
    "abort",
    () => {
      return sheet.remove();
    },
    {
      once: true,
    },
  );
  const text = within(link).getByText(label),
    clip = text.parentElement!;
  vi.spyOn(text, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 194, 24),
  );
  vi.spyOn(clip, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 120, 24),
  );
  const progress = () => {
    return getComputedStyle(clip)
      .getPropertyValue("--okou-nav-title-progress")
      .trim();
  };
  const restingTransform = getComputedStyle(text).transform;
  expect(progress()).toBe("0");
  const user = userEvent.setup({ delay: null });
  await user.hover(link);
  expect(progress()).toBe("1");
  expect(getComputedStyle(text).transform).not.toBe(restingTransform);
  expect(getComputedStyle(clip).transition).toContain("925ms");
  expect(
    getComputedStyle(clip).getPropertyValue("--okou-nav-title-duration").trim(),
  ).toBe("925ms");
  await user.unhover(link);
  expect(getComputedStyle(text).transform).toBe(restingTransform);
  expect(progress()).toBe("0");
}
test("chat-relations-005 the resource list distinguishes created and running peers and reveals a clipped title", async () => {
  const reviewed = child("Delivery manifests awaiting customs clearance"),
    second = child("Warehouse balance"),
    peer = { ...contact("Transfer ledger"), status: "running" as const },
    href = "https://example.slack.com/archives/C321/p54321";
  install(
    { children: [reviewed, second], contacts: [peer] },
    { type: "source", kind: "slack", href },
  );
  await openChat();
  const panel = await openPanel();
  const section = await chats(panel);
  expect(
    within(panel).getByRole("region", { name: "From" }).querySelector("a"),
  ).toHaveAttribute("href", href);
  for (const entry of [reviewed, second]) {
    const link = anchor(within(section).getByText(entry.title!));
    expect(link).toHaveAttribute("href", path(entry.threadId));
    expect(within(link).queryByText("Running")).toBeNull();
  }
  const running = anchor(within(section).getByText("Transfer ledger"));
  expect(running).toHaveAttribute("href", path(peer.threadId));
  expect(within(running).getByText("Running")).toBeVisible();
  expect(queryButton("Messages with Transfer ledger", section)).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await revealClippedTitle(
    anchor(within(section).getByText(reviewed.title!)),
    reviewed.title!,
  );
});
test("chat-relations-007 the only origin row links its parent run and reveals the clipped parent title", async () => {
  const label = "Review of the international freight schedule",
    parent = contact(label),
    source = origin(parent);
  install({}, source);
  await openChat();
  const panel = await openPanel();
  const section = await chats(panel);
  const rows = within(section).getAllByRole("listitem");
  expect(rows).toHaveLength(1);
  const row = within(rows[0]!);
  const link = anchor(row.getByText(label));
  expect(link).toHaveAttribute(
    "href",
    path(parent.threadId) + "#run-" + source.runId,
  );
  expect(row.getByText("From")).toBeVisible();
  expect(within(panel).queryByRole("region", { name: "From" })).toBeNull();
  await revealClippedTitle(link, label);
});

test("chat-navigation-position-restoration-007 Following a child’s resource origin places the parent run at the top of its conversation", async () => {
  mockChatGeometry();
  const parent = contact("Field survey");
  const link = origin(parent);
  install({}, link, {
    id: parent.threadId,
    title: parent.title,
    listing: {},
    runId: link.runId,
    followingTurns: 10,
  });
  await openChat();
  const resources = await openPanel();
  click(anchor(await within(await chats(resources)).findByText(parent.title)));
  const text = "Work in Field survey";
  await screen.findByText(text);
  await waitFor(() => {
    expect(location.pathname + location.hash).toBe(
      path(parent.threadId) + "#run-" + link.runId,
    );
    expect(
      messageOffset(text, requiredElement("[data-scroll-container]")),
    ).toBe(0);
  });
  await expect(
    findFastControl("button", "Scroll to bottom"),
  ).resolves.toBeVisible();
});

const parent = chatListThread(11, "Release planning");
const renamedChildThread = chatListThread(12, "Release notes");
const launchId = "2cfed9db-f2ee-4180-9722-b0e72ee6c740";
function relatedChats(respondToRelationship?: () => Promise<void> | undefined) {
  context.mocks.browser.matchMedia(true);
  mockChatLifecycle(context, {
    threadId: renamedChildThread.id,
    threadTitle: renamedChildThread.title,
    chatEvents: [
      {
        id: launchId,
        runId: launchId,
        role: "user",
        createdAt: renamedChildThread.createdAt,
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
    snapshot: [parent, renamedChildThread],
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
            lastMessageAt: renamedChildThread.createdAt,
          },
        ],
      });
    },
  );
  return stream;
}

test("chat-relations-rename-001 shows the current parent as one linked source with a collapsed message history", async () => {
  relatedChats();
  await setupPage({ context, path: `/chats/${renamedChildThread.id}` });
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
  await setupPage({ context, path: `/chats/${renamedChildThread.id}` });
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

async function firstMarker(turns: number) {
  vi.stubEnv("TZ", "UTC");
  mockChatGeometry();
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    chatEvents: conversationEvents(turns),
  });
  await setupPage({ context, path: RUN_PATH });
  await screen.findByText("Locator answer " + turns);
  const rail = requiredElement("[data-conversation-locator]");
  await waitFor(() => {
    expect(rail.querySelectorAll("[data-locator-tick]")).toHaveLength(
      Math.min(turns, 24),
    );
  });
  fireEvent.pointerMove(rail, {
    clientY: (600 - (Math.min(turns, 24) - 1) * 10) / 2,
  });
  return rail;
}
test("chat-conversation-locator-001 first sampled marker previews the timestamp of the unrendered opening question", async () => {
  await firstMarker(25);
  expect(screen.queryByText("Locator question 1")).toBeNull();
  const time = await screen.findByText("Aug 1, 10:00 AM", { selector: "time" });
  expect(time).toHaveAttribute("datetime", "2026-08-01T10:00:00.000Z");
});
test("chat-conversation-locator-005 leaving the locator dismisses the first turn timestamp", async () => {
  const rail = await firstMarker(8);
  await screen.findByText("Aug 1, 10:00 AM", { selector: "time" });
  fireEvent.pointerLeave(rail);
  await waitFor(() => {
    expect(
      screen.queryByText("Aug 1, 10:00 AM", { selector: "time" }),
    ).toBeNull();
  });
});

test("chat-conversation-locator-002 selecting the oldest marker unmounts the far end of a thirty-turn transcript", async () => {
  const rail = await firstMarker(30);
  const pane = requiredElement("[data-scroll-container]");
  expect(screen.queryByText("Locator question 1")).not.toBeInTheDocument();
  await screen.findByText("Aug 1, 10:00 AM", { selector: "time" });
  click(rail);
  await screen.findByText("Locator question 1");
  await waitFor(() => {
    expect(messageOffset("Locator question 1", pane)).toBe(0);
    expect(
      messageAnchor("Locator question 1", pane).querySelector(
        "[data-locator-landed]",
      ),
    ).toBeInTheDocument();
  });
  expect(screen.queryByText("Locator answer 24")).not.toBeInTheDocument();
  expect(screen.queryByText("Locator answer 30")).not.toBeInTheDocument();
});
