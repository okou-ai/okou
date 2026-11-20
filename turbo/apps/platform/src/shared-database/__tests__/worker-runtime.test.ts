import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  chatThreadsContract,
  chatThreadEventsContract,
  type ChatThreadEvent,
  type ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";

import { expect, test } from "vitest";

import { createAuthedContractClient } from "../../signals/api-client-base.ts";
import type { ApiClientFactory } from "../../signals/api-client.ts";

import {
  mockChatThreadSnapshotResponse,
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
    archived: false,
    renamedAt: null,
    selectedModel: null,
    serviceTier: null,
    computerUseHostId: null,
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

test("treat a headerless 426 from chat event rows as an upgrade request", async () => {
  const { runtime, events } = startRuntime();
  const threadId = crypto.randomUUID();
  context.mocks.http.get("*/api/chat-threads/:threadId/event-rows", () => {
    return Response.json(
      {
        error: {
          code: "CLIENT_UPGRADE_REQUIRED",
          message: "Client update required",
        },
      },
      { status: 426 },
    );
  });
  await expect(
    runtime.query(
      {
        dataKey: chatEventKey(threadId),
        afterSeqId: null,
        consistency: "catch-up",
      },
      context.signal,
    ),
  ).rejects.toMatchObject({
    name: "SharedDatabaseHttpError",
    status: 426,
  });
  expect(events).toContainEqual({
    type: "worker-unavailable",
    reason: "force-upgrade-required",
  });
});

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

test("Load a chat thread snapshot from its presigned object URL", async () => {
  const { runtime } = startRuntime();
  const expected = {
    chatThreads: [snapshotThread("Stored in R2")],
    latestEventId: null,
    latestSeqId: null,
  };
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      url: SNAPSHOT_URL,
      expiresInSeconds: 900,
      latestEventId: null,
      latestSeqId: null,
    });
  });
  context.mocks.http.get(SNAPSHOT_URL, () => {
    return new Response(JSON.stringify({ chatThreads: expected.chatThreads }));
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });

  await expect(
    queryRuntime(runtime, {
      dataKey: chatThreadEventKey(),
      afterSeqId: null,
      consistency: "catch-up",
    }),
  ).resolves.toStrictEqual({ snapshot: expected, events: [] });
  await expect(
    queryRuntime(runtime, {
      dataKey: chatThreadEventKey(),
      afterSeqId: null,
      consistency: "cache-only",
    }),
  ).resolves.toStrictEqual({ snapshot: expected, events: [] });
});

test("Rebuild chat data after its saved cursor expires", async () => {
  {
    const { runtime } = startRuntime();
    const dataKey = chatEventKey(crypto.randomUUID());
    const oldRow = chatEventRow(dataKey.threadId, 1);
    const rebuiltRow = chatEventRow(dataKey.threadId, 10);
    const tailRow = chatEventRow(dataKey.threadId, 11);
    let expired = false;
    context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
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
    });
    context.mocks.http.get(SNAPSHOT_URL, () => {
      return new Response(snapshotNdjson([rebuiltRow]));
    });
    let returnedExpiry = false;
    context.mocks.api(
      chatThreadEventsContract.rows,
      ({ query, query: requestQuery, respond }) => {
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
      return respond(
        200,
        mockChatThreadSnapshotResponse(context, {
          chatThreads: [
            snapshotThread(current ? "old snapshot" : "new snapshot"),
          ],
          latestEventId: crypto.randomUUID(),
          latestSeqId: current ? 1 : 10,
        }),
      );
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

test("Project metadata recovers an expired cursor, reopens offline and stays owner scoped", async () => {
  const project = {
    id: "30000000-0000-4000-8000-000000000071",
    name: "Launch",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
  let refresh = false;
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects: [{ ...project, name: refresh ? "New name" : project.name }],
      latestEventId: null,
      latestSeqId: refresh ? 5 : 1,
    });
  });
  context.mocks.api(projectsContract.events, ({ query, respond }) => {
    if (refresh && query.sinceSeqId === 1) {
      return respond(410, {
        error: { code: "PROJECT_EVENTS_EXPIRED", message: "Refresh snapshot" },
      });
    }
    return respond(200, { events: [], hasMore: false });
  });
  const owner = identity();
  const first = startRuntime(owner).runtime;
  const query = {
    dataKey: { kind: "project-event" as const },
    afterSeqId: null,
    consistency: "catch-up" as const,
  };
  expect((await queryRuntime(first, query)).snapshot?.projects).toStrictEqual([
    project,
  ]);
  refresh = true;
  expect((await queryRuntime(first, query)).snapshot?.projects[0]?.name).toBe(
    "New name",
  );
  const reopened = startRuntime(owner).runtime;
  expect(
    (await queryRuntime(reopened, { ...query, consistency: "cache-only" }))
      .snapshot?.latestSeqId,
  ).toBe(5);
  const peer = startRuntime(
    identity({ userId: owner.userId + "-peer" }),
  ).runtime;
  await expect(
    queryRuntime(peer, { ...query, consistency: "cache-only" }),
  ).resolves.toStrictEqual({ snapshot: null, events: [] });
});
