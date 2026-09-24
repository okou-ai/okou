import {
  chatThreadEventSchema,
  chatThreadSnapshotProjectionSchema,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import { z } from "zod";

export const sharedDatabaseIdentitySchema = z
  .object({
    userId: z.string().min(1),
    orgId: z.string().min(1),
  })
  .strict();

export type SharedDatabaseIdentity = z.infer<
  typeof sharedDatabaseIdentitySchema
>;

export const chatEventDataKeySchema = z
  .object({
    kind: z.literal("chat-event"),
    threadId: z.string().min(1),
  })
  .strict();

export const chatThreadEventDataKeySchema = z
  .object({
    kind: z.literal("chat-thread-event"),
  })
  .strict();

export const sharedDatabaseDataKeySchema = z.discriminatedUnion("kind", [
  chatEventDataKeySchema,
  chatThreadEventDataKeySchema,
]);

export type ChatEventDataKey = z.infer<typeof chatEventDataKeySchema>;
export type ChatThreadEventDataKey = z.infer<
  typeof chatThreadEventDataKeySchema
>;
export type SharedDatabaseDataKey = z.infer<typeof sharedDatabaseDataKeySchema>;

export type ScopedChatEventDataKey = ChatEventDataKey &
  Pick<SharedDatabaseIdentity, "userId" | "orgId">;
export type ScopedChatThreadEventDataKey = ChatThreadEventDataKey &
  Pick<SharedDatabaseIdentity, "userId" | "orgId">;
export type ScopedSharedDatabaseDataKey =
  | ScopedChatEventDataKey
  | ScopedChatThreadEventDataKey;

const sharedDatabaseConsistencySchema = z.enum(["cache-only", "catch-up"]);

export type SharedDatabaseConsistency = z.infer<
  typeof sharedDatabaseConsistencySchema
>;

export const sharedDatabaseQuerySchema = z
  .object({
    dataKey: sharedDatabaseDataKeySchema,
    afterSeqId: z.number().int().nonnegative().nullable(),
    consistency: sharedDatabaseConsistencySchema,
  })
  .strict();

export interface SharedDatabaseQuery<TKey extends SharedDatabaseDataKey> {
  readonly dataKey: TKey;
  readonly afterSeqId: number | null;
  readonly consistency: SharedDatabaseConsistency;
}

// SharedWorker and IndexedDB hold materialized thread data, never a URL that
// expires independently of their cache lifetime.
const chatThreadSnapshotSchema = z.object({
  chatThreads: z.array(chatThreadSnapshotProjectionSchema),
  latestEventId: z.string().uuid().nullable(),
  latestSeqId: z.number().int().positive().nullable(),
});
export const chatThreadIndicatorsSchema =
  chatThreadsContract.indicators.responses[200].extend({
    unreadAt: z.record(z.string().uuid(), z.string().datetime()),
  });
export type ChatThreadIndicators = z.infer<typeof chatThreadIndicatorsSchema>;

export const chatThreadEventQueryResultSchema = z
  .object({
    snapshot: chatThreadSnapshotSchema.nullable(),
    events: z.array(chatThreadEventSchema),
  })
  .strict();

export type ChatThreadEventQueryResult = z.infer<
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
    return chatEventRowSchema
      .array()
      .parse(value) as SharedDatabaseQueryResult<TKey>;
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
