import { command } from "ccstate";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import {
  chatThreadSnapshotArchiveSchema,
  chatThreadSnapshotProjectionSchema,
} from "@okouai/api-contracts/contracts/chat-threads";
import { modelSettingsSchema } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lt,
  lte,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import {
  chatThreadEventSequences,
  chatThreadEvents,
} from "@okouai/db/schema/chat-thread-event";
import { chatThreadSnapshots } from "@okouai/db/schema/chat-thread-snapshot";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { userExportEntries } from "@okouai/db/schema/user-export-entry";
import { z } from "zod";
import {
  nullableDriverValueDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { env, optionalEnv } from "../../lib/env";
import { mapConcurrent } from "../../lib/map-concurrent";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  deleteS3Objects,
  listS3ObjectsPage,
  putImmutableS3Object,
  type S3Object,
} from "../external/s3";
import { chatThreadSnapshotObjectKey } from "./chat-thread-snapshot-object";

interface SnapshotCompactionStats {
  readonly scopes: number;
  readonly eventsApplied: number;
  readonly eventsPruned: number;
}

type SnapshotCompactionScope =
  | { readonly kind: "global" }
  | {
      readonly kind: "fixtures";
      readonly scopes: readonly {
        readonly userId: string;
        readonly orgId: string;
      }[];
    };

type SnapshotRootDb = Pick<
  Db,
  "select" | "selectDistinct" | "update" | "insert" | "delete"
>;
const CHAT_THREAD_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CHAT_THREAD_SNAPSHOT_BATCH_SIZE = 500;
const CHAT_THREAD_SNAPSHOT_PUBLISH_CONCURRENCY = 10;
const DEFAULT_CHAT_THREAD_EVENT_PRUNE_BATCH_SIZE = 500;
/** Rows read per bounded page while scanning sequences or a scope's threads. */
const SCAN_PAGE_SIZE = 500;
const gzipAsync = promisify(gzip);

function chatThreadSnapshotBatchSize(): number {
  const raw = optionalEnv("CHAT_THREAD_SNAPSHOT_COMPACTION_BATCH_SIZE");
  if (raw === undefined) {
    return DEFAULT_CHAT_THREAD_SNAPSHOT_BATCH_SIZE;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      "CHAT_THREAD_SNAPSHOT_COMPACTION_BATCH_SIZE must be a positive integer",
    );
  }
  return parsed;
}

function chatThreadEventPruneBatchSize(): number {
  const raw = optionalEnv("CHAT_THREAD_EVENT_PRUNE_BATCH_SIZE");
  if (raw === undefined) {
    return DEFAULT_CHAT_THREAD_EVENT_PRUNE_BATCH_SIZE;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      "CHAT_THREAD_EVENT_PRUNE_BATCH_SIZE must be a positive integer",
    );
  }
  return parsed;
}

interface SnapshotStorage {
  readonly upload: (objectKey: string, body: Buffer) => Promise<void>;
  readonly list: (prefix: string) => Promise<{
    readonly objects: readonly S3Object[];
    readonly isTruncated: boolean;
  }>;
  readonly delete: (objectKeys: readonly string[]) => Promise<void>;
}

const SNAPSHOT_GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const SNAPSHOT_GC_SHARDS_PER_RUN = 16;
const SNAPSHOT_GC_PAGE_SIZE = 1000;
const SNAPSHOT_GC_DELETE_QUOTA = 100;
const HEX_DIGITS = "0123456789abcdef";

interface ScopeKey {
  readonly userId: string;
  readonly orgId: string;
}

interface SnapshotHead {
  readonly latestEventId: string | null;
  readonly latestEventSeqId: number | null;
  readonly objectKey: string | null;
  readonly updatedAt: Date;
}

interface SnapshotCandidate extends ScopeKey {
  readonly previous: SnapshotHead | null;
  readonly latestEventId: string | null;
  readonly latestSeqId: number | null;
}

function scopeKey(scope: ScopeKey): string {
  return `${scope.userId}\u0000${scope.orgId}`;
}

/** Snapshot heads for a bounded set of scopes, read by the users they name. */
async function loadSnapshotHeads(
  db: SnapshotRootDb,
  scopes: readonly ScopeKey[],
): Promise<ReadonlyMap<string, SnapshotHead>> {
  if (scopes.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      userId: chatThreadSnapshots.userId,
      orgId: chatThreadSnapshots.orgId,
      latestEventId: chatThreadSnapshots.latestEventId,
      latestEventSeqId: chatThreadSnapshots.latestEventSeqId,
      objectKey: chatThreadSnapshots.objectKey,
      updatedAt: chatThreadSnapshots.updatedAt,
    })
    .from(chatThreadSnapshots)
    .where(
      inArray(chatThreadSnapshots.userId, [
        ...new Set(
          scopes.map((scope) => {
            return scope.userId;
          }),
        ),
      ]),
    );
  return new Map(
    rows.map((row) => {
      return [scopeKey(row), row] as const;
    }),
  );
}

/**
 * The newest visible event at or below a committed sequence position. A
 * sequence position is allocated in the same statement as its event, so every
 * event up to it is committed; an id conflict can still leave a gap at the tip.
 */
async function latestEventAtOrBelow(
  db: SnapshotRootDb,
  scope: ScopeKey,
  seqId: number,
): Promise<{ readonly id: string; readonly seqId: number } | undefined> {
  const [event] = await db
    .select({ id: chatThreadEvents.id, seqId: chatThreadEvents.seqId })
    .from(chatThreadEvents)
    .where(
      and(
        eq(chatThreadEvents.userId, scope.userId),
        eq(chatThreadEvents.orgId, scope.orgId),
        lte(chatThreadEvents.seqId, seqId),
      ),
    )
    .orderBy(desc(chatThreadEvents.seqId))
    .limit(1);
  return event;
}

/**
 * A scope needs a new snapshot when it has a visible event past its position
 * or still has the retired inline payload. A sequence that only advanced over
 * an id-conflict gap needs nothing.
 */
async function toCandidate(
  db: SnapshotRootDb,
  scope: ScopeKey,
  lastSeqId: number,
  previous: SnapshotHead | undefined,
): Promise<SnapshotCandidate | null> {
  const covered = previous?.latestEventSeqId ?? 0;
  const hasObject = previous !== undefined && previous.objectKey !== null;
  if (hasObject && lastSeqId <= covered) {
    return null;
  }
  const latest = await latestEventAtOrBelow(db, scope, lastSeqId);
  if (hasObject && (latest === undefined || latest.seqId <= covered)) {
    return null;
  }
  // An empty scope with no snapshot and only allocator gaps has nothing to
  // publish. Subsequent cron runs must not keep sending an empty projection.
  if (previous === undefined && latest === undefined) {
    return null;
  }
  const advanced = latest !== undefined && latest.seqId > covered;
  return {
    ...scope,
    previous: previous ?? null,
    latestEventId: advanced ? latest.id : (previous?.latestEventId ?? null),
    latestSeqId: advanced ? latest.seqId : (previous?.latestEventSeqId ?? null),
  };
}

/**
 * Finds up to `limit` scopes to compact. The global cron pages through
 * `chat_thread_event_sequences` by primary key: one row per scope, advanced in
 * the same statement as every thread event, so it is the complete and small
 * list of scopes that can have changed.
 */
async function findSnapshotCandidates(
  db: SnapshotRootDb,
  scope: SnapshotCompactionScope,
  limit: number,
): Promise<readonly SnapshotCandidate[]> {
  const candidates: SnapshotCandidate[] = [];
  let after: ScopeKey | null = null;
  while (candidates.length < limit) {
    const page: readonly (ScopeKey & { readonly lastSeqId: number })[] =
      await db
        .select({
          userId: chatThreadEventSequences.userId,
          orgId: chatThreadEventSequences.orgId,
          lastSeqId: chatThreadEventSequences.lastSeqId,
        })
        .from(chatThreadEventSequences)
        .where(
          and(
            scopeSequencePredicate(scope),
            after === null
              ? undefined
              : or(
                  gt(chatThreadEventSequences.userId, after.userId),
                  and(
                    eq(chatThreadEventSequences.userId, after.userId),
                    gt(chatThreadEventSequences.orgId, after.orgId),
                  ),
                ),
          ),
        )
        .orderBy(
          asc(chatThreadEventSequences.userId),
          asc(chatThreadEventSequences.orgId),
        )
        .limit(SCAN_PAGE_SIZE);
    const heads = await loadSnapshotHeads(db, page);
    for (const row of page) {
      if (candidates.length >= limit) {
        break;
      }
      const candidate = await toCandidate(
        db,
        row,
        row.lastSeqId,
        heads.get(scopeKey(row)),
      );
      if (candidate) {
        candidates.push(candidate);
      }
    }
    const last = page.at(-1);
    if (!last || page.length < SCAN_PAGE_SIZE) {
      break;
    }
    after = last;
  }
  return candidates;
}

function scopeSequencePredicate(
  scope: SnapshotCompactionScope,
): SQL | undefined {
  if (scope.kind === "global") {
    return undefined;
  }
  if (scope.scopes.length === 0) {
    return sql`false`;
  }
  return or(
    ...scope.scopes.map((owned) => {
      return and(
        eq(chatThreadEventSequences.userId, owned.userId),
        eq(chatThreadEventSequences.orgId, owned.orgId),
      );
    }),
  );
}

/** A timestamp rendered exactly as `jsonb_build_object` renders it. */
function jsonTimestamp(column: SQLWrapper) {
  return sql`to_jsonb(${column}) #>> '{}'`.mapWith(pgTextDecoder);
}

function nullableJsonTimestamp(column: SQLWrapper) {
  return sql`to_jsonb(${column}) #>> '{}'`.mapWith(
    nullableDriverValueDecoder(pgTextDecoder),
  );
}

/**
 * The scope's sidebar projection: the user's threads under the organization's
 * Agents, pinned first, then newest message first. Reads the org's Agent ids
 * and pages the user's threads by the (user_id, last_message_at, id) index,
 * filtering by Agent in the application instead of joining.
 */
async function loadScopeProjection(db: SnapshotRootDb, scope: ScopeKey) {
  const orgAgents = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.orgId, scope.orgId));
  const agentIds = new Set(
    orgAgents.map((agent) => {
      return agent.id;
    }),
  );
  const threads: z.infer<typeof chatThreadSnapshotProjectionSchema>[] = [];
  let after: { readonly lastMessageAt: Date; readonly id: string } | null =
    null;
  for (;;) {
    const page = await db
      .select({
        id: chatThreads.id,
        agentId: chatThreads.agentId,
        title: chatThreads.title,
        lastMessageAt: chatThreads.lastMessageAt,
        sortAt: jsonTimestamp(chatThreads.lastMessageAt),
        createdAt: jsonTimestamp(chatThreads.createdAt),
        updatedAt: jsonTimestamp(chatThreads.updatedAt),
        pinnedAt: nullableJsonTimestamp(chatThreads.pinnedAt),
        pinOrder: chatThreads.pinOrder,
        archived: chatThreads.archived,
        renamedAt: nullableJsonTimestamp(chatThreads.renamedAt),
        selectedModel: chatThreads.selectedModel,
        modelSettings: chatThreads.modelSettings,
        codexServiceTier: chatThreads.codexServiceTier,
        computerUseHostId: chatThreads.computerUseHostId,
        cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
        selectedVideoModel: chatThreads.selectedVideoModel,
        selectedImageModel: chatThreads.selectedImageModel,
      })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.userId, scope.userId),
          after === null
            ? undefined
            : or(
                lt(chatThreads.lastMessageAt, after.lastMessageAt),
                and(
                  eq(chatThreads.lastMessageAt, after.lastMessageAt),
                  lt(chatThreads.id, after.id),
                ),
              ),
        ),
      )
      .orderBy(desc(chatThreads.lastMessageAt), desc(chatThreads.id))
      .limit(SCAN_PAGE_SIZE);
    for (const thread of page) {
      if (thread.agentId === null || !agentIds.has(thread.agentId)) {
        continue;
      }
      threads.push(
        chatThreadSnapshotProjectionSchema.parse({
          id: thread.id,
          agentId: thread.agentId,
          title: thread.title,
          sortAt: thread.sortAt,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          pinnedAt: thread.pinnedAt,
          pinOrder: thread.pinOrder,
          archived: thread.archived,
          renamedAt: thread.renamedAt,
          selectedModel: thread.selectedModel,
          modelSettings: modelSettingsSchema.parse(thread.modelSettings ?? {}),
          serviceTier: thread.codexServiceTier === "fast" ? "priority" : null,
          computerUseHostId: thread.computerUseHostId,
          cloudBrowserEnabled: thread.cloudBrowserEnabled,
          selectedVideoModel: thread.selectedVideoModel,
          selectedImageModel: thread.selectedImageModel,
        }),
      );
    }
    const last = page.at(-1);
    if (!last || page.length < SCAN_PAGE_SIZE) {
      break;
    }
    after = { lastMessageAt: last.lastMessageAt, id: last.id };
  }
  // Pinned threads first; both groups keep the newest-message-first order.
  return [
    ...threads.filter((thread) => {
      return thread.pinnedAt !== null;
    }),
    ...threads.filter((thread) => {
      return thread.pinnedAt === null;
    }),
  ];
}

/** The sha256 part of an immutable snapshot object key. */
function objectKeyDigest(objectKey: string | null): string | null {
  return objectKey?.match(/-([0-9a-f]{64})\.json\.gz$/u)?.[1] ?? null;
}

/**
 * Publishes one scope's snapshot head with a single-row compare-and-set on the
 * head the candidate was read from. A lost race is left for the next run.
 */
async function publishChatThreadSnapshot(
  db: SnapshotRootDb,
  candidate: SnapshotCandidate,
  objectKey: string,
): Promise<boolean> {
  const updatedAt = nowDate();
  if (candidate.previous === null) {
    const inserted = await db
      .insert(chatThreadSnapshots)
      .values({
        userId: candidate.userId,
        orgId: candidate.orgId,
        latestEventId: candidate.latestEventId,
        latestEventSeqId: candidate.latestSeqId,
        chatThreads: [],
        objectKey,
        createdAt: updatedAt,
        updatedAt,
      })
      .onConflictDoNothing()
      .returning({ userId: chatThreadSnapshots.userId });
    return inserted.length > 0;
  }
  const previous = candidate.previous;
  const updated = await db
    .update(chatThreadSnapshots)
    .set({
      latestEventId: candidate.latestEventId,
      latestEventSeqId: candidate.latestSeqId,
      chatThreads: [],
      objectKey,
      updatedAt,
    })
    .where(
      and(
        eq(chatThreadSnapshots.userId, candidate.userId),
        eq(chatThreadSnapshots.orgId, candidate.orgId),
        eq(chatThreadSnapshots.updatedAt, previous.updatedAt),
        sql`${chatThreadSnapshots.objectKey} IS NOT DISTINCT FROM ${previous.objectKey}`,
        sql`${chatThreadSnapshots.latestEventSeqId} IS NOT DISTINCT FROM ${previous.latestEventSeqId}`,
      ),
    )
    .returning({ userId: chatThreadSnapshots.userId });
  return updated.length > 0;
}

async function compactCandidate(
  db: SnapshotRootDb,
  candidate: SnapshotCandidate,
  storage: SnapshotStorage,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const chatThreads = chatThreadSnapshotArchiveSchema.parse({
    chatThreads: await loadScopeProjection(db, candidate),
  }).chatThreads;
  signal?.throwIfAborted();
  const compressed = await gzipAsync(
    Buffer.from(JSON.stringify({ chatThreads })),
  );
  const objectKey = chatThreadSnapshotObjectKey({
    userId: candidate.userId,
    orgId: candidate.orgId,
    latestSeqId: candidate.latestSeqId,
    body: compressed,
  });
  const previousKey = candidate.previous?.objectKey ?? null;
  // Only the sequence moved and the projection is byte-identical: keep the
  // existing immutable object and advance the head without another upload.
  const unchanged =
    previousKey !== null &&
    objectKeyDigest(previousKey) === objectKeyDigest(objectKey);
  if (!unchanged) {
    await storage.upload(objectKey, compressed);
    signal?.throwIfAborted();
  }
  return await publishChatThreadSnapshot(
    db,
    candidate,
    unchanged && previousKey !== null ? previousKey : objectKey,
  );
}

async function collectChatThreadSnapshotGarbage(
  db: SnapshotRootDb,
  storage: SnapshotStorage,
  signal?: AbortSignal,
): Promise<void> {
  const now = nowDate();
  const olderThan = new Date(now.getTime() - SNAPSHOT_GC_GRACE_MS);
  const firstShard =
    (Math.floor(now.getTime() / (60 * 60 * 1000)) *
      SNAPSHOT_GC_SHARDS_PER_RUN) %
    256;
  let remaining = SNAPSHOT_GC_DELETE_QUOTA;
  for (let offset = 0; offset < SNAPSHOT_GC_SHARDS_PER_RUN; offset += 1) {
    signal?.throwIfAborted();
    const shard = (firstShard + offset) % 256;
    const prefix = `chat-thread-snapshots/v1/${shard.toString(16).padStart(2, "0")}`;
    const firstPage = await storage.list(prefix);
    const pages = firstPage.isTruncated
      ? await Promise.all(
          [...HEX_DIGITS].map(async (suffix) => {
            const page = await storage.list(`${prefix}${suffix}`);
            if (page.isTruncated) {
              throw new Error("Chat thread snapshot GC partition is too large");
            }
            return page.objects;
          }),
        )
      : [firstPage.objects];
    for (const objects of pages) {
      signal?.throwIfAborted();
      const oldObjects = objects.filter((object) => {
        return object.lastModified < olderThan;
      });
      if (oldObjects.length === 0) {
        continue;
      }
      const keys = oldObjects.map((object) => {
        return object.key;
      });
      const [snapshotReferences, exportReferences] = await Promise.all([
        db
          .select({ objectKey: chatThreadSnapshots.objectKey })
          .from(chatThreadSnapshots)
          .where(inArray(chatThreadSnapshots.objectKey, keys)),
        db
          .selectDistinct({ objectKey: userExportEntries.sourceKey })
          .from(userExportEntries)
          .where(inArray(userExportEntries.sourceKey, keys)),
      ]);
      const referenced = new Set(
        [...snapshotReferences, ...exportReferences].map((row) => {
          return row.objectKey;
        }),
      );
      const garbage = oldObjects
        .filter((object) => {
          return !referenced.has(object.key);
        })
        .slice(0, remaining);
      if (garbage.length > 0) {
        await storage.delete(
          garbage.map((object) => {
            return object.key;
          }),
        );
        remaining -= garbage.length;
      }
      if (remaining === 0) {
        return;
      }
    }
  }
}

/**
 * Deletes compacted events past retention. One bounded read picks the oldest
 * expired events, one bounded read gets their scopes' snapshot positions, and
 * one DELETE removes only the events a published snapshot already covers.
 */
async function pruneCompactedEvents(
  db: SnapshotRootDb,
  scope: SnapshotCompactionScope,
  limit: number,
): Promise<number> {
  const cutoff = new Date(nowDate().getTime() - CHAT_THREAD_EVENT_RETENTION_MS);
  const expired = await db
    .select({
      id: chatThreadEvents.id,
      userId: chatThreadEvents.userId,
      orgId: chatThreadEvents.orgId,
      seqId: chatThreadEvents.seqId,
    })
    .from(chatThreadEvents)
    .where(
      and(
        lt(chatThreadEvents.createdAt, cutoff),
        scope.kind === "global"
          ? undefined
          : scope.scopes.length === 0
            ? sql`false`
            : or(
                ...scope.scopes.map((owned) => {
                  return and(
                    eq(chatThreadEvents.userId, owned.userId),
                    eq(chatThreadEvents.orgId, owned.orgId),
                  );
                }),
              ),
      ),
    )
    .orderBy(asc(chatThreadEvents.createdAt), asc(chatThreadEvents.id))
    .limit(limit);
  const heads = await loadSnapshotHeads(db, expired);
  const covered = expired
    .filter((event) => {
      const covering = heads.get(scopeKey(event))?.latestEventSeqId;
      return (
        covering !== null && covering !== undefined && event.seqId <= covering
      );
    })
    .map((event) => {
      return event.id;
    });
  if (covered.length === 0) {
    return 0;
  }
  const deleted = await db
    .delete(chatThreadEvents)
    .where(inArray(chatThreadEvents.id, covered))
    .returning({ id: chatThreadEvents.id });
  return deleted.length;
}

export async function compactChatThreadSnapshotsForScope(
  db: Db,
  scope: SnapshotCompactionScope,
  storage: SnapshotStorage,
  signal?: AbortSignal,
): Promise<SnapshotCompactionStats> {
  const candidates = await findSnapshotCandidates(
    db,
    scope,
    chatThreadSnapshotBatchSize(),
  );
  const published = await mapConcurrent(
    candidates,
    CHAT_THREAD_SNAPSHOT_PUBLISH_CONCURRENCY,
    async (candidate) => {
      return (await compactCandidate(db, candidate, storage, signal))
        ? candidate
        : null;
    },
  );
  let scopes = 0;
  let eventsApplied = 0;
  for (const candidate of published) {
    if (candidate === null) {
      continue;
    }
    scopes += 1;
    // Sequence positions advanced; id-conflict gaps make this an upper bound.
    eventsApplied += Math.max(
      0,
      (candidate.latestSeqId ?? 0) -
        (candidate.previous?.latestEventSeqId ?? 0),
    );
  }

  signal?.throwIfAborted();
  const eventsPruned = await pruneCompactedEvents(
    db,
    scope,
    chatThreadEventPruneBatchSize(),
  );

  if (scope.kind === "global") {
    await collectChatThreadSnapshotGarbage(db, storage, signal);
  }

  return { scopes, eventsApplied, eventsPruned };
}

export const compactChatThreadSnapshots$ = command(
  async (
    { get, set },
    scope: SnapshotCompactionScope,
    signal: AbortSignal,
  ): Promise<SnapshotCompactionStats> => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    return await compactChatThreadSnapshotsForScope(
      set(writeDb$),
      scope,
      {
        upload: async (objectKey, body) => {
          await get(
            putImmutableS3Object(bucket, objectKey, body, "application/json", {
              signal,
              contentEncoding: "gzip",
            }),
          );
        },
        list: async (prefix) => {
          return await get(
            listS3ObjectsPage(bucket, prefix, SNAPSHOT_GC_PAGE_SIZE),
          );
        },
        delete: async (objectKeys) => {
          await get(deleteS3Objects(bucket, objectKeys, signal));
        },
      },
      signal,
    );
  },
);
