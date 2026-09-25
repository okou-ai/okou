import { fetchResource } from "../lib/resource-fetch.ts";
import {
  chatThreadsContract,
  chatThreadEventsContract,
  chatThreadSnapshotArchiveSchema,
  type ChatThreadEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import type { ChatEventCursor } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { CLIENT_FORCE_UPGRADE_STATUS } from "@okouai/api-contracts/contracts/client-headers";
import type {
  AppRouter,
  InitClientArgs,
  InitClientReturn,
} from "@okouai/api-contracts/contracts/trpc-contract";
import type { IDBPDatabase } from "idb";

import {
  captureSentryLogError,
  sentryLogContext,
} from "../lib/sentry-config.ts";
import { now } from "../lib/time.ts";
import { createChatIdbOpener } from "../signals/external/chat-idb-opener.ts";
import { createIdbDiagnosticsStore } from "../signals/external/idb-diagnostics-store.ts";
import { createIdbEventRowStores } from "../signals/external/idb-event-row-store.ts";
import { createStrictIdbChatThreadEventStores } from "../signals/external/idb-chat-thread-event-store.ts";
import type { ApiClientFactory } from "../signals/api-client.ts";
import { logger } from "../signals/log.ts";
import { isAbortError, settle } from "../signals/utils.ts";
import {
  scopeSharedDatabaseDataKey,
  type ChatEventDataKey,
  type ChatThreadEventDataKey,
  type ChatThreadEventQueryResult,
  type SharedDatabaseDataKey,
  type SharedDatabaseIdentity,
  type SharedDatabaseQuery,
  type SharedDatabaseQueryResult,
  type ScopedChatEventDataKey,
  type ScopedChatThreadEventDataKey,
  type ScopedSharedDatabaseDataKey,
} from "./data-key.ts";
import type {
  IndexedDbDiagnostics,
  IndexedDbSnapshotMeasurement,
} from "./computed-key.ts";
import { CHAT_THREAD_EVENT_LOG_SNAPSHOT_REBASE_THRESHOLD } from "./event-log-policy.ts";
import {
  assertChatEventSchemaVersion,
  CHAT_EVENT_SCHEMA_VERSION_HEADERS,
} from "./chat-event-schema-version.ts";
import type { SharedDatabaseWorkerMessage } from "./protocol.ts";
import { SharedDatabaseHttpError } from "./http-error.ts";
type SharedDatabaseContractClient<TContract extends AppRouter> =
  InitClientReturn<TContract, InitClientArgs>;

const CHAT_EVENT_ROWS_PAGE_LIMIT = 50;
const THREAD_START_SEQ_ID = 0;
const L = logger("SharedDatabaseWorker");

function chatEventRowsQuery(cursor: ChatEventCursor) {
  return cursor.lastEventId === null
    ? {
        sinceSeqId: cursor.lastSeqId,
        limit: CHAT_EVENT_ROWS_PAGE_LIMIT,
      }
    : {
        sinceSeqId: cursor.lastSeqId,
        sinceEventId: cursor.lastEventId,
        limit: CHAT_EVENT_ROWS_PAGE_LIMIT,
      };
}

type WorkerRuntimeEvent = Extract<
  SharedDatabaseWorkerMessage,
  { readonly type: "worker-unavailable" }
>;

type ChatEventContractClient = SharedDatabaseContractClient<
  typeof chatThreadEventsContract
>;

interface ChatEventRemoteState {
  readonly remoteRows: readonly ChatEventRow[];
  readonly cursor: ChatEventCursor;
  readonly cursorFromServer: boolean;
  readonly needsColdStartTailConfirmation: boolean;
  readonly replacedCache: boolean;
}

interface ChatEventRemoteContext {
  readonly client: ChatEventContractClient;
  readonly dataKey: ScopedChatEventDataKey;
}

interface ChatThreadEventRemoteState {
  readonly result: ChatThreadEventQueryResult;
  readonly cursor: { readonly eventId: string; readonly seqId: number } | null;
  readonly replacement: boolean;
  readonly cursorFromServerSnapshot: boolean;
  readonly newEvents: readonly ChatThreadEvent[];
}

interface ChatThreadEventRemoteContext {
  readonly client: SharedDatabaseContractClient<typeof chatThreadsContract>;
}

interface ChatDatabaseEntry {
  readonly promise: Promise<IDBPDatabase>;
  database: IDBPDatabase | null;
  invalidated: boolean;
}

interface ChatThreadEventCache {
  readonly result: ChatThreadEventQueryResult;
  readonly degraded: boolean;
}

interface ChatEventBatchWrite {
  readonly dataKey: ScopedChatEventDataKey;
  readonly rows: readonly ChatEventRow[];
  readonly cursor: ChatEventCursor;
}

interface SharedDatabaseWorkerRuntimeOptions {
  readonly identity: SharedDatabaseIdentity;
  readonly emit: (message: WorkerRuntimeEvent) => void;
  readonly createContractClient: ApiClientFactory;
}

class ChatThreadNotFoundError extends Error {
  constructor() {
    super("Chat thread not found");
    this.name = "ChatThreadNotFoundError";
  }
}

function dataKeyDiagnosticDetails(dataKey: ScopedSharedDatabaseDataKey): {
  readonly dataset: ScopedSharedDatabaseDataKey["kind"];
  readonly orgId: string;
  readonly userId: string;
} {
  return {
    dataset: dataKey.kind,
    orgId: dataKey.orgId,
    userId: dataKey.userId,
  };
}

function isRecoverableChatIdbTransactionError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "UnknownError" ||
      error.name === "TransactionInactiveError" ||
      error.name === "InvalidStateError")
  );
}

function logDataKeyError(
  dataKey: ScopedSharedDatabaseDataKey,
  operation: string,
  error: unknown,
): void {
  L.debug(operation, { ...dataKeyDiagnosticDetails(dataKey), error });
}

function reportDataKeyError(
  dataKey: ScopedSharedDatabaseDataKey,
  operation: string,
  error: unknown,
): void {
  logDataKeyError(dataKey, operation, error);
  if (isAbortError(error)) {
    return;
  }
  const details = dataKeyDiagnosticDetails(dataKey);
  const context = sentryLogContext({
    contexts: {
      shared_database: { org_id: dataKey.orgId },
      ...(error instanceof SharedDatabaseHttpError
        ? { response: { status_code: error.status } }
        : {}),
    },
    tags: {
      "shared_database.dataset": dataKey.kind,
      "shared_database.operation": operation,
    },
    user: { id: dataKey.userId },
  });
  captureSentryLogError("SharedDatabaseWorker", [
    operation,
    error,
    details,
    context,
  ]);
}

function mergeChatEventRows(
  rowSets: readonly (readonly ChatEventRow[])[],
): ChatEventRow[] {
  const byId = new Map<string, ChatEventRow>();
  for (const rows of rowSets) {
    for (const row of rows) {
      byId.set(row.id, row);
    }
  }
  return Array.from(byId.values()).sort((left, right) => {
    return left.seqId - right.seqId;
  });
}

function requireChatEventCursor(
  cursors: ReadonlyMap<string, ChatEventCursor>,
  threadId: string,
): ChatEventCursor {
  const cursor = cursors.get(threadId);
  if (!cursor) {
    throw new Error("ChatEvent catch-up cursor is missing");
  }
  return cursor;
}

function chatThreadEventCursor(
  result: ChatThreadEventQueryResult,
): { readonly eventId: string; readonly seqId: number } | null {
  const event = result.events.at(-1);
  if (event) {
    return { eventId: event.id, seqId: event.seqId };
  }
  const snapshot = result.snapshot;
  if (
    !snapshot ||
    snapshot.latestEventId === null ||
    snapshot.latestSeqId === null
  ) {
    return null;
  }
  return {
    eventId: snapshot.latestEventId,
    seqId: snapshot.latestSeqId,
  };
}

export class SharedDatabaseWorkerRuntime {
  private readonly identity: SharedDatabaseIdentity;
  private databaseEntry: ChatDatabaseEntry | null = null;
  private readonly emit: (message: WorkerRuntimeEvent) => void;
  private readonly createContractClient: ApiClientFactory;

  constructor(
    options: SharedDatabaseWorkerRuntimeOptions,
    rootSignal: AbortSignal,
  ) {
    const { identity, emit, createContractClient } = options;
    this.emit = emit;
    this.createContractClient = createContractClient;
    this.identity = {
      userId: identity.userId,
      orgId: identity.orgId,
    };
    rootSignal.addEventListener(
      "abort",
      () => {
        L.debug("runtime.abort", {
          orgId: this.identity.orgId,
          userId: this.identity.userId,
        });
        this.databaseEntry?.database?.close();
        this.databaseEntry = null;
      },
      { once: true },
    );
  }

  async query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    signal.throwIfAborted();
    const dataKey = scopeSharedDatabaseDataKey(query.dataKey, this.identity);
    const startedAt = now();
    const result = await settle(this.queryData(query, dataKey, signal), signal);
    if (!result.ok) {
      reportDataKeyError(dataKey, "query.error", result.error);
      throw result.error;
    }
    L.debug("query.finish", {
      ...dataKeyDiagnosticDetails(dataKey),
      durationMs: now() - startedAt,
    });
    return result.value;
  }

  async getIndexedDbDiagnostics(
    signal: AbortSignal,
  ): Promise<IndexedDbDiagnostics> {
    return await this.runChatIdbOperation(
      createIdbDiagnosticsStore,
      (store) => {
        return store.read(signal);
      },
      signal,
    );
  }

  async measureIndexedDbSnapshot(
    signal: AbortSignal,
  ): Promise<IndexedDbSnapshotMeasurement | null> {
    return await this.runChatIdbOperation(
      createIdbDiagnosticsStore,
      (store) => {
        return store.measureSnapshot(signal);
      },
      signal,
    );
  }

  async catchUpChatEvents(
    requestedThreadIds: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly string[]> {
    signal.throwIfAborted();
    const threadIds = [...new Set(requestedThreadIds)];
    if (threadIds.length === 0) {
      return [];
    }
    const dataKeys = threadIds.map((threadId) => {
      return scopeSharedDatabaseDataKey(
        { kind: "chat-event", threadId },
        this.identity,
      );
    });
    const diagnosticDataKey = dataKeys[0];
    if (!diagnosticDataKey) {
      throw new Error("ChatEvent catch-up requires a diagnostic data key");
    }
    const cachedCursorsResult = await settle(
      this.runChatIdbOperation(
        createIdbEventRowStores,
        (stores) => {
          return stores.readStore.readCursors(threadIds, signal);
        },
        signal,
      ),
      signal,
    );
    if (!cachedCursorsResult.ok) {
      logDataKeyError(
        diagnosticDataKey,
        "indexeddb.chat-event-cursors.read.error",
        cachedCursorsResult.error,
      );
    }
    const cachedCursors = cachedCursorsResult.ok
      ? cachedCursorsResult.value
      : new Map<string, ChatEventCursor>();
    const cursors = new Map<string, ChatEventCursor>(
      threadIds.map((threadId) => {
        const cursor: ChatEventCursor = cachedCursors.get(threadId) ?? {
          lastEventId: null,
          lastSeqId: THREAD_START_SEQ_ID,
        };
        return [threadId, cursor] as const;
      }),
    );

    const client = this.createContractClient(chatThreadEventsContract);
    const response = await client.catchUp({
      headers: CHAT_EVENT_SCHEMA_VERSION_HEADERS,
      body: threadIds.map((threadId) => {
        return [threadId, requireChatEventCursor(cursors, threadId).lastSeqId];
      }),
      fetchOptions: { signal },
    });
    signal.throwIfAborted();
    if (
      response.status === 401 ||
      response.status === CLIENT_FORCE_UPGRADE_STATUS
    ) {
      throw new SharedDatabaseHttpError(response.status);
    }
    assertChatEventSchemaVersion(response.headers);
    if (response.status !== 200) {
      throw new SharedDatabaseHttpError(response.status);
    }
    this.assertChatEventCatchUpPartition(
      threadIds,
      cursors,
      response.body.events,
      response.body.notFoundThreads,
    );

    const writes: ChatEventBatchWrite[] = Object.entries(
      response.body.events,
    ).flatMap(([threadId, rows]) => {
      const last = rows.at(-1);
      return last === undefined
        ? []
        : [
            {
              dataKey: scopeSharedDatabaseDataKey(
                { kind: "chat-event", threadId },
                this.identity,
              ),
              rows,
              cursor: { lastEventId: last.id, lastSeqId: last.seqId },
            },
          ];
    });
    const batchWritten = await this.persistChatEventBatch(writes, signal);
    const rebuiltThreadIds = await Promise.all(
      response.body.notFoundThreads.map(async (threadId) => {
        const dataKey = scopeSharedDatabaseDataKey(
          { kind: "chat-event", threadId },
          this.identity,
        );
        const rebuilt = await this.replaceChatEventsFromSnapshot(
          client,
          dataKey,
          signal,
        );
        return rebuilt ? threadId : null;
      }),
    );
    return [
      ...(batchWritten
        ? writes.map(({ dataKey }) => {
            return dataKey.threadId;
          })
        : []),
      ...rebuiltThreadIds.filter((threadId) => {
        return threadId !== null;
      }),
    ];
  }

  private assertChatEventCatchUpPartition(
    threadIds: readonly string[],
    cursors: ReadonlyMap<string, ChatEventCursor>,
    events: Readonly<Record<string, readonly ChatEventRow[]>>,
    notFoundThreads: readonly string[],
  ): void {
    const requested = new Set(threadIds);
    const notFound = new Set(notFoundThreads);
    if (notFound.size !== notFoundThreads.length) {
      throw new Error("ChatEvent catch-up returned duplicate missing threads");
    }
    for (const threadId of notFound) {
      if (!requested.has(threadId)) {
        throw new Error(
          "ChatEvent catch-up returned an unknown missing thread",
        );
      }
    }
    for (const [threadId, rows] of Object.entries(events)) {
      if (!requested.has(threadId) || notFound.has(threadId)) {
        throw new Error(
          "ChatEvent catch-up returned an invalid event partition",
        );
      }
      let lastSeqId = requireChatEventCursor(cursors, threadId).lastSeqId;
      for (const row of rows) {
        if (row.chatThreadId !== threadId || row.seqId <= lastSeqId) {
          throw new Error("ChatEvent catch-up returned an invalid event tail");
        }
        lastSeqId = row.seqId;
      }
    }
    for (const threadId of requested) {
      if (!Object.hasOwn(events, threadId) && !notFound.has(threadId)) {
        throw new Error("ChatEvent catch-up response is incomplete");
      }
    }
  }

  private async persistChatEventBatch(
    writes: readonly ChatEventBatchWrite[],
    signal: AbortSignal,
  ): Promise<boolean> {
    if (writes.length === 0) {
      return true;
    }
    const written = await settle(
      this.runChatIdbOperation(
        createIdbEventRowStores,
        (stores) => {
          return stores.writeStore.upsertRowsAndCursors(
            writes.map(({ dataKey, rows, cursor }) => {
              return { threadId: dataKey.threadId, rows, cursor };
            }),
            signal,
          );
        },
        signal,
      ),
      signal,
    );
    if (!written.ok) {
      const firstWrite = writes[0];
      if (!firstWrite) {
        throw new Error("ChatEvent batch write diagnostic is missing");
      }
      logDataKeyError(
        firstWrite.dataKey,
        "indexeddb.chat-event-batch.write.error",
        written.error,
      );
      return false;
    }
    return true;
  }

  private async replaceChatEventsFromSnapshot(
    client: ChatEventContractClient,
    dataKey: ScopedChatEventDataKey,
    signal: AbortSignal,
  ): Promise<boolean> {
    const snapshot = await settle(
      this.fetchChatEventSnapshot(client, dataKey, signal),
      signal,
    );
    if (!snapshot.ok) {
      if (snapshot.error instanceof ChatThreadNotFoundError) {
        return await this.clearChatEventCache(dataKey, signal);
      }
      throw snapshot.error;
    }
    const state = await settle(
      this.fetchChatEventRows(
        { client, dataKey },
        {
          remoteRows: snapshot.value.rows,
          cursor: snapshot.value.cursor,
          cursorFromServer: true,
          needsColdStartTailConfirmation: true,
          replacedCache: true,
        },
        signal,
      ),
      signal,
    );
    if (!state.ok) {
      if (
        state.error instanceof SharedDatabaseHttpError &&
        state.error.status === 404
      ) {
        return await this.clearChatEventCache(dataKey, signal);
      }
      throw state.error;
    }
    return await this.persistChatEventRows(dataKey, state.value, signal);
  }

  private async clearChatEventCache(
    dataKey: ScopedChatEventDataKey,
    signal: AbortSignal,
  ): Promise<boolean> {
    const cleared = await settle(
      this.runChatIdbOperation(
        createIdbEventRowStores,
        (stores) => {
          return stores.writeStore.clearThread(dataKey.threadId, signal);
        },
        signal,
      ),
      signal,
    );
    if (!cleared.ok) {
      logDataKeyError(
        dataKey,
        "indexeddb.chat-event.clear.error",
        cleared.error,
      );
      return false;
    }
    return true;
  }

  private async queryData<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    dataKey: ScopedSharedDatabaseDataKey,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    if (query.dataKey.kind === "chat-event" && dataKey.kind === "chat-event") {
      const result = await this.queryChatEvents(
        dataKey,
        query.afterSeqId,
        query.consistency,
        signal,
      );
      return result as SharedDatabaseQueryResult<TKey>;
    }
    if (dataKey.kind !== "chat-thread-event") {
      throw new Error("Shared database query data key is invalid");
    }
    const result = await this.queryChatThreadEvents(
      dataKey,
      query.consistency,
      signal,
    );
    return result as SharedDatabaseQueryResult<TKey>;
  }

  private async queryChatEvents(
    dataKey: ScopedChatEventDataKey,
    afterSeqId: number | null,
    consistency: SharedDatabaseQuery<ChatEventDataKey>["consistency"],
    signal: AbortSignal,
  ): Promise<ChatEventRow[]> {
    if (consistency === "cache-only") {
      return await this.readChatEventCache(dataKey, afterSeqId, signal);
    }
    const remoteRows = await this.syncChatEvents(dataKey, signal);
    signal.throwIfAborted();
    const cached = await this.readChatEventCache(dataKey, afterSeqId, signal);
    const requestedRemoteRows = remoteRows.filter((row) => {
      return afterSeqId === null || row.seqId > afterSeqId;
    });
    return mergeChatEventRows([cached, requestedRemoteRows]);
  }

  private async queryChatThreadEvents(
    dataKey: ScopedChatThreadEventDataKey,
    consistency: SharedDatabaseQuery<ChatThreadEventDataKey>["consistency"],
    signal: AbortSignal,
  ): Promise<ChatThreadEventQueryResult> {
    if (consistency === "cache-only") {
      return (await this.readChatThreadEventCache(dataKey, signal)).result;
    }
    return await this.syncChatThreadEvents(dataKey, signal);
  }

  private async syncChatEvents(
    dataKey: ScopedChatEventDataKey,
    signal: AbortSignal,
  ): Promise<readonly ChatEventRow[]> {
    const cachedCursorResult = await settle(
      this.runChatIdbOperation(
        createIdbEventRowStores,
        (stores) => {
          return stores.readStore.readCursor(dataKey.threadId, signal);
        },
        signal,
      ),
      signal,
    );
    const cachedCursor = cachedCursorResult.ok
      ? cachedCursorResult.value
      : null;
    if (!cachedCursorResult.ok) {
      logDataKeyError(
        dataKey,
        "indexeddb.chat-event-cursor.read.error",
        cachedCursorResult.error,
      );
    }

    const client = this.createContractClient(chatThreadEventsContract);

    let state: ChatEventRemoteState = {
      remoteRows: [],
      cursor: cachedCursor ?? {
        lastEventId: null,
        lastSeqId: THREAD_START_SEQ_ID,
      },
      cursorFromServer: false,
      needsColdStartTailConfirmation: false,
      replacedCache: false,
    };

    if (cachedCursor === null || !cachedCursorResult.ok) {
      const snapshot = await this.fetchChatEventSnapshot(
        client,
        dataKey,
        signal,
      );
      state = {
        remoteRows: snapshot.rows,
        cursor: snapshot.cursor,
        cursorFromServer: true,
        needsColdStartTailConfirmation: true,
        replacedCache: true,
      };
    }
    state = await this.fetchChatEventRows({ client, dataKey }, state, signal);
    await this.persistChatEventRows(dataKey, state, signal);
    return state.remoteRows;
  }

  private async persistChatEventRows(
    dataKey: ScopedChatEventDataKey,
    state: ChatEventRemoteState,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!state.replacedCache && state.remoteRows.length === 0) {
      return false;
    }
    const written = await settle(
      this.runChatIdbOperation(
        createIdbEventRowStores,
        (stores) => {
          return state.replacedCache
            ? stores.writeStore.replaceRowsAndCursor(
                dataKey.threadId,
                state.remoteRows,
                state.cursor,
                signal,
              )
            : stores.writeStore.upsertRowsAndCursor(
                dataKey.threadId,
                state.remoteRows,
                state.cursor,
                signal,
              );
        },
        signal,
      ),
      signal,
    );
    if (!written.ok) {
      logDataKeyError(
        dataKey,
        "indexeddb.chat-event.write.error",
        written.error,
      );
      return false;
    }
    return true;
  }

  private async fetchChatEventRows(
    context: ChatEventRemoteContext,
    initialState: ChatEventRemoteState,
    signal: AbortSignal,
  ): Promise<ChatEventRemoteState> {
    const { client, dataKey } = context;
    let remoteRows = [...initialState.remoteRows];
    let cursor = initialState.cursor;
    let cursorFromServer = initialState.cursorFromServer;
    let needsColdStartTailConfirmation =
      initialState.needsColdStartTailConfirmation;
    let replacedCache = initialState.replacedCache;
    let loadNextPage = true;
    while (loadNextPage) {
      const page = await client.rows({
        headers: CHAT_EVENT_SCHEMA_VERSION_HEADERS,
        params: { threadId: dataKey.threadId },
        query: chatEventRowsQuery(cursor),
        fetchOptions: { signal },
      });
      signal.throwIfAborted();
      if (page.status === 401 || page.status === CLIENT_FORCE_UPGRADE_STATUS) {
        throw new SharedDatabaseHttpError(page.status);
      }
      assertChatEventSchemaVersion(page.headers);
      if (page.status === 410) {
        if (cursorFromServer) {
          throw new Error(
            "ChatEvent cursor expired immediately after a server snapshot",
          );
        }
        const snapshot = await this.fetchChatEventSnapshot(
          client,
          dataKey,
          signal,
        );
        remoteRows = [...snapshot.rows];
        cursor = snapshot.cursor;
        cursorFromServer = true;
        needsColdStartTailConfirmation = true;
        replacedCache = true;
        continue;
      }
      if (page.status !== 200) {
        throw new SharedDatabaseHttpError(page.status);
      }
      remoteRows = mergeChatEventRows([remoteRows, page.body.rows]);
      cursor = page.body.cursor;
      const confirmColdStartTail = needsColdStartTailConfirmation;
      needsColdStartTailConfirmation = false;
      loadNextPage = confirmColdStartTail || page.body.hasMore;
    }
    return {
      remoteRows,
      cursor,
      cursorFromServer,
      needsColdStartTailConfirmation,
      replacedCache,
    };
  }

  private async fetchChatEventSnapshot(
    client: ChatEventContractClient,
    dataKey: ScopedChatEventDataKey,
    signal: AbortSignal,
  ): Promise<{
    readonly rows: readonly ChatEventRow[];
    readonly cursor: ChatEventCursor;
  }> {
    const snapshot = await client.snapshot({
      headers: CHAT_EVENT_SCHEMA_VERSION_HEADERS,
      params: { threadId: dataKey.threadId },
      fetchOptions: { signal },
    });
    signal.throwIfAborted();
    if (
      snapshot.status === 401 ||
      snapshot.status === CLIENT_FORCE_UPGRADE_STATUS
    ) {
      throw new SharedDatabaseHttpError(snapshot.status);
    }
    assertChatEventSchemaVersion(snapshot.headers);
    if (snapshot.status === 404) {
      if (snapshot.body.error.code !== "CHAT_EVENT_SNAPSHOT_NOT_FOUND") {
        throw new ChatThreadNotFoundError();
      }
      return {
        rows: [],
        cursor: { lastEventId: null, lastSeqId: THREAD_START_SEQ_ID },
      };
    }
    if (snapshot.status !== 200) {
      throw new SharedDatabaseHttpError(snapshot.status);
    }
    const response = await fetchResource(snapshot.body.url, {}, signal);
    if (!response.ok) {
      throw new SharedDatabaseHttpError(response.status);
    }
    const text = await response.text();
    signal.throwIfAborted();
    if (text.length > 0 && !text.endsWith("\n")) {
      throw new Error("ChatEvent snapshot must be newline-delimited JSON");
    }
    const rows =
      text.length === 0
        ? []
        : text
            .slice(0, -1)
            .split("\n")
            .map((line) => {
              const parsed: unknown = JSON.parse(line);
              return chatEventRowSchema.parse(parsed);
            });
    return {
      rows,
      cursor:
        snapshot.body.lastEventId === null
          ? { lastEventId: null, lastSeqId: THREAD_START_SEQ_ID }
          : {
              lastEventId: snapshot.body.lastEventId,
              lastSeqId: snapshot.body.lastSeqId,
            },
    };
  }

  private async syncChatThreadEvents(
    dataKey: ScopedChatThreadEventDataKey,
    signal: AbortSignal,
  ): Promise<ChatThreadEventQueryResult> {
    const cached = await this.readChatThreadEventCache(dataKey, signal);
    const client = this.createContractClient(chatThreadsContract);
    const cachedCursor = chatThreadEventCursor(cached.result);
    let state: ChatThreadEventRemoteState = {
      result: cached.result,
      cursor: cachedCursor,
      replacement: false,
      cursorFromServerSnapshot: false,
      newEvents: [],
    };

    if (
      cached.result.snapshot === null ||
      cachedCursor === null ||
      cached.degraded
    ) {
      const result = {
        snapshot: await this.fetchChatThreadSnapshot(client, signal),
        events: [],
      };
      state = {
        result,
        cursor: chatThreadEventCursor(result),
        replacement: true,
        cursorFromServerSnapshot: true,
        newEvents: [],
      };
    }

    const remoteContext = { client };
    state = await this.loadChatThreadEventTail(remoteContext, state, signal);
    state = await this.maybeRebaseChatThreadEventSnapshot(
      dataKey,
      remoteContext,
      state,
      signal,
    );

    const shouldWrite = state.replacement || state.newEvents.length > 0;
    if (shouldWrite) {
      const snapshot = state.result.snapshot;
      if (!snapshot) {
        throw new Error("ChatThreadEvent synchronization requires a snapshot");
      }
      const written = await settle(
        this.runChatIdbOperation(
          createStrictIdbChatThreadEventStores,
          (stores) => {
            return state.replacement
              ? stores.writeStore.replaceFromSnapshot(
                  {
                    chatThreads: snapshot.chatThreads,
                    latestEventId: snapshot.latestEventId,
                    latestSeqId: snapshot.latestSeqId,
                  },
                  state.result.events,
                  signal,
                )
              : stores.writeStore.upsertEvents(state.newEvents, signal);
          },
          signal,
        ),
        signal,
      );
      if (!written.ok) {
        logDataKeyError(
          dataKey,
          "indexeddb.chat-thread-event.write.error",
          written.error,
        );
      }
    }
    return state.result;
  }

  private async loadChatThreadEventTail(
    context: ChatThreadEventRemoteContext,
    initialState: ChatThreadEventRemoteState,
    signal: AbortSignal,
  ): Promise<ChatThreadEventRemoteState> {
    const { client } = context;
    let state = initialState;
    let hasMore = true;
    while (hasMore) {
      const page = await client.events({
        query: state.cursor ? { sinceSeqId: state.cursor.seqId } : {},
        fetchOptions: { signal },
      });
      signal.throwIfAborted();
      if (page.status === 410) {
        if (state.cursorFromServerSnapshot) {
          throw new Error(
            "ChatThreadEvent cursor expired immediately after a server snapshot",
          );
        }
        const result = {
          snapshot: await this.fetchChatThreadSnapshot(client, signal),
          events: [],
        };
        state = {
          result,
          cursor: chatThreadEventCursor(result),
          replacement: true,
          cursorFromServerSnapshot: true,
          newEvents: [],
        };
        continue;
      }
      if (page.status !== 200) {
        throw new SharedDatabaseHttpError(page.status);
      }
      const pageEvents = page.body.events.filter((event) => {
        return state.cursor === null || event.seqId > state.cursor.seqId;
      });
      if (pageEvents.length > 0) {
        const lastEvent = pageEvents.at(-1)!;
        state = {
          result: {
            snapshot: state.result.snapshot,
            events: [...state.result.events, ...pageEvents],
          },
          cursor: { eventId: lastEvent.id, seqId: lastEvent.seqId },
          replacement: state.replacement,
          cursorFromServerSnapshot: false,
          newEvents: [...state.newEvents, ...pageEvents],
        };
      }
      hasMore = page.body.hasMore && page.body.events.length > 0;
    }
    return state;
  }

  private async maybeRebaseChatThreadEventSnapshot(
    dataKey: ScopedChatThreadEventDataKey,
    context: ChatThreadEventRemoteContext,
    state: ChatThreadEventRemoteState,
    signal: AbortSignal,
  ): Promise<ChatThreadEventRemoteState> {
    if (
      state.replacement ||
      state.result.events.length <=
        CHAT_THREAD_EVENT_LOG_SNAPSHOT_REBASE_THRESHOLD
    ) {
      return state;
    }
    const rebasedSnapshot = await settle(
      this.fetchChatThreadSnapshot(context.client, signal),
      signal,
    );
    if (!rebasedSnapshot.ok) {
      if (
        rebasedSnapshot.error instanceof SharedDatabaseHttpError &&
        rebasedSnapshot.error.status === 401
      ) {
        throw rebasedSnapshot.error;
      }
      L.debug("snapshot-rebase.skip", {
        ...dataKeyDiagnosticDetails(dataKey),
        error: rebasedSnapshot.error,
      });
      return state;
    }
    const result = { snapshot: rebasedSnapshot.value, events: [] };
    return await this.loadChatThreadEventTail(
      context,
      {
        result,
        cursor: chatThreadEventCursor(result),
        replacement: true,
        cursorFromServerSnapshot: true,
        newEvents: [],
      },
      signal,
    );
  }

  private async fetchChatThreadSnapshot(
    client: SharedDatabaseContractClient<typeof chatThreadsContract>,
    signal: AbortSignal,
  ): Promise<NonNullable<ChatThreadEventQueryResult["snapshot"]>> {
    const snapshot = await client.snapshot({ fetchOptions: { signal } });
    signal.throwIfAborted();
    if (snapshot.status !== 200) {
      throw new SharedDatabaseHttpError(snapshot.status);
    }
    if ("chatThreads" in snapshot.body) {
      // A rollback-window API can still return an inline snapshot. The current
      // API returns this shape only for a scope without a snapshot row.
      return snapshot.body;
    }
    const response = await fetchResource(snapshot.body.url, {}, signal);
    if (!response.ok) {
      throw new SharedDatabaseHttpError(response.status);
    }
    const archive = chatThreadSnapshotArchiveSchema.parse(
      await response.json(),
    );
    signal.throwIfAborted();
    return {
      chatThreads: archive.chatThreads,
      latestEventId: snapshot.body.latestEventId,
      latestSeqId: snapshot.body.latestSeqId,
    };
  }

  private async readChatEventCache(
    dataKey: ScopedChatEventDataKey,
    afterSeqId: number | null,
    signal: AbortSignal,
  ): Promise<ChatEventRow[]> {
    const result = await settle(
      this.runChatIdbOperation(
        createIdbEventRowStores,
        (stores) => {
          return stores.readStore.readRowsAfter(
            dataKey.threadId,
            afterSeqId,
            signal,
          );
        },
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      logDataKeyError(dataKey, "indexeddb.chat-event.read.error", result.error);
      return [];
    }
    return result.value;
  }

  private async readChatThreadEventCache(
    dataKey: ScopedChatThreadEventDataKey,
    signal: AbortSignal,
  ): Promise<ChatThreadEventCache> {
    const result = await settle(
      this.runChatIdbOperation(
        createStrictIdbChatThreadEventStores,
        (stores) => {
          return Promise.all([
            stores.readStore.readSnapshot(signal),
            stores.readStore.readEventLog(signal),
          ]);
        },
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      logDataKeyError(
        dataKey,
        "indexeddb.chat-thread-event.read.error",
        result.error,
      );
      return {
        result: { snapshot: null, events: [] },
        degraded: true,
      };
    }
    const [snapshot, eventLog] = result.value;
    return {
      result: {
        snapshot:
          snapshot === null
            ? null
            : {
                chatThreads: [...snapshot.chatThreads],
                latestEventId: snapshot.latestEventId,
                latestSeqId: snapshot.latestSeqId,
              },
        events: [...eventLog.events],
      },
      degraded: false,
    };
  }

  private async runChatIdbOperation<TStores, TResult>(
    createStores: (getDatabase: () => Promise<IDBPDatabase>) => TStores,
    operation: (stores: TStores) => Promise<TResult>,
    signal: AbortSignal,
  ): Promise<TResult> {
    const run = (database: IDBPDatabase): Promise<TResult> => {
      return operation(
        createStores(() => {
          return Promise.resolve(database);
        }),
      );
    };
    const firstConnection = await this.getDatabaseConnection(signal);
    const firstResult = await settle(run(firstConnection.database), signal);
    if (firstResult.ok) {
      return firstResult.value;
    }
    if (!isRecoverableChatIdbTransactionError(firstResult.error)) {
      throw firstResult.error;
    }
    this.discardDatabase(firstConnection.entry);
    const retryConnection = await this.getDatabaseConnection(signal);
    const retryResult = await settle(run(retryConnection.database), signal);
    if (retryResult.ok) {
      return retryResult.value;
    }
    if (isRecoverableChatIdbTransactionError(retryResult.error)) {
      this.discardDatabase(retryConnection.entry);
    }
    throw retryResult.error;
  }

  private discardDatabase(entry: ChatDatabaseEntry): void {
    if (this.databaseEntry !== entry) {
      return;
    }
    entry.database?.close();
    this.databaseEntry = null;
  }

  private async getDatabaseConnection(signal: AbortSignal): Promise<{
    readonly entry: ChatDatabaseEntry;
    readonly database: IDBPDatabase;
  }> {
    let entry = this.databaseEntry;
    if (!entry) {
      const opener = createChatIdbOpener({
        onVersionChange: () => {
          if (this.databaseEntry) {
            this.databaseEntry.invalidated = true;
          }
          this.emit({
            type: "worker-unavailable",
            reason: "indexeddb-version-changed",
          });
        },
      });
      const nextEntry: ChatDatabaseEntry = {
        promise: opener.openChatIdb(this.identity.userId, this.identity.orgId),
        database: null,
        invalidated: false,
      };
      entry = nextEntry;
      this.databaseEntry = entry;
    }
    if (entry.invalidated) {
      throw new Error("Chat IndexedDB version changed; reload is required");
    }
    const database = await entry.promise;
    signal.throwIfAborted();
    entry.database ??= database;
    if (entry.invalidated) {
      throw new Error("Chat IndexedDB version changed; reload is required");
    }
    return { entry, database };
  }
}
