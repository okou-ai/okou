import type { IDBPDatabase } from "idb";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";

/** Local cache shape changes bump this base; Chat Event requests add their version. */
const CHAT_IDB_CACHE_SCHEMA_VERSION_BASE = 33_000;

export const CHAT_IDB_VERSION =
  CHAT_IDB_CACHE_SCHEMA_VERSION_BASE + CURRENT_CHAT_EVENT_SCHEMA_VERSION;
export const CHAT_EVENT_ROWS_STORE = "chat_events";
export const CHAT_EVENT_ROWS_ORDER_INDEX = "byThreadAndSeq";
export const CHAT_EVENT_CURSOR_STORE = "chat_event_cursors";
export const CHAT_THREAD_SNAPSHOT_STORE = "chat_thread_snapshot";
export const CHAT_THREAD_SNAPSHOT_ID = "current";
export const CHAT_THREAD_EVENTS_STORE = "chat_thread_events";
export const CHAT_THREAD_EVENT_SYNC_STORE = "chat_thread_event_sync";
export const CHAT_THREAD_EVENTS_ORDER_INDEX = "bySeqId";

export const PROJECT_SNAPSHOT_STORE = "project_snapshot";
export const PROJECT_EVENTS_STORE = "project_events";
export const PROJECT_EVENTS_ORDER_INDEX = "bySeqId";

export const CHAT_IDB_STORE_NAMES = [
  CHAT_EVENT_ROWS_STORE,
  CHAT_EVENT_CURSOR_STORE,
  CHAT_THREAD_SNAPSHOT_STORE,
  CHAT_THREAD_EVENTS_STORE,
  CHAT_THREAD_EVENT_SYNC_STORE,
  PROJECT_SNAPSHOT_STORE,
  PROJECT_EVENTS_STORE,
] as const;

function createChatEventRowsStore(db: IDBPDatabase): void {
  const store = db.createObjectStore(CHAT_EVENT_ROWS_STORE, { keyPath: "id" });
  store.createIndex(CHAT_EVENT_ROWS_ORDER_INDEX, ["chatThreadId", "seqId"], {
    unique: true,
  });
}

function createChatEventCursorStore(db: IDBPDatabase): void {
  db.createObjectStore(CHAT_EVENT_CURSOR_STORE, { keyPath: "threadId" });
}

function createChatThreadSnapshotStore(db: IDBPDatabase): void {
  db.createObjectStore(CHAT_THREAD_SNAPSHOT_STORE, { keyPath: "id" });
}

function createChatThreadEventsStore(db: IDBPDatabase): void {
  const store = db.createObjectStore(CHAT_THREAD_EVENTS_STORE, {
    keyPath: "id",
  });
  store.createIndex(CHAT_THREAD_EVENTS_ORDER_INDEX, "seqId", {
    unique: true,
  });
}

function createChatThreadEventSyncStore(db: IDBPDatabase): void {
  db.createObjectStore(CHAT_THREAD_EVENT_SYNC_STORE, { keyPath: "id" });
}

function deleteLocalCacheStores(db: IDBPDatabase): void {
  for (const storeName of Array.from(db.objectStoreNames)) {
    db.deleteObjectStore(storeName);
  }
}

export function upgradeChatIdb(db: IDBPDatabase, oldVersion: number): void {
  // Project stores are additive to this Chat Event generation. Preserve its
  // existing rows; older row generations still rebuild from the server.
  const previousChatVersion = 32_000 + CURRENT_CHAT_EVENT_SCHEMA_VERSION;
  if (
    oldVersion > 0 &&
    oldVersion < CHAT_IDB_VERSION &&
    oldVersion !== previousChatVersion
  ) {
    deleteLocalCacheStores(db);
  }
  if (!db.objectStoreNames.contains(CHAT_EVENT_ROWS_STORE)) {
    createChatEventRowsStore(db);
  }
  if (!db.objectStoreNames.contains(CHAT_EVENT_CURSOR_STORE)) {
    createChatEventCursorStore(db);
  }
  if (!db.objectStoreNames.contains(CHAT_THREAD_SNAPSHOT_STORE)) {
    createChatThreadSnapshotStore(db);
  }
  if (!db.objectStoreNames.contains(CHAT_THREAD_EVENTS_STORE)) {
    createChatThreadEventsStore(db);
  }
  if (!db.objectStoreNames.contains(CHAT_THREAD_EVENT_SYNC_STORE)) {
    createChatThreadEventSyncStore(db);
  }
  if (!db.objectStoreNames.contains(PROJECT_SNAPSHOT_STORE)) {
    db.createObjectStore(PROJECT_SNAPSHOT_STORE, { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains(PROJECT_EVENTS_STORE)) {
    const events = db.createObjectStore(PROJECT_EVENTS_STORE, {
      keyPath: "id",
    });
    events.createIndex(PROJECT_EVENTS_ORDER_INDEX, "seqId", { unique: true });
  }
}
