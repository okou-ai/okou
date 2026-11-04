import { fetchResource } from "../lib/resource-fetch.ts";
import { chatThreadEventsContract } from "@okouai/api-contracts/client/chat-threads";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import type { ChatEventCursor } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { CLIENT_FORCE_UPGRADE_STATUS } from "@okouai/api-contracts/contracts/client-headers";
import type {
  ClientRouter,
  InitClientArgs,
  InitClientReturn,
} from "@okouai/api-contracts/client/types";
import type { IDBPDatabase } from "idb";

import {
  captureSentryLogError,
  sentryLogContext,
} from "../lib/sentry-config.ts";
import { now } from "../lib/time.ts";
import { createChatIdbOpener } from "../signals/external/chat-idb-opener.ts";
import { createIdbDiagnosticsStore } from "../signals/external/idb-diagnostics-store.ts";
import { createIdbEventRowStores } from "../signals/external/idb-event-row-store.ts";
import {
  metadataEventCursor,
  type MetadataEvent,
  type MetadataSnapshot,
  type MetadataEventResult,
} from "../signals/external/idb-metadata-event-store.ts";
import {
  createChatThreadEventSource,
  createProjectEventSource,
  loadMetadataEventTail,
  type MetadataEventSource,
  type MetadataEventRemoteState,
} from "./metadata-event-source.ts";
import type { ApiClientFactory } from "../signals/api-client.ts";
import { logger } from "../signals/log.ts";
import { isAbortError, settle } from "../signals/utils.ts";
import {
  scopeSharedDatabaseDataKey,
  type ChatEventDataKey,
  type SharedDatabaseDataKey,
  type SharedDatabaseIdentity,
  type SharedDatabaseQuery,
  type SharedDatabaseQueryResult,
  type ScopedChatEventDataKey,
  type ScopedSharedDatabaseDataKey,
} from "./data-key.ts";
import type {
  IndexedDbDiagnostics,
  IndexedDbSnapshotMeasurement,
} from "./computed-key.ts";
import type { SharedDatabaseWorkerMessage } from "./protocol.ts";
import { SharedDatabaseHttpError } from "./http-error.ts";
type SharedDatabaseContractClient<TContract extends ClientRouter> =
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

interface SharedDatabaseEntry {
  readonly promise: Promise<IDBPDatabase>;
  database: IDBPDatabase | null;
  invalidated: boolean;
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

function isIndexedDbUnavailable(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    [
      "AbortError",
      "InvalidStateError",
      "NotAllowedError",
      "NotReadableError",
      "QuotaExceededError",
      "SecurityError",
      "UnknownError",
      "VersionError",
    ].includes(error.name)
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

export class SharedDatabaseWorkerRuntime {
  private readonly identity: SharedDatabaseIdentity;
  private databaseEntry: SharedDatabaseEntry | null = null;
  private readonly emit: (message: WorkerRuntimeEvent) => void;
  private readonly createContractClient: ApiClientFactory;

  constructor(
    options: SharedDatabaseWorkerRuntimeOptions,
    private readonly rootSignal: AbortSignal,
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
    // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
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
    return await this.runIndexedDbOperation(
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
    return await this.runIndexedDbOperation(
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
    // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
    const cachedCursorsResult = await settle(
      this.runIndexedDbOperation(
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
    // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
    const written = await settle(
      this.runIndexedDbOperation(
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
    // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
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
    // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
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
    // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
    const cleared = await settle(
      this.runIndexedDbOperation(
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
    if (dataKey.kind === "project-event") {
      return (await this.queryMetadataEvents(
        dataKey,
        query.consistency,
        createProjectEventSource(this.createContractClient),
        signal,
      )) as SharedDatabaseQueryResult<TKey>;
    }
    if (dataKey.kind !== "chat-thread-event") {
      throw new Error("Shared database query data key is invalid");
    }
    const result = await this.queryMetadataEvents(
      dataKey,
      query.consistency,
      createChatThreadEventSource(this.createContractClient),
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

  private async syncChatEvents(
    dataKey: ScopedChatEventDataKey,
    signal: AbortSignal,
  ): Promise<readonly ChatEventRow[]> {
    // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
    const cachedCursorResult = await settle(
      this.runIndexedDbOperation(
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
    // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
    const written = await settle(
      this.runIndexedDbOperation(
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
        params: { threadId: dataKey.threadId },
        query: chatEventRowsQuery(cursor),
        fetchOptions: { signal },
      });
      signal.throwIfAborted();
      if (page.status === 401 || page.status === CLIENT_FORCE_UPGRADE_STATUS) {
        throw new SharedDatabaseHttpError(page.status);
      }
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
      // The page receives Worker rows without decoding them again, so row pages
      // are decoded here like cached and snapshot rows.
      const pageRows = page.body.rows.map((row) => {
        return chatEventRowSchema.parse(row);
      });
      remoteRows = mergeChatEventRows([remoteRows, pageRows]);
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

  private async queryMetadataEvents<
    TSnapshot extends MetadataSnapshot,
    TEvent extends MetadataEvent,
  >(
    dataKey: ScopedSharedDatabaseDataKey,
    consistency: "cache-only" | "catch-up",
    source: MetadataEventSource<TSnapshot, TEvent>,
    signal: AbortSignal,
  ): Promise<MetadataEventResult<TSnapshot, TEvent>> {
    const cached = await this.readMetadataEventCache(dataKey, source, signal);
    if (consistency === "cache-only") {
      return cached.result;
    }
    let state: MetadataEventRemoteState<TSnapshot, TEvent> = {
      result: cached.result,
      replacement: false,
      cursorFromServerSnapshot: false,
      newEvents: [],
    };
    if (cached.result.snapshot === null || cached.degraded) {
      state = {
        result: { snapshot: await source.snapshot(signal), events: [] },
        replacement: true,
        cursorFromServerSnapshot: true,
        newEvents: [],
      };
    }
    state = await loadMetadataEventTail(source, state, signal);
    state = await this.maybeRebaseMetadataEventSnapshot(
      dataKey,
      source,
      state,
      signal,
    );
    if (!state.replacement && state.newEvents.length === 0) {
      return state.result;
    }
    const snapshot = state.result.snapshot;
    if (!snapshot) {
      throw new Error(`${source.name} synchronization requires a snapshot`);
    }
    // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
    const written = await settle(
      this.runIndexedDbOperation(
        source.createStores,
        async (stores) => {
          await stores.write(
            snapshot,
            state.replacement ? state.result.events : state.newEvents,
            state.replacement,
            signal,
          );
          return await stores.read(signal);
        },
        signal,
      ),
      signal,
    );
    if (!written.ok) {
      if (!isIndexedDbUnavailable(written.error)) {
        throw written.error;
      }
      logDataKeyError(
        dataKey,
        "indexeddb.metadata-event.write.error",
        written.error,
      );
      return state.result;
    }
    return (metadataEventCursor(written.value) ?? 0) >
      (metadataEventCursor(state.result) ?? 0)
      ? written.value
      : state.result;
  }

  private async maybeRebaseMetadataEventSnapshot<
    TSnapshot extends MetadataSnapshot,
    TEvent extends MetadataEvent,
  >(
    dataKey: ScopedSharedDatabaseDataKey,
    source: MetadataEventSource<TSnapshot, TEvent>,
    state: MetadataEventRemoteState<TSnapshot, TEvent>,
    signal: AbortSignal,
  ): Promise<MetadataEventRemoteState<TSnapshot, TEvent>> {
    if (
      source.rebaseThreshold === null ||
      state.replacement ||
      state.result.events.length <= source.rebaseThreshold
    ) {
      return state;
    }
    // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
    const rebasedSnapshot = await settle(source.snapshot(signal), signal);
    if (!rebasedSnapshot.ok) {
      const error = rebasedSnapshot.error;
      if (!(error instanceof SharedDatabaseHttpError) || error.status < 500) {
        throw error;
      }
      // Compaction is optional: the synchronized tail is still authoritative.
      logDataKeyError(dataKey, "snapshot-rebase.skip", error);
      return state;
    }
    return await loadMetadataEventTail(
      source,
      {
        result: { snapshot: rebasedSnapshot.value, events: [] },
        replacement: true,
        cursorFromServerSnapshot: true,
        newEvents: [],
      },
      signal,
    );
  }

  private async readChatEventCache(
    dataKey: ScopedChatEventDataKey,
    afterSeqId: number | null,
    signal: AbortSignal,
  ): Promise<ChatEventRow[]> {
    // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
    const result = await settle(
      this.runIndexedDbOperation(
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

  private async readMetadataEventCache<
    TSnapshot extends MetadataSnapshot,
    TEvent extends MetadataEvent,
  >(
    dataKey: ScopedSharedDatabaseDataKey,
    source: MetadataEventSource<TSnapshot, TEvent>,
    signal: AbortSignal,
  ): Promise<{
    readonly result: MetadataEventResult<TSnapshot, TEvent>;
    readonly degraded: boolean;
  }> {
    // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
    const result = await settle(
      this.runIndexedDbOperation(
        source.createStores,
        (stores) => {
          return stores.read(signal);
        },
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      // Storage availability is optional; malformed persisted data and
      // programming errors must not masquerade as an empty cache.
      if (!isIndexedDbUnavailable(result.error)) {
        throw result.error;
      }
      logDataKeyError(
        dataKey,
        "indexeddb.metadata-event.read.error",
        result.error,
      );
      return { result: { snapshot: null, events: [] }, degraded: true };
    }
    return { result: result.value, degraded: false };
  }

  private async runIndexedDbOperation<TStores, TResult>(
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
    const connection = await this.getDatabaseConnection(signal);
    return await run(connection.database);
  }

  private async getDatabaseConnection(signal: AbortSignal): Promise<{
    readonly entry: SharedDatabaseEntry;
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
      const nextEntry: SharedDatabaseEntry = {
        promise: opener.openChatIdb(this.identity.userId, this.identity.orgId),
        database: null,
        invalidated: false,
      };
      entry = nextEntry;
      this.databaseEntry = entry;
    }
    if (entry.invalidated) {
      throw new DOMException(
        "Chat IndexedDB version changed; reload is required",
        "InvalidStateError",
      );
    }
    const database = await entry.promise;
    entry.database ??= database;
    // Opening IndexedDB cannot be aborted. Adopt its connection before a
    // query cancellation, and close a late open if the runtime already ended.
    if (this.rootSignal.aborted) {
      database.close();
      this.rootSignal.throwIfAborted();
    }
    signal.throwIfAborted();
    if (entry.invalidated) {
      throw new DOMException(
        "Chat IndexedDB version changed; reload is required",
        "InvalidStateError",
      );
    }
    return { entry, database };
  }
}
