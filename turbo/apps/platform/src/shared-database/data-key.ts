import {
  chatThreadEventSchema,
  chatThreadSnapshotProjectionSchema,
  indicatorsSchema,
} from "@okouai/api-contracts/validators/chat-threads";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  array,
  discriminatedUnion,
  literal,
  number,
  object,
  record,
  string,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

export const sharedDatabaseIdentitySchema = object({
  userId: string().min(1),
  orgId: string().min(1),
}).strict();

export type SharedDatabaseIdentity = zInfer<
  typeof sharedDatabaseIdentitySchema
>;

export const chatEventDataKeySchema = object({
  kind: literal("chat-event"),
  threadId: string().min(1),
}).strict();

export const chatThreadEventDataKeySchema = object({
  kind: literal("chat-thread-event"),
}).strict();

export const sharedDatabaseDataKeySchema = discriminatedUnion("kind", [
  chatEventDataKeySchema,
  chatThreadEventDataKeySchema,
]);

export type ChatEventDataKey = zInfer<typeof chatEventDataKeySchema>;
export type ChatThreadEventDataKey = zInfer<
  typeof chatThreadEventDataKeySchema
>;
export type SharedDatabaseDataKey = zInfer<typeof sharedDatabaseDataKeySchema>;

export type ScopedChatEventDataKey = ChatEventDataKey &
  Pick<SharedDatabaseIdentity, "userId" | "orgId">;
export type ScopedChatThreadEventDataKey = ChatThreadEventDataKey &
  Pick<SharedDatabaseIdentity, "userId" | "orgId">;
export type ScopedSharedDatabaseDataKey =
  ScopedChatEventDataKey | ScopedChatThreadEventDataKey;

const sharedDatabaseConsistencySchema = zEnum(["cache-only", "catch-up"]);

export type SharedDatabaseConsistency = zInfer<
  typeof sharedDatabaseConsistencySchema
>;

export const sharedDatabaseQuerySchema = object({
  dataKey: sharedDatabaseDataKeySchema,
  afterSeqId: number().int().nonnegative().nullable(),
  consistency: sharedDatabaseConsistencySchema,
}).strict();

export interface SharedDatabaseQuery<TKey extends SharedDatabaseDataKey> {
  readonly dataKey: TKey;
  readonly afterSeqId: number | null;
  readonly consistency: SharedDatabaseConsistency;
}

// SharedWorker and IndexedDB hold materialized thread data, never a URL that
// expires independently of their cache lifetime.
const chatThreadSnapshotSchema = object({
  chatThreads: array(chatThreadSnapshotProjectionSchema),
  latestEventId: string().uuid().nullable(),
  latestSeqId: number().int().positive().nullable(),
});
export const chatThreadIndicatorsSchema = indicatorsSchema.extend({
  unreadAt: record(string().uuid(), string().datetime()),
});
export type ChatThreadIndicators = zInfer<typeof chatThreadIndicatorsSchema>;

export const chatThreadEventQueryResultSchema = object({
  snapshot: chatThreadSnapshotSchema.nullable(),
  events: array(chatThreadEventSchema),
}).strict();

export type ChatThreadEventQueryResult = zInfer<
  typeof chatThreadEventQueryResultSchema
>;

interface SharedDatabaseDatasetMap {
  readonly "chat-event": {
    readonly dataKey: ChatEventDataKey;
    readonly result: ChatEventRow[];
  };
  readonly "chat-thread-event": {
    readonly dataKey: ChatThreadEventDataKey;
    readonly result: ChatThreadEventQueryResult;
  };
}

export type SharedDatabaseQueryResult<TKey extends SharedDatabaseDataKey> =
  SharedDatabaseDatasetMap[TKey["kind"]]["result"];

export function parseSharedDatabaseQueryResult<
  TKey extends SharedDatabaseDataKey,
>(dataKey: TKey, value: unknown): SharedDatabaseQueryResult<TKey> {
  if (dataKey.kind === "chat-event") {
    // The same-build Worker decodes cached, snapshot, and row-page rows before
    // returning them; the port only clones them.
    return value as SharedDatabaseQueryResult<TKey>;
  }
  return chatThreadEventQueryResultSchema.parse(
    value,
  ) as SharedDatabaseQueryResult<TKey>;
}

export function scopeSharedDatabaseDataKey(
  dataKey: ChatEventDataKey,
  identity: Pick<SharedDatabaseIdentity, "userId" | "orgId">,
): ScopedChatEventDataKey;
export function scopeSharedDatabaseDataKey(
  dataKey: ChatThreadEventDataKey,
  identity: Pick<SharedDatabaseIdentity, "userId" | "orgId">,
): ScopedChatThreadEventDataKey;
export function scopeSharedDatabaseDataKey(
  dataKey: SharedDatabaseDataKey,
  identity: Pick<SharedDatabaseIdentity, "userId" | "orgId">,
): ScopedSharedDatabaseDataKey;
export function scopeSharedDatabaseDataKey(
  dataKey: SharedDatabaseDataKey,
  identity: Pick<SharedDatabaseIdentity, "userId" | "orgId">,
): ScopedSharedDatabaseDataKey {
  return { ...dataKey, userId: identity.userId, orgId: identity.orgId };
}
