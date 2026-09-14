import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import {
  chatThreadsContract,
  chatThreadEventsContract,
  type ChatThreadEvent,
  type ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import { openDB } from "idb";
import { expect, test, vi } from "vitest";

import { createAuthedContractClient } from "../../signals/api-client-base.ts";
import type { ApiClientFactory } from "../../signals/api-client.ts";
import { CHAT_IDB_VERSION } from "../../signals/external/chat-idb-schema.ts";
import {
  chatEventRowsResponse,
  testContext,
} from "../../signals/__tests__/test-helpers.ts";
import type {
  ChatEventDataKey,
  ChatThreadEventDataKey,
  SharedDatabaseDataKey,
  SharedDatabaseIdentity,
  SharedDatabaseQuery,
  SharedDatabaseQueryResult,
} from "../data-key.ts";
import type { WorkerBroadcastMessage } from "../worker-context.ts";
import { SharedDatabaseWorkerRuntime } from "../worker-runtime.ts";

const context = testContext();
const SNAPSHOT_URL = "https://r2.example.com/shared-worker-chat-events.ndjson";
const CREATED_AT = "2026-08-14T08:00:00.000Z";
const WORKER_APP_VERSION = "shared-worker-store-version";
const AGENT_ID = "c0000000-0000-4000-a000-000000000920";
const THREAD_ID = "b0000000-0000-4000-a000-000000000920";

function identity(
  overrides: Partial<SharedDatabaseIdentity> = {},
): SharedDatabaseIdentity {
  return {
    userId: `shared-worker-user-${context.resourceId}`,
    orgId: `shared-worker-org-${context.resourceId}`,
    ...overrides,
  };
}

function chatEventKey(threadId: string): ChatEventDataKey {
  return {
    kind: "chat-event",
    threadId,
  };
}

function chatThreadEventKey(): ChatThreadEventDataKey {
  return { kind: "chat-thread-event" };
}

function chatEventRow(threadId: string, seqId: number): ChatEventRow {
  return {
    id: crypto.randomUUID(),
    chatThreadId: threadId,
    runId: null,
    revokesEventId: null,
    eventType: "output.message",
    payload: { content: `message ${seqId}` },
    contextType: null,
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId,
    createdAt: CREATED_AT,
  };
}

function snapshotThread(title: string): ChatThreadSnapshotProjection {
  return {
    id: THREAD_ID,
    agentId: AGENT_ID,
    title,
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
}

function renamedThreadEvent(seqId: number, title: string): ChatThreadEvent {
  return {
    id: crypto.randomUUID(),
    seqId,
    kind: "renamed",
    chatThreadId: THREAD_ID,
    agentId: AGENT_ID,
    title,
    selectedModel: null,
    serviceTier: null,
    computerUseHostId: null,
    selectedVideoModel: null,
    createdAt: CREATED_AT,
  };
}

function snapshotNdjson(rows: readonly ChatEventRow[]): string {
  return `${rows
    .map((row) => {
      return JSON.stringify(row);
    })
    .join("\n")}\n`;
}

interface RuntimeFixture {
  readonly events: WorkerBroadcastMessage[];
  readonly runtime: SharedDatabaseWorkerRuntime;
}

function startRuntime(
  currentIdentity: SharedDatabaseIdentity = identity(),
  vercelProtectionBypass?: string,
): RuntimeFixture {
  const events: WorkerBroadcastMessage[] = [];
  const createContractClient: ApiClientFactory = (contract) => {
    return createAuthedContractClient(contract, {
      baseUrl: location.origin,
      clientVersion: WORKER_APP_VERSION,
      getToken: () => {
        return Promise.resolve("initial-token");
      },
      getVercelProtectionBypass: () => {
        return vercelProtectionBypass;
      },
      onForceUpgrade: () => {
        events.push({
          type: "worker-unavailable",
          reason: "force-upgrade-required",
        });
      },
    });
  };
  const runtime = new SharedDatabaseWorkerRuntime(
    {
      identity: currentIdentity,
      emit: (event) => {
        events.push(event);
      },
      createContractClient,
    },
    context.signal,
  );
  return { events, runtime };
}

async function queryRuntime<TKey extends SharedDatabaseDataKey>(
  runtime: SharedDatabaseWorkerRuntime,
  query: SharedDatabaseQuery<TKey>,
  signal: AbortSignal = context.signal,
): Promise<SharedDatabaseQueryResult<TKey>> {
  return await runtime.query(query, signal);
}

test.each(["catch-up", "rows", "snapshot"] as const)(
  "treat a headerless 426 from %s as an upgrade request",
  async (operation) => {
    const { runtime, events } = startRuntime();
    const response = () => {
      return Response.json(
        {
          error: {
            code: "CLIENT_UPGRADE_REQUIRED",
            message: "Client update required",
          },
        },
        { status: 426 },
      );
    };
    const threadId = crypto.randomUUID();
    if (operation === "catch-up") {
      context.mocks.http.post("*/api/chat/events/catch-up", response);
    } else {
      context.mocks.http.get(
        operation === "rows"
          ? "*/api/chat-threads/:threadId/event-rows"
          : "*/api/chat-threads/:threadId/event-snapshot",
        response,
      );
    }
    const request =
      operation === "catch-up"
        ? runtime.catchUpChatEvents([threadId], context.signal)
        : runtime.query(
            {
              dataKey: chatEventKey(threadId),
              afterSeqId: null,
              consistency: "catch-up",
            },
            context.signal,
          );
    await expect(request).rejects.toMatchObject({
      name: "SharedDatabaseHttpError",
      status: 426,
    });
    expect(events).toContainEqual({
      type: "worker-unavailable",
      reason: "force-upgrade-required",
    });
  },
);

test.each(["catch-up", "rows", "snapshot"] as const)(
  "still reject a successful %s response missing the schema header",
  async (operation) => {
    const { runtime, events } = startRuntime();
    const threadId = crypto.randomUUID();
    if (operation === "catch-up") {
      context.mocks.http.post("*/api/chat/events/catch-up", () => {
        return Response.json({
          events: { [threadId]: [] },
          notFoundThreads: [],
        });
      });
    } else if (operation === "rows") {
      context.mocks.http.get("*/api/chat-threads/:threadId/event-rows", () => {
        return Response.json(chatEventRowsResponse([], { sinceSeqId: 0 }));
      });
    } else {
      context.mocks.http.get(
        "*/api/chat-threads/:threadId/event-snapshot",
        () => {
          return Response.json({
            url: SNAPSHOT_URL,
            lastEventId: null,
            lastSeqId: 0,
            expiresInSeconds: 3600,
          });
        },
      );
    }
    const request =
      operation === "catch-up"
        ? runtime.catchUpChatEvents([threadId], context.signal)
        : runtime.query(
            {
              dataKey: chatEventKey(threadId),
              afterSeqId: null,
              consistency: "catch-up",
            },
            context.signal,
          );
    await expect(request).rejects.toThrow(
      "Unexpected Chat Event schema version null",
    );
    expect(events).toStrictEqual([]);
  },
);

test("Keep cached chat data isolated by user and workspace", async () => {
  const firstIdentity = identity();
  const secondIdentity = identity({
    orgId: `${identity().orgId}-second`,
  });
  const dataKey = chatEventKey(crypto.randomUUID());
  const firstRow = chatEventRow(dataKey.threadId, 1);
  const secondRow = chatEventRow(dataKey.threadId, 2);
  let availableRows: readonly ChatEventRow[] = [firstRow];
  context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
    return respond(404, {
      error: {
        code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
        message: "Chat event snapshot not found",
      },
    });
  });
  context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
    return respond(200, chatEventRowsResponse(availableRows, query));
  });

  const firstRuntime = startRuntime(firstIdentity).runtime;
  const secondRuntime = startRuntime(secondIdentity).runtime;
  await queryRuntime(firstRuntime, {
    dataKey,
    afterSeqId: null,
    consistency: "catch-up",
  });
  availableRows = [secondRow];
  await queryRuntime(secondRuntime, {
    dataKey,
    afterSeqId: null,
    consistency: "catch-up",
  });

  await expect(
    queryRuntime(firstRuntime, {
      dataKey,
      afterSeqId: null,
      consistency: "cache-only",
    }),
  ).resolves.toStrictEqual([firstRow]);
  await expect(
    queryRuntime(secondRuntime, {
      dataKey,
      afterSeqId: null,
      consistency: "cache-only",
    }),
  ).resolves.toStrictEqual([secondRow]);
});

test("Read locally cached chat data without the network", async () => {
  const { runtime } = startRuntime();
  let networkRequests = 0;
  context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
    networkRequests += 1;
    return respond(404, {
      error: {
        code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
        message: "Chat event snapshot not found",
      },
    });
  });
  context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
    networkRequests += 1;
    return respond(200, chatEventRowsResponse([], query));
  });
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    networkRequests += 1;
    return respond(200, {
      chatThreads: [],
      latestEventId: null,
      latestSeqId: null,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    networkRequests += 1;
    return respond(200, { events: [], hasMore: false });
  });

  await expect(
    queryRuntime(runtime, {
      dataKey: chatEventKey(crypto.randomUUID()),
      afterSeqId: null,
      consistency: "cache-only",
    }),
  ).resolves.toStrictEqual([]);
  await expect(
    queryRuntime(runtime, {
      dataKey: chatThreadEventKey(),
      afterSeqId: null,
      consistency: "cache-only",
    }),
  ).resolves.toStrictEqual({ snapshot: null, events: [] });
  expect(networkRequests).toBe(0);
});

test("Load complete chat history across a snapshot boundary", async () => {
  const { runtime } = startRuntime();
  const dataKey = chatEventKey(crypto.randomUUID());
  const snapshotRow = chatEventRow(dataKey.threadId, 2);
  const tailRow = chatEventRow(dataKey.threadId, 3);
  const requestedSeqIds: number[] = [];
  context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
    return respond(200, {
      url: SNAPSHOT_URL,
      expiresInSeconds: 900,
      lastEventId: snapshotRow.id,
      lastSeqId: 2,
    });
  });
  context.mocks.http.get(SNAPSHOT_URL, () => {
    return new Response(snapshotNdjson([snapshotRow]));
  });
  context.mocks.api(
    chatThreadEventsContract.rows,
    ({ query, query: requestQuery, respond }) => {
      requestedSeqIds.push(requestQuery.sinceSeqId);
      return respond(
        200,
        chatEventRowsResponse(
          requestQuery.sinceSeqId === 2 ? [tailRow] : [],
          query,
        ),
      );
    },
  );

  await expect(
    queryRuntime(runtime, {
      dataKey,
      afterSeqId: null,
      consistency: "catch-up",
    }),
  ).resolves.toStrictEqual([snapshotRow, tailRow]);
  expect(requestedSeqIds).toStrictEqual([2, 3]);
  const requestCount = requestedSeqIds.length;
  await expect(
    queryRuntime(runtime, {
      dataKey,
      afterSeqId: 2,
      consistency: "cache-only",
    }),
  ).resolves.toStrictEqual([tailRow]);
  expect(requestedSeqIds).toHaveLength(requestCount);
});

test("Preserve a future run failure reason from snapshot storage", async () => {
  const { runtime } = startRuntime();
  const dataKey = chatEventKey(crypto.randomUUID());
  const failedRow: ChatEventRow = {
    id: crypto.randomUUID(),
    chatThreadId: dataKey.threadId,
    runId: "a0000000-0000-4000-a000-000000000096",
    revokesEventId: null,
    eventType: "run.failed",
    failureReason: "provider_model_retired",
    payload: { error: "The selected provider model is no longer available" },
    contextType: null,
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId: 7,
    createdAt: CREATED_AT,
  };
  context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
    return respond(200, {
      url: SNAPSHOT_URL,
      expiresInSeconds: 900,
      lastEventId: failedRow.id,
      lastSeqId: failedRow.seqId,
    });
  });
  context.mocks.http.get(SNAPSHOT_URL, () => {
    return new Response(snapshotNdjson([failedRow]));
  });
  context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
    return respond(200, chatEventRowsResponse([], query));
  });

  await expect(
    queryRuntime(runtime, {
      dataKey,
      afterSeqId: null,
      consistency: "catch-up",
    }),
  ).resolves.toStrictEqual([failedRow]);
  await expect(
    queryRuntime(runtime, {
      dataKey,
      afterSeqId: null,
      consistency: "cache-only",
    }),
  ).resolves.toStrictEqual([failedRow]);
});

test("Rebuild chat data after its saved cursor expires", async () => {
  {
    const { runtime } = startRuntime();
    const dataKey = chatEventKey(crypto.randomUUID());
    const oldRow = chatEventRow(dataKey.threadId, 1);
    const rebuiltRow = chatEventRow(dataKey.threadId, 10);
    const tailRow = chatEventRow(dataKey.threadId, 11);
    let expired = false;
    context.mocks.api(
      chatThreadEventsContract.snapshot,
      ({ request, respond }) => {
        expect(request.headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER)).toBe(
          CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
        );
        if (!expired) {
          return respond(404, {
            error: {
              code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
              message: "Chat event snapshot not found",
            },
          });
        }
        return respond(200, {
          url: SNAPSHOT_URL,
          expiresInSeconds: 900,
          lastEventId: rebuiltRow.id,
          lastSeqId: 10,
        });
      },
    );
    context.mocks.http.get(SNAPSHOT_URL, () => {
      return new Response(snapshotNdjson([rebuiltRow]));
    });
    let returnedExpiry = false;
    context.mocks.api(
      chatThreadEventsContract.rows,
      ({ query, request, query: requestQuery, respond }) => {
        expect(request.headers.get(CHAT_EVENT_SCHEMA_VERSION_HEADER)).toBe(
          CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
        );
        if (!expired) {
          return respond(
            200,
            chatEventRowsResponse(
              requestQuery.sinceSeqId === 0 ? [oldRow] : [],
              query,
            ),
          );
        }
        if (requestQuery.sinceSeqId === 1 && !returnedExpiry) {
          returnedExpiry = true;
          return respond(410, {
            error: {
              code: "CHAT_EVENTS_EXPIRED",
              message: "Chat events cursor has expired",
            },
          });
        }
        return respond(
          200,
          chatEventRowsResponse(
            requestQuery.sinceSeqId === 10 ? [tailRow] : [],
            query,
          ),
        );
      },
    );

    await queryRuntime(runtime, {
      dataKey,
      afterSeqId: null,
      consistency: "catch-up",
    });
    expired = true;
    await expect(
      queryRuntime(runtime, {
        dataKey,
        afterSeqId: oldRow.seqId,
        consistency: "catch-up",
      }),
    ).resolves.toStrictEqual([rebuiltRow, tailRow]);
    await expect(
      queryRuntime(runtime, {
        dataKey,
        afterSeqId: null,
        consistency: "cache-only",
      }),
    ).resolves.toStrictEqual([rebuiltRow, tailRow]);
  }
  {
    const { runtime } = startRuntime();
    const dataKey = chatThreadEventKey();
    const oldEvent = renamedThreadEvent(2, "old title");
    const currentEvent = renamedThreadEvent(11, "current title");
    let snapshotVersion = 1;
    let returnExpiry = false;
    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      const current = snapshotVersion === 1;
      return respond(200, {
        chatThreads: [
          snapshotThread(current ? "old snapshot" : "new snapshot"),
        ],
        latestEventId: crypto.randomUUID(),
        latestSeqId: current ? 1 : 10,
      });
    });
    context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
      if (returnExpiry && query.sinceSeqId === oldEvent.seqId) {
        returnExpiry = false;
        return respond(410, {
          error: {
            code: "CHAT_THREAD_EVENTS_EXPIRED",
            message: "Chat thread events cursor has expired",
          },
        });
      }
      if (snapshotVersion === 1) {
        return respond(200, { events: [oldEvent], hasMore: false });
      }
      return respond(200, {
        events: query.sinceSeqId === 10 ? [currentEvent] : [],
        hasMore: false,
      });
    });

    await queryRuntime(runtime, {
      dataKey,
      afterSeqId: null,
      consistency: "catch-up",
    });
    snapshotVersion = 2;
    returnExpiry = true;
    await expect(
      queryRuntime(runtime, {
        dataKey,
        afterSeqId: oldEvent.seqId,
        consistency: "catch-up",
      }),
    ).resolves.toStrictEqual({
      snapshot: {
        chatThreads: [snapshotThread("new snapshot")],
        latestEventId: expect.any(String),
        latestSeqId: 10,
      },
      events: [currentEvent],
    });
  }
});

test("Report only non-empty tails from a batched chat catch-up", async () => {
  const { runtime } = startRuntime();
  const unchangedThreadId = crypto.randomUUID();
  const updatedThreadId = crypto.randomUUID();
  const updatedRow = chatEventRow(updatedThreadId, 1);
  context.mocks.api(chatThreadEventsContract.catchUp, ({ body, respond }) => {
    expect(body).toStrictEqual([
      [unchangedThreadId, 0],
      [updatedThreadId, 0],
    ]);
    return respond(200, {
      events: {
        [unchangedThreadId]: [],
        [updatedThreadId]: [updatedRow],
      },
      notFoundThreads: [],
    });
  });

  await expect(
    runtime.catchUpChatEvents(
      [unchangedThreadId, updatedThreadId],
      context.signal,
    ),
  ).resolves.toStrictEqual([updatedThreadId]);
  await expect(
    queryRuntime(runtime, {
      dataKey: chatEventKey(unchangedThreadId),
      afterSeqId: null,
      consistency: "cache-only",
    }),
  ).resolves.toStrictEqual([]);
  await expect(
    queryRuntime(runtime, {
      dataKey: chatEventKey(updatedThreadId),
      afterSeqId: null,
      consistency: "cache-only",
    }),
  ).resolves.toStrictEqual([updatedRow]);
});

test("Rebuild a cached chat when batched catch-up cannot continue its cursor", async () => {
  const { runtime } = startRuntime();
  const dataKey = chatEventKey(crypto.randomUUID());
  const cachedRow = chatEventRow(dataKey.threadId, 1);
  const rebuiltRow = chatEventRow(dataKey.threadId, 10);
  const tailRow = chatEventRow(dataKey.threadId, 11);
  let rebuilding = false;

  context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
    if (!rebuilding) {
      return respond(404, {
        error: {
          code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
          message: "Chat event snapshot not found",
        },
      });
    }
    return respond(200, {
      url: SNAPSHOT_URL,
      expiresInSeconds: 900,
      lastEventId: rebuiltRow.id,
      lastSeqId: rebuiltRow.seqId,
    });
  });
  context.mocks.http.get(SNAPSHOT_URL, () => {
    return new Response(snapshotNdjson([rebuiltRow]));
  });
  context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
    return respond(
      200,
      chatEventRowsResponse(rebuilding ? [tailRow] : [cachedRow], query),
    );
  });
  context.mocks.api(chatThreadEventsContract.catchUp, ({ body, respond }) => {
    expect(body).toStrictEqual([[dataKey.threadId, cachedRow.seqId]]);
    return respond(200, {
      events: {},
      notFoundThreads: [dataKey.threadId],
    });
  });

  await queryRuntime(runtime, {
    dataKey,
    afterSeqId: null,
    consistency: "catch-up",
  });
  rebuilding = true;

  await expect(
    runtime.catchUpChatEvents([dataKey.threadId], context.signal),
  ).resolves.toStrictEqual([dataKey.threadId]);
  await expect(
    queryRuntime(runtime, {
      dataKey,
      afterSeqId: null,
      consistency: "cache-only",
    }),
  ).resolves.toStrictEqual([rebuiltRow, tailRow]);
});

test.each(["readonly", "readwrite"] as const)(
  "Serve remote chat data without Sentry reports when IndexedDB %s transactions fail",
  async (mode) => {
    const { runtime } = startRuntime();
    const dataKey = chatEventKey(crypto.randomUUID());
    const remoteRow = chatEventRow(dataKey.threadId, 1);
    const snapshot = {
      chatThreads: [snapshotThread("Available conversation")],
      latestEventId: null,
      latestSeqId: null,
    };
    await queryRuntime(runtime, {
      dataKey,
      afterSeqId: null,
      consistency: "cache-only",
    });
    const transaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
      this: IDBDatabase,
      storeNames,
      transactionMode,
      options,
    ) {
      if (transactionMode === mode) {
        throw new DOMException(
          "Local storage unavailable",
          "InvalidStateError",
        );
      }
      return transaction.call(this, storeNames, transactionMode, options);
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
      return respond(200, chatEventRowsResponse([remoteRow], query));
    });
    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      return respond(200, snapshot);
    });
    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      return respond(200, { events: [], hasMore: false });
    });

    await expect(
      queryRuntime(runtime, {
        dataKey,
        afterSeqId: null,
        consistency: "catch-up",
      }),
    ).resolves.toStrictEqual([remoteRow]);
    await expect(
      queryRuntime(runtime, {
        dataKey: chatThreadEventKey(),
        afterSeqId: null,
        consistency: "catch-up",
      }),
    ).resolves.toStrictEqual({ snapshot, events: [] });
    expect(context.mocks.sentry().reports).toStrictEqual([]);

    context.mocks.api(chatThreadEventsContract.rows, ({ respond }) => {
      return respond(500, {
        error: {
          code: "INTERNAL_ERROR",
          message: "Remote storage unavailable",
        },
      });
    });
    await expect(
      queryRuntime(runtime, {
        dataKey,
        afterSeqId: null,
        consistency: "catch-up",
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(context.mocks.sentry().reports).toMatchObject([
      { type: "exception", error: { status: 500 } },
    ]);
  },
);

test("Continue online when local chat storage becomes unavailable", async () => {
  const currentIdentity = identity();
  const { events, runtime } = startRuntime(currentIdentity);
  const dataKey = chatEventKey(crypto.randomUUID());
  const remoteRow = chatEventRow(dataKey.threadId, 1);
  await queryRuntime(runtime, {
    dataKey,
    afterSeqId: null,
    consistency: "cache-only",
  });
  const upgradedDb = await openDB(
    `vm0-chat-${currentIdentity.userId}-${currentIdentity.orgId}`,
    CHAT_IDB_VERSION + 1,
  );
  context.signal.addEventListener("abort", () => {
    upgradedDb.close();
  });
  await vi.waitFor(() => {
    expect(
      events.filter((event) => {
        return (
          event.type === "worker-unavailable" &&
          event.reason === "indexeddb-version-changed"
        );
      }),
    ).toHaveLength(1);
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
    return respond(200, chatEventRowsResponse([remoteRow], query));
  });

  await expect(
    queryRuntime(runtime, {
      dataKey,
      afterSeqId: null,
      consistency: "catch-up",
    }),
  ).resolves.toStrictEqual([remoteRow]);
  await expect(
    queryRuntime(runtime, {
      dataKey,
      afterSeqId: null,
      consistency: "cache-only",
    }),
  ).resolves.toStrictEqual([]);
  expect(context.mocks.sentry().reports).toStrictEqual([]);
});
