import { command, type Write } from "ccstate";
import { int, object } from "zod";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  lte,
  notExists,
  sql,
  type SQL,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { agents } from "@okouai/db/schema/agent";
import {
  chatEventSearchMessages,
  chatEventSearchMessageWatermarks,
} from "@okouai/db/schema/chat-event-search";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSequences } from "@okouai/db/schema/chat-event-sequence";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatSearchIndexText } from "../../lib/chat-search-bigram";
import { parseRawRows } from "../../lib/db-raw-rows";
import { optionalEnv } from "../../lib/env";
import { writeDb$ } from "../external/db";
import {
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./chat-user-message.service";
import {
  canonicalChatEventContent,
  canonicalChatEventUserMessage,
} from "./canonical-chat-event-read.service";
import { visibleChatEventCondition } from "./chat-event-shared.service";

interface ChatEventSearchProjectionStats {
  readonly threads: number;
  readonly indexedEvents: number;
  readonly deletedDocs: number;
  readonly orphanedThreads: number;
  readonly convergence: ChatEventSearchProjectionConvergence;
}

interface ChatEventSearchProjectionConvergence {
  readonly eligibleThreads: number;
  readonly durableCaughtUpThreads: number;
}

interface CandidateThread {
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
}

interface ThreadProjectionStats {
  readonly thread: number;
  readonly indexedEvents: number;
  readonly deletedDocs: number;
}

interface SearchMessageProjection {
  readonly role: SearchableRole;
  readonly text: string;
  readonly textBigram: string;
}

interface ThreadProjectionProgress {
  readonly lagging: boolean;
  readonly rows: readonly ProjectionRow[];
}

interface SearchProjectionBatch {
  readonly messages: CanonicalSearchMessageInsert[];
  readonly revokedEventIds: string[];
}

interface SearchProjectionWriteStats {
  readonly indexedEvents: number;
  readonly deletedDocs: number;
}

type SearchableRole = "user" | "assistant";
interface CanonicalSearchMessageInsert {
  readonly chatThreadId: string;
  readonly seqId: number;
  readonly runId: string | null;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly role: SearchableRole;
  readonly createdAt: Date;
  readonly text: string;
  readonly textBigram: string;
}

const DEFAULT_THREAD_BATCH_SIZE = 500;
const THREAD_EVENT_LIMIT = 1000;

function chatEventSearchThreadBatchSize(): number {
  const raw = optionalEnv("CHAT_EVENT_SEARCH_PROJECTION_BATCH_SIZE");
  if (raw === undefined) {
    return DEFAULT_THREAD_BATCH_SIZE;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      "CHAT_EVENT_SEARCH_PROJECTION_BATCH_SIZE must be a positive integer",
    );
  }
  return parsed;
}

function searchMessageRole(eventType: string): SearchableRole | null {
  if (eventType === "input.prompt" || eventType === "input.rejected") {
    return "user";
  }
  if (eventType === "output.message") {
    return "assistant";
  }
  return null;
}

function searchMessageText(row: {
  readonly eventType: (typeof chatEvents.$inferSelect)["eventType"];
  readonly content: string | null;
  readonly userMessage: UserMessageDocument | null;
}): string | null {
  const userMessage = requiredUserMessageForEvent(
    row.eventType,
    row.userMessage,
  );
  const text = userMessage
    ? projectUserMessage(userMessage).displayText
    : row.content;
  const trimmed = text?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function searchMessageProjection(row: {
  readonly runId: string | null;
  readonly eventType: (typeof chatEvents.$inferSelect)["eventType"];
  readonly content: string | null;
  readonly userMessage: UserMessageDocument | null;
}): SearchMessageProjection | null {
  const role = searchMessageRole(row.eventType);
  if (role === null) {
    return null;
  }
  const text = searchMessageText(row);
  if (text === null) {
    return null;
  }
  return { role, text, textBigram: chatSearchIndexText(text) };
}

type ProjectionRow = Pick<
  typeof chatEvents.$inferSelect,
  "id" | "runId" | "eventType" | "revokesEventId" | "seqId" | "createdAt"
> & {
  content: string | null;
  userMessage: UserMessageDocument | null;
};

function nextProjectionWatermark(
  rows: readonly ProjectionRow[],
  lastChatEventSeqId: number,
): number {
  const lastRow = rows[rows.length - 1];
  return rows.length < THREAD_EVENT_LIMIT
    ? Math.max(lastRow?.seqId ?? 0, lastChatEventSeqId)
    : (lastRow?.seqId ?? lastChatEventSeqId);
}

function collectSearchMessageProjections(rows: readonly ProjectionRow[]): {
  readonly projectionByEventId: ReadonlyMap<string, SearchMessageProjection>;
  readonly revokedEventIds: Set<string>;
} {
  const revokedEventIds = new Set<string>();
  const projectionByEventId = new Map<string, SearchMessageProjection>();
  for (const row of rows) {
    if (row.revokesEventId !== null) {
      revokedEventIds.add(row.revokesEventId);
    }
    const projection = searchMessageProjection(row);
    if (projection !== null) {
      projectionByEventId.set(row.id, projection);
    }
  }
  return { projectionByEventId, revokedEventIds };
}

function searchMessage(
  row: ProjectionRow,
  thread: CandidateThread,
  projections: ReadonlyMap<string, SearchMessageProjection>,
  visibleEventIds: ReadonlySet<string>,
): CanonicalSearchMessageInsert | null {
  const projection = projections.get(row.id);
  if (!projection || !visibleEventIds.has(row.id)) {
    return null;
  }
  return {
    chatThreadId: thread.chatThreadId,
    seqId: row.seqId,
    runId: row.runId,
    orgId: thread.orgId,
    userId: thread.userId,
    agentId: thread.agentId,
    role: projection.role,
    createdAt: row.createdAt,
    text: projection.text,
    textBigram: projection.textBigram,
  };
}

function emptyThreadProjectionStats(): ThreadProjectionStats {
  return {
    thread: 0,
    indexedEvents: 0,
    deletedDocs: 0,
  };
}

function projectionThreadSelection() {
  return {
    lastChatEventSeqId:
      sql`COALESCE(${chatEventSequences.lastSeqId}, 0)`.mapWith(
        chatEventSequences.lastSeqId,
      ),
  };
}

function projectionRowSelection() {
  return {
    id: chatEvents.id,
    runId: chatEvents.runId,
    eventType: chatEvents.eventType,
    content: canonicalChatEventContent(),
    userMessage: canonicalChatEventUserMessage(),
    revokesEventId: chatEvents.revokesEventId,
    seqId: chatEvents.seqId,
    createdAt: chatEvents.createdAt,
  };
}

function searchEventVisibilityCondition(eventIds: readonly string[]) {
  return and(
    inArray(chatEvents.id, [...eventIds]),
    visibleChatEventCondition(),
  );
}

function projectionRowRangeCondition(
  chatThreadId: string,
  indexedSeqId: number,
) {
  return and(
    eq(chatEvents.chatThreadId, chatThreadId),
    gt(chatEvents.seqId, indexedSeqId),
  );
}

function searchProjectionBatch(
  rows: readonly ProjectionRow[],
  thread: CandidateThread,
  projections: ReadonlyMap<string, SearchMessageProjection>,
  visibleEventIds: ReadonlySet<string>,
  revokedEventIds: ReadonlySet<string>,
): SearchProjectionBatch {
  return {
    messages: rows.flatMap((row) => {
      const message = searchMessage(row, thread, projections, visibleEventIds);
      return message ? [message] : [];
    }),
    revokedEventIds: [...revokedEventIds],
  };
}

function searchProjectionWatermark(
  chatThreadId: string,
  lastChatEventSeqId: number,
  progress: ThreadProjectionProgress,
) {
  return {
    chatThreadId,
    indexedSeqId: nextProjectionWatermark(progress.rows, lastChatEventSeqId),
  };
}

function searchProjectionCommitSql(
  batch: SearchProjectionBatch,
  watermark: ReturnType<typeof searchProjectionWatermark> | null,
) {
  const messages = batch.messages.map((message) => {
    return {
      chat_thread_id: message.chatThreadId,
      seq_id: message.seqId,
      run_id: message.runId,
      user_id: message.userId,
      org_id: message.orgId,
      agent_id: message.agentId,
      role: message.role,
      created_at: message.createdAt.toISOString(),
      text: message.text,
      text_bigram: message.textBigram,
    };
  });
  return sql`SELECT indexed_events AS "indexedEvents", deleted_docs AS "deletedDocs"
    FROM public.publish_chat_event_search_projection(
      ${JSON.stringify(messages)}::jsonb,
      ${sql.param(batch.revokedEventIds)}::uuid[],
      ${watermark?.chatThreadId ?? null}::uuid,
      ${watermark?.indexedSeqId ?? null}::bigint
    )`;
}

const searchProjectionWriteSchema = object({
  indexedEvents: int().nonnegative(),
  deletedDocs: int().nonnegative(),
});

function threadProjectionStats(
  progress: ThreadProjectionProgress,
  writes: SearchProjectionWriteStats,
): ThreadProjectionStats {
  return {
    thread: progress.lagging ? 1 : 0,
    indexedEvents: writes.indexedEvents,
    deletedDocs: writes.deletedDocs,
  };
}

async function projectThread(
  {
    set,
  }: Parameters<Write<Promise<ThreadProjectionStats>, [CandidateThread]>>[0],
  thread: CandidateThread,
): Promise<ThreadProjectionStats> {
  const db = set(writeDb$);
  const chatThreadId = thread.chatThreadId;
  const projectionThread = await (async (): Promise<{
    readonly lastChatEventSeqId: number;
  } | null> => {
    const [thread] = await db
      .select(projectionThreadSelection())
      .from(chatThreads)
      .leftJoin(
        chatEventSequences,
        eq(chatEventSequences.chatThreadId, chatThreads.id),
      )
      .where(eq(chatThreads.id, chatThreadId))
      .limit(1);
    return thread ?? null;
  })();
  if (!projectionThread) {
    return emptyThreadProjectionStats();
  }
  const lastChatEventSeqId = projectionThread.lastChatEventSeqId;
  const progress = await (async (): Promise<ThreadProjectionProgress> => {
    const [progress] = await db
      .select({ indexedSeqId: chatEventSearchMessageWatermarks.indexedSeqId })
      .from(chatEventSearchMessageWatermarks)
      .where(eq(chatEventSearchMessageWatermarks.chatThreadId, chatThreadId))
      .limit(1);
    const indexedSeqId = progress?.indexedSeqId ?? 0;
    const lagging = lastChatEventSeqId > indexedSeqId;
    const rows = lagging
      ? await (async () => {
          return await db
            .select(projectionRowSelection())
            .from(chatEvents)
            .where(projectionRowRangeCondition(chatThreadId, indexedSeqId))
            .orderBy(asc(chatEvents.seqId))
            .limit(THREAD_EVENT_LIMIT);
        })()
      : [];
    return { lagging, rows };
  })();

  const batch = await (async (): Promise<SearchProjectionBatch> => {
    // Any event type can revoke an earlier one. Resolve every target before
    // chat_events retention can remove its stable thread/sequence coordinate.
    const { projectionByEventId, revokedEventIds } =
      collectSearchMessageProjections(progress.rows);
    const eventIds = [...projectionByEventId.keys()];
    const visibleEventIds = await (async (): Promise<ReadonlySet<string>> => {
      if (eventIds.length === 0) {
        return new Set();
      }
      const rows = await db
        .select({ id: chatEvents.id })
        .from(chatEvents)
        .where(searchEventVisibilityCondition(eventIds));
      return new Set(
        rows.map((row) => {
          return row.id;
        }),
      );
    })();
    return searchProjectionBatch(
      progress.rows,
      thread,
      projectionByEventId,
      visibleEventIds,
      revokedEventIds,
    );
  })();
  const query = searchProjectionCommitSql(
    batch,
    progress.lagging
      ? searchProjectionWatermark(chatThreadId, lastChatEventSeqId, progress)
      : null,
  );
  const [writes] = parseRawRows(
    searchProjectionWriteSchema,
    await db.execute(query),
  );
  if (!writes) {
    throw new Error("Chat search projection returned no write result");
  }
  return threadProjectionStats(progress, writes);
}

const projectThread$ = command(projectThread);

/**
 * Removes a bounded set of derived rows whose canonical thread is gone.
 * A projector racing this cleanup can recreate an orphan after the selection;
 * the next cron tick will select it again.
 */
const cleanupOrphanedSearchProjection$ = command(
  async ({ set }): Promise<number> => {
    const db = set(writeDb$);
    const orphanedWatermarks = db.$with("orphaned_watermarks").as(
      db
        .select({ chatThreadId: chatEventSearchMessageWatermarks.chatThreadId })
        .from(chatEventSearchMessageWatermarks)
        .where(
          notExists(
            db
              .select({ id: chatThreads.id })
              .from(chatThreads)
              .where(
                eq(
                  chatThreads.id,
                  chatEventSearchMessageWatermarks.chatThreadId,
                ),
              ),
          ),
        )
        .orderBy(asc(chatEventSearchMessageWatermarks.chatThreadId))
        .limit(chatEventSearchThreadBatchSize()),
    );
    const selectedThreadIds = db
      .select({ chatThreadId: orphanedWatermarks.chatThreadId })
      .from(orphanedWatermarks);
    const deletedWatermarks = db.$with("deleted_watermarks").as(
      db
        .delete(chatEventSearchMessageWatermarks)
        .where(
          inArray(
            chatEventSearchMessageWatermarks.chatThreadId,
            selectedThreadIds,
          ),
        )
        .returning({
          chatThreadId: chatEventSearchMessageWatermarks.chatThreadId,
        }),
    );
    const watermarkDeletion = db
      .$with("watermark_deletion")
      .as(
        db
          .select({ orphanedThreads: count().as("orphaned_threads") })
          .from(deletedWatermarks),
      );
    // Consume the complete watermark DELETE before deleting messages. COUNT
    // still produces one row at zero: both deletes use the original selection
    // even when a competing cleaner already deleted its watermarks.
    const deletedMessages = db.$with("deleted_messages").as(
      db.delete(chatEventSearchMessages).where(
        and(
          inArray(chatEventSearchMessages.chatThreadId, selectedThreadIds),
          exists(
            db
              .select({
                orphanedThreads: watermarkDeletion.orphanedThreads,
              })
              .from(watermarkDeletion)
              .where(gte(watermarkDeletion.orphanedThreads, 0)),
          ),
        ),
      ),
    );
    const [stats] = await db
      .with(
        orphanedWatermarks,
        deletedWatermarks,
        watermarkDeletion,
        deletedMessages,
      )
      .select({ orphanedThreads: watermarkDeletion.orphanedThreads })
      .from(watermarkDeletion);
    if (!stats) {
      throw new Error("Orphaned chat search cleanup query returned no row");
    }
    return stats.orphanedThreads;
  },
);

function searchProjectionCandidateSource(batchSize: number): SQL {
  const query = new QueryBuilder();
  // Probe source IDs, not filtered candidates. The tail keeps this window
  // from becoming a business cutoff when pending threads are sparse.
  const sourceKeys = query
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .orderBy(asc(chatThreads.id))
    .limit(4 * batchSize)
    .as("source_keys");
  const bounds = query
    .select({ upperId: sourceKeys.id })
    .from(sourceKeys)
    .orderBy(desc(sourceKeys.id))
    .limit(1);
  const upperId = sql`(SELECT upper_id FROM bounds)`;
  const lagging = gt(
    chatEventSequences.lastSeqId,
    sql`COALESCE(${chatEventSearchMessageWatermarks.indexedSeqId}, 0)`,
  );
  const selection = {
    chatThreadId: chatThreads.id,
    userId: chatThreads.userId,
    orgId: agents.orgId,
    agentId: agents.id,
  };
  const head = query
    .select(selection)
    .from(chatThreads)
    .leftJoin(
      chatEventSequences,
      eq(chatEventSequences.chatThreadId, chatThreads.id),
    )
    .innerJoin(agents, eq(chatThreads.agentId, agents.id))
    .leftJoin(
      chatEventSearchMessageWatermarks,
      eq(chatEventSearchMessageWatermarks.chatThreadId, chatThreads.id),
    )
    .where(and(lagging, lte(chatThreads.id, upperId)))
    .orderBy(asc(chatThreads.id))
    .limit(batchSize);
  // Only narrow sequence/watermark metadata is scanned for tail membership;
  // thread and Agent rows are fetched after pending IDs have been found.
  const tailIds = query
    .select({ chatThreadId: chatEventSequences.chatThreadId })
    .from(chatEventSequences)
    .leftJoin(
      chatEventSearchMessageWatermarks,
      eq(
        chatEventSearchMessageWatermarks.chatThreadId,
        chatEventSequences.chatThreadId,
      ),
    )
    .where(and(gt(chatEventSequences.chatThreadId, upperId), lagging));
  const tail = query
    .select(selection)
    .from(chatThreads)
    .innerJoin(agents, eq(chatThreads.agentId, agents.id))
    .where(
      and(
        gt(chatThreads.id, upperId),
        sql`${chatThreads.id} = ANY(ARRAY(${tailIds}))`,
      ),
    )
    .orderBy(asc(chatThreads.id));
  // MATERIALIZED head and a runtime LIMIT keep the expensive tail (including
  // its ARRAY initplan) unexecuted when the head already fills the batch.
  // Both halves share one statement snapshot and disjoint ID ranges.
  return sql`(
    WITH bounds(upper_id) AS MATERIALIZED (${bounds}),
    head(thread_id, user_id, org_id, agent_id) AS MATERIALIZED (${head}),
    tail(thread_id, user_id, org_id, agent_id) AS MATERIALIZED (
      ${tail}
      LIMIT GREATEST(${batchSize} - (SELECT ${count()} FROM head), 0)
    )
    SELECT * FROM head
    UNION ALL
    SELECT * FROM tail
    ORDER BY thread_id ASC
    LIMIT ${batchSize}
  ) candidates`;
}

export const projectChatEventSearch$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<ChatEventSearchProjectionStats> => {
    const db = set(writeDb$);
    const orphanedThreads = await set(cleanupOrphanedSearchProjection$);
    signal.throwIfAborted();
    const candidateThreads = await db
      .select({
        chatThreadId: sql`candidates.thread_id`.mapWith(chatThreads.id),
        userId: sql`candidates.user_id`.mapWith(chatThreads.userId),
        orgId: sql`candidates.org_id`.mapWith(agents.orgId),
        agentId: sql`candidates.agent_id`.mapWith(agents.id),
      })
      .from(searchProjectionCandidateSource(chatEventSearchThreadBatchSize()))
      .orderBy(asc(sql`candidates.thread_id`));
    signal.throwIfAborted();

    let threads = 0;
    let indexedEvents = 0;
    let deletedDocs = 0;
    for (const thread of candidateThreads) {
      signal.throwIfAborted();
      const stats = await set(projectThread$, thread);
      signal.throwIfAborted();
      threads += stats.thread;
      indexedEvents += stats.indexedEvents;
      deletedDocs += stats.deletedDocs;
    }
    const convergence =
      await (async (): Promise<ChatEventSearchProjectionConvergence> => {
        // The sequence's cascading thread FK already guarantees a canonical parent.
        const eligibleScope = gt(chatEventSequences.lastSeqId, 0);
        const [stats] = await db
          .select({
            eligibleThreads: count(),
            durableCaughtUpThreads: count(
              chatEventSearchMessageWatermarks.chatThreadId,
            ),
          })
          .from(chatEventSequences)
          .leftJoin(
            chatEventSearchMessageWatermarks,
            and(
              eq(
                chatEventSearchMessageWatermarks.chatThreadId,
                chatEventSequences.chatThreadId,
              ),
              gte(
                chatEventSearchMessageWatermarks.indexedSeqId,
                chatEventSequences.lastSeqId,
              ),
            ),
          )
          .where(eligibleScope);
        if (!stats) {
          throw new Error(
            "Chat search projection convergence query returned no row",
          );
        }
        return stats;
      })();
    signal.throwIfAborted();
    return {
      threads,
      indexedEvents,
      deletedDocs,
      orphanedThreads,
      convergence,
    };
  },
);
