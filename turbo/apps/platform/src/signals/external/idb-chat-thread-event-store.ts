import type { IDBPDatabase } from "idb";
import { chatThreadEventSchema } from "@okouai/api-contracts/validators/chat-threads";
import { chatThreadEventQueryResultSchema } from "../../shared-database/data-key.ts";
import {
  CHAT_THREAD_EVENTS_ORDER_INDEX,
  CHAT_THREAD_EVENTS_STORE,
  CHAT_THREAD_SNAPSHOT_STORE,
} from "./chat-idb-schema.ts";
import { createIdbMetadataEventStores } from "./idb-metadata-event-store.ts";

export function createStrictIdbChatThreadEventStores(
  getDb: () => Promise<IDBPDatabase>,
) {
  return createIdbMetadataEventStores(getDb, {
    snapshotStore: CHAT_THREAD_SNAPSHOT_STORE,
    eventsStore: CHAT_THREAD_EVENTS_STORE,
    orderIndex: CHAT_THREAD_EVENTS_ORDER_INDEX,
    snapshotSchema: chatThreadEventQueryResultSchema.shape.snapshot.unwrap(),
    eventSchema: chatThreadEventSchema,
  });
}
