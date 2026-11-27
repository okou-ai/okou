import userEvent from "@testing-library/user-event";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { sendComposerMessage } from "./chat-composer-template-gallery-test-helpers.ts";
import {
  fireEvent,
  screen,
  waitFor,
  within,
  cleanup,
} from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage, startPage } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  mockChatThreadSnapshotResponse,
  createTestRuntime,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
} from "./chat-event-test-helpers.ts";
import {
  mockChatGeometry,
  messageOffset,
  requiredElement,
  messageAnchor,
} from "./chat-conversation-locator-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  chatThreadsContract,
  chatThreadEventsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { chatListEvent } from "./chat-list-test-helpers.ts";
import {
  promptEvent,
  createChatRunFixtures,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";
import { completedMarkdownReply } from "./markdown-page-test-helpers.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";

const context = testContext();

function eventId(group: number, index: number) {
  return (
    "8a790000-0000-4000-a000-" + String(group * 100 + index).padStart(12, "0")
  );
}
async function library(
  first: "Research" | "Current",
  entry: "home" | "conversation",
) {
  mockChatGeometry();
  const current = continuityThread(179, 1, first + " notes");
  const peer = continuityThread(179, 2, "Planning notes");
  const messages = [current, peer].flatMap((thread) => {
    const label = thread.id === current.id ? first : "Planning";
    const inputs = Array.from({ length: 9 }, (_, i) => {
      return {
        id: eventId(thread.id === current.id ? 1 : 2, i + 1),
        role: "user" as const,
        content: label + " message " + (i + 1),
        runId: eventId(thread.id === current.id ? 1 : 2, i + 1),
        createdAt: new Date(Date.UTC(2026, 6, 1, 9, i)).toISOString(),
      };
    });
    return mockChatEventRows(normalizeMockChatEvents(inputs, thread.id));
  });
  const { pageOptions } = installContinuityWorkspace(context, {
    caseId: 179,
    threads: [current, peer],
    chatEventRows: messages,
  });
  await setupPage({
    context,
    ...pageOptions,
    path: entry === "home" ? "/?compose=1" : "/chats/" + current.id,
  });
  return { current, peer };
}
async function surface(text: string) {
  await screen.findByText(text, { exact: true });
  const viewport = requiredElement("[data-scroll-container]");
  expect(within(viewport).getByText(text, { exact: true })).toBeVisible();
  return viewport;
}
async function read(text: string, offset: number) {
  const viewport = await surface(text);
  await waitFor(() => {
    expect(viewport.scrollTop + viewport.clientHeight).toBe(
      viewport.scrollHeight,
    );
  });
  fireEvent.scroll(viewport);
  fireEvent.wheel(viewport, { deltaY: -400 });
  viewport.scrollTop += messageOffset(text, viewport) - offset;
  fireEvent.scroll(viewport);
  await expect(
    findFastControl("button", "Scroll to bottom"),
  ).resolves.toBeVisible();
  expect(messageOffset(text, viewport)).toBe(offset);
  return viewport;
}
async function sidebar(title: string) {
  click(await findFastControl("link", title));
}
async function shortcut(key: "ArrowUp" | "ArrowDown") {
  const editor = await findComposerEditor();
  editor.focus();
  fireEvent.keyDown(editor, { key, ctrlKey: true, shiftKey: true });
}
test("chat-navigation-position-restoration-001 The chat shortcuts restore the current message 64 pixels below the viewport", async () => {
  const { current, peer } = await library("Current", "conversation");
  await read("Current message 2", 64);
  await expect(
    findFastControl("link", "Planning notes"),
  ).resolves.toBeVisible();
  await shortcut("ArrowUp");
  const next = await surface("Planning message 2");
  expect(location.pathname).toBe("/chats/" + peer.id);
  expect(within(next).queryByText("Current message 2")).toBeNull();
  await shortcut("ArrowDown");
  const restored = await surface("Current message 2");
  await waitFor(() => {
    expect(messageOffset("Current message 2", restored)).toBe(64);
  });
  expect(location.pathname).toBe("/chats/" + current.id);
  expect(within(restored).queryByText("Planning message 2")).toBeNull();
  await expect(
    findFastControl("button", "Scroll to bottom"),
  ).resolves.toBeVisible();
});
test("chat-navigation-position-restoration-002 Returning from Planning in the sidebar preserves the Research reading offset", async () => {
  await library("Research", "conversation");
  await read("Research message 2", 96);
  await sidebar("Planning notes");
  await surface("Planning message 1");
  await sidebar("Research notes");
  const restored = await surface("Research message 2");
  await waitFor(() => {
    expect(messageOffset("Research message 2", restored)).toBe(96);
  });
  await expect(
    findFastControl("button", "Scroll to bottom"),
  ).resolves.toBeVisible();
});
test("chat-navigation-position-restoration-003 Scroll to bottom returns from Research history to the latest activity", async () => {
  await library("Research", "home");
  await sidebar("Planning notes");
  await surface("Planning message 1");
  await sidebar("Research notes");
  const viewport = await read("Research message 2", 48);
  click(await findFastControl("button", "Scroll to bottom"));
  await waitFor(() => {
    expect(viewport.scrollTop + viewport.clientHeight).toBe(
      viewport.scrollHeight,
    );
    expect(queryFastControl("button", "Scroll to bottom")).toBeNull();
  });
});
test("chat-navigation-position-restoration-010 Sending while reading history clears the editor and returns to the newest activity", async () => {
  mockChatGeometry();
  const thread = "3a790000-0000-4000-a000-000000000011";
  const run = eventId(4, 8);
  const messages = Array.from({ length: 8 }, (_, i) => {
    return {
      id: eventId(4, i + 1),
      runId: eventId(4, i + 1),
      role: "user" as const,
      content: "History message " + (i + 1),
      createdAt: new Date(Date.UTC(2026, 6, 1, 10, i)).toISOString(),
    };
  });
  mockChatLifecycle(context, {
    threadId: thread,
    chatEvents: messages,
    activeRunIds: [run],
  });
  await setupPage({ context, path: "/chats/" + thread });
  const viewport = await read("History message 2", 48);
  const editor = await findComposerEditor();
  const text = "Add the latest deployment result.";
  await sendComposerMessage(userEvent.setup({ delay: null }), text);
  await within(viewport).findByText(text, { exact: true });
  await waitFor(() => {
    expect(viewport.scrollTop + viewport.clientHeight).toBe(
      viewport.scrollHeight,
    );
    expect(editor.textContent).toBe("");
    expect(queryFastControl("button", "Scroll to bottom")).toBeNull();
  });
});

test.each([400, 550, 700])(
  "Opening a middle event keeps reading context in a %i pixel viewport",
  async (height) => {
    mockChatGeometry(() => {
      return height;
    });
    const id = crypto.randomUUID();
    const entries = Array.from({ length: 12 }, (_, i) => {
      const runId = eventId(63, i + 1);
      return {
        id: runId,
        runId,
        role: "user" as const,
        content: "Survey station " + (i + 1),
        createdAt: new Date(Date.UTC(2026, 6, 3, 8, i)).toISOString(),
      };
    });
    mockChatLifecycle(context, { threadId: id, chatEvents: entries });
    await setupPage({
      context,
      path: "/chats/" + id + "#event-" + entries[5]!.id,
    });
    const title = entries[5]!.content;
    const viewport = await surface(title);
    await waitFor(() => {
      expect(
        messageAnchor(title, viewport).querySelector("[data-locator-landed]"),
      ).toBeInTheDocument();
    });
    const offset = messageOffset(title, viewport);
    expect(offset).toBeCloseTo(0.28 * height);
    await expect(
      findFastControl("button", "Scroll to bottom"),
    ).resolves.toBeVisible();
  },
);

test("worker-runtime-007 An expired transcript and thread list recover their fresh snapshots and both tails", async () => {
  const thread = continuityThread(819, 1, "Preliminary plan"),
    stamp = crypto.randomUUID(),
    run = crypto.randomUUID();
  const renewed = { ...thread, title: "Updated plan" },
    latest = chatListEvent(819, 11, "renamed", thread.id, {
      title: "Reviewed plan",
    });
  const rows = mockChatEventRows(
    normalizeMockChatEvents(
      ["Initial version", "Revised schedule", "Minutes approved"].map(
        (text, i) => {
          return promptEvent({
            id: crypto.randomUUID(),
            runId: run,
            seqId: [1, 10, 11][i]!,
            text,
          });
        },
      ),
      thread.id,
    ),
  );
  const ws = installContinuityWorkspace(context, {
    caseId: 819,
    threads: [thread],
    chatEventRows: [],
  });
  let expired = false;
  const url = "https://local-archive.example/meeting-rows";
  const rowExpired = context.mocks.deferred<void>(),
    metaExpired = context.mocks.deferred<void>();
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(
      200,
      mockChatThreadSnapshotResponse(context, {
        chatThreads: [expired ? renewed : thread],
        latestSeqId: expired ? 10 : 1,
        latestEventId: expired ? rows[1]!.id : stamp,
      }),
    );
  });
  context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
    if (expired && query.sinceSeqId === 1) {
      if (!metaExpired.settled()) {
        metaExpired.resolve();
      }
      return respond(410, {
        error: { code: "CURSOR_EXPIRED", message: "Refresh meeting list" },
      });
    }
    return respond(200, {
      events: expired && query.sinceSeqId === 10 ? [latest] : [],
      hasMore: false,
    });
  });
  context.mocks.http.get(url, () => {
    return new Response(JSON.stringify(rows[1]) + "\n");
  });
  context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
    return expired
      ? respond(200, {
          url,
          expiresInSeconds: 90,
          lastEventId: rows[1]!.id,
          lastSeqId: 10,
        })
      : respond(404, {
          error: {
            code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
            message: "No archive",
          },
        });
  });
  context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
    if (expired && query.sinceSeqId === 1) {
      if (!rowExpired.settled()) {
        rowExpired.resolve();
      }
      return respond(410, {
        error: { code: "CHAT_EVENTS_EXPIRED", message: "Refresh transcript" },
      });
    }
    const result = rows.filter((row) => {
        return (
          (expired ? row.seqId === 11 : row.seqId === 1) &&
          row.seqId > (query.sinceSeqId ?? 0)
        );
      }),
      last = result.at(-1);
    return respond(200, {
      rows: result,
      cursor: last
        ? { lastEventId: last.id, lastSeqId: last.seqId }
        : query.sinceEventId
          ? { lastEventId: query.sinceEventId, lastSeqId: query.sinceSeqId }
          : { lastEventId: null, lastSeqId: 0 },
      hasMore: false,
    });
  });
  await setupPage({
    context: createTestRuntime(context),
    auth: ws.pageOptions.auth,
    path: "/chats/" + thread.id,
  });
  await expect(screen.findByText("Initial version")).resolves.toBeVisible();
  const channel =
    "user-org:" +
    ws.pageOptions.auth.user.id +
    ":" +
    ws.pageOptions.auth.organization!.activeOrg!.id;
  expired = true;
  context.mocks.ably.triggerOnChannel(channel, "threadListChanged");
  context.mocks.ably.triggerOnChannel(
    channel,
    "chatThreadMessageCreated:" + thread.id,
  );
  await Promise.all([rowExpired.promise, metaExpired.promise]);
  await expect(screen.findByText("Minutes approved")).resolves.toBeVisible();
  await expect(screen.findByText("Revised schedule")).resolves.toBeVisible();
  await expect(
    findFastControl("link", /Reviewed plan/u),
  ).resolves.toBeVisible();
  cleanup();
  const held = context.mocks.deferred<void>();
  context.mocks.api(
    chatThreadEventsContract.rows,
    async ({ query, respond }) => {
      await held.promise;
      return respond(200, {
        rows: [],
        hasMore: false,
        cursor: query.sinceEventId
          ? { lastEventId: query.sinceEventId, lastSeqId: query.sinceSeqId }
          : { lastEventId: null, lastSeqId: 0 },
      });
    },
  );
  const reopened = await startPage({
    context: createTestRuntime(context),
    auth: ws.pageOptions.auth,
    path: "/chats/" + thread.id,
  });
  await reopened.content;
  await expect(screen.findByText("Minutes approved")).resolves.toBeVisible();
  await expect(screen.findByText("Revised schedule")).resolves.toBeVisible();
  expect(screen.queryByText("Initial version")).toBeNull();
  held.resolve();
  await reopened.ready;
});

test("A returning reader follows the expense cursors across two deliveries and leaves for a new chat", async () => {
  const thread = continuityThread(942, 1, "Expenses"),
    other = continuityThread(942, 2, "Travel review");
  const stages = [
    "Approve train ticket",
    "Book the return seat",
    "Print the departure pass",
  ];
  const rows = mockChatEventRows(
    normalizeMockChatEvents(
      stages.map((content, i) => {
        return {
          id: crypto.randomUUID(),
          role: "user",
          content,
          runId: crypto.randomUUID(),
          seqId: i + 1,
          createdAt: new Date(Date.UTC(2026, 10, 1, 10, 0, i)).toISOString(),
        };
      }),
      thread.id,
    ),
  );
  const ws = installContinuityWorkspace(context, {
    caseId: 942,
    threads: [thread, other],
    chatEventRows: rows.slice(0, 1),
  });
  const pageOptions = {
    ...ws.pageOptions,
    path: "/chats/" + thread.id,
  };
  const original = createTestRuntime(context);
  await setupPage({ ...pageOptions, context: original });
  await screen.findByText(stages[0]!);
  cleanup();
  original.dispose();
  const arrived = context.mocks.deferred<void>(),
    release = context.mocks.deferred<void>();
  let length = 2;
  context.mocks.api(
    chatThreadEventsContract.rows,
    async ({ params, query, respond }) => {
      const matching = params.threadId === thread.id;
      const cursor = query.sinceSeqId ?? 0;
      if (matching) {
        if (!arrived.settled()) {
          arrived.resolve();
        }
        await release.promise;
      }
      const predecessor = rows[length - 2]!;
      const accepted =
        matching &&
        cursor === predecessor.seqId &&
        query.sinceEventId === predecessor.id;
      const body = accepted ? rows.slice(cursor, length) : [];
      const tail = body.at(-1);
      const lastEventId = tail?.id ?? query.sinceEventId;
      return respond(200, {
        rows: body,
        hasMore: false,
        cursor: lastEventId
          ? { lastSeqId: tail?.seqId ?? cursor, lastEventId }
          : { lastSeqId: 0, lastEventId: null },
      });
    },
  );
  const active = createTestRuntime(context);
  const session = await startPage({ ...pageOptions, context: active });
  try {
    await arrived.promise;
    await expect(screen.findByText(stages[0]!)).resolves.toBeVisible();
    expect(screen.queryByText(stages[1]!)).toBeNull();
    release.resolve();
    await session.ready;
    await screen.findByText(stages[1]!);
    const member = ws.pageOptions.auth;
    const wire =
      "user-org:" + member.user.id + ":" + member.organization?.activeOrg?.id;
    const emit = () => {
      return context.mocks.ably.triggerOnChannel(
        wire,
        "chatThreadMessageCreated:" + thread.id,
        { threadId: thread.id },
      );
    };
    length = 3;
    emit();
    await screen.findByText(stages[2]!);
    const messages = screen.getAllByText(
      /^(Approve train ticket|Book the return seat|Print the departure pass)$/,
    );
    expect(
      messages.map((message) => {
        return message.textContent;
      }),
    ).toStrictEqual(stages);
    click(await findFastControl("link", /^New chat/));
    await waitFor(() => {
      return expect(location.pathname).toBe("/");
    });
    await screen.findByRole("textbox", { name: "Message" });
    cleanup();
    active.dispose();
    await waitFor(() => {
      return expect(
        context.mocks.ably.hasChannelSubscriptionOnChannel(wire),
      ).toBeFalsy();
    });
    emit();
    await setupPage({
      ...pageOptions,
      context: createTestRuntime(context),
      path: "/chats/" + other.id,
    });
    await screen.findByText("Travel review", {
      selector: '[data-testid="chat-thread-header-title"]',
    });
  } finally {
    if (!release.settled()) {
      release.resolve();
    }
  }
});

test("Only the updated conversation gains a message when the worker warms two open threads", async () => {
  const stable = continuityThread(886, 1, "Mooring notes");
  const changed = continuityThread(886, 2, "Harbor survey");
  const ws = installContinuityWorkspace(context, {
    caseId: 886,
    threads: [stable, changed],
    chatEventRows: [],
  });
  const row = mockChatEventRows(
    normalizeMockChatEvents(
      [
        {
          role: "user",
          id: crypto.randomUUID(),
          runId: crypto.randomUUID(),
          seqId: 1,
          createdAt: "2026-10-18T12:00:00Z",
          content: "Survey marker installed",
        },
      ],
      changed.id,
    ),
  )[0]!;
  const batch = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let supply = false;
  context.mocks.api(
    chatThreadEventsContract.catchUp,
    async ({ body, respond }) => {
      const targets = new Set(
        body.map(([id]) => {
          return id;
        }),
      );
      const matching =
        supply && targets.has(stable.id) && targets.has(changed.id);
      if (matching) {
        if (!batch.settled()) {
          batch.resolve();
        }
        await release.promise;
      }
      return respond(200, {
        notFoundThreads: [],
        events: Object.fromEntries(
          body.map(([id, seq]) => {
            return [id, matching && id === changed.id && seq < 1 ? [row] : []];
          }),
        ),
      });
    },
  );
  const options = {
    ...ws.pageOptions,
    path: "/chats/" + stable.id + "?sidebar=" + changed.id,
  };
  const original = createTestRuntime(context);
  await setupPage({ ...options, context: original });
  const pane = (id: string) => {
    return document.querySelector<HTMLElement>(
      '[data-chat-thread-container-id="' + id + '"]',
    )!;
  };
  await waitFor(() => {
    expect(pane(stable.id)).toBeVisible();
    expect(pane(changed.id)).toBeVisible();
  });
  supply = true;
  const auth = ws.pageOptions.auth;
  context.mocks.ably.triggerOnChannel(
    "user-org:" + auth.user.id + ":" + auth.organization?.activeOrg?.id,
    "chatThreadMessageCreated:" + stable.id,
    { threadId: stable.id },
  );
  await batch.promise;
  expect(screen.queryByText("Survey marker installed")).toBeNull();
  release.resolve();
  await screen.findByText("Survey marker installed");
  expect(pane(changed.id)).toHaveTextContent("Survey marker installed");
  expect(pane(stable.id)).not.toHaveTextContent("Survey marker installed");
  cleanup();
  original.dispose();
  const remote = context.mocks.deferred<void>(),
    allow = context.mocks.deferred<void>();
  context.mocks.api(chatThreadEventsContract.rows, async ({ respond }) => {
    if (!remote.settled()) {
      remote.resolve();
    }
    await allow.promise;
    return respond(200, {
      rows: [],
      hasMore: false,
      cursor: { lastSeqId: 0, lastEventId: null },
    });
  });
  const reopened = await startPage({
    ...options,
    context: createTestRuntime(context),
  });
  try {
    await remote.promise;
    await screen.findByText("Survey marker installed");
    expect(pane(changed.id)).toHaveTextContent("Survey marker installed");
    expect(pane(stable.id).querySelector("[data-role=user]")).toBeNull();
  } finally {
    allow.resolve();
  }
  await reopened.ready;
});

test("chat-message-history-002 the artifacts panel explains that this completed conversation has no artifacts", async () => {
  await setupPage({
    context,
    path: completedMarkdownReply(context, "No files were requested."),
  });
  await screen.findByText("No files were requested.");
  click(await findAction("button", "Artifacts and chats"));
  const title = await screen.findByRole("heading", {
    name: "Artifacts and chats",
  });
  expect(title).toBeVisible();
  await expect(screen.findByText("No artifacts yet")).resolves.toBeVisible();
});

test("chat-message-history-001 reopening the claimed prompt presents one active turn", async () => {
  const text = "Compare the revised packing lists";
  const runId = crypto.randomUUID();
  const queued = promptEvent({ id: crypto.randomUUID(), seqId: 1, text });
  createChatRunFixtures(context).installRunChat({
    activeRunIds: [runId],
    chatEvents: [
      queued,
      {
        ...promptEvent({ id: crypto.randomUUID(), seqId: 2, text, runId }),
        revokesEventId: queued.id,
      },
    ],
  });

  await setupPage({ context, path: RUN_PATH });
  await expect(screen.findByText("Thinking...")).resolves.toBeInTheDocument();
  await expect(findAction("button", "Stop")).resolves.toBeEnabled();
  expect(screen.getByText(text)).toBeInTheDocument();
  expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
  expect(screen.queryByText("Waiting in")).not.toBeInTheDocument();
});
