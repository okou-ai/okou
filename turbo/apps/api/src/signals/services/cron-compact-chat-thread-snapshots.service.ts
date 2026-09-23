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
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  assertErasureSubjectWritable,
  erasureSubjectOpenCondition,
} from "@okouai/db/operations/account-erasure";
import { chatThreadEvents } from "@okouai/db/schema/chat-thread-event";
import { chatThreadSnapshots } from "@okouai/db/schema/chat-thread-snapshot";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { userExportEntries } from "@okouai/db/schema/user-export-entry";
import { z } from "zod";
import {
  executeRawRows,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
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

function snapshotScopePredicate(
  scope: SnapshotCompactionScope,
  userId: SQLWrapper,
  orgId: SQLWrapper,
): SQL | undefined {
  if (scope.kind === "global") {
    return undefined;
  }
  if (scope.scopes.length === 0) {
    return sql`false`;
  }
  return or(
    ...scope.scopes.map((ownedScope) => {
      return and(eq(userId, ownedScope.userId), eq(orgId, ownedScope.orgId));
    }),
  );
}

type SnapshotRootDb = Pick<Db, "execute" | "select" | "selectDistinct">;
const CHAT_THREAD_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CHAT_THREAD_SNAPSHOT_BATCH_SIZE = 500;
const CHAT_THREAD_SNAPSHOT_PUBLISH_CONCURRENCY = 10;
const DEFAULT_CHAT_THREAD_EVENT_PRUNE_BATCH_SIZE = 500;
const CHAT_THREAD_SNAPSHOT_STALE_MS = 24 * 60 * 60 * 1000;
const snapshot = alias(chatThreadSnapshots, "snapshot");
const event = alias(chatThreadEvents, "event");
const thread = alias(chatThreads, "thread");
const agent = alias(agents, "agent");
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

const snapshotCandidateRowSchema = z.object({
  userId: z.string(),
  orgId: z.string(),
  latestEventId: z.string().uuid().nullable(),
  latestSeqId: z.coerce.number().int().positive().nullable(),
  chatThreads: z.array(
    chatThreadSnapshotProjectionSchema.extend({ modelSettings: z.unknown() }),
  ),
  previousUpdatedAt: pgTimestampWithoutTimezoneToDateSchema.nullable(),
  previousObjectKey: z.string().nullable(),
  previousSeqId: z.coerce.number().int().positive().nullable(),
  eventsApplied: z.int(),
});

const prunedEventsRowSchema = z.object({ count: z.int() });
const publishedRowSchema = z.object({ published: z.int() });

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

function allScopesCte(staleCutoff: Date): SQL {
  return sql`
    all_scopes AS (
      SELECT ${chatThreads.userId} AS user_id, ${agents.orgId} AS org_id
      FROM ${chatThreads}
      INNER JOIN ${agents}
        ON ${eq(agents.id, chatThreads.agentId)}

      UNION

      SELECT ${chatThreadEvents.userId} AS user_id, ${chatThreadEvents.orgId} AS org_id
      FROM ${chatThreadEvents}

      UNION

      SELECT ${chatThreadSnapshots.userId} AS user_id, ${chatThreadSnapshots.orgId} AS org_id
      FROM ${chatThreadSnapshots}
      WHERE ${lt(chatThreadSnapshots.updatedAt, staleCutoff)}
    )
  `;
}

function candidateScopesCte(
  db: SnapshotRootDb,
  staleCutoff: Date,
  batchSize: number,
  scope: SnapshotCompactionScope,
): SQL {
  return sql`
    candidate_scopes AS (
      SELECT
        scope.user_id,
        scope.org_id
      FROM all_scopes scope
      LEFT JOIN ${chatThreadSnapshots} ${snapshot}
        ON ${and(
          eq(snapshot.userId, sql`scope.user_id`),
          eq(snapshot.orgId, sql`scope.org_id`),
        )}
      LEFT JOIN LATERAL (
        SELECT event.id, event.seq_id
        FROM ${chatThreadEvents} ${event}
        WHERE ${and(
          eq(event.userId, sql`scope.user_id`),
          eq(event.orgId, sql`scope.org_id`),
          or(
            isNull(snapshot.latestEventSeqId),
            gt(event.seqId, snapshot.latestEventSeqId),
          ),
        )}
        ORDER BY ${desc(event.seqId)}
        LIMIT 1
      ) latest_event ON true
      WHERE ${and(
        or(
          isNull(snapshot.userId),
          isNull(snapshot.objectKey),
          isNotNull(sql`latest_event.id`),
          lt(snapshot.updatedAt, staleCutoff),
        ),
        snapshotScopePredicate(scope, sql`scope.user_id`, sql`scope.org_id`),
        // Selection only: do not let a closed scope occupy a bounded cron
        // batch forever. Admission inside the PUT transaction remains the
        // authority when this unlocked candidate read races closure.
        erasureSubjectOpenCondition(db, [
          { subjectKind: "user", subjectId: sql`scope.user_id` },
          { subjectKind: "organization", subjectId: sql`scope.org_id` },
        ]),
      )}
      ORDER BY
        ${asc(snapshot.updatedAt)} NULLS FIRST,
        latest_event.seq_id ASC NULLS FIRST,
        scope.user_id ASC,
        scope.org_id ASC
      LIMIT ${batchSize}
    )
  `;
}

function rebuiltCte(): SQL {
  return sql`
    rebuilt AS (
      SELECT
        scope.user_id,
        scope.org_id,
        COALESCE(latest_event.id, snapshot.latest_event_id) AS latest_event_id,
        COALESCE(
          latest_event.seq_id,
          snapshot.latest_event_seq_id
        ) AS latest_event_seq_id,
        COALESCE(thread_projection.chat_threads, '[]'::jsonb) AS chat_threads,
        snapshot.updated_at AS snapshot_updated_at,
        snapshot.object_key AS snapshot_object_key,
        snapshot.latest_event_seq_id AS snapshot_previous_seq_id,
        events_after_snapshot.count AS events_applied
      FROM candidate_scopes scope
      LEFT JOIN ${chatThreadSnapshots} ${snapshot}
        ON ${and(
          eq(snapshot.userId, sql`scope.user_id`),
          eq(snapshot.orgId, sql`scope.org_id`),
        )}
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', thread.id,
            'agentId', thread.agent_id,
            'title', thread.title,
            'sortAt', thread.last_message_at,
            'createdAt', thread.created_at,
            'updatedAt', thread.updated_at,
            'pinnedAt', thread.pinned_at,
            'pinOrder', thread.pin_order,
            'renamedAt', thread.renamed_at,
            'selectedModel', thread.selected_model,
            'modelSettings', thread.model_settings,
            'serviceTier', CASE
              WHEN ${eq(thread.codexServiceTier, sql`'fast'`)} THEN 'priority'
              ELSE NULL
            END,
            'computerUseHostId', thread.computer_use_host_id,
            'cloudBrowserEnabled', thread.cloud_browser_enabled,
            'selectedVideoModel', thread.selected_video_model,
            'selectedImageModel', thread.selected_image_model
          )
          ORDER BY
            ${asc(isNull(thread.pinnedAt))},
            ${desc(thread.lastMessageAt)},
            ${desc(thread.id)}
        ) AS chat_threads
        FROM ${chatThreads} ${thread}
        INNER JOIN ${agents} ${agent}
          ON ${eq(agent.id, thread.agentId)}
        WHERE ${and(
          eq(thread.userId, sql`scope.user_id`),
          eq(agent.orgId, sql`scope.org_id`),
        )}
      ) thread_projection ON true
      LEFT JOIN LATERAL (
        SELECT event.id, event.seq_id
        FROM ${chatThreadEvents} ${event}
        WHERE ${and(
          eq(event.userId, sql`scope.user_id`),
          eq(event.orgId, sql`scope.org_id`),
          or(
            isNull(snapshot.latestEventSeqId),
            gt(event.seqId, snapshot.latestEventSeqId),
          ),
        )}
        ORDER BY ${desc(event.seqId)}
        LIMIT 1
      ) latest_event ON true
      LEFT JOIN LATERAL (
        SELECT ${count()}::int AS count
        FROM ${chatThreadEvents} ${event}
        WHERE ${and(
          eq(event.userId, sql`scope.user_id`),
          eq(event.orgId, sql`scope.org_id`),
          or(
            isNull(snapshot.latestEventSeqId),
            gt(event.seqId, snapshot.latestEventSeqId),
          ),
        )}
      ) events_after_snapshot ON true
    )
  `;
}

function chatThreadSnapshotCandidatesSql(args: {
  readonly db: SnapshotRootDb;
  readonly staleCutoff: Date;
  readonly batchSize: number;
  readonly scope: SnapshotCompactionScope;
}): SQL {
  return sql`
    WITH ${allScopesCte(args.staleCutoff)},
    ${candidateScopesCte(args.db, args.staleCutoff, args.batchSize, args.scope)},
    ${rebuiltCte()}
    SELECT
      rebuilt.user_id AS "userId",
      rebuilt.org_id AS "orgId",
      rebuilt.latest_event_id AS "latestEventId",
      rebuilt.latest_event_seq_id AS "latestSeqId",
      rebuilt.chat_threads AS "chatThreads",
      rebuilt.snapshot_updated_at AS "previousUpdatedAt",
      rebuilt.snapshot_object_key AS "previousObjectKey",
      rebuilt.snapshot_previous_seq_id AS "previousSeqId",
      rebuilt.events_applied AS "eventsApplied"
    FROM rebuilt
  `;
}

type SnapshotCandidate = z.infer<typeof snapshotCandidateRowSchema>;

async function publishChatThreadSnapshot(
  db: SnapshotRootDb,
  candidate: SnapshotCandidate,
  objectKey: string,
): Promise<boolean> {
  const updatedAt = nowDate();
  const publication =
    candidate.previousUpdatedAt === null
      ? sql`
          WITH published AS (
            INSERT INTO ${chatThreadSnapshots} (
              user_id, org_id, latest_event_id, latest_event_seq_id,
              chat_threads, object_key, created_at, updated_at
            )
            SELECT
              ${candidate.userId}, ${candidate.orgId},
              ${sql.param(candidate.latestEventId, chatThreadSnapshots.latestEventId)},
              ${sql.param(candidate.latestSeqId, chatThreadSnapshots.latestEventSeqId)},
              '[]'::jsonb, ${objectKey},
              ${sql.param(updatedAt, chatThreadSnapshots.createdAt)},
              ${sql.param(updatedAt, chatThreadSnapshots.updatedAt)}
            WHERE EXISTS (
              SELECT 1 FROM ${chatThreads} ${thread}
              INNER JOIN ${agents} ${agent} ON ${eq(agent.id, thread.agentId)}
              WHERE ${and(
                eq(thread.userId, candidate.userId),
                eq(agent.orgId, candidate.orgId),
              )}
            ) OR EXISTS (
              SELECT 1 FROM ${chatThreadEvents} ${event}
              WHERE ${and(
                eq(event.userId, candidate.userId),
                eq(event.orgId, candidate.orgId),
              )}
            )
            ON CONFLICT (user_id, org_id) DO NOTHING
            RETURNING 1
          )
          SELECT ${count()}::int AS "published" FROM published
        `
      : sql`
          WITH published AS (
            UPDATE ${chatThreadSnapshots}
            SET
              latest_event_id = ${sql.param(candidate.latestEventId, chatThreadSnapshots.latestEventId)},
              latest_event_seq_id = ${sql.param(candidate.latestSeqId, chatThreadSnapshots.latestEventSeqId)},
              chat_threads = '[]'::jsonb,
              object_key = ${objectKey},
              updated_at = ${sql.param(updatedAt, chatThreadSnapshots.updatedAt)}
            WHERE ${and(
              eq(chatThreadSnapshots.userId, candidate.userId),
              eq(chatThreadSnapshots.orgId, candidate.orgId),
              eq(chatThreadSnapshots.updatedAt, candidate.previousUpdatedAt),
            )}
              AND ${chatThreadSnapshots.objectKey} IS NOT DISTINCT FROM ${candidate.previousObjectKey}
              AND ${chatThreadSnapshots.latestEventSeqId} IS NOT DISTINCT FROM ${sql.param(candidate.previousSeqId, chatThreadSnapshots.latestEventSeqId)}
            RETURNING 1
          )
          SELECT ${count()}::int AS "published" FROM published
        `;
  const [row] = await executeRawRows(db, publication, publishedRowSchema);
  return row?.published === 1;
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

async function compactChatThreadSnapshotBatch(
  db: Db,
  batchSize: number,
  scope: SnapshotCompactionScope,
  storage: SnapshotStorage,
  signal?: AbortSignal,
): Promise<Omit<SnapshotCompactionStats, "eventsPruned">> {
  const staleCutoff = new Date(
    nowDate().getTime() - CHAT_THREAD_SNAPSHOT_STALE_MS,
  );
  const candidates = await executeRawRows(
    db,
    chatThreadSnapshotCandidatesSql({
      db,
      staleCutoff,
      batchSize,
      scope,
    }),
    snapshotCandidateRowSchema,
  );
  const published = await mapConcurrent(
    candidates,
    CHAT_THREAD_SNAPSHOT_PUBLISH_CONCURRENCY,
    async (candidate) => {
      signal?.throwIfAborted();
      const chatThreads = chatThreadSnapshotArchiveSchema.parse({
        chatThreads: candidate.chatThreads.map((thread) => {
          return {
            ...thread,
            modelSettings: modelSettingsSchema.parse(
              thread.modelSettings ?? {},
            ),
          };
        }),
      }).chatThreads;
      const compressed = await gzipAsync(
        Buffer.from(JSON.stringify({ chatThreads })),
      );
      const objectKey = chatThreadSnapshotObjectKey({
        userId: candidate.userId,
        orgId: candidate.orgId,
        latestSeqId: candidate.latestSeqId,
        body: compressed,
      });
      // A candidate can outlive its SELECT. Take the existing D1 shared
      // admission before the external PUT, retain it through publication, and
      // let subject closure wait for an already-admitted PUT to settle. A
      // candidate resumed after closure must not put any bytes at all.
      return await db.transaction(async (tx) => {
        await assertErasureSubjectWritable(tx, [
          { subjectKind: "user", subjectId: candidate.userId },
          { subjectKind: "organization", subjectId: candidate.orgId },
        ]);
        signal?.throwIfAborted();
        await storage.upload(objectKey, compressed);
        signal?.throwIfAborted();
        return (await publishChatThreadSnapshot(tx, candidate, objectKey))
          ? candidate
          : null;
      });
    },
  );
  let scopes = 0;
  let eventsApplied = 0;
  for (const candidate of published) {
    if (candidate === null) {
      continue;
    }
    scopes += 1;
    eventsApplied += candidate.eventsApplied;
  }
  return { scopes, eventsApplied };
}

export async function compactChatThreadSnapshotsForScope(
  db: Db,
  scope: SnapshotCompactionScope,
  storage: SnapshotStorage,
  signal?: AbortSignal,
): Promise<SnapshotCompactionStats> {
  const snapshotBatchSize = chatThreadSnapshotBatchSize();
  const eventPruneBatchSize = chatThreadEventPruneBatchSize();
  const compacted = await compactChatThreadSnapshotBatch(
    db,
    snapshotBatchSize,
    scope,
    storage,
    signal,
  );

  signal?.throwIfAborted();
  const cutoff = new Date(nowDate().getTime() - CHAT_THREAD_EVENT_RETENTION_MS);
  const pruned = await executeRawRows(
    db,
    sql`
      WITH prune_candidates AS MATERIALIZED (
        SELECT ${event.id}
        FROM ${chatThreadEvents} ${event}
        INNER JOIN ${chatThreadSnapshots} ${snapshot}
          ON ${and(
            eq(snapshot.userId, event.userId),
            eq(snapshot.orgId, event.orgId),
          )}
        WHERE ${and(
          snapshotScopePredicate(scope, event.userId, event.orgId),
          isNotNull(snapshot.latestEventSeqId),
          lt(event.createdAt, cutoff),
          lte(event.seqId, snapshot.latestEventSeqId),
        )}
        ORDER BY
          ${asc(event.createdAt)},
          ${asc(event.userId)},
          ${asc(event.orgId)},
          ${asc(event.seqId)},
          ${asc(event.id)}
        LIMIT ${eventPruneBatchSize}
        FOR UPDATE OF event SKIP LOCKED
      ),
      pruned AS (
        DELETE FROM ${chatThreadEvents} ${event}
        USING prune_candidates
        WHERE ${eq(event.id, sql`prune_candidates.id`)}
        RETURNING 1
      )
      SELECT ${count()}::int AS "count"
      FROM pruned
    `,
    prunedEventsRowSchema,
  );

  if (scope.kind === "global") {
    await collectChatThreadSnapshotGarbage(db, storage, signal);
  }

  return {
    scopes: compacted.scopes,
    eventsApplied: compacted.eventsApplied,
    eventsPruned: pruned[0]?.count ?? 0,
  };
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
