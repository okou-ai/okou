import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import {
  chatThreadsContract,
  chatThreadEventsContract,
  type ChatThreadEvent,
  type ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import { expect, test, vi } from "vitest";

import { setupPage } from "../../__tests__/page-helper.ts";
import {
  testContext,
  chatEventRowsResponse,
} from "../../signals/__tests__/test-helpers.ts";
import { createChatEventSignals } from "../../signals/chat-page/chat-event-signals.ts";
import { eventDrivenChatThreads$ } from "../../signals/chat-page/chat-thread-event-sourcing.ts";
import { resetSignal } from "../../signals/utils.ts";
import {
  CHAT_EVENT_CURSOR_STORE,
  CHAT_EVENT_ROWS_STORE,
  CHAT_IDB_VERSION,
  upgradeChatIdb,
} from "../../signals/external/chat-idb-schema.ts";
import { openDB } from "idb";
import {
  queryChatEventSharedDatabase$,
  indexedDbSnapshotMeasurementFromWorker$,
  measureIndexedDbSnapshotFromWorker$,
} from "../../signals/shared-database.ts";

const context = testContext();
const CREATED_AT = "2026-08-14T10:00:00.000Z";

function userId(): string {
  return `direct-bridge-user-${context.resourceId}`;
}

function orgId(): string {
  return `direct-bridge-org-${context.resourceId}`;
}

function realtimeChannel(): string {
  return `user-org:${userId()}:${orgId()}`;
}

function row(threadId: string, seqId: number): ChatEventRow {
  return {
    id: crypto.randomUUID(),
    chatThreadId: threadId,
    runId: null,
    revokesEventId: null,
    eventType: "output.message",
    payload: { content: `direct bridge message ${seqId}` },
    contextType: null,
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId,
    createdAt: CREATED_AT,
  };
}

async function seedChatEventCache(cachedRow: ChatEventRow): Promise<void> {
  const db = await openDB(`vm0-chat-${userId()}-${orgId()}`, CHAT_IDB_VERSION, {
    upgrade(database, oldVersion) {
      upgradeChatIdb(database, oldVersion);
    },
  });
  try {
    const tx = db.transaction(
      [CHAT_EVENT_ROWS_STORE, CHAT_EVENT_CURSOR_STORE],
      "readwrite",
    );
    await Promise.all([
      tx.objectStore(CHAT_EVENT_ROWS_STORE).put(cachedRow),
      tx.objectStore(CHAT_EVENT_CURSOR_STORE).put({
        threadId: cachedRow.chatThreadId,
        schemaVersion: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
        lastEventId: cachedRow.id,
        lastSeqId: cachedRow.seqId,
      }),
      tx.done,
    ]);
  } finally {
    db.close();
  }
}

test("Preserve exact UTF-8 snapshot bytes across the worker protocol", async () => {
  // The Settings page rounds payload sizes to KB/MB, so it cannot assert the
  // exact UTF-8 byte contract for non-ASCII text. Keep only that wire-level
  // invariant here; counts, empty results, measurement, and reset use page tests.
  const snapshotThread: ChatThreadSnapshotProjection = {
    id: crypto.randomUUID(),
    agentId: crypto.randomUUID(),
    title: "Snapshot 文 😀",
    sortAt: CREATED_AT,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    pinnedAt: null,
    renamedAt: null,
    selectedModel: null,
    serviceTier: null,
    computerUseHostId: null,
    selectedVideoModel: null,
  };
  const snapshot = {
    chatThreads: [snapshotThread],
    latestEventId: crypto.randomUUID(),
    latestSeqId: 1,
  };
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, { agents: {}, threads: {} });
  });
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, snapshot);
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });

  await setupPage({
    context,
    path: "/error",
    sharedWorkerTestTransport: "message-port",
    auth: {
      user: { id: userId(), fullName: "Direct Bridge User" },
      session: { token: "direct-bridge-token" },
      organization: {
        activeOrg: { id: orgId(), name: "Direct Bridge Org" },
        memberships: [{ id: orgId() }],
      },
    },
  });
  await vi.waitFor(() => {
    expect(
      context.store.get(eventDrivenChatThreads$).find((thread) => {
        return thread.id === snapshotThread.id;
      })?.title,
    ).toBe(snapshotThread.title);
  });

  context.store.set(measureIndexedDbSnapshotFromWorker$);
  const measurement = await context.store.get(
    indexedDbSnapshotMeasurementFromWorker$,
  );
  const serializedSnapshot = JSON.stringify({ id: "current", ...snapshot });
  const expectedBytes = new Blob([serializedSnapshot]).size;
  expect(expectedBytes).toBeGreaterThan(serializedSnapshot.length);
  expect(measurement?.payloadBytes).toBe(expectedBytes);
});

test("Show cached chat data before catching up live", async () => {
  const threadId = crypto.randomUUID();
  const unreadThreadId = crypto.randomUUID();
  const cachedRow = row(threadId, 1);
  const caughtUpRow = row(threadId, 2);
  const realtimeRow = row(threadId, 3);
  await seedChatEventCache(cachedRow);

  const initialPage = context.mocks.deferred<void>();
  let availableRows: readonly ChatEventRow[] = [caughtUpRow];
  const requestedSeqIds: number[] = [];
  const prewarmedThreadIds: string[] = [];
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: {},
      threads: { [unreadThreadId]: "unread" },
    });
  });
  context.mocks.api(chatThreadEventsContract.catchUp, ({ body, respond }) => {
    return respond(200, {
      events: Object.fromEntries(
        body.map(([threadId]) => {
          prewarmedThreadIds.push(threadId);
          return [threadId, []];
        }),
      ),
      notFoundThreads: [],
    });
  });
  context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
    return respond(404, {
      error: {
        code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
        message: "Chat event snapshot not found",
      },
    });
  });
  context.mocks.api(
    chatThreadEventsContract.rows,
    async ({ query, respond }) => {
      requestedSeqIds.push(query.sinceSeqId);
      if (query.sinceSeqId === 1) {
        await initialPage.promise;
      }
      return respond(
        200,
        chatEventRowsResponse(
          availableRows.filter((candidate) => {
            return candidate.seqId > query.sinceSeqId;
          }),
          query,
        ),
      );
    },
  );

  await setupPage({
    context,
    path: "/error",
    sharedWorkerTestTransport: "message-port",
    auth: {
      user: { id: userId(), fullName: "Direct Bridge User" },
      session: { token: "direct-bridge-token" },
      organization: {
        activeOrg: { id: orgId(), name: "Direct Bridge Org" },
        memberships: [{ id: orgId() }],
      },
    },
  });
  await vi.waitFor(() => {
    expect(prewarmedThreadIds).toContain(unreadThreadId);
  });

  const resetOwner$ = resetSignal();
  const ownerSignal = context.store.set(resetOwner$, context.signal);
  const signals = createChatEventSignals(threadId);
  await context.store.set(signals.setup$, ownerSignal);
  expect(
    context.store.get(signals.chatEvents$).map((event) => {
      return event.seqId;
    }),
  ).toStrictEqual([1]);

  const catchUp = context.store.set(signals.catchUp$, ownerSignal);
  await vi.waitFor(() => {
    expect(requestedSeqIds).toStrictEqual([1]);
  });
  expect(
    context.store.get(signals.chatEvents$).map((event) => {
      return event.seqId;
    }),
  ).toStrictEqual([1]);
  initialPage.resolve(undefined);
  await catchUp;
  expect(
    context.store.get(signals.chatEvents$).map((event) => {
      return event.seqId;
    }),
  ).toStrictEqual([1, 2]);

  availableRows = [caughtUpRow, realtimeRow];
  context.mocks.ably.triggerOnChannel(
    realtimeChannel(),
    `chatThreadMessageCreated:${threadId}`,
  );
  await vi.waitFor(() => {
    expect(
      context.store.get(signals.chatEvents$).map((event) => {
        return event.seqId;
      }),
    ).toStrictEqual([1, 2, 3]);
  });
  expect(requestedSeqIds[0]).toBe(1);
  expect(requestedSeqIds).toContain(2);
  expect(new Set(requestedSeqIds).size).toBe(requestedSeqIds.length);
  expect(
    requestedSeqIds.every((seqId, index) => {
      return index === 0 || seqId > requestedSeqIds[index - 1]!;
    }),
  ).toBeTruthy();

  context.store.set(resetOwner$);
  const requestsBeforeAbort = requestedSeqIds.length;
  context.mocks.ably.triggerOnChannel(
    realtimeChannel(),
    `chatThreadMessageCreated:${threadId}`,
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(requestedSeqIds).toHaveLength(requestsBeforeAbort);
});

test("Cache incoming chat messages before the conversation is opened", async () => {
  const unopenedThreadId = crypto.randomUUID();
  const incomingRows = [row(unopenedThreadId, 1), row(unopenedThreadId, 2)];
  const batchedThreadIds: string[] = [];
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: {},
      threads: { [unopenedThreadId]: "unread" },
    });
  });
  context.mocks.api(chatThreadEventsContract.catchUp, ({ body, respond }) => {
    batchedThreadIds.push(
      ...body.map(([threadId]) => {
        return threadId;
      }),
    );
    return respond(200, {
      events: Object.fromEntries(
        body.map(([threadId]) => {
          return [threadId, threadId === unopenedThreadId ? incomingRows : []];
        }),
      ),
      notFoundThreads: [],
    });
  });
  context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
    return respond(404, {
      error: {
        code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
        message: "Chat event snapshot not found",
      },
    });
  });
  context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
    return respond(200, chatEventRowsResponse(incomingRows, query));
  });

  await setupPage({
    context,
    path: "/error",
    sharedWorkerTestTransport: "message-port",
    auth: {
      user: { id: userId(), fullName: "Direct Bridge User" },
      session: { token: "direct-bridge-token" },
      organization: {
        activeOrg: { id: orgId(), name: "Direct Bridge Org" },
        memberships: [{ id: orgId() }],
      },
    },
  });

  await vi.waitFor(() => {
    expect(batchedThreadIds).toContain(unopenedThreadId);
  });

  const resetOwner$ = resetSignal();
  const ownerSignal = context.store.set(resetOwner$, context.signal);
  const signals = createChatEventSignals(unopenedThreadId);
  await context.store.set(signals.setup$, ownerSignal);

  expect(
    context.store.get(signals.chatEvents$).map((event) => {
      return event.seqId;
    }),
  ).toStrictEqual([1, 2]);
  context.store.set(resetOwner$);
});

test("Preserve every message during a burst of realtime notifications", async () => {
  const threadId = crypto.randomUUID();
  const unopenedThreadId = crypto.randomUUID();
  const cachedRow = row(threadId, 1);
  const secondRow = row(threadId, 2);
  const thirdRow = row(threadId, 3);
  await seedChatEventCache(cachedRow);
  const catchUpStarted = context.mocks.deferred<void>();
  const releaseCatchUp = context.mocks.deferred<void>();
  let catchUpRequests = 0;
  const prewarmedThreadIds: string[] = [];
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: {},
      threads: { [unopenedThreadId]: "unread" },
    });
  });
  context.mocks.api(chatThreadEventsContract.catchUp, ({ body, respond }) => {
    return respond(200, {
      events: Object.fromEntries(
        body.map(([threadId]) => {
          prewarmedThreadIds.push(threadId);
          return [threadId, []];
        }),
      ),
      notFoundThreads: [],
    });
  });
  context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
    return respond(404, {
      error: {
        code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
        message: "Chat event snapshot not found",
      },
    });
  });
  context.mocks.api(
    chatThreadEventsContract.rows,
    async ({ query, respond }) => {
      catchUpRequests += 1;
      if (query.sinceSeqId === 1 && !catchUpStarted.settled()) {
        catchUpStarted.resolve();
        await releaseCatchUp.promise;
      }
      return respond(
        200,
        chatEventRowsResponse(
          [secondRow, thirdRow].filter((candidate) => {
            return candidate.seqId > query.sinceSeqId;
          }),
          query,
        ),
      );
    },
  );

  await setupPage({
    context,
    path: "/error",
    sharedWorkerTestTransport: "message-port",
    auth: {
      user: { id: userId(), fullName: "Direct Bridge User" },
      session: { token: "direct-bridge-token" },
      organization: {
        activeOrg: { id: orgId(), name: "Direct Bridge Org" },
        memberships: [{ id: orgId() }],
      },
    },
  });
  await vi.waitFor(() => {
    expect(prewarmedThreadIds).toContain(unopenedThreadId);
  });
  const resetOwner$ = resetSignal();
  const ownerSignal = context.store.set(resetOwner$, context.signal);
  const signals = createChatEventSignals(threadId);
  await context.store.set(signals.setup$, ownerSignal);
  expect(
    context.store.get(signals.chatEvents$).map((event) => {
      return event.seqId;
    }),
  ).toStrictEqual([1]);

  context.mocks.ably.triggerOnChannel(
    realtimeChannel(),
    `chatThreadMessageCreated:${threadId}`,
  );
  await catchUpStarted.promise;
  context.mocks.ably.triggerOnChannel(
    realtimeChannel(),
    `chatThreadMessageCreated:${threadId}`,
  );
  context.mocks.ably.triggerOnChannel(
    realtimeChannel(),
    `chatThreadMessageCreated:${threadId}`,
  );
  releaseCatchUp.resolve();

  await vi.waitFor(() => {
    expect(
      context.store.get(signals.chatEvents$).map((event) => {
        return event.seqId;
      }),
    ).toStrictEqual([1, 2, 3]);
  });
  expect(catchUpRequests).toBeGreaterThan(0);
  context.store.set(resetOwner$);
});

test("Subscribe shared chat data through the worker", async () => {
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, { agents: {}, threads: {} });
  });

  await setupPage({
    context,
    path: "/error",
    sharedWorkerTestTransport: "message-port",
    auth: {
      user: { id: userId(), fullName: "Direct Bridge User" },
      session: { token: "direct-bridge-token" },
      organization: {
        activeOrg: { id: orgId(), name: "Direct Bridge Org" },
        memberships: [{ id: orgId() }],
      },
    },
  });

  await vi.waitFor(() => {
    expect(
      context.mocks.ably.hasChannelSubscriptionOnChannel(realtimeChannel()),
    ).toBeTruthy();
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(
        realtimeChannel(),
        "threadListChanged",
      ),
    ).toBeTruthy();
  });
  expect(context.store).not.toBe(context.workerStore);
});

test("Keep the chat list current with realtime thread changes", async () => {
  const threadId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const snapshotEventId = crypto.randomUUID();
  const snapshotThread: ChatThreadSnapshotProjection = {
    id: threadId,
    agentId,
    title: "Snapshot title",
    sortAt: CREATED_AT,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    pinnedAt: null,
    renamedAt: null,
    selectedModel: null,
    serviceTier: null,
    computerUseHostId: null,
    selectedVideoModel: null,
  };
  const rename = (seqId: number, title: string): ChatThreadEvent => {
    return {
      id: crypto.randomUUID(),
      seqId,
      kind: "renamed",
      chatThreadId: threadId,
      agentId,
      title,
      selectedModel: null,
      serviceTier: null,
      computerUseHostId: null,
      selectedVideoModel: null,
      createdAt: CREATED_AT,
    };
  };
  const firstRename = rename(2, "First remote title");
  const secondRename = rename(3, "Second remote title");
  let availableEvents: readonly ChatThreadEvent[] = [firstRename];

  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, { agents: {}, threads: {} });
  });
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: [snapshotThread],
      latestEventId: snapshotEventId,
      latestSeqId: 1,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: availableEvents.filter((event) => {
        return event.seqId > (query.sinceSeqId ?? 0);
      }),
      hasMore: false,
    });
  });

  await setupPage({
    context,
    path: "/error",
    sharedWorkerTestTransport: "message-port",
    auth: {
      user: { id: userId(), fullName: "Direct Bridge User" },
      session: { token: "direct-bridge-token" },
      organization: {
        activeOrg: { id: orgId(), name: "Direct Bridge Org" },
        memberships: [{ id: orgId() }],
      },
    },
  });
  await vi.waitFor(() => {
    expect(
      context.store.get(eventDrivenChatThreads$).find((thread) => {
        return thread.id === threadId;
      })?.title,
    ).toBe("First remote title");
  });

  availableEvents = [firstRename, secondRename];
  context.mocks.ably.triggerOnChannel(realtimeChannel(), "threadListChanged");
  await vi.waitFor(() => {
    expect(
      context.store.get(eventDrivenChatThreads$).find((thread) => {
        return thread.id === threadId;
      })?.title,
    ).toBe("Second remote title");
  });
});

test.each(["direct", "message-port"] as const)(
  "Cancel only the requesting reader across the %s bridge",
  async (transport) => {
    // The page cannot isolate one wait from another concurrent reader. Use the
    // production bootstrap and bridge query boundary to exercise that contract.
    const threadId = crypto.randomUUID();
    const canonicalRow = row(threadId, 1);
    const started = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    context.mocks.api(
      chatThreadEventsContract.rows,
      async ({ query, respond }) => {
        if (query.sinceSeqId === 0) {
          if (!started.settled()) {
            started.resolve();
          }
          await release.promise;
          return respond(200, chatEventRowsResponse([canonicalRow], query));
        }
        return respond(200, chatEventRowsResponse([], query));
      },
    );
    await setupPage({
      context,
      path: "/error",
      sharedWorkerTestTransport: transport,
      auth: {
        user: { id: userId(), fullName: "Direct Bridge User" },
        session: { token: "direct-bridge-token" },
        organization: {
          activeOrg: { id: orgId(), name: "Direct Bridge Org" },
          memberships: [{ id: orgId() }],
        },
      },
    });
    const resetParent$ = resetSignal();
    const resetReader$ = resetSignal();
    const parentSignal = context.store.set(resetParent$, context.signal);
    const readerSignal = context.store.set(resetReader$, parentSignal);
    const query = {
      dataKey: { kind: "chat-event", threadId },
      afterSeqId: null,
      consistency: "catch-up",
    } as const;
    const first = context.store.set(
      queryChatEventSharedDatabase$,
      query,
      readerSignal,
    );
    const cancelled = Promise.allSettled([first]);
    const second = context.store.set(
      queryChatEventSharedDatabase$,
      query,
      context.signal,
    );
    await started.promise;
    context.store.set(resetParent$);
    await expect(cancelled).resolves.toStrictEqual([
      { status: "rejected", reason: parentSignal.reason },
    ]);
    expect(readerSignal.reason).toBe(parentSignal.reason);
    release.resolve();
    await expect(second).resolves.toStrictEqual([canonicalRow]);
    await expect(
      context.store.set(
        queryChatEventSharedDatabase$,
        {
          ...query,
          consistency: "cache-only",
        },
        context.signal,
      ),
    ).resolves.toStrictEqual([canonicalRow]);

    const reason = new DOMException("Reader already cancelled", "AbortError");
    await expect(
      context.store.set(
        queryChatEventSharedDatabase$,
        query,
        AbortSignal.abort(reason),
      ),
    ).rejects.toBe(reason);
  },
);
