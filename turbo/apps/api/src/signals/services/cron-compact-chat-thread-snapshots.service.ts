import { command } from "ccstate";
import { createHash, randomUUID } from "node:crypto";
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
  exists,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import {
  chatThreadEventSequences,
  chatThreadEvents,
} from "@okouai/db/schema/chat-thread-event";
import {
  chatThreadSnapshotGcState,
  chatThreadSnapshots,
} from "@okouai/db/schema/chat-thread-snapshot";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { userExportEntries } from "@okouai/db/schema/user-export-entry";
import type { infer as zInfer } from "zod";
import {
  nullableDriverValueDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { mapConcurrent } from "../../lib/map-concurrent";
import { nowDate } from "../../lib/time";
import { db$, writeDb$, type Db } from "../external/db";
import {
  deleteS3Objects,
  listS3ObjectsPage,
  putImmutableS3Object,
  type S3Object,
} from "../external/s3";
import { isAbortError, settleIncludingAbort } from "../utils";
import { chatThreadSnapshotObjectKey } from "./chat-thread-snapshot-object";

interface SnapshotCompactionStats {
  readonly scopes: number;
  readonly eventsApplied: number;
  readonly eventsPruned: number;
  readonly gc: SnapshotGcStats;
}

interface SnapshotGcStats {
  readonly pagesScanned: number;
  readonly objectsScanned: number;
  readonly deleteAttempts: number;
  readonly objectsDeleted: number;
  readonly deferred: boolean;
  readonly failed: boolean;
}

const log = logger("api:cron:compact-chat-thread-snapshots");
type SnapshotRootDb = Pick<
  Db,
  "select" | "selectDistinct" | "update" | "insert" | "delete"
>;
const CHAT_THREAD_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CHAT_THREAD_SNAPSHOT_BATCH_SIZE = 500;
const CHAT_THREAD_SNAPSHOT_PUBLISH_CONCURRENCY = 10;
const DEFAULT_CHAT_THREAD_EVENT_PRUNE_BATCH_SIZE = 500;
const CANDIDATE_SCAN_PAGE_SIZE = 500;
/** Larger pages reduce round trips when rebuilding a scope's full sidebar. */
const PROJECTION_SCAN_PAGE_SIZE = 1000;
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
}

const SNAPSHOT_GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const SNAPSHOT_GC_SHARDS_PER_RUN = 16;
const SNAPSHOT_GC_PAGE_SIZE = 1000;
const SNAPSHOT_GC_DELETE_QUOTA = 100;
const SNAPSHOT_GC_WORK_BUDGET_MS = 30_000;
const SNAPSHOT_GC_SHARD_COUNT = 256;
const SNAPSHOT_GC_SLOT_MS = 60 * 60 * 1000;

interface ScopeKey {
  readonly userId: string;
  readonly orgId: string;
}

interface SnapshotHead {
  readonly latestEventId: string | null;
  readonly latestEventSeqId: number | null;
  readonly objectKey: string | null;
  readonly contentDigest: string | null;
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
      contentDigest: chatThreadSnapshots.contentDigest,
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
        .limit(CANDIDATE_SCAN_PAGE_SIZE);
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
    if (!last || page.length < CANDIDATE_SCAN_PAGE_SIZE) {
      break;
    }
    after = last;
  }
  return candidates;
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
  const threads: zInfer<typeof chatThreadSnapshotProjectionSchema>[] = [];
  let after: { readonly lastMessageAt: Date; readonly id: string } | null =
    null;
  for (;;) {
    // Match the index's NULLS LAST order; both cursor columns are non-null.
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
        hidden: chatThreads.hidden,
        muted: chatThreads.muted,
        renamedAt: nullableJsonTimestamp(chatThreads.renamedAt),
        selectedModel: chatThreads.selectedModel,
        modelSettings: chatThreads.modelSettings,
        codexServiceTier: chatThreads.codexServiceTier,
        computerUseHostId: chatThreads.computerUseHostId,
        cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
      })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.userId, scope.userId),
          after === null
            ? undefined
            : lt(
                sql`(${chatThreads.lastMessageAt}, ${chatThreads.id})`,
                sql`(${sql.param(after.lastMessageAt, chatThreads.lastMessageAt)}, ${sql.param(after.id, chatThreads.id)})`,
              ),
        ),
      )
      .orderBy(
        sql`${desc(chatThreads.lastMessageAt)} nulls last`,
        sql`${desc(chatThreads.id)} nulls last`,
      )
      .limit(PROJECTION_SCAN_PAGE_SIZE);
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
          hidden: thread.hidden,
          muted: thread.muted,
          renamedAt: thread.renamedAt,
          selectedModel: thread.selectedModel,
          modelSettings: modelSettingsSchema.parse(thread.modelSettings ?? {}),
          serviceTier: thread.codexServiceTier === "fast" ? "priority" : null,
          computerUseHostId: thread.computerUseHostId,
          cloudBrowserEnabled: thread.cloudBrowserEnabled,
        }),
      );
    }
    const last = page.at(-1);
    if (!last || page.length < PROJECTION_SCAN_PAGE_SIZE) {
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

/**
 * Publishes one scope's snapshot head with a single-row compare-and-set on the
 * head the candidate was read from. A lost race is left for the next run.
 */
async function publishChatThreadSnapshot(
  db: SnapshotRootDb,
  candidate: SnapshotCandidate,
  objectKey: string,
  contentDigest: string,
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
        objectKey,
        contentDigest,
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
      objectKey,
      contentDigest,
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
  const contentDigest = createHash("sha256").update(compressed).digest("hex");
  const previousKey = candidate.previous?.objectKey ?? null;
  // Only the sequence moved and the projection is byte-identical: keep the
  // existing immutable object and advance the head without another upload.
  const unchanged =
    previousKey !== null && candidate.previous?.contentDigest === contentDigest;
  const objectKey = unchanged
    ? previousKey
    : chatThreadSnapshotObjectKey({
        userId: candidate.userId,
        orgId: candidate.orgId,
      });
  if (!unchanged) {
    await storage.upload(objectKey, compressed);
    signal?.throwIfAborted();
  }
  return await publishChatThreadSnapshot(
    db,
    candidate,
    objectKey,
    contentDigest,
  );
}

function chatThreadSnapshotGcPrefixes(now: Date): readonly string[] {
  const slot = Math.floor(now.getTime() / SNAPSHOT_GC_SLOT_MS);
  const firstShard =
    (slot * SNAPSHOT_GC_SHARDS_PER_RUN) % SNAPSHOT_GC_SHARD_COUNT;
  // Rotate within the hourly window and on each revisit of that window so
  // dense or failing partitions cannot permanently consume a sibling's quota.
  const startOffset =
    (Math.floor(slot / (SNAPSHOT_GC_SHARD_COUNT / SNAPSHOT_GC_SHARDS_PER_RUN)) +
      Math.floor((now.getTime() % SNAPSHOT_GC_SLOT_MS) / (10 * 60 * 1000))) %
    SNAPSHOT_GC_SHARDS_PER_RUN;
  return Array.from({ length: SNAPSHOT_GC_SHARDS_PER_RUN }, (_, offset) => {
    const shard =
      firstShard + ((startOffset + offset) % SNAPSHOT_GC_SHARDS_PER_RUN);
    return `chat-thread-snapshots/v1/${shard.toString(16).padStart(2, "0")}`;
  });
}

const findChatThreadSnapshotGarbage$ = command(
  async (
    { get },
    objects: readonly S3Object[],
    olderThan: Date,
    signal: AbortSignal,
  ): Promise<readonly string[]> => {
    signal.throwIfAborted();
    const keys = objects
      .filter((object) => {
        return object.lastModified < olderThan;
      })
      .map((object) => {
        return object.key;
      });
    if (keys.length === 0) {
      return [];
    }
    const db = get(db$);
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
    signal.throwIfAborted();
    const referenced = new Set(
      [...snapshotReferences, ...exportReferences].map((row) => {
        return row.objectKey;
      }),
    );
    return keys.filter((key) => {
      return !referenced.has(key);
    });
  },
);

const collectChatThreadSnapshotGarbage$ = command(
  async (
    { get, set },
    bucket: string,
    signal: AbortSignal,
  ): Promise<SnapshotGcStats> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const now = nowDate();
    const olderThan = new Date(now.getTime() - SNAPSHOT_GC_GRACE_MS);
    const stats = {
      pagesScanned: 0,
      objectsScanned: 0,
      deleteAttempts: 0,
      objectsDeleted: 0,
      deferred: false,
      failed: false,
    };
    const workSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(SNAPSHOT_GC_WORK_BUDGET_MS),
    ]);
    for (const prefix of chatThreadSnapshotGcPrefixes(now)) {
      signal.throwIfAborted();
      const remaining = SNAPSHOT_GC_DELETE_QUOTA - stats.deleteAttempts;
      if (remaining === 0 || workSignal.aborted) {
        stats.deferred = true;
        break;
      }
      const attempt = await settleIncludingAbort(async () => {
        workSignal.throwIfAborted();
        await db
          .insert(chatThreadSnapshotGcState)
          .values({ bucket, prefix })
          .onConflictDoNothing();
        workSignal.throwIfAborted();
        const [state] = await db
          .select({
            cursorObjectKey: chatThreadSnapshotGcState.cursorObjectKey,
            cycleId: chatThreadSnapshotGcState.cycleId,
          })
          .from(chatThreadSnapshotGcState)
          .where(
            and(
              eq(chatThreadSnapshotGcState.bucket, bucket),
              eq(chatThreadSnapshotGcState.prefix, prefix),
            ),
          );
        workSignal.throwIfAborted();
        if (!state) {
          throw new Error("Chat thread snapshot GC progress is missing");
        }
        const page = await get(
          listS3ObjectsPage(
            bucket,
            prefix,
            Math.min(SNAPSHOT_GC_PAGE_SIZE, remaining),
            state.cursorObjectKey ?? undefined,
            workSignal,
          ),
        );
        workSignal.throwIfAborted();
        stats.pagesScanned++;
        stats.objectsScanned += page.objects.length;
        const garbage = await set(
          findChatThreadSnapshotGarbage$,
          page.objects,
          olderThan,
          workSignal,
        );
        workSignal.throwIfAborted();
        if (garbage.length > 0) {
          // Failed and uncertain deletes still consume this run's allowance.
          stats.deleteAttempts += garbage.length;
          await get(deleteS3Objects(bucket, garbage, workSignal));
          workSignal.throwIfAborted();
          stats.objectsDeleted += garbage.length;
        }
        const nextCursor = page.isTruncated ? page.objects.at(-1)?.key : null;
        if (nextCursor === undefined) {
          throw new Error(
            "Chat thread snapshot GC page has no resume position",
          );
        }
        // Publish only a fully handled page. The cycle id fences a stale
        // invocation even if a newer scan has already wrapped to the same key.
        const [advanced] = await db
          .update(chatThreadSnapshotGcState)
          .set({
            cursorObjectKey: nextCursor,
            cycleId: page.isTruncated ? state.cycleId : randomUUID(),
          })
          .where(
            and(
              eq(chatThreadSnapshotGcState.bucket, bucket),
              eq(chatThreadSnapshotGcState.prefix, prefix),
              eq(chatThreadSnapshotGcState.cycleId, state.cycleId),
              state.cursorObjectKey === null
                ? isNull(chatThreadSnapshotGcState.cursorObjectKey)
                : eq(
                    chatThreadSnapshotGcState.cursorObjectKey,
                    state.cursorObjectKey,
                  ),
            ),
          )
          .returning({ bucket: chatThreadSnapshotGcState.bucket });
        workSignal.throwIfAborted();
        if (!advanced || page.isTruncated) {
          stats.deferred = true;
        }
      });
      signal.throwIfAborted();
      if (!attempt.ok) {
        stats.deferred = true;
        const deadlineCancellation =
          workSignal.aborted &&
          (attempt.error === workSignal.reason || isAbortError(attempt.error));
        if (!deadlineCancellation) {
          log.error("Failed chat thread snapshot garbage collection", {
            type: "chat_thread_snapshot_gc_failed",
            prefix,
            error: attempt.error,
          });
          stats.failed = true;
        }
      }
    }
    signal.throwIfAborted();
    return stats;
  },
);

/**
 * Deletes compacted events past retention. One bounded read picks the oldest
 * expired events, one bounded read gets their scopes' snapshot positions, and
 * one DELETE removes only the events a published snapshot already covers.
 */
async function pruneCompactedEvents(
  db: SnapshotRootDb,
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
        // Eligibility must precede LIMIT: an uncovered expired prefix would
        // otherwise be selected on every run and starve later covered events.
        // The head lookup uses its (user_id, org_id) primary key; the bounded
        // read below still rechecks heads before deleting a selected batch.
        exists(
          db
            .select({ userId: chatThreadSnapshots.userId })
            .from(chatThreadSnapshots)
            .where(
              and(
                eq(chatThreadSnapshots.userId, chatThreadEvents.userId),
                eq(chatThreadSnapshots.orgId, chatThreadEvents.orgId),
                gte(
                  chatThreadSnapshots.latestEventSeqId,
                  chatThreadEvents.seqId,
                ),
              ),
            ),
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

export const compactChatThreadSnapshots$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<SnapshotCompactionStats> => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const db = set(writeDb$);
    const storage: SnapshotStorage = {
      upload: async (objectKey, body) => {
        await get(
          putImmutableS3Object(bucket, objectKey, body, "application/json", {
            signal,
            contentEncoding: "gzip",
          }),
        );
      },
    };
    return await (async (
      signal: AbortSignal,
    ): Promise<SnapshotCompactionStats> => {
      const candidates = await findSnapshotCandidates(
        db,
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
        chatThreadEventPruneBatchSize(),
      );

      const gc = await set(collectChatThreadSnapshotGarbage$, bucket, signal);

      return { scopes, eventsApplied, eventsPruned, gc };
    })(signal);
  },
);
