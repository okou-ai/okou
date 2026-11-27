import type { projectEventQueryResultSchema } from "@okouai/api-contracts/validators/projects";
import {
  chatThreadEventSchema,
  chatThreadSnapshotProjectionSchema,
} from "@okouai/api-contracts/validators/chat-threads";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { array, number, object, uuid, type infer as zInfer } from "zod";

export interface ChatDatabaseIdentity {
  readonly userId: string;
  readonly orgId: string;
}

export interface ChatEventDataKey {
  readonly kind: "chat-event";
  readonly threadId: string;
}

export interface ChatThreadEventDataKey {
  readonly kind: "chat-thread-event";
}

export interface ProjectEventDataKey {
  readonly kind: "project-event";
}

export type ChatDatabaseDataKey =
  ChatEventDataKey | ChatThreadEventDataKey | ProjectEventDataKey;

export type ChatDatabaseConsistency = "cache-only" | "catch-up";

export interface ChatDatabaseQuery<TKey extends ChatDatabaseDataKey> {
  readonly dataKey: TKey;
  readonly afterSeqId: number | null;
  readonly consistency: ChatDatabaseConsistency;
}

// IndexedDB holds materialized thread data, never a URL that expires
// independently of its cache lifetime.
const chatThreadSnapshotSchema = object({
  chatThreads: array(chatThreadSnapshotProjectionSchema),
  latestEventId: uuid().nullable(),
  latestSeqId: number().int().positive().nullable(),
});

export const chatThreadEventQueryResultSchema = object({
  snapshot: chatThreadSnapshotSchema.nullable(),
  events: array(chatThreadEventSchema),
}).strict();

export type ChatThreadEventQueryResult = zInfer<
  typeof chatThreadEventQueryResultSchema
>;

interface ChatDatabaseDatasetMap {
  readonly "project-event": {
    readonly dataKey: ProjectEventDataKey;
    readonly result: zInfer<typeof projectEventQueryResultSchema>;
  };
  readonly "chat-event": {
    readonly dataKey: ChatEventDataKey;
    readonly result: ChatEventRow[];
  };
  readonly "chat-thread-event": {
    readonly dataKey: ChatThreadEventDataKey;
    readonly result: ChatThreadEventQueryResult;
  };
}

export type ChatDatabaseQueryResult<TKey extends ChatDatabaseDataKey> =
  ChatDatabaseDatasetMap[TKey["kind"]]["result"];
