import type { IDBPDatabase } from "idb";
import { runIndexedDbTransaction } from "./indexeddb-client.ts";

export interface MetadataEvent {
  readonly id: string;
  readonly seqId: number;
}

export interface MetadataSnapshot {
  readonly latestEventId: string | null;
  readonly latestSeqId: number | null;
}

export interface MetadataEventResult<
  TSnapshot extends MetadataSnapshot,
  TEvent extends MetadataEvent,
> {
  readonly snapshot: TSnapshot | null;
  readonly events: TEvent[];
}

interface MetadataEventStoreOptions<TSnapshot, TEvent> {
  readonly snapshotStore: string;
  readonly eventsStore: string;
  readonly orderIndex: string;
  readonly snapshotSchema: { parse(value: unknown): TSnapshot };
  readonly eventSchema: { parse(value: unknown): TEvent };
}

export function metadataEventCursor(
  result: MetadataEventResult<MetadataSnapshot, MetadataEvent>,
): number | null {
  return result.events.at(-1)?.seqId ?? result.snapshot?.latestSeqId ?? null;
}

const SNAPSHOT_ID = "current";
const EVENT_READ_PAGE_SIZE = 300;

export function createIdbMetadataEventStores<
  TSnapshot extends MetadataSnapshot,
  TEvent extends MetadataEvent,
>(
  getDb: () => Promise<IDBPDatabase>,
  options: MetadataEventStoreOptions<TSnapshot, TEvent>,
) {
  const { snapshotStore, eventsStore, orderIndex } = options;

  return {
    async read(
      signal: AbortSignal,
    ): Promise<MetadataEventResult<TSnapshot, TEvent>> {
      const db = await getDb();
      signal.throwIfAborted();
      return await runIndexedDbTransaction(
        {
          database: "chat",
          template: `${snapshotStore}.get+${eventsStore}.get_all_by_seq`,
          transaction_mode: "readonly",
        },
        () => {
          return db.transaction([snapshotStore, eventsStore], "readonly");
        },
        async (tx, trackRequest) => {
          const raw: unknown = await trackRequest(
            tx.objectStore(snapshotStore).get(SNAPSHOT_ID),
          );
          const snapshot =
            raw === undefined ? null : options.snapshotSchema.parse(raw);
          const events: TEvent[] = [];
          const index = tx.objectStore(eventsStore).index(orderIndex);
          let more = true;
          while (more) {
            signal.throwIfAborted();
            const after = events.at(-1)?.seqId;
            const rows: unknown[] = await trackRequest(
              index.getAll(
                after === undefined
                  ? undefined
                  : IDBKeyRange.lowerBound(after, true),
                EVENT_READ_PAGE_SIZE,
              ),
            );
            events.push(
              ...rows.map((row) => {
                return options.eventSchema.parse(row);
              }),
            );
            more = rows.length === EVENT_READ_PAGE_SIZE;
          }
          return { snapshot, events };
        },
      );
    },

    async write(
      snapshot: TSnapshot,
      events: readonly TEvent[],
      replacement: boolean,
      signal: AbortSignal,
    ): Promise<void> {
      const db = await getDb();
      signal.throwIfAborted();
      await runIndexedDbTransaction(
        {
          database: "chat",
          template: replacement
            ? `${eventsStore}.clear+put_many+${snapshotStore}.put`
            : `${eventsStore}.put_many`,
          transaction_mode: "readwrite",
        },
        () => {
          return db.transaction([snapshotStore, eventsStore], "readwrite");
        },
        async (tx, trackRequest) => {
          const raw: unknown = await trackRequest(
            tx.objectStore(snapshotStore).get(SNAPSHOT_ID),
          );
          const currentSnapshot =
            raw === undefined ? null : options.snapshotSchema.parse(raw);
          const store = tx.objectStore(eventsStore);
          const latest = await trackRequest(
            store.index(orderIndex).openKeyCursor(undefined, "prev"),
          );
          const latestSeqId = latest?.key;
          if (latestSeqId !== undefined && typeof latestSeqId !== "number") {
            throw new Error("Invalid IndexedDB metadata event sequence");
          }
          const currentSeqId = Math.max(
            latestSeqId ?? 0,
            currentSnapshot?.latestSeqId ?? 0,
          );
          const incomingSeqId =
            events.at(-1)?.seqId ?? snapshot.latestSeqId ?? 0;
          signal.throwIfAborted();
          // A slower sync must not replace a newer persisted snapshot or tail.
          if (currentSeqId > incomingSeqId) {
            return;
          }
          const snapshotSeqId =
            (replacement ? snapshot : currentSnapshot)?.latestSeqId ?? 0;
          // Queue the whole mutation without an await/cancellation boundary
          // between clearing the old tail and inserting its replacement.
          const replacementRequests = replacement
            ? [
                trackRequest(store.clear()),
                trackRequest(
                  tx
                    .objectStore(snapshotStore)
                    .put({ ...snapshot, id: SNAPSHOT_ID }),
                ),
              ]
            : [];
          await Promise.all([
            ...replacementRequests,
            ...events
              .filter((event) => {
                return event.seqId > snapshotSeqId;
              })
              .map((event) => {
                return trackRequest(store.put(event));
              }),
          ]);
        },
      );
    },
  };
}

export type MetadataEventStores<
  TSnapshot extends MetadataSnapshot,
  TEvent extends MetadataEvent,
> = ReturnType<typeof createIdbMetadataEventStores<TSnapshot, TEvent>>;
