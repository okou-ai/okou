import type { IDBPDatabase } from "idb";
import {
  chatThreadEventSchema,
  chatThreadSnapshotProjectionSchema,
} from "@okouai/api-contracts/validators/chat-threads";
import type {
  ChatThreadEvent,
  ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  CHAT_THREAD_EVENT_SYNC_STORE,
  CHAT_THREAD_EVENTS_ORDER_INDEX,
  CHAT_THREAD_EVENTS_STORE,
  CHAT_THREAD_SNAPSHOT_ID,
  CHAT_THREAD_SNAPSHOT_STORE,
} from "./chat-idb-schema.ts";
import { runIndexedDbTransaction } from "./indexeddb-client.ts";

const EVENT_READ_PAGE_SIZE = 300;

const TRANSACTION_TEMPLATES = {
  clear:
    "chat_thread_snapshot.clear+chat_thread_events.clear+chat_thread_event_sync.clear",
  readEventBoundary: "chat_thread_events.open_key_cursor_by_seq",
  readEventPage: "chat_thread_events.get_all_by_seq",
  readSnapshot: "chat_thread_snapshot.get",
  replaceFromSnapshot:
    "chat_thread_events.clear+put_many+chat_thread_snapshot.put",
  upsertEvents: "chat_thread_events.put_many",
} as const;

interface ChatThreadSnapshotRecord {
  readonly chatThreads: readonly ChatThreadSnapshotProjection[];
  readonly latestEventId: string | null;
  readonly latestSeqId: number | null;
}

interface ChatThreadEventLog {
  readonly events: readonly ChatThreadEvent[];
  readonly latestEventId: string | null;
  readonly latestSeqId: number | null;
}

interface ChatThreadEventReadBoundary {
  readonly latestEventId: string;
  readonly latestSeqId: number;
}

interface StoredChatThreadSnapshot extends ChatThreadSnapshotRecord {
  readonly id: typeof CHAT_THREAD_SNAPSHOT_ID;
}

type GetDb = () => Promise<IDBPDatabase>;

function validateSnapshot(raw: unknown): ChatThreadSnapshotRecord | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const row = raw as Partial<StoredChatThreadSnapshot>;
  const latestEventId = row.latestEventId;
  const latestSeqId = row.latestSeqId;
  return {
    chatThreads: chatThreadSnapshotProjectionSchema
      .array()
      .parse(row.chatThreads ?? []),
    latestEventId:
      latestEventId === undefined || latestEventId === null
        ? null
        : validateEventId(latestEventId),
    latestSeqId:
      latestSeqId === undefined || latestSeqId === null
        ? null
        : validateSeqId(latestSeqId),
  };
}

function validateEvent(raw: unknown): ChatThreadEvent {
  return chatThreadEventSchema.parse(raw);
}

function validateSeqId(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new Error("Invalid IndexedDB chat thread event seq_id");
  }
  return raw;
}

function validateEventId(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error("Invalid IndexedDB chat thread event id");
  }
  return raw;
}

function emptyEventLog(): ChatThreadEventLog {
  return { events: [], latestEventId: null, latestSeqId: null };
}

async function readEventBoundary(
  getDb: GetDb,
  signal?: AbortSignal,
): Promise<ChatThreadEventReadBoundary | null> {
  const db = await getDb();
  signal?.throwIfAborted();
  return await runIndexedDbTransaction(
    {
      database: "chat",
      template: TRANSACTION_TEMPLATES.readEventBoundary,
      transaction_mode: "readonly",
    },
    () => {
      return db.transaction(CHAT_THREAD_EVENTS_STORE, "readonly");
    },
    async (tx, trackRequest) => {
      const latestCursor = await trackRequest(
        tx.store
          .index(CHAT_THREAD_EVENTS_ORDER_INDEX)
          .openKeyCursor(undefined, "prev"),
      );
      signal?.throwIfAborted();
      if (!latestCursor) {
        return null;
      }
      return {
        latestEventId: validateEventId(latestCursor.primaryKey),
        latestSeqId: validateSeqId(latestCursor.key),
      };
    },
  );
}

async function readEventPage(
  getDb: GetDb,
  after: number | null,
  through: number,
  signal?: AbortSignal,
): Promise<readonly ChatThreadEvent[] | null> {
  const db = await getDb();
  signal?.throwIfAborted();
  return await runIndexedDbTransaction(
    {
      database: "chat",
      template: TRANSACTION_TEMPLATES.readEventPage,
      transaction_mode: "readonly",
    },
    () => {
      return db.transaction(CHAT_THREAD_EVENTS_STORE, "readonly");
    },
    async (tx, trackRequest) => {
      const index = tx.store.index(CHAT_THREAD_EVENTS_ORDER_INDEX);
      const range = after
        ? IDBKeyRange.bound(after, through, true)
        : IDBKeyRange.upperBound(through);
      const storedEvents = await trackRequest(
        index.getAll(range, EVENT_READ_PAGE_SIZE),
      );
      signal?.throwIfAborted();
      return storedEvents.map(validateEvent);
    },
  );
}

function createStrictReadStore(getDb: GetDb) {
  return {
    async readSnapshot(signal?: AbortSignal) {
      const db = await getDb();
      signal?.throwIfAborted();
      return await runIndexedDbTransaction(
        {
          database: "chat",
          template: TRANSACTION_TEMPLATES.readSnapshot,
          transaction_mode: "readonly",
        },
        () => {
          return db.transaction(CHAT_THREAD_SNAPSHOT_STORE, "readonly");
        },
        async (tx, trackRequest) => {
          const raw = await trackRequest(tx.store.get(CHAT_THREAD_SNAPSHOT_ID));
          return validateSnapshot(raw);
        },
      );
    },

    async readEventLog(signal?: AbortSignal) {
      const boundary = await readEventBoundary(getDb, signal);
      if (!boundary) {
        return emptyEventLog();
      }

      const events: ChatThreadEvent[] = [];
      let after: number | null = null;
      while (events.at(-1)?.seqId !== boundary.latestSeqId) {
        const page = await readEventPage(
          getDb,
          after,
          boundary.latestSeqId,
          signal,
        );
        if (!page) {
          return emptyEventLog();
        }
        const lastEvent = page.at(-1);
        if (!lastEvent) {
          return emptyEventLog();
        }
        events.push(...page);
        after = lastEvent.seqId;
      }

      return {
        events,
        latestEventId: boundary.latestEventId,
        latestSeqId: boundary.latestSeqId,
      } satisfies ChatThreadEventLog;
    },
  };
}

function createStrictWriteStore(getDb: GetDb) {
  return {
    async replaceFromSnapshot(
      snapshot: ChatThreadSnapshotRecord,
      events: readonly ChatThreadEvent[],
      signal?: AbortSignal,
    ) {
      const db = await getDb();
      signal?.throwIfAborted();
      await runIndexedDbTransaction(
        {
          database: "chat",
          template: TRANSACTION_TEMPLATES.replaceFromSnapshot,
          transaction_mode: "readwrite",
        },
        () => {
          return db.transaction(
            [CHAT_THREAD_SNAPSHOT_STORE, CHAT_THREAD_EVENTS_STORE],
            "readwrite",
          );
        },
        async (tx, trackRequest) => {
          await trackRequest(tx.objectStore(CHAT_THREAD_EVENTS_STORE).clear());
          const eventStore = tx.objectStore(CHAT_THREAD_EVENTS_STORE);
          const requests = events.map((event) => {
            signal?.throwIfAborted();
            return trackRequest(eventStore.put(event));
          });
          await Promise.all([
            trackRequest(
              tx.objectStore(CHAT_THREAD_SNAPSHOT_STORE).put({
                id: CHAT_THREAD_SNAPSHOT_ID,
                chatThreads: [...snapshot.chatThreads],
                latestEventId: snapshot.latestEventId,
                latestSeqId: snapshot.latestSeqId,
              } satisfies StoredChatThreadSnapshot),
            ),
            ...requests,
          ]);
        },
      );
    },

    async upsertEvents(
      events: readonly ChatThreadEvent[],
      signal?: AbortSignal,
    ) {
      if (events.length === 0) {
        return;
      }
      const db = await getDb();
      signal?.throwIfAborted();
      await runIndexedDbTransaction(
        {
          database: "chat",
          template: TRANSACTION_TEMPLATES.upsertEvents,
          transaction_mode: "readwrite",
        },
        () => {
          return db.transaction(CHAT_THREAD_EVENTS_STORE, "readwrite");
        },
        async (tx, trackRequest) => {
          const eventStore = tx.store;
          const requests = events.map((event) => {
            signal?.throwIfAborted();
            return trackRequest(eventStore.put(event));
          });
          await Promise.all(requests);
        },
      );
    },

    async clear(signal?: AbortSignal) {
      const db = await getDb();
      signal?.throwIfAborted();
      await runIndexedDbTransaction(
        {
          database: "chat",
          template: TRANSACTION_TEMPLATES.clear,
          transaction_mode: "readwrite",
        },
        () => {
          return db.transaction(
            [
              CHAT_THREAD_SNAPSHOT_STORE,
              CHAT_THREAD_EVENTS_STORE,
              CHAT_THREAD_EVENT_SYNC_STORE,
            ],
            "readwrite",
          );
        },
        async (tx, trackRequest) => {
          await Promise.all([
            trackRequest(tx.objectStore(CHAT_THREAD_SNAPSHOT_STORE).clear()),
            trackRequest(tx.objectStore(CHAT_THREAD_EVENTS_STORE).clear()),
            trackRequest(tx.objectStore(CHAT_THREAD_EVENT_SYNC_STORE).clear()),
          ]);
        },
      );
    },
  };
}

export function createStrictIdbChatThreadEventStores(getDb: GetDb) {
  return Object.freeze({
    readStore: createStrictReadStore(getDb),
    writeStore: createStrictWriteStore(getDb),
  });
}
