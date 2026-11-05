import type { IDBPDatabase } from "idb";
import {
  projectSnapshotArchiveSchema,
  projectEventSchema,
} from "@okouai/api-contracts/validators/projects";
import {
  PROJECT_EVENTS_ORDER_INDEX,
  PROJECT_EVENTS_STORE,
  PROJECT_SNAPSHOT_STORE,
} from "./chat-idb-schema.ts";
import { createIdbMetadataEventStores } from "./idb-metadata-event-store.ts";

export function createIdbProjectEventStores(
  getDb: () => Promise<IDBPDatabase>,
) {
  return createIdbMetadataEventStores(getDb, {
    snapshotStore: PROJECT_SNAPSHOT_STORE,
    eventsStore: PROJECT_EVENTS_STORE,
    orderIndex: PROJECT_EVENTS_ORDER_INDEX,
    snapshotSchema: projectSnapshotArchiveSchema,
    eventSchema: projectEventSchema,
  });
}
