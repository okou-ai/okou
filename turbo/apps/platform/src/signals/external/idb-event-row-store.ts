import type { IDBPDatabase } from "idb";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  type ChatEventCursor,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { logger } from "../log.ts";
import { onRejection } from "../utils.ts";
import {
  CHAT_EVENT_ROWS_ORDER_INDEX,
  CHAT_EVENT_ROWS_STORE,
  CHAT_EVENT_CURSOR_STORE,
} from "./chat-idb-schema.ts";
import { disabledChatIdbError, logChatIdbDisabled } from "./chat-idb-safe.ts";
import { runIndexedDbTransaction } from "./indexeddb-client.ts";

const L = logger("ChatEventRowIndexedDb");

const TRANSACTION_TEMPLATES = {
  clearThread:
    "chat_event_rows.get_all_keys_by_order+delete_many+chat_event_cursor.delete",
  readCursor: "chat_event_cursor.get",
  readCursors: "chat_event_cursor.get_many",
  readRowsAfter: "chat_event_cursor.get+chat_event_rows.get_all_by_order",
  replaceRowsAndCursor:
    "chat_event_rows.get_all_keys_by_order+delete_many+put_many+chat_event_cursor.put",
  upsertRowsAndCursor: "chat_event_rows.put_many+chat_event_cursor.put",
  upsertRowsAndCursors: "chat_event_rows.put_many+chat_event_cursor.put_many",
} as const;

interface ChatEventRowReadStore {
  readCursors(
    threadIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, ChatEventCursor>>;
  readCursor(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<ChatEventCursor | null>;
  readRowsAfter(
    threadId: string,
    afterSeqId: number | null,
    signal?: AbortSignal,
  ): Promise<ChatEventRow[]>;
}

interface ChatEventRowWriteStore {
  upsertRowsAndCursors(
    entries: readonly {
      readonly threadId: string;
      readonly rows: readonly ChatEventRow[];
      readonly cursor: ChatEventCursor;
    }[],
    signal?: AbortSignal,
  ): Promise<void>;
  upsertRowsAndCursor(
    threadId: string,
    rows: readonly ChatEventRow[],
    cursor: ChatEventCursor,
    signal?: AbortSignal,
  ): Promise<void>;
  replaceRowsAndCursor(
    threadId: string,
    rows: readonly ChatEventRow[],
    cursor: ChatEventCursor,
    signal?: AbortSignal,
  ): Promise<void>;
  clearThread(threadId: string, signal?: AbortSignal): Promise<void>;
}

// The store persists only strict canonical rows. Its introducing schema
// upgrade dropped the previous raw-row cache before rebuilding it.
function storedChatEventRow(raw: unknown): ChatEventRow {
  return chatEventRowSchema.parse(raw);
}

function storedChatEventCursor(raw: unknown): ChatEventCursor {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("schemaVersion" in raw) ||
    raw.schemaVersion !== CURRENT_CHAT_EVENT_SCHEMA_VERSION ||
    !("lastEventId" in raw) ||
    !("lastSeqId" in raw) ||
    typeof raw.lastSeqId !== "number" ||
    !Number.isSafeInteger(raw.lastSeqId) ||
    raw.lastSeqId < 0
  ) {
    throw new Error("Invalid cached Chat Event cursor");
  }
  if (raw.lastEventId === null) {
    if (raw.lastSeqId !== 0) {
      throw new Error("Invalid cached Chat Event cursor");
    }
    return { lastEventId: null, lastSeqId: 0 };
  }
  if (typeof raw.lastEventId !== "string" || raw.lastSeqId === 0) {
    throw new Error("Invalid cached Chat Event cursor");
  }
  return {
    lastEventId: raw.lastEventId,
    lastSeqId: raw.lastSeqId,
  };
}

function threadRowRange(
  threadId: string,
  afterSeqId: number | null,
): IDBKeyRange {
  if (afterSeqId === null) {
    return IDBKeyRange.bound([threadId], [threadId, []]);
  }
  return IDBKeyRange.bound([threadId, afterSeqId], [threadId, []], true, false);
}

type GetDb = () => Promise<IDBPDatabase>;

function createRowReadStore(
  storeName: string,
  cursorStoreName: string,
  getDb: GetDb,
): ChatEventRowReadStore {
  return {
    async readCursors(threadIds, signal) {
      const db = await getDb();
      signal?.throwIfAborted();
      return await runIndexedDbTransaction(
        {
          database: "chat",
          template: TRANSACTION_TEMPLATES.readCursors,
          transaction_mode: "readonly",
        },
        () => {
          return db.transaction(cursorStoreName, "readonly");
        },
        async (tx, trackRequest) => {
          const rawCursors = await Promise.all(
            threadIds.map((threadId) => {
              return trackRequest(tx.store.get(threadId));
            }),
          );
          signal?.throwIfAborted();
          const cursors = new Map<string, ChatEventCursor>();
          for (const [index, rawCursor] of rawCursors.entries()) {
            if (rawCursor !== undefined) {
              const threadId = threadIds[index];
              if (threadId === undefined) {
                throw new Error("Chat Event cursor batch index is invalid");
              }
              cursors.set(threadId, storedChatEventCursor(rawCursor));
            }
          }
          return cursors;
        },
      );
    },
    async readCursor(threadId, signal) {
      const db = await getDb();
      signal?.throwIfAborted();
      return await runIndexedDbTransaction(
        {
          database: "chat",
          template: TRANSACTION_TEMPLATES.readCursor,
          transaction_mode: "readonly",
        },
        () => {
          return db.transaction(cursorStoreName, "readonly");
        },
        async (tx, trackRequest) => {
          const cursor = await trackRequest(tx.store.get(threadId));
          signal?.throwIfAborted();
          return cursor === undefined ? null : storedChatEventCursor(cursor);
        },
      );
    },
    async readRowsAfter(threadId, afterSeqId, signal) {
      L.debug("readRowsAfter:start", { threadId, afterSeqId });
      const db = await getDb();
      signal?.throwIfAborted();
      return await runIndexedDbTransaction(
        {
          database: "chat",
          template: TRANSACTION_TEMPLATES.readRowsAfter,
          transaction_mode: "readonly",
        },
        () => {
          return db.transaction([storeName, cursorStoreName], "readonly");
        },
        async (tx, trackRequest) => {
          const rawCursor = await trackRequest(
            tx.objectStore(cursorStoreName).get(threadId),
          );
          signal?.throwIfAborted();
          if (rawCursor === undefined) {
            return [];
          }
          // A cursor versions the whole row generation. Reject it before
          // exposing rows so a retired cache shape cannot enter the current
          // row stream.
          storedChatEventCursor(rawCursor);
          const index = tx
            .objectStore(storeName)
            .index(CHAT_EVENT_ROWS_ORDER_INDEX);
          const storedRows = await trackRequest(
            index.getAll(threadRowRange(threadId, afterSeqId)),
          );
          signal?.throwIfAborted();
          const rows = storedRows.map(storedChatEventRow);
          L.debug("readRowsAfter:done", { threadId, count: rows.length });
          return rows;
        },
      );
    },
  };
}

function createUpsertRowsAndCursors(
  storeName: string,
  cursorStoreName: string,
  getDb: GetDb,
): ChatEventRowWriteStore["upsertRowsAndCursors"] {
  return async (entries, signal) => {
    if (entries.length === 0) {
      return;
    }
    const db = await getDb();
    signal?.throwIfAborted();
    await runIndexedDbTransaction(
      {
        database: "chat",
        template: TRANSACTION_TEMPLATES.upsertRowsAndCursors,
        transaction_mode: "readwrite",
      },
      () => {
        return db.transaction([storeName, cursorStoreName], "readwrite");
      },
      async (tx, trackRequest) => {
        const rowStore = tx.objectStore(storeName);
        const cursorStore = tx.objectStore(cursorStoreName);
        const requests = entries.flatMap((entry) => {
          signal?.throwIfAborted();
          return [
            ...entry.rows.map((row) => {
              return trackRequest(rowStore.put(row));
            }),
            trackRequest(
              cursorStore.put({
                threadId: entry.threadId,
                schemaVersion: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
                lastEventId: entry.cursor.lastEventId,
                lastSeqId: entry.cursor.lastSeqId,
              }),
            ),
          ];
        });
        await Promise.all(requests);
      },
    );
    L.debug("upsertRowsAndCursors:done", {
      threadCount: entries.length,
      rowCount: entries.reduce((count, entry) => {
        return count + entry.rows.length;
      }, 0),
    });
  };
}

function createRowWriteStore(
  storeName: string,
  cursorStoreName: string,
  getDb: GetDb,
): ChatEventRowWriteStore {
  return {
    upsertRowsAndCursors: createUpsertRowsAndCursors(
      storeName,
      cursorStoreName,
      getDb,
    ),
    async upsertRowsAndCursor(threadId, rows, cursor, signal) {
      L.debug("upsertRows:start", { count: rows.length });
      const db = await getDb();
      signal?.throwIfAborted();
      await runIndexedDbTransaction(
        {
          database: "chat",
          template: TRANSACTION_TEMPLATES.upsertRowsAndCursor,
          transaction_mode: "readwrite",
        },
        () => {
          return db.transaction([storeName, cursorStoreName], "readwrite");
        },
        async (tx, trackRequest) => {
          const rowStore = tx.objectStore(storeName);
          const requests = rows.map((row) => {
            signal?.throwIfAborted();
            return trackRequest(rowStore.put(row));
          });
          requests.push(
            trackRequest(
              tx.objectStore(cursorStoreName).put({
                threadId,
                schemaVersion: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
                lastEventId: cursor.lastEventId,
                lastSeqId: cursor.lastSeqId,
              }),
            ),
          );
          await Promise.all(requests);
        },
      );
      L.debug("upsertRows:done", { count: rows.length });
    },
    async replaceRowsAndCursor(threadId, rows, cursor, signal) {
      const db = await getDb();
      signal?.throwIfAborted();
      let deletedCount = 0;
      await runIndexedDbTransaction(
        {
          database: "chat",
          template: TRANSACTION_TEMPLATES.replaceRowsAndCursor,
          transaction_mode: "readwrite",
        },
        () => {
          return db.transaction([storeName, cursorStoreName], "readwrite");
        },
        async (tx, trackRequest) => {
          const rowStore = tx.objectStore(storeName);
          const index = rowStore.index(CHAT_EVENT_ROWS_ORDER_INDEX);
          const keys = await trackRequest(
            index.getAllKeys(threadRowRange(threadId, null)),
          );
          signal?.throwIfAborted();
          deletedCount = keys.length;
          const deleteRequests = keys.map((key) => {
            return trackRequest(rowStore.delete(key));
          });
          const putRequests = rows.map((row) => {
            signal?.throwIfAborted();
            return trackRequest(rowStore.put(row));
          });
          await Promise.all([
            ...deleteRequests,
            ...putRequests,
            trackRequest(
              tx.objectStore(cursorStoreName).put({
                threadId,
                schemaVersion: CURRENT_CHAT_EVENT_SCHEMA_VERSION,
                lastEventId: cursor.lastEventId,
                lastSeqId: cursor.lastSeqId,
              }),
            ),
          ]);
        },
      );
      L.debug("replaceRows:done", {
        threadId,
        deletedCount,
        count: rows.length,
      });
    },
    async clearThread(threadId, signal) {
      const db = await getDb();
      signal?.throwIfAborted();
      let deletedCount = 0;
      await runIndexedDbTransaction(
        {
          database: "chat",
          template: TRANSACTION_TEMPLATES.clearThread,
          transaction_mode: "readwrite",
        },
        () => {
          return db.transaction([storeName, cursorStoreName], "readwrite");
        },
        async (tx, trackRequest) => {
          const rowStore = tx.objectStore(storeName);
          const index = rowStore.index(CHAT_EVENT_ROWS_ORDER_INDEX);
          const keys = await trackRequest(
            index.getAllKeys(threadRowRange(threadId, null)),
          );
          signal?.throwIfAborted();
          deletedCount = keys.length;
          const requests = keys.map((key) => {
            return trackRequest(rowStore.delete(key));
          });
          requests.push(
            trackRequest(tx.objectStore(cursorStoreName).delete(threadId)),
          );
          await Promise.all(requests);
        },
      );
      L.debug("clearThread:done", { threadId, count: deletedCount });
    },
  };
}

function createIdbEventRowStores(getChatIdb: GetDb) {
  const dbName = "current chat IndexedDB";
  const storeName = CHAT_EVENT_ROWS_STORE;
  const cursorStoreName = CHAT_EVENT_CURSOR_STORE;

  let disabled = false;

  function disableForSession(reason: unknown): void {
    if (disabled) {
      return;
    }
    disabled = true;
    logChatIdbDisabled(dbName, reason);
  }

  async function getDb(): Promise<IDBPDatabase> {
    if (disabled) {
      throw disabledChatIdbError(dbName);
    }

    // IDB open is a cache fast path; rejection disables it for this tab.
    // eslint-disable-next-line ccstate/no-on-rejection -- 存量 2026/10/21: disable the unavailable IndexedDB cache for this tab.
    return await onRejection(getChatIdb(), disableForSession);
  }

  return Object.freeze({
    readStore: createRowReadStore(storeName, cursorStoreName, getDb),
    writeStore: createRowWriteStore(storeName, cursorStoreName, getDb),
  });
}

export { createIdbEventRowStores };
