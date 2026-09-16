import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  chatThreadEventsContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { expect, test, vi } from "vitest";
import type { Store } from "ccstate";

import {
  chatEventRowsResponse,
  testContext,
} from "../../signals/__tests__/test-helpers.ts";
import { resetSignal } from "../../signals/utils.ts";
import { mockNow } from "../../lib/time.ts";
import { ApiError } from "../../lib/api-error.ts";
import { SharedDatabaseHttpError } from "../http-error.ts";
import type {
  SharedDatabaseBridgeEvents,
  SharedDatabasePortLike,
  SharedDatabaseTokenProvider,
} from "../bridge.ts";
import type { ComputedKey } from "../computed-key.ts";
import type {
  ChatEventDataKey,
  SharedDatabaseDataKey,
  SharedDatabaseIdentity,
} from "../data-key.ts";
import {
  MessagePortSharedDatabaseBridge,
  type SharedDatabaseHeartbeatLoop,
} from "../message-port-client.ts";
import { SharedDatabaseMessagePortServer } from "../message-port-server.ts";
import {
  sharedDatabaseClientMessageSchema,
  sharedDatabaseWorkerMessageSchema,
} from "../protocol.ts";
import {
  openConnection$,
  recordConnectionHeartbeat$,
  registerConnection$,
  requestTokenFromLatestConnection$,
} from "../worker-context.ts";
import {
  getComputedStoreMessage$,
  initializeSharedDatabaseWorker$,
  refreshWorkerComputed$,
} from "../worker-signals.ts";

const context = testContext();
const CREATED_AT = "2026-08-14T09:00:00.000Z";
const WORKER_APP_VERSION = "message-port-worker-version";

class InMemoryMessagePort implements SharedDatabasePortLike {
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  readonly postedMessages: unknown[] = [];
  peer: InMemoryMessagePort | null = null;
  closed = false;

  postMessage(value: unknown): void {
    if (this.closed) {
      return;
    }
    const cloned: unknown = structuredClone(value);
    this.postedMessages.push(cloned);
    queueMicrotask(() => {
      this.peer?.dispatch(cloned);
    });
  }

  start(): void {}

  close(): void {
    this.closed = true;
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.listeners.delete(listener);
  }

  private dispatch(data: unknown): void {
    if (this.closed) {
      return;
    }
    for (const listener of this.listeners) {
      listener(new MessageEvent("message", { data }));
    }
  }
}

function messagePortPair(): readonly [
  InMemoryMessagePort,
  InMemoryMessagePort,
] {
  const platformPort = new InMemoryMessagePort();
  const workerPort = new InMemoryMessagePort();
  platformPort.peer = workerPort;
  workerPort.peer = platformPort;
  return [platformPort, workerPort];
}

function identity(): SharedDatabaseIdentity {
  return {
    userId: `message-port-user-${context.resourceId}`,
    orgId: `message-port-org-${context.resourceId}`,
  };
}

function dataKey(threadId: string): ChatEventDataKey {
  return {
    kind: "chat-event",
    threadId,
  };
}

function row(threadId: string, seqId: number): ChatEventRow {
  return {
    id: crypto.randomUUID(),
    chatThreadId: threadId,
    runId: null,
    revokesEventId: null,
    eventType: "output.message",
    payload: { content: `port message ${seqId}` },
    contextType: null,
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId,
    createdAt: CREATED_AT,
  };
}

function bridgeEvents(): SharedDatabaseBridgeEvents {
  return {
    chatThreadReadCursorUpdated: vi.fn<(payload: unknown) => void>(),
    computedReloaded: vi.fn<(computedKey: ComputedKey) => void>(),
    databaseInvalidated: vi.fn<(dataKey: SharedDatabaseDataKey) => void>(),
    workerUnavailable: vi.fn<SharedDatabaseBridgeEvents["workerUnavailable"]>(),
  };
}

const holdHeartbeatLoop: SharedDatabaseHeartbeatLoop = (
  heartbeat,
  signal,
): void => {
  signal.throwIfAborted();
  heartbeat();
};

function initializeWorker(
  signal: AbortSignal = context.signal,
  workerStore: Store = context.workerStore,
): void {
  const workerIdentity = identity();
  workerStore.set(
    initializeSharedDatabaseWorker$,
    {
      appVersion: WORKER_APP_VERSION,
      identity: workerIdentity,
      apiBaseUrl: location.origin,
      getToken: (signal) => {
        return workerStore.set(requestTokenFromLatestConnection$, signal);
      },
      oauthApiBaseUrl: location.origin,
      onForceUpgrade: vi.fn<() => void>(),
    },
    signal,
  );
}

function connectProtocolTransport(
  bridgeSignal: AbortSignal,
  getToken: SharedDatabaseTokenProvider = () => {
    return Promise.resolve("message-port-token");
  },
  events: SharedDatabaseBridgeEvents = bridgeEvents(),
  workerStore: Store = context.workerStore,
): {
  readonly bridge: MessagePortSharedDatabaseBridge;
  readonly platformPort: InMemoryMessagePort;
  readonly workerPort: InMemoryMessagePort;
} {
  const [platformPort, workerPort] = messagePortPair();
  new SharedDatabaseMessagePortServer(workerStore, workerPort, context.signal);
  return {
    bridge: new MessagePortSharedDatabaseBridge(
      platformPort,
      events,
      bridgeSignal,
      getToken,
      holdHeartbeatLoop,
    ),
    platformPort,
    workerPort,
  };
}

test("share one Worker realtime subscription until tabs disconnect", async () => {
  initializeWorker();
  const resetFirstOwner$ = resetSignal();
  const firstOwnerSignal = context.store.set(resetFirstOwner$, context.signal);
  const resetSecondOwner$ = resetSignal();
  const secondOwnerSignal = context.store.set(
    resetSecondOwner$,
    context.signal,
  );
  const first = connectProtocolTransport(firstOwnerSignal);
  const second = connectProtocolTransport(secondOwnerSignal);
  const firstMessages: unknown[] = [];
  const secondMessages: unknown[] = [];
  let firstResyncs = 0;
  let secondResyncs = 0;
  const topic = "connectorPermissionUpdated";
  const channelName = `user:${identity().userId}`;

  await first.bridge.registerTab(firstOwnerSignal);
  await second.bridge.registerTab(secondOwnerSignal);
  await Promise.all([
    first.bridge.subscribeRealtime(
      "first-subscription",
      "user",
      topic,
      (message) => {
        firstMessages.push(message.data);
      },
      () => {
        firstResyncs += 1;
      },
    ),
    second.bridge.subscribeRealtime(
      "second-subscription",
      "user",
      topic,
      (message) => {
        secondMessages.push(message.data);
      },
      () => {
        secondResyncs += 1;
      },
    ),
  ]);

  await vi.waitFor(() => {
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(channelName, topic),
    ).toBeTruthy();
  });
  context.mocks.ably.triggerOnChannel(channelName, topic, { revision: 1 });
  await vi.waitFor(() => {
    expect(firstMessages).toStrictEqual([{ revision: 1 }]);
    expect(secondMessages).toStrictEqual([{ revision: 1 }]);
  });

  // Only the Worker sees Ably's continuity signal, so it has to tell every tab
  // holding the subscription. A replayed reattach must stay silent.
  context.mocks.ably.triggerResume();
  expect(firstResyncs).toBe(0);
  expect(secondResyncs).toBe(0);

  context.mocks.ably.triggerConnectionState("suspended");
  context.mocks.ably.triggerConnectionState("connected");
  await vi.waitFor(() => {
    expect(firstResyncs).toBe(1);
    expect(secondResyncs).toBe(1);
  });

  context.store.set(resetFirstOwner$);
  context.mocks.ably.triggerOnChannel(channelName, topic, { revision: 2 });
  await vi.waitFor(() => {
    expect(secondMessages).toStrictEqual([{ revision: 1 }, { revision: 2 }]);
  });
  expect(firstMessages).toStrictEqual([{ revision: 1 }]);

  context.store.set(resetSecondOwner$);
  await vi.waitFor(() => {
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(channelName, topic),
    ).toBeFalsy();
  });
});

test("route workspace realtime subscriptions through the organization channel", async () => {
  initializeWorker();
  const resetOwner$ = resetSignal();
  const ownerSignal = context.store.set(resetOwner$, context.signal);
  const { bridge } = connectProtocolTransport(ownerSignal);
  const messages: unknown[] = [];
  const topic = "presentationTemplatesChanged";
  const channelName = `org:${identity().orgId}`;

  await bridge.registerTab(ownerSignal);
  await bridge.subscribeRealtime(
    "workspace-subscription",
    "org",
    topic,
    (message) => {
      messages.push(message.data);
    },
    () => {},
  );

  await vi.waitFor(() => {
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(channelName, topic),
    ).toBeTruthy();
  });
  context.mocks.ably.triggerOnChannel(channelName, topic, { revision: 1 });
  await vi.waitFor(() => {
    expect(messages).toStrictEqual([{ revision: 1 }]);
  });
});

test("preserve a rejected 401 through the port and allow a later query to succeed", async () => {
  initializeWorker();
  const { bridge } = connectProtocolTransport(context.signal);
  await bridge.registerTab(context.signal);
  let denied = true;
  const key = dataKey(crypto.randomUUID());
  const recoveredRow = row(key.threadId, 1);
  context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
    if (denied) {
      return respond(401, {
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      });
    }
    return respond(
      200,
      chatEventRowsResponse(
        query.sinceSeqId === 0 ? [recoveredRow] : [],
        query,
      ),
    );
  });
  const query = {
    dataKey: key,
    afterSeqId: null,
    consistency: "catch-up",
  } as const;
  const failed = bridge.query(query, context.signal);
  await expect(failed).rejects.toBeInstanceOf(SharedDatabaseHttpError);
  await expect(failed).rejects.toMatchObject({ status: 401 });
  denied = false;
  await expect(bridge.query(query, context.signal)).resolves.toStrictEqual([
    recoveredRow,
  ]);
});

test.each([401, 426, 500])(
  "preserve HTTP status %s on query errors across MessagePort",
  async (status) => {
    initializeWorker();
    const { bridge } = connectProtocolTransport(context.signal);
    await bridge.registerTab(context.signal);
    context.mocks.http.get("*/api/chat-threads/snapshot", () => {
      return Response.json(
        { error: { code: "REQUEST_FAILED", message: "Request failed" } },
        { status },
      );
    });
    const failed = bridge.query(
      {
        dataKey: { kind: "chat-thread-event" },
        afterSeqId: null,
        consistency: "catch-up",
      },
      context.signal,
    );
    await expect(failed).rejects.toBeInstanceOf(SharedDatabaseHttpError);
    await expect(failed).rejects.toMatchObject({ status });
  },
);

test.each([401, 426])(
  "preserve API error classification for computed HTTP %s across MessagePort",
  async (status) => {
    initializeWorker();
    const { bridge } = connectProtocolTransport(context.signal);
    await bridge.registerTab(context.signal);
    context.mocks.http.get("*/api/indicators", () => {
      return Response.json(
        { error: { code: "REQUEST_FAILED", message: "Request failed" } },
        { status },
      );
    });
    const failed = bridge.getComputed("chat-thread-indicators");
    await expect(failed).rejects.toBeInstanceOf(ApiError);
    await expect(failed).rejects.toMatchObject({
      status,
      code: "REQUEST_FAILED",
    });
  },
);

test("Keep concurrent shared chat loads independent", async () => {
  initializeWorker();
  const resetOwner$ = resetSignal();
  const ownerSignal = context.store.set(resetOwner$, context.signal);
  const { bridge } = connectProtocolTransport(ownerSignal);
  await bridge.registerTab(ownerSignal);
  const firstKey = dataKey(crypto.randomUUID());
  const secondKey = dataKey(crypto.randomUUID());
  const firstRow = row(firstKey.threadId, 1);
  const secondRow = row(secondKey.threadId, 1);
  const firstGate = context.mocks.deferred<void>();
  const secondGate = context.mocks.deferred<void>();
  const started = new Set<string>();

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
    async ({ params, query, request, respond }) => {
      expect(request.headers.get("x-client-version")).toBe(WORKER_APP_VERSION);
      if (query.sinceSeqId > 0) {
        return respond(200, chatEventRowsResponse([], query));
      }
      started.add(params.threadId);
      if (params.threadId === firstKey.threadId) {
        await firstGate.promise;
        return respond(200, chatEventRowsResponse([firstRow], query));
      }
      await secondGate.promise;
      return respond(200, chatEventRowsResponse([secondRow], query));
    },
  );

  const first = bridge.query(
    { dataKey: firstKey, afterSeqId: null, consistency: "catch-up" },
    ownerSignal,
  );
  const second = bridge.query(
    { dataKey: secondKey, afterSeqId: null, consistency: "catch-up" },
    ownerSignal,
  );
  await vi.waitFor(() => {
    expect(started).toStrictEqual(
      new Set([firstKey.threadId, secondKey.threadId]),
    );
  });

  secondGate.resolve(undefined);
  await expect(second).resolves.toStrictEqual([secondRow]);
  firstGate.resolve(undefined);
  await expect(first).resolves.toStrictEqual([firstRow]);
});

test("Authenticate worker requests through the tab with the latest heartbeat", async () => {
  initializeWorker();
  const resetFirstOwner$ = resetSignal();
  const firstOwnerSignal = context.store.set(resetFirstOwner$, context.signal);
  const resetSecondOwner$ = resetSignal();
  const secondOwnerSignal = context.store.set(
    resetSecondOwner$,
    context.signal,
  );
  const first = connectProtocolTransport(firstOwnerSignal, () => {
    return Promise.resolve("first-tab-token");
  });
  const second = connectProtocolTransport(secondOwnerSignal, () => {
    return Promise.resolve("second-tab-token");
  });
  mockNow(1000, context.signal);
  await first.bridge.registerTab(firstOwnerSignal);
  mockNow(2000, context.signal);
  await second.bridge.registerTab(secondOwnerSignal);
  const key = dataKey(crypto.randomUUID());
  let requestTokens = new Set<string | null>();

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
    ({ query, request, respond }) => {
      requestTokens.add(request.headers.get("authorization"));
      return respond(200, chatEventRowsResponse([], query));
    },
  );

  await expect(
    second.bridge.query(
      { dataKey: key, afterSeqId: null, consistency: "catch-up" },
      secondOwnerSignal,
    ),
  ).resolves.toStrictEqual([]);
  expect(requestTokens).toStrictEqual(new Set(["Bearer second-tab-token"]));
  requestTokens = new Set<string | null>();

  mockNow(3000, context.signal);
  first.platformPort.postMessage({ type: "heartbeat" });
  await expect(
    second.bridge.query(
      {
        dataKey: dataKey(crypto.randomUUID()),
        afterSeqId: null,
        consistency: "catch-up",
      },
      secondOwnerSignal,
    ),
  ).resolves.toStrictEqual([]);
  expect(requestTokens).toStrictEqual(new Set(["Bearer first-tab-token"]));
  requestTokens = new Set<string | null>();

  second.platformPort.postMessage({ type: "heartbeat" });
  await expect(
    first.bridge.query(
      {
        dataKey: dataKey(crypto.randomUUID()),
        afterSeqId: null,
        consistency: "catch-up",
      },
      firstOwnerSignal,
    ),
  ).resolves.toStrictEqual([]);
  expect(requestTokens).toStrictEqual(new Set(["Bearer second-tab-token"]));
});

test("Cancel one shared chat load without cancelling worker progress", async () => {
  initializeWorker();
  const resetOwner$ = resetSignal();
  const ownerSignal = context.store.set(resetOwner$, context.signal);
  const { bridge, workerPort } = connectProtocolTransport(ownerSignal);
  await bridge.registerTab(ownerSignal);
  const key = dataKey(crypto.randomUUID());
  const canonicalRow = row(key.threadId, 1);
  const requestStarted = context.mocks.deferred<void>();
  const releaseRequest = context.mocks.deferred<void>();

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
      if (query.sinceSeqId === 0) {
        requestStarted.resolve(undefined);
        await releaseRequest.promise;
        return respond(200, chatEventRowsResponse([canonicalRow], query));
      }
      return respond(200, chatEventRowsResponse([], query));
    },
  );

  const resetCaller$ = resetSignal();
  const callerSignal = context.store.set(resetCaller$, ownerSignal);
  const pending = bridge.query(
    { dataKey: key, afterSeqId: null, consistency: "catch-up" },
    callerSignal,
  );
  await requestStarted.promise;
  context.store.set(resetCaller$);
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  releaseRequest.resolve(undefined);

  await vi.waitFor(async () => {
    await expect(
      bridge.query(
        { dataKey: key, afterSeqId: null, consistency: "cache-only" },
        ownerSignal,
      ),
    ).resolves.toStrictEqual([canonicalRow]);
  });
  expect(workerPort.closed).toBeFalsy();
});

test("Disconnect one tab without interrupting another tab", async () => {
  initializeWorker();
  const resetFirstOwner$ = resetSignal();
  const firstOwnerSignal = context.store.set(resetFirstOwner$, context.signal);
  const resetSecondOwner$ = resetSignal();
  const secondOwnerSignal = context.store.set(
    resetSecondOwner$,
    context.signal,
  );
  const first = connectProtocolTransport(firstOwnerSignal);
  const second = connectProtocolTransport(secondOwnerSignal);
  await first.bridge.registerTab(firstOwnerSignal);
  await second.bridge.registerTab(secondOwnerSignal);

  context.store.set(resetFirstOwner$);
  await vi.waitFor(() => {
    expect(first.workerPort.closed).toBeTruthy();
  });

  await expect(
    second.bridge.query(
      {
        dataKey: dataKey(crypto.randomUUID()),
        afterSeqId: null,
        consistency: "cache-only",
      },
      secondOwnerSignal,
    ),
  ).resolves.toStrictEqual([]);
  expect(second.workerPort.closed).toBeFalsy();
});

test("Send a heartbeat immediately after tab registration", async () => {
  initializeWorker();
  const { bridge, platformPort } = connectProtocolTransport(context.signal);
  await bridge.registerTab(context.signal);

  expect(
    platformPort.postedMessages.slice(0, 2).map((message) => {
      return sharedDatabaseClientMessageSchema.parse(message);
    }),
  ).toStrictEqual([{ type: "register-tab" }, { type: "heartbeat" }]);
});

test("Keep sending heartbeats while the tab bridge is active", async () => {
  const [platformPort] = messagePortPair();
  const resetOwner$ = resetSignal();
  const ownerSignal = context.store.set(resetOwner$, context.signal);
  const bridge = new MessagePortSharedDatabaseBridge(
    platformPort,
    bridgeEvents(),
    ownerSignal,
    () => {
      return Promise.resolve("test-token");
    },
  );
  await bridge.registerTab(ownerSignal);

  await vi.waitFor(() => {
    expect(
      platformPort.postedMessages.filter((message) => {
        return (
          sharedDatabaseClientMessageSchema.parse(message).type === "heartbeat"
        );
      }).length,
    ).toBeGreaterThanOrEqual(2);
  });
  context.store.set(resetOwner$);
});

test("Reject shared-data access before the tab is registered", async () => {
  initializeWorker();
  const { bridge } = connectProtocolTransport(context.signal);

  await expect(
    bridge.query(
      {
        dataKey: dataKey(crypto.randomUUID()),
        afterSeqId: null,
        consistency: "cache-only",
      },
      context.signal,
    ),
  ).rejects.toThrow(
    "Shared database tab registration is required before query",
  );
});

test("Validate shared chat results received from the worker", async () => {
  const [platformPort, workerPort] = messagePortPair();
  const resetOwner$ = resetSignal();
  const ownerSignal = context.store.set(resetOwner$, context.signal);
  const bridge = new MessagePortSharedDatabaseBridge(
    platformPort,
    bridgeEvents(),
    ownerSignal,
    () => {
      return Promise.resolve("test-token");
    },
  );
  workerPort.addEventListener("message", (event) => {
    const message = event.data;
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "query" &&
      "requestId" in message &&
      typeof message.requestId === "string"
    ) {
      workerPort.postMessage({
        type: "result",
        requestId: message.requestId,
        value: [{ malformed: true }],
      });
    }
  });
  workerPort.start();
  await bridge.registerTab(ownerSignal);

  await expect(
    bridge.query(
      {
        dataKey: dataKey(crypto.randomUUID()),
        afterSeqId: null,
        consistency: "cache-only",
      },
      ownerSignal,
    ),
  ).rejects.toMatchObject({ name: "ZodError" });
});

test("Stop pending requests when the bridge lifecycle ends", async () => {
  const [platformPort, workerPort] = messagePortPair();
  const resetOwner$ = resetSignal();
  const ownerSignal = context.store.set(resetOwner$, context.signal);
  const bridge = new MessagePortSharedDatabaseBridge(
    platformPort,
    bridgeEvents(),
    ownerSignal,
    () => {
      return Promise.resolve("test-token");
    },
  );
  const requestsStarted = context.mocks.deferred<void>();
  const requestIds = new Map<"get-computed" | "query", string>();
  workerPort.addEventListener("message", (event) => {
    const message = event.data;
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      (message.type === "get-computed" || message.type === "query") &&
      "requestId" in message &&
      typeof message.requestId === "string"
    ) {
      requestIds.set(message.type, message.requestId);
      if (requestIds.size === 2) {
        requestsStarted.resolve(undefined);
      }
    }
  });
  workerPort.start();
  await bridge.registerTab(ownerSignal);

  const resetCaller$ = resetSignal();
  const callerSignal = context.store.set(resetCaller$, context.signal);
  const pendingQuery = bridge.query(
    {
      dataKey: dataKey(crypto.randomUUID()),
      afterSeqId: null,
      consistency: "cache-only",
    },
    callerSignal,
  );
  const pendingComputed = bridge.getComputed("chat-thread-indicators");
  await requestsStarted.promise;
  context.store.set(resetOwner$);
  const reason: unknown = ownerSignal.reason;

  await expect(pendingQuery).rejects.toBe(reason);
  await expect(pendingComputed).rejects.toBe(reason);
  expect(platformPort.closed).toBeTruthy();

  for (const requestId of requestIds.values()) {
    workerPort.postMessage({
      type: "result",
      requestId,
      value: { agents: {}, threads: {} },
    });
  }
  await expect(bridge.getComputed("chat-thread-indicators")).rejects.toBe(
    reason,
  );
});

function mockUnreadIndicators(threadId: string): void {
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, { agents: {}, threads: { [threadId]: "unread" } });
  });
}

/** The Worker channel the credential-scoped subscriptions attach to. */
function credentialChannel(): string {
  const { userId, orgId } = identity();
  return `user-org:${userId}:${orgId}`;
}

function mockChatEventCatchUp(
  availableRows: () => readonly ChatEventRow[],
  onRequest: () => void = () => {},
): void {
  context.mocks.api(chatThreadEventsContract.catchUp, ({ body, respond }) => {
    onRequest();
    return respond(200, {
      events: Object.fromEntries(
        body.map(([id, sinceSeqId]) => {
          return [
            id,
            availableRows().filter((event) => {
              return event.chatThreadId === id && event.seqId > sinceSeqId;
            }),
          ];
        }),
      ),
      notFoundThreads: [],
    });
  });
}

/**
 * Warming lands in the cache before the Worker invalidates the thread, so the
 * invalidation is the synchronization point for "this thread is warm now".
 */
function chatEventInvalidations(threadId: string): {
  readonly events: SharedDatabaseBridgeEvents;
  readonly next: () => Promise<void>;
} {
  let pending: ReturnType<typeof context.mocks.deferred<void>> | null = null;
  return {
    events: {
      ...bridgeEvents(),
      databaseInvalidated: (invalidated: SharedDatabaseDataKey) => {
        if (
          invalidated.kind === "chat-event" &&
          invalidated.threadId === threadId
        ) {
          pending?.resolve();
          pending = null;
        }
      },
    },
    next: () => {
      const deferred = context.mocks.deferred<void>();
      pending = deferred;
      return deferred.promise;
    },
  };
}

function cachedRows(
  bridge: MessagePortSharedDatabaseBridge,
  threadId: string,
): Promise<unknown> {
  return bridge.query(
    { dataKey: dataKey(threadId), afterSeqId: null, consistency: "cache-only" },
    context.signal,
  );
}

test("Warm unread chats on connect and on every indicator refresh", async () => {
  const startedAt = 10_000;
  mockNow(startedAt, context.signal);
  const threadId = crypto.randomUUID();
  const rows = [row(threadId, 1), row(threadId, 2)];
  let availableRows = rows.slice(0, 1);
  mockUnreadIndicators(threadId);
  mockChatEventCatchUp(() => {
    return availableRows;
  });
  initializeWorker();
  const warming = chatEventInvalidations(threadId);
  const connectWarmed = warming.next();
  const { bridge } = connectProtocolTransport(
    context.signal,
    undefined,
    warming.events,
  );
  await bridge.registerTab(context.signal);
  // The `threadListChanged` subscription primes warming when it attaches.
  await connectWarmed;
  await expect(cachedRows(bridge, threadId)).resolves.toStrictEqual(
    rows.slice(0, 1),
  );

  availableRows = rows;
  const refreshWarmed = warming.next();
  mockNow(startedAt + 2000, context.signal);
  context.mocks.ably.triggerOnChannel(credentialChannel(), "threadListChanged");
  await refreshWarmed;
  await expect(cachedRows(bridge, threadId)).resolves.toStrictEqual(rows);
});

test("Keep indicators readable when chat warming fails", async () => {
  const startedAt = 20_000;
  mockNow(startedAt, context.signal);
  const threadId = crypto.randomUUID();
  const rows = [row(threadId, 1), row(threadId, 2)];
  let availableRows = rows.slice(0, 1);
  let failCatchUp = false;
  const failedCatchUp = context.mocks.deferred<void>();
  mockUnreadIndicators(threadId);
  context.mocks.api(chatThreadEventsContract.catchUp, ({ body, respond }) => {
    if (failCatchUp) {
      if (!failedCatchUp.settled()) {
        failedCatchUp.resolve();
      }
      return respond(500, {
        error: { message: "Catch-up failed", code: "INTERNAL_SERVER_ERROR" },
      });
    }
    return respond(200, {
      events: Object.fromEntries(
        body.map(([id, sinceSeqId]) => {
          return [
            id,
            availableRows.filter((event) => {
              return event.chatThreadId === id && event.seqId > sinceSeqId;
            }),
          ];
        }),
      ),
      notFoundThreads: [],
    });
  });
  initializeWorker();
  const warming = chatEventInvalidations(threadId);
  const connectWarmed = warming.next();
  const { bridge } = connectProtocolTransport(
    context.signal,
    undefined,
    warming.events,
  );
  await bridge.registerTab(context.signal);
  await connectWarmed;

  // Warming is a head start for readers that fall back to their own catch-up,
  // so its failure must stay inside the Worker instead of failing every tab's
  // unread indicators.
  failCatchUp = true;
  mockNow(startedAt + 2000, context.signal);
  context.mocks.ably.triggerOnChannel(credentialChannel(), "threadListChanged");
  await failedCatchUp.promise;
  await expect(
    bridge.getComputed("chat-thread-indicators"),
  ).resolves.toStrictEqual({
    agents: {},
    threads: { [threadId]: "unread" },
  });

  failCatchUp = false;
  availableRows = rows;
  const recoveredWarming = warming.next();
  mockNow(startedAt + 4000, context.signal);
  context.mocks.ably.triggerOnChannel(credentialChannel(), "threadListChanged");
  await recoveredWarming;
  await expect(cachedRows(bridge, threadId)).resolves.toStrictEqual(rows);
});

test("Cancel waiting indicator reads when their Worker lifecycle ends", async () => {
  mockNow(30_000, context.signal);
  const threadId = crypto.randomUUID();
  const resetWorker$ = resetSignal();
  const workerSignal = context.store.set(resetWorker$, context.signal);
  const refreshLoaded = context.mocks.deferred<void>();
  let refreshing = false;
  mockUnreadIndicators(threadId);
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    if (refreshing && !refreshLoaded.settled()) {
      refreshLoaded.resolve();
    }
    return respond(200, { agents: {}, threads: { [threadId]: "unread" } });
  });
  context.mocks.api(chatThreadEventsContract.catchUp, ({ body, respond }) => {
    return respond(200, {
      events: Object.fromEntries(
        body.map(([id]) => {
          return [id, []];
        }),
      ),
      notFoundThreads: [],
    });
  });
  initializeWorker(workerSignal);
  const connectionId = crypto.randomUUID();
  const connectionSignal = context.workerStore.set(
    openConnection$,
    connectionId,
    workerSignal,
  );
  context.workerStore.set(
    registerConnection$,
    connectionId,
    {
      getToken: () => {
        return Promise.resolve("message-port-token");
      },
      port: new InMemoryMessagePort(),
    },
    connectionSignal,
  );
  context.workerStore.set(recordConnectionHeartbeat$, connectionId);
  // Observe the Worker request directly: abort closes its message port before
  // the server can send a response to the client.
  const readIndicators = () => {
    return context.workerStore.set(
      getComputedStoreMessage$,
      connectionId,
      {
        type: "get-computed",
        requestId: crypto.randomUUID(),
        computedKey: "chat-thread-indicators",
      },
      workerSignal,
    );
  };
  await readIndicators();

  refreshing = true;
  context.workerStore.set(refreshWorkerComputed$, "chat-thread-indicators");
  await Promise.all([
    expect(readIndicators()).rejects.toMatchObject({
      name: "AbortError",
    }),
    expect(readIndicators()).rejects.toMatchObject({
      name: "AbortError",
    }),
    (async () => {
      await refreshLoaded.promise;
      context.store.set(resetWorker$);
    })(),
  ]);
});

test("Keep scopes, topics, and subscriber releases independent on one port", async () => {
  initializeWorker();
  const { bridge } = connectProtocolTransport(context.signal);
  await bridge.registerTab(context.signal);
  const topic = "presentationTemplatesChanged";
  const userChannel = `user:${identity().userId}`;
  const orgChannel = `org:${identity().orgId}`;
  const messages: string[] = [];
  const subscribe = (id: string, scope: "user" | "org", topicName = topic) => {
    return bridge.subscribeRealtime(
      id,
      scope,
      topicName,
      () => {
        messages.push(id);
      },
      () => {},
    );
  };
  await subscribe("first", "user");
  // Joining an already-ready topic must acknowledge the new subscriber too.
  await subscribe("second", "user");
  await subscribe("organization", "org");
  await subscribe("other-topic", "user", "connectorPermissionUpdated");

  bridge.unsubscribeRealtime("first");
  // A completed query is a barrier for the preceding unsubscribe message.
  await cachedRows(bridge, crypto.randomUUID());
  context.mocks.ably.triggerOnChannel(userChannel, topic);
  context.mocks.ably.triggerOnChannel(orgChannel, topic);
  context.mocks.ably.triggerOnChannel(
    userChannel,
    "connectorPermissionUpdated",
  );
  await vi.waitFor(() => {
    expect([...messages].sort()).toStrictEqual([
      "organization",
      "other-topic",
      "second",
    ]);
  });

  bridge.unsubscribeRealtime("second");
  await vi.waitFor(() => {
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(userChannel, topic),
    ).toBeFalsy();
  });
  expect(
    context.mocks.ably.hasSubscriptionOnChannel(orgChannel, topic),
  ).toBeTruthy();
  expect(
    context.mocks.ably.hasSubscriptionOnChannel(
      userChannel,
      "connectorPermissionUpdated",
    ),
  ).toBeTruthy();
  await subscribe("reacquired", "user");
  context.mocks.ably.triggerOnChannel(userChannel, topic);
  await vi.waitFor(() => {
    expect(messages.at(-1)).toBe("reacquired");
  });
  expect(messages).toHaveLength(4);
});

test.each(["attach", "fail"] as const)(
  "Ignore a stale subscription %s after cancellation and reacquisition",
  async (completion) => {
    initializeWorker();
    const { bridge, workerPort } = connectProtocolTransport(context.signal);
    await bridge.registerTab(context.signal);
    const topic = "connectorPermissionUpdated";
    const channel = `user:${identity().userId}`;
    const oldAttach = context.mocks.ably.deferSubscribeOnChannel(
      channel,
      topic,
    );
    const oldMessages: unknown[] = [];
    const oldSubscription = bridge.subscribeRealtime(
      "reused-id",
      "user",
      topic,
      (message) => {
        oldMessages.push(message.data);
      },
      () => {},
    );
    const cancelled = Promise.allSettled([oldSubscription]);
    await oldAttach.started;
    bridge.unsubscribeRealtime("reused-id");
    await expect(cancelled).resolves.toMatchObject([
      { status: "rejected", reason: { name: "AbortError" } },
    ]);
    await vi.waitFor(() => {
      expect(
        context.mocks.ably.hasSubscriptionOnChannel(channel, topic),
      ).toBeFalsy();
    });

    const nextAttach = context.mocks.ably.deferSubscribeOnChannel(
      channel,
      topic,
    );
    const messages: unknown[] = [];
    const subscription = bridge.subscribeRealtime(
      "reused-id",
      "user",
      topic,
      (message) => {
        messages.push(message.data);
      },
      () => {},
    );
    await nextAttach.started;
    if (completion === "attach") {
      oldAttach.attach();
    } else {
      oldAttach.fail(new Error("Old subscription failed"));
    }
    nextAttach.attach();
    await subscription;
    context.mocks.ably.triggerOnChannel(channel, topic, { revision: 1 });
    await vi.waitFor(() => {
      expect(messages).toStrictEqual([{ revision: 1 }]);
    });
    expect(oldMessages).toStrictEqual([]);
    const replies = workerPort.postedMessages
      .map((message) => {
        return sharedDatabaseWorkerMessageSchema.parse(message);
      })
      .filter((message) => {
        return (
          message.type === "realtime-subscribed" ||
          message.type === "realtime-subscription-error"
        );
      });
    expect(replies).toStrictEqual([
      { type: "realtime-subscribed", subscriptionId: "reused-id" },
    ]);
  },
);

test("Deliver an attach failure to every subscriber and permit reacquisition", async () => {
  initializeWorker();
  const first = connectProtocolTransport(context.signal);
  const second = connectProtocolTransport(context.signal);
  await first.bridge.registerTab(context.signal);
  await second.bridge.registerTab(context.signal);
  const topic = "connectorPermissionUpdated";
  const channel = `user:${identity().userId}`;
  const attach = context.mocks.ably.deferSubscribeOnChannel(channel, topic);
  const failed = Promise.allSettled([
    first.bridge.subscribeRealtime(
      "first",
      "user",
      topic,
      () => {},
      () => {},
    ),
    second.bridge.subscribeRealtime(
      "second",
      "user",
      topic,
      () => {},
      () => {},
    ),
  ]);
  await attach.started;
  await cachedRows(second.bridge, crypto.randomUUID());
  attach.fail(new Error("Attach rejected"));
  await expect(failed).resolves.toMatchObject([
    { status: "rejected", reason: { message: "Attach rejected" } },
    { status: "rejected", reason: { message: "Attach rejected" } },
  ]);
  expect(
    context.mocks.ably.hasSubscriptionOnChannel(channel, topic),
  ).toBeFalsy();

  const messages: unknown[] = [];
  await second.bridge.subscribeRealtime(
    "second",
    "user",
    topic,
    (message) => {
      messages.push(message.data);
    },
    () => {},
  );
  context.mocks.ably.triggerOnChannel(channel, topic, { recovered: true });
  await vi.waitFor(() => {
    expect(messages).toStrictEqual([{ recovered: true }]);
  });
});

test("Keep identical subscription keys in separate worker Stores independent", async () => {
  const resetWorker$ = resetSignal();
  const firstSignal = context.workerStore.set(resetWorker$, context.signal);
  const secondSignal = context.store.set(resetWorker$, context.signal);
  initializeWorker(firstSignal, context.workerStore);
  initializeWorker(secondSignal, context.store);
  const first = connectProtocolTransport(firstSignal);
  const second = connectProtocolTransport(
    secondSignal,
    undefined,
    undefined,
    context.store,
  );
  await first.bridge.registerTab(firstSignal);
  await second.bridge.registerTab(secondSignal);
  const topic = "connectorPermissionUpdated";
  const channel = `user:${identity().userId}`;
  const messages: unknown[] = [];
  await first.bridge.subscribeRealtime(
    "same-id",
    "user",
    topic,
    () => {},
    () => {},
  );
  await second.bridge.subscribeRealtime(
    "same-id",
    "user",
    topic,
    (message) => {
      messages.push(message.data);
    },
    () => {},
  );

  context.workerStore.set(resetWorker$);
  expect(firstSignal.aborted).toBeTruthy();
  expect(secondSignal.aborted).toBeFalsy();
  await vi.waitFor(() => {
    expect(first.workerPort.closed).toBeTruthy();
  });
  expect(first.workerPort.listeners.size).toBe(0);
  context.mocks.ably.triggerOnChannel(channel, topic, { revision: 1 });
  await vi.waitFor(() => {
    expect(messages).toStrictEqual([{ revision: 1 }]);
  });
  await expect(
    cachedRows(second.bridge, crypto.randomUUID()),
  ).resolves.toStrictEqual([]);
});

test("Close an unregistered port on parent cancellation and reject a pre-aborted parent", () => {
  const resetWorker$ = resetSignal();
  const workerSignal = context.store.set(resetWorker$, context.signal);
  const [platformPort, workerPort] = messagePortPair();
  new SharedDatabaseMessagePortServer(
    context.workerStore,
    workerPort,
    workerSignal,
  );
  const queuedListener = [...workerPort.listeners][0]!;
  platformPort.postMessage({ type: "register-tab" });
  context.store.set(resetWorker$);
  expect(workerPort.closed).toBeTruthy();
  expect(workerPort.listeners.size).toBe(0);
  // An already queued browser callback cannot register or reply after closure.
  queuedListener(
    new MessageEvent("message", { data: { type: "register-tab" } }),
  );
  queuedListener(new MessageEvent("message", { data: { type: "disconnect" } }));
  expect(workerPort.postedMessages).toStrictEqual([]);

  const reason = new DOMException("Worker was already stopped", "AbortError");
  const [, unopenedPort] = messagePortPair();
  expect(() => {
    new SharedDatabaseMessagePortServer(
      context.workerStore,
      unopenedPort,
      AbortSignal.abort(reason),
    );
  }).toThrow(reason);
  expect(unopenedPort.listeners.size).toBe(0);
});

test("Reject pending token work on disconnect and ignore its late completion", async () => {
  initializeWorker();
  const resetOwner$ = resetSignal();
  const ownerSignal = context.store.set(resetOwner$, context.signal);
  const tokenStarted = context.mocks.deferred<void>();
  const token = context.mocks.deferred<string>();
  const first = connectProtocolTransport(ownerSignal, () => {
    if (!tokenStarted.settled()) {
      tokenStarted.resolve();
    }
    return token.promise;
  });
  // Registration queues a heartbeat. It must reach the worker before token routing.
  await first.bridge.registerTab(ownerSignal);
  await cachedRows(first.bridge, crypto.randomUUID());
  const pending = context.workerStore.set(
    requestTokenFromLatestConnection$,
    context.signal,
  );
  const cancelled = Promise.allSettled([pending]);
  await tokenStarted.promise;
  context.store.set(resetOwner$);
  await expect(cancelled).resolves.toMatchObject([
    { status: "rejected", reason: { name: "AbortError" } },
  ]);
  expect(first.workerPort.closed).toBeTruthy();
  expect(first.workerPort.listeners.size).toBe(0);
  const replies = first.workerPort.postedMessages.length;
  token.resolve("stale-token");

  const second = connectProtocolTransport(context.signal, () => {
    return Promise.resolve("fresh-token");
  });
  await second.bridge.registerTab(context.signal);
  await cachedRows(second.bridge, crypto.randomUUID());
  await expect(
    context.workerStore.set(requestTokenFromLatestConnection$, context.signal),
  ).resolves.toBe("fresh-token");
  expect(first.workerPort.postedMessages).toHaveLength(replies);
});

test("Settle a disconnected query while another port completes the shared load", async () => {
  initializeWorker();
  const resetOwner$ = resetSignal();
  const ownerSignal = context.store.set(resetOwner$, context.signal);
  const first = connectProtocolTransport(ownerSignal);
  const second = connectProtocolTransport(context.signal);
  await first.bridge.registerTab(ownerSignal);
  await second.bridge.registerTab(context.signal);
  const key = dataKey(crypto.randomUUID());
  const canonicalRow = row(key.threadId, 1);
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
  const query = {
    dataKey: key,
    afterSeqId: null,
    consistency: "catch-up",
  } as const;
  const pending = first.bridge.query(query, ownerSignal);
  const cancelled = Promise.allSettled([pending]);
  const surviving = second.bridge.query(query, context.signal);
  await started.promise;
  context.store.set(resetOwner$);
  await expect(cancelled).resolves.toStrictEqual([
    { status: "rejected", reason: ownerSignal.reason },
  ]);
  await vi.waitFor(() => {
    expect(first.workerPort.closed).toBeTruthy();
  });
  const replies = first.workerPort.postedMessages.length;
  release.resolve();
  await expect(surviving).resolves.toStrictEqual([canonicalRow]);
  expect(first.workerPort.postedMessages).toHaveLength(replies);
  expect(first.workerPort.listeners.size).toBe(0);
});

test("Propagate the worker parent's reason through pending token work", async () => {
  const resetWorker$ = resetSignal();
  const workerSignal = context.store.set(resetWorker$, context.signal);
  initializeWorker(workerSignal);
  const token = context.mocks.deferred<string>();
  const tokenStarted = context.mocks.deferred<void>();
  const { bridge, workerPort } = connectProtocolTransport(
    context.signal,
    () => {
      if (!tokenStarted.settled()) {
        tokenStarted.resolve();
      }
      return token.promise;
    },
  );
  await bridge.registerTab(context.signal);
  await cachedRows(bridge, crypto.randomUUID());
  const pending = context.workerStore.set(
    requestTokenFromLatestConnection$,
    context.signal,
  );
  const cancelled = Promise.allSettled([pending]);
  await tokenStarted.promise;
  context.store.set(resetWorker$);
  await expect(cancelled).resolves.toStrictEqual([
    { status: "rejected", reason: workerSignal.reason },
  ]);
  expect(workerPort.closed).toBeTruthy();
  expect(workerPort.listeners.size).toBe(0);
  token.resolve("late-token");
});
