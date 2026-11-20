import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";

import {
  chatThreadEventsContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { expect, test, vi } from "vitest";
import type { Store } from "ccstate";

import {
  chatEventRowsResponse,
  createTestRuntime,
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
import { sharedDatabaseWorkerMessageSchema } from "../protocol.ts";
import { requestTokenFromTabs$ } from "../worker-context.ts";
import { initializeSharedDatabaseWorker$ } from "../worker-signals.ts";

const axiomTelemetry = vi.hoisted(() => {
  return {
    ingest:
      vi.fn<
        (dataset: string, events: readonly Record<string, unknown>[]) => void
      >(),
  };
});

vi.mock("@axiomhq/js", () => {
  return {
    Axiom: class {
      ingest(
        dataset: string,
        events: readonly Record<string, unknown>[],
      ): void {
        axiomTelemetry.ingest(dataset, events);
      }
    },
  };
});

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
        return workerStore.set(requestTokenFromTabs$, signal);
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
  heartbeatLoop: SharedDatabaseHeartbeatLoop = holdHeartbeatLoop,
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
      heartbeatLoop,
    ),
    platformPort,
    workerPort,
  };
}

// Observe the external Axiom payload through real token bridge round trips.
function tokenRequestTelemetry() {
  return axiomTelemetry.ingest.mock.calls.flatMap(([dataset, events]) => {
    expect(dataset).toBe("vm0-client-telemetry-prod");
    return events.filter((event) => {
      return event.name === "shared_database.token_request";
    });
  });
}

async function prepareTokenTelemetryRequest(ownerSignal = context.signal) {
  mockNow(new Date("2026-10-14T02:00:00Z"), context.signal);
  axiomTelemetry.ingest.mockReset();
  vi.stubEnv("VITE_AXIOM_CLIENT_TELEMETRY_TOKEN", "xaat-test-ingest-token");
  context.signal.addEventListener(
    "abort",
    () => {
      vi.unstubAllEnvs();
    },
    { once: true },
  );
  context.mocks.browser.url("https://app.okou.ai/");
  initializeWorker();
  const tokenRequested = context.mocks.deferred<void>();
  const tokenResponse = context.mocks.deferred<string | null>();
  let holdToken = false;
  const transport = connectProtocolTransport(ownerSignal, () => {
    if (!holdToken) {
      return Promise.resolve("bootstrap-token");
    }
    tokenRequested.resolve();
    return tokenResponse.promise;
  });
  await transport.bridge.registerTab(ownerSignal);
  await vi.waitFor(() => {
    expect(
      context.mocks.ably.hasChannelSubscriptionOnChannel(credentialChannel()),
    ).toBeTruthy();
  });
  holdToken = true;
  axiomTelemetry.ingest.mockReset();
  transport.workerPort.postedMessages.length = 0;
  return { ...transport, tokenRequested, tokenResponse };
}

function expectTokenRequestTelemetry(
  events: readonly Record<string, unknown>[],
  requestId: string,
  outcome: "success" | "error" | "aborted",
): void {
  expect(events).toHaveLength(2);
  for (const [index, event] of events.entries()) {
    expect(event).toMatchObject({
      "attributes.custom": {
        "okou.client.outcome": index === 0 ? "started" : outcome,
        "okou.shared_database.token_request.request_id": requestId,
      },
      name: "shared_database.token_request",
      "scope.name": "okou-app/shared-worker",
      "resource.deployment.environment.name": "production",
    });
    expect(event.duration).toStrictEqual(expect.any(Number));
  }
  expect(events[0]).not.toHaveProperty("status.code");
  expect(events[1]?.["status.code"]).toBe(
    outcome === "aborted" ? undefined : outcome === "success" ? "OK" : "ERROR",
  );
}

function tokenRequestId(workerPort: InMemoryMessagePort): string {
  const requests = workerPort.postedMessages
    .map((message) => {
      return sharedDatabaseWorkerMessageSchema.parse(message);
    })
    .filter((message) => {
      return message.type === "get-token";
    });
  expect(requests).toHaveLength(1);
  return requests[0]!.requestId;
}

test("Correlate token bridge failures without reporting raw error text", async () => {
  const { bridge, workerPort, tokenRequested, tokenResponse } =
    await prepareTokenTelemetryRequest();
  const indicators = bridge.getComputed("chat-thread-indicators");
  const failure = new Error("private-token-provider-error");
  const rejected = Promise.allSettled([indicators]);
  await tokenRequested.promise;
  const requestId = tokenRequestId(workerPort);
  tokenResponse.reject(failure);
  await expect(rejected).resolves.toMatchObject([
    { status: "rejected", reason: { name: "AggregateError" } },
  ]);
  const events = tokenRequestTelemetry();
  expectTokenRequestTelemetry(events, requestId, "error");
  expect(JSON.stringify(events)).not.toContain(failure.message);
});

// Multiple tabs share one Worker; exercise their independent MessagePorts.
test("Keep foreground presence until the last visible tab hides or disconnects", async () => {
  initializeWorker();
  const resetSecond$ = resetSignal();
  const secondSignal = context.store.set(resetSecond$, context.signal);
  const first = connectProtocolTransport(context.signal);
  const second = connectProtocolTransport(secondSignal);
  await first.bridge.registerTab(context.signal);
  await second.bridge.registerTab(secondSignal);
  const { userId, orgId } = identity();
  const channel = `user-org-foreground:${userId}:${orgId}`;

  first.bridge.setTabVisibility("visible");
  await vi.waitFor(() => {
    expect(context.mocks.ably.getPresenceCount(channel)).toBe(1);
  });
  second.bridge.setTabVisibility("visible");
  first.bridge.setTabVisibility("hidden");
  // A query round trip observes both preceding state messages on each port.
  await first.bridge.getComputed("chat-thread-indicators");
  await second.bridge.getComputed("chat-thread-indicators");
  expect(context.mocks.ably.getPresenceCount(channel)).toBe(1);

  second.bridge.setTabVisibility("hidden");
  await vi.waitFor(() => {
    expect(context.mocks.ably.getPresenceCount(channel)).toBe(0);
  });
  second.bridge.setTabVisibility("visible");
  await vi.waitFor(() => {
    expect(context.mocks.ably.getPresenceCount(channel)).toBe(1);
  });
  context.store.set(resetSecond$);
  await vi.waitFor(() => {
    expect(context.mocks.ably.getPresenceCount(channel)).toBe(0);
  });
});

// A future feature's event has no existing page interaction. Exercise the
// production MessagePort boundary so new events cannot close the chat read port.
test.each(["user"] as const)(
  "Forward new %s events without registering their names and keep chat reads available",
  async (scope) => {
    const threadId = crypto.randomUUID();
    const existingRow = row(threadId, 1);
    context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
      return respond(
        200,
        chatEventRowsResponse(
          query.sinceSeqId === 0 ? [existingRow] : [],
          query,
        ),
      );
    });
    initializeWorker();
    const { bridge } = connectProtocolTransport(context.signal);
    await bridge.registerTab(context.signal);

    const topic = "newFeature:changed";
    const { userId, orgId } = identity();
    const channelName = {
      user: `user:${userId}`,
      org: `org:${orgId}`,
      credential: `user-org:${userId}:${orgId}`,
    }[scope];
    const messages: unknown[] = [];
    await bridge.subscribeRealtime(
      "new-feature",
      scope,
      topic,
      (message) => {
        messages.push(message.data);
      },
      () => {},
    );

    context.mocks.ably.triggerOnChannel(`${channelName}-other`, topic, {
      revision: "other identity",
    });
    context.mocks.ably.triggerOnChannel(channelName, "anotherFeature:changed", {
      revision: "other event",
    });
    context.mocks.ably.triggerOnChannel(channelName, topic, { revision: 1 });
    await vi.waitFor(() => {
      expect(messages).toStrictEqual([{ revision: 1 }]);
    });
    await expect(
      bridge.query(
        {
          dataKey: dataKey(threadId),
          afterSeqId: null,
          consistency: "catch-up",
        },
        context.signal,
      ),
    ).resolves.toStrictEqual([existingRow]);
  },
);

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

test("preserve upgrade status on query errors across MessagePort", async () => {
  initializeWorker();
  const { bridge } = connectProtocolTransport(context.signal);
  await bridge.registerTab(context.signal);
  context.mocks.http.get("*/api/chat-threads/snapshot", () => {
    return Response.json(
      { error: { code: "REQUEST_FAILED", message: "Request failed" } },
      { status: 426 },
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
  await expect(failed).rejects.toMatchObject({ status: 426 });
});

test("preserve API error classification for computed upgrade errors across MessagePort", async () => {
  initializeWorker();
  const { bridge } = connectProtocolTransport(context.signal);
  await bridge.registerTab(context.signal);
  context.mocks.http.get("*/api/indicators", () => {
    return Response.json(
      { error: { code: "REQUEST_FAILED", message: "Request failed" } },
      { status: 426 },
    );
  });
  const failed = bridge.getComputed("chat-thread-indicators");
  await expect(failed).rejects.toBeInstanceOf(ApiError);
  await expect(failed).rejects.toMatchObject({
    status: 426,
    code: "REQUEST_FAILED",
  });
});

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

// Delay heartbeats so the requesting tab, rather than daemon startup, initiates
// the first token round trip. Registration and query messages remain unchanged.
const deferHeartbeatLoop: SharedDatabaseHeartbeatLoop = (
  _heartbeat,
  signal,
) => {
  signal.throwIfAborted();
};

test("Authenticate a shared read with the first successful tab without waiting for its sibling", async () => {
  initializeWorker();
  const delayedToken = context.mocks.deferred<string | null>();
  const firstRequested = context.mocks.deferred<void>();
  const first = connectProtocolTransport(
    context.signal,
    () => {
      firstRequested.resolve();
      return delayedToken.promise;
    },
    bridgeEvents(),
    context.workerStore,
    deferHeartbeatLoop,
  );
  const second = connectProtocolTransport(
    context.signal,
    () => {
      return Promise.resolve("second-tab-token");
    },
    bridgeEvents(),
    context.workerStore,
    deferHeartbeatLoop,
  );
  await first.bridge.registerTab(context.signal);
  await second.bridge.registerTab(context.signal);
  const requestTokens = new Set<string | null>();
  const indicators = { agents: {}, threads: {}, unreadAt: {} };
  context.mocks.api(chatThreadsContract.indicators, ({ request, respond }) => {
    requestTokens.add(request.headers.get("authorization"));
    return respond(200, indicators);
  });

  const pending = second.bridge.getComputed("chat-thread-indicators");
  await firstRequested.promise;
  await expect(pending).resolves.toStrictEqual(indicators);
  expect(requestTokens).toStrictEqual(new Set(["Bearer second-tab-token"]));
  tokenRequestId(first.workerPort);
  tokenRequestId(second.workerPort);
  delayedToken.resolve("late-first-tab-token");
});

test.each<"disconnects" | "rejects">(["disconnects"])(
  "Authenticate a shared read when another token provider %s first",
  async (failure) => {
    initializeWorker();
    const resetFirstOwner$ = resetSignal();
    const firstOwnerSignal = context.store.set(
      resetFirstOwner$,
      context.signal,
    );
    const firstToken = context.mocks.deferred<string | null>();
    const healthyToken = context.mocks.deferred<string | null>();
    const healthyRequested = context.mocks.deferred<void>();
    const first = connectProtocolTransport(
      firstOwnerSignal,
      () => {
        return firstToken.promise;
      },
      bridgeEvents(),
      context.workerStore,
      deferHeartbeatLoop,
    );
    const healthy = connectProtocolTransport(
      context.signal,
      () => {
        healthyRequested.resolve();
        return healthyToken.promise;
      },
      bridgeEvents(),
      context.workerStore,
      deferHeartbeatLoop,
    );
    await first.bridge.registerTab(firstOwnerSignal);
    await healthy.bridge.registerTab(context.signal);
    const indicators = { agents: {}, threads: {}, unreadAt: {} };
    const requestTokens = new Set<string | null>();
    context.mocks.api(
      chatThreadsContract.indicators,
      ({ request, respond }) => {
        requestTokens.add(request.headers.get("authorization"));
        return respond(200, indicators);
      },
    );

    const result = Promise.allSettled([
      healthy.bridge.getComputed("chat-thread-indicators"),
    ]);
    await healthyRequested.promise;
    const requestId = tokenRequestId(first.workerPort);
    if (failure === "rejects") {
      firstToken.reject(new Error("Clerk token is unavailable"));
    } else {
      context.store.set(resetFirstOwner$);
    }
    const failureMessage =
      failure === "rejects"
        ? {
            type: "token-error",
            requestId,
            error: { name: "Error", message: "Clerk token is unavailable" },
          }
        : { type: "disconnect" };
    await vi.waitFor(() => {
      expect(first.platformPort.postedMessages).toContainEqual(failureMessage);
    });
    healthyToken.resolve("healthy-tab-token");

    await expect(result).resolves.toStrictEqual([
      { status: "fulfilled", value: indicators },
    ]);
    expect(requestTokens).toStrictEqual(new Set(["Bearer healthy-tab-token"]));
    if (failure === "disconnects") {
      firstToken.resolve("late-disconnected-tab-token");
    }
  },
);

test("Reject a shared read with AggregateError when every tab's token provider fails", async () => {
  initializeWorker();
  const lastToken = context.mocks.deferred<string | null>();
  const lastRequested = context.mocks.deferred<void>();
  const first = connectProtocolTransport(
    context.signal,
    () => {
      return Promise.reject(new Error("First tab token unavailable"));
    },
    bridgeEvents(),
    context.workerStore,
    deferHeartbeatLoop,
  );
  const last = connectProtocolTransport(
    context.signal,
    () => {
      lastRequested.resolve();
      return lastToken.promise;
    },
    bridgeEvents(),
    context.workerStore,
    deferHeartbeatLoop,
  );
  await first.bridge.registerTab(context.signal);
  await last.bridge.registerTab(context.signal);

  const result = Promise.allSettled([
    last.bridge.getComputed("chat-thread-indicators"),
  ]);
  await lastRequested.promise;
  await vi.waitFor(() => {
    expect(first.platformPort.postedMessages).toContainEqual({
      type: "token-error",
      requestId: tokenRequestId(first.workerPort),
      error: { name: "Error", message: "First tab token unavailable" },
    });
  });
  lastToken.reject(new Error("Last tab token unavailable"));

  await expect(result).resolves.toMatchObject([
    { status: "rejected", reason: { name: "AggregateError" } },
  ]);
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

function mockUnreadIndicators(threadId: string): void {
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: {},
      threads: { [threadId]: "unread" },
      unreadAt: {},
    });
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

test("Refresh unread indicators after an indicator change without warming messages", async () => {
  const threadId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  let muted = false;
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(
      200,
      muted
        ? { agents: {}, threads: {}, unreadAt: {} }
        : {
            agents: { [agentId]: "unread" },
            threads: { [threadId]: "unread" },
            unreadAt: { [threadId]: "2026-03-10T00:00:00Z" },
          },
    );
  });
  let catchUpRequestCount = 0;
  mockChatEventCatchUp(
    () => {
      return [];
    },
    () => {
      catchUpRequestCount += 1;
    },
  );
  initializeWorker();
  const { bridge } = connectProtocolTransport(context.signal);
  await bridge.registerTab(context.signal);
  await vi.waitFor(() => {
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(
        credentialChannel(),
        "chatIndicatorsChanged",
      ),
    ).toBeTruthy();
  });
  await expect(
    bridge.getComputed("chat-thread-indicators"),
  ).resolves.toMatchObject({ threads: { [threadId]: "unread" } });
  muted = true;
  context.mocks.ably.triggerOnChannel(
    credentialChannel(),
    "chatIndicatorsChanged",
  );
  await vi.waitFor(async () => {
    await expect(
      bridge.getComputed("chat-thread-indicators"),
    ).resolves.toStrictEqual({ agents: {}, threads: {}, unreadAt: {} });
  });
  expect(catchUpRequestCount).toBe(0);
});

test("Warm unread chats only after chat message notifications", async () => {
  const startedAt = 10_000;
  mockNow(startedAt, context.signal);
  const threadId = crypto.randomUUID();
  const notifiedThreadId = crypto.randomUUID();
  const rows = [row(threadId, 1), row(threadId, 2)];
  let availableRows = rows.slice(0, 1);
  let catchUpRequestCount = 0;
  mockUnreadIndicators(threadId);
  mockChatEventCatchUp(
    () => {
      return availableRows;
    },
    () => {
      catchUpRequestCount += 1;
    },
  );
  initializeWorker();
  const warming = chatEventInvalidations(threadId);
  let indicatorReloadCount = 0;
  const { bridge } = connectProtocolTransport(context.signal, undefined, {
    ...warming.events,
    computedReloaded: (computedKey) => {
      if (computedKey === "chat-thread-indicators") {
        indicatorReloadCount += 1;
      }
    },
  });
  await bridge.registerTab(context.signal);
  await vi.waitFor(() => {
    for (const topic of [
      "chatIndicatorsChanged",
      "chatThreadReadCursorUpdated",
    ]) {
      expect(
        context.mocks.ably.hasSubscriptionOnChannel(credentialChannel(), topic),
      ).toBeTruthy();
    }
  });

  context.mocks.ably.triggerOnChannel(
    credentialChannel(),
    "chatIndicatorsChanged",
  );
  context.mocks.ably.triggerOnChannel(
    credentialChannel(),
    "chatThreadReadCursorUpdated",
    { threadId, lastReadAt: null },
  );
  await vi.waitFor(() => {
    expect(indicatorReloadCount).toBeGreaterThanOrEqual(3);
  });
  // An indicator change invalidates before and after its refresh; a read
  // cursor invalidates after its refresh. Neither warms chat content.
  expect(indicatorReloadCount).toBe(3);
  expect(catchUpRequestCount).toBe(0);

  const firstWarmed = warming.next();
  context.mocks.ably.triggerOnChannel(
    credentialChannel(),
    `chatThreadMessageCreated:${notifiedThreadId}`,
  );
  await firstWarmed;
  expect(catchUpRequestCount).toBe(1);
  await expect(cachedRows(bridge, threadId)).resolves.toStrictEqual(
    rows.slice(0, 1),
  );

  availableRows = rows;
  const secondWarmed = warming.next();
  mockNow(startedAt + 2000, context.signal);
  context.mocks.ably.triggerOnChannel(
    credentialChannel(),
    `chatThreadMessageCreated:${notifiedThreadId}`,
  );
  await secondWarmed;
  expect(catchUpRequestCount).toBe(2);
  await expect(cachedRows(bridge, threadId)).resolves.toStrictEqual(rows);
});

test("Keep indicators readable when message-triggered chat warming fails", async () => {
  const startedAt = 20_000;
  mockNow(startedAt, context.signal);
  const threadId = crypto.randomUUID();
  const notifiedThreadId = crypto.randomUUID();
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
  const { bridge } = connectProtocolTransport(
    context.signal,
    undefined,
    warming.events,
  );
  await bridge.registerTab(context.signal);
  await vi.waitFor(() => {
    expect(
      context.mocks.ably.hasChannelSubscriptionOnChannel(credentialChannel()),
    ).toBeTruthy();
  });

  // Warming is a head start for readers that fall back to their own catch-up,
  // so its failure must stay inside the Worker instead of failing every tab's
  // unread indicators.
  failCatchUp = true;
  context.mocks.ably.triggerOnChannel(
    credentialChannel(),
    `chatThreadMessageCreated:${notifiedThreadId}`,
  );
  await failedCatchUp.promise;
  await expect(
    bridge.getComputed("chat-thread-indicators"),
  ).resolves.toStrictEqual({
    agents: {},
    threads: { [threadId]: "unread" },
    unreadAt: {},
  });

  failCatchUp = false;
  availableRows = rows;
  const recoveredWarming = warming.next();
  mockNow(startedAt + 2000, context.signal);
  context.mocks.ably.triggerOnChannel(
    credentialChannel(),
    `chatThreadMessageCreated:${notifiedThreadId}`,
  );
  await recoveredWarming;
  await expect(cachedRows(bridge, threadId)).resolves.toStrictEqual(rows);
});

test("Keep scopes, topics, and subscriber releases independent on one port", async () => {
  initializeWorker();
  const { bridge } = connectProtocolTransport(context.signal);
  await bridge.registerTab(context.signal);
  const topic = "presentationTemplatesChanged";
  const userChannel = `user:${identity().userId}`;
  const orgChannel = `org:${identity().orgId}`;
  const messages: string[] = [];
  const subscribe = (
    id: string,
    scope: "user" | "org",
    topicName:
      "presentationTemplatesChanged" | "connectorPermissionUpdated" = topic,
  ) => {
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

test("Ignore a stale subscription attach after cancellation and reacquisition", async () => {
  initializeWorker();
  const { bridge, workerPort } = connectProtocolTransport(context.signal);
  await bridge.registerTab(context.signal);
  const topic = "connectorPermissionUpdated";
  const channel = `user:${identity().userId}`;
  const oldAttach = context.mocks.ably.deferSubscribeOnChannel(channel, topic);
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

  const nextAttach = context.mocks.ably.deferSubscribeOnChannel(channel, topic);
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
  oldAttach.attach();
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
});

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
  const firstWorker = createTestRuntime(context);
  const secondWorker = createTestRuntime(context);
  const resetWorker$ = resetSignal();
  const firstSignal = firstWorker.workerStore.set(
    resetWorker$,
    firstWorker.signal,
  );
  const secondSignal = secondWorker.workerStore.set(
    resetWorker$,
    secondWorker.signal,
  );
  initializeWorker(firstSignal, firstWorker.workerStore);
  initializeWorker(secondSignal, secondWorker.workerStore);
  const first = connectProtocolTransport(
    firstSignal,
    undefined,
    undefined,
    firstWorker.workerStore,
  );
  const second = connectProtocolTransport(
    secondSignal,
    undefined,
    undefined,
    secondWorker.workerStore,
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

  firstWorker.workerStore.set(resetWorker$);
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
