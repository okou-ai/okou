import { command } from "ccstate";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { chatThreadEvents } from "@okouai/db/schema/chat-thread-event";
import { chatThreadSnapshots } from "@okouai/db/schema/chat-thread-snapshot";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { z } from "zod";
import { executeRawRows } from "../../lib/db-raw-rows";
import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";

interface SnapshotCompactionStats {
  readonly scopes: number;
  readonly eventsApplied: number;
  readonly removedDeletedAgentThreads: number;
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

type SnapshotRootDb = Pick<Db, "execute" | "select" | "transaction">;
const CHAT_THREAD_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CHAT_THREAD_SNAPSHOT_BATCH_SIZE = 500;
const DEFAULT_CHAT_THREAD_EVENT_PRUNE_BATCH_SIZE = 500;
const CHAT_THREAD_SNAPSHOT_STALE_MS = 24 * 60 * 60 * 1000;
const snapshot = alias(chatThreadSnapshots, "snapshot");
const event = alias(chatThreadEvents, "event");
const thread = alias(chatThreads, "thread");
const agent = alias(agents, "agent");

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

const snapshotBatchRowSchema = z.object({
  scopes: z.int(),
  eventsApplied: z.int(),
  removedDeletedAgentThreads: z.int(),
});

const prunedEventsRowSchema = z.object({ count: z.int() });

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
          isNotNull(sql`latest_event.id`),
          lt(snapshot.updatedAt, staleCutoff),
        ),
        snapshotScopePredicate(scope, sql`scope.user_id`, sql`scope.org_id`),
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

function rebuiltCte(db: Pick<Db, "select">): SQL {
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
        events_after_snapshot.count AS events_applied,
        deleted_agent_threads.count AS removed_deleted_agent_threads
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
      LEFT JOIN LATERAL (
        SELECT ${count()}::int AS count
        FROM jsonb_array_elements(
          COALESCE(${snapshot.chatThreads}, '[]'::jsonb)
        ) AS old_thread(thread)
        WHERE ${notExists(
          db
            .select({ id: agent.id })
            .from(agent)
            .where(
              and(
                eq(agent.id, sql`(old_thread.thread ->> 'agentId')::uuid`),
                eq(agent.orgId, sql`scope.org_id`),
              ),
            ),
        )}
        ) deleted_agent_threads ON true
    )
  `;
}

function upsertedCte(updatedAt: Date): SQL {
  return sql`
    upserted AS (
      INSERT INTO ${chatThreadSnapshots} (
        user_id,
        org_id,
        latest_event_id,
        latest_event_seq_id,
        chat_threads,
        created_at,
        updated_at
      )
      SELECT
        rebuilt.user_id,
        rebuilt.org_id,
        rebuilt.latest_event_id,
        rebuilt.latest_event_seq_id,
        rebuilt.chat_threads,
        ${sql.param(updatedAt, chatThreadSnapshots.createdAt)},
        ${sql.param(updatedAt, chatThreadSnapshots.updatedAt)}
      FROM rebuilt
      ON CONFLICT (user_id, org_id)
      DO UPDATE SET
        latest_event_id = CASE
          WHEN EXCLUDED.latest_event_seq_id IS NOT NULL
            AND (
              ${chatThreadSnapshots.latestEventSeqId} IS NULL
              OR EXCLUDED.latest_event_seq_id > ${chatThreadSnapshots.latestEventSeqId}
            )
          THEN EXCLUDED.latest_event_id
          ELSE ${chatThreadSnapshots.latestEventId}
        END,
        latest_event_seq_id = CASE
          WHEN EXCLUDED.latest_event_seq_id IS NOT NULL
            AND (
              ${chatThreadSnapshots.latestEventSeqId} IS NULL
              OR EXCLUDED.latest_event_seq_id > ${chatThreadSnapshots.latestEventSeqId}
            )
          THEN EXCLUDED.latest_event_seq_id
          ELSE ${chatThreadSnapshots.latestEventSeqId}
        END,
        chat_threads = EXCLUDED.chat_threads,
        updated_at = EXCLUDED.updated_at
      RETURNING user_id, org_id
    )
  `;
}

function compactChatThreadSnapshotBatchSql(
  db: Pick<Db, "select">,
  args: {
    readonly updatedAt: Date;
    readonly staleCutoff: Date;
    readonly batchSize: number;
    readonly scope: SnapshotCompactionScope;
  },
): SQL {
  return sql`
    WITH ${allScopesCte(args.staleCutoff)},
    ${candidateScopesCte(args.staleCutoff, args.batchSize, args.scope)},
    ${rebuiltCte(db)},
    ${upsertedCte(args.updatedAt)}
    SELECT
      ${count()}::int AS "scopes",
      COALESCE(SUM(rebuilt.events_applied), 0)::int AS "eventsApplied",
      COALESCE(SUM(rebuilt.removed_deleted_agent_threads), 0)::int AS "removedDeletedAgentThreads"
    FROM rebuilt
    INNER JOIN upserted
      ON upserted.user_id = rebuilt.user_id
     AND upserted.org_id = rebuilt.org_id
  `;
}

async function compactChatThreadSnapshotBatch(
  db: SnapshotRootDb,
  batchSize: number,
  scope: SnapshotCompactionScope,
): Promise<Omit<SnapshotCompactionStats, "eventsPruned">> {
  const updatedAt = nowDate();
  const staleCutoff = new Date(
    updatedAt.getTime() - CHAT_THREAD_SNAPSHOT_STALE_MS,
  );
  const rows = await executeRawRows(
    db,
    compactChatThreadSnapshotBatchSql(db, {
      updatedAt,
      staleCutoff,
      batchSize,
      scope,
    }),
    snapshotBatchRowSchema,
  );

  return {
    scopes: rows[0]?.scopes ?? 0,
    eventsApplied: rows[0]?.eventsApplied ?? 0,
    removedDeletedAgentThreads: rows[0]?.removedDeletedAgentThreads ?? 0,
  };
}

async function compactChatThreadSnapshotsForScope(
  db: SnapshotRootDb,
  scope: SnapshotCompactionScope,
  signal?: AbortSignal,
): Promise<SnapshotCompactionStats> {
  const snapshotBatchSize = chatThreadSnapshotBatchSize();
  const eventPruneBatchSize = chatThreadEventPruneBatchSize();
  const compacted = await db.transaction(
    async (tx) => {
      return await compactChatThreadSnapshotBatch(tx, snapshotBatchSize, scope);
    },
    { isolationLevel: "repeatable read" },
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

  return {
    scopes: compacted.scopes,
    eventsApplied: compacted.eventsApplied,
    removedDeletedAgentThreads: compacted.removedDeletedAgentThreads,
    eventsPruned: pruned[0]?.count ?? 0,
  };
}

export const compactChatThreadSnapshots$ = command(
  async (
    { set },
    scope: SnapshotCompactionScope,
    signal: AbortSignal,
  ): Promise<SnapshotCompactionStats> => {
    return await compactChatThreadSnapshotsForScope(
      set(writeDb$),
      scope,
      signal,
    );
  },
);
