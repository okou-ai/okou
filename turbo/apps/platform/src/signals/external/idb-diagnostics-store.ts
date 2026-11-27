import type { IDBPDatabase } from "idb";

import {
  CHAT_IDB_STORE_NAMES,
  CHAT_THREAD_SNAPSHOT_ID,
  CHAT_THREAD_SNAPSHOT_STORE,
} from "./chat-idb-schema.ts";
import { runIndexedDbTransaction } from "./indexeddb-client.ts";

export interface IndexedDbDiagnostics {
  readonly version: number;
  readonly stores: readonly {
    readonly name: string;
    readonly recordCount: number;
  }[];
}

export interface IndexedDbSnapshotMeasurement {
  readonly threadCount: number;
  readonly payloadBytes: number;
  readonly readDurationMs: number;
}

type GetDb = () => Promise<IDBPDatabase>;

type ChatIdbStoreName = (typeof CHAT_IDB_STORE_NAMES)[number];

async function countStoreRecords(
  db: IDBPDatabase,
  name: ChatIdbStoreName,
  signal: AbortSignal,
): Promise<IndexedDbDiagnostics["stores"][number]> {
  const recordCount = await runIndexedDbTransaction(
    {
      database: "chat",
      template: `${name}.count`,
      transaction_mode: "readonly",
    },
    () => {
      return db.transaction(name, "readonly");
    },
    async (tx, trackRequest): Promise<number> => {
      return await trackRequest(tx.store.count());
    },
  );
  signal.throwIfAborted();
  return { name, recordCount };
}

export function createIdbDiagnosticsStore(getDb: GetDb) {
  return {
    async read(signal: AbortSignal): Promise<IndexedDbDiagnostics> {
      const db = await getDb();
      signal.throwIfAborted();
      const stores = await Promise.all(
        CHAT_IDB_STORE_NAMES.map(async (name) => {
          return await countStoreRecords(db, name, signal);
        }),
      );
      return { version: db.version, stores };
    },
    async measureSnapshot(
      signal: AbortSignal,
    ): Promise<IndexedDbSnapshotMeasurement | null> {
      const db = await getDb();
      signal.throwIfAborted();
      const startedAt = performance.now();
      const snapshot: unknown = await runIndexedDbTransaction(
        {
          database: "chat",
          template: "chat_thread_snapshot.get_for_diagnostics",
          transaction_mode: "readonly",
        },
        () => {
          return db.transaction(CHAT_THREAD_SNAPSHOT_STORE, "readonly");
        },
        async (tx, trackRequest): Promise<unknown> => {
          return await trackRequest(tx.store.get(CHAT_THREAD_SNAPSHOT_ID));
        },
      );
      signal.throwIfAborted();
      const readDurationMs = performance.now() - startedAt;
      if (snapshot === undefined) {
        return null;
      }
      if (
        typeof snapshot !== "object" ||
        snapshot === null ||
        !("chatThreads" in snapshot) ||
        !Array.isArray(snapshot.chatThreads)
      ) {
        throw new Error("Invalid IndexedDB chat thread snapshot");
      }
      // Serialize only after the read transaction finishes. This estimates
      // UTF-8 JSON payload bytes, not IndexedDB's physical storage footprint.
      const payloadBytes = new TextEncoder().encode(
        JSON.stringify(snapshot),
      ).byteLength;
      return {
        threadCount: snapshot.chatThreads.length,
        payloadBytes,
        readDurationMs,
      };
    },
  };
}
