import { command } from "ccstate";
import {
  and,
  asc,
  count,
  eq,
  exists,
  gt,
  gte,
  inArray,
  notExists,
  sql,
} from "drizzle-orm";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { isRetiredGoalArchiveText } from "@okouai/api-contracts/contracts/retired-goal-archive";
import { agents } from "@okouai/db/schema/agent";
import {
  chatEventSearchMessages,
  chatEventSearchMessageWatermarks,
} from "@okouai/db/schema/chat-event-search";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSequences } from "@okouai/db/schema/chat-event-sequence";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatSearchIndexText } from "../../lib/chat-search-bigram";
import type { Tx } from "../../lib/db-types";
import { optionalEnv } from "../../lib/env";
import { writeDb$, type Db } from "../external/db";
import {
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./chat-user-message.service";
import {
  canonicalChatEventVisibleContent,
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

interface ChatEventSearchProjectionOptions {
  readonly chatThreadIds?: readonly string[];
}

interface ChatEventSearchTestProjectionOptions {
  readonly chatThreadIds: readonly string[];
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
  readonly runId: string | null;
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
  // The canonical row projection already checked the full raw provenance.
  // Preserve the historical objective's trailing whitespace as well.
  if (
    row.eventType === "output.message" &&
    row.runId === null &&
    text !== null &&
    isRetiredGoalArchiveText(text)
  ) {
    return text;
  }
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

async function loadProjectionRows(
  tx: Tx,
  chatThreadId: string,
  indexedSeqId: number,
) {
  return await tx
    .select({
      id: chatEvents.id,
      runId: chatEvents.runId,
      eventType: chatEvents.eventType,
      content: canonicalChatEventVisibleContent(),
      userMessage: canonicalChatEventUserMessage(),
      revokesEventId: chatEvents.revokesEventId,
      seqId: chatEvents.seqId,
      createdAt: chatEvents.createdAt,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, chatThreadId),
        gt(chatEvents.seqId, indexedSeqId),
      ),
    )
    .orderBy(asc(chatEvents.seqId))
    .limit(THREAD_EVENT_LIMIT);
}

type ProjectionRow = Awaited<ReturnType<typeof loadProjectionRows>>[number];

function nextProjectionWatermark(
  rows: readonly ProjectionRow[],
  lastChatEventSeqId: number,
): number {
  const lastRow = rows[rows.length - 1];
  return rows.length < THREAD_EVENT_LIMIT
    ? Math.max(lastRow?.seqId ?? 0, lastChatEventSeqId)
    : (lastRow?.seqId ?? lastChatEventSeqId);
}

async function visibleSearchEventIds(
  tx: Tx,
  eventIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (eventIds.length === 0) {
    return new Set();
  }
  const rows = await tx
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(
      and(inArray(chatEvents.id, [...eventIds]), visibleChatEventCondition(tx)),
    );
  return new Set(
    rows.map((row) => {
      return row.id;
    }),
  );
}

async function loadProjectionThread(
  tx: Tx,
  chatThreadId: string,
): Promise<{ readonly lastChatEventSeqId: number } | null> {
  const [thread] = await tx
    .select({
      lastChatEventSeqId:
        sql`COALESCE(${chatEventSequences.lastSeqId}, 0)`.mapWith(
          chatEventSequences.lastSeqId,
        ),
    })
    .from(chatThreads)
    .leftJoin(
      chatEventSequences,
      eq(chatEventSequences.chatThreadId, chatThreads.id),
    )
    .where(eq(chatThreads.id, chatThreadId))
    .limit(1);
  return thread ?? null;
}

async function loadThreadProjectionProgress(
  tx: Tx,
  chatThreadId: string,
  lastChatEventSeqId: number,
): Promise<ThreadProjectionProgress> {
  const [progress] = await tx
    .select({ indexedSeqId: chatEventSearchMessageWatermarks.indexedSeqId })
    .from(chatEventSearchMessageWatermarks)
    .where(eq(chatEventSearchMessageWatermarks.chatThreadId, chatThreadId))
    .limit(1);
  const indexedSeqId = progress?.indexedSeqId ?? 0;
  const lagging = lastChatEventSeqId > indexedSeqId;
  const rows = lagging
    ? await loadProjectionRows(tx, chatThreadId, indexedSeqId)
    : [];
  return { lagging, rows };
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

async function buildSearchProjectionBatch(
  tx: Tx,
  thread: CandidateThread,
  progress: ThreadProjectionProgress,
): Promise<SearchProjectionBatch> {
  // Any event type can revoke an earlier one. Resolve every target before
  // chat_events retention can remove its stable thread/sequence coordinate.
  const { projectionByEventId, revokedEventIds } =
    collectSearchMessageProjections(progress.rows);
  const visibleEventIds = await visibleSearchEventIds(tx, [
    ...projectionByEventId.keys(),
  ]);
  return {
    messages: progress.rows.flatMap((row) => {
      const message = searchMessage(
        row,
        thread,
        projectionByEventId,
        visibleEventIds,
      );
      return message ? [message] : [];
    }),
    revokedEventIds: [...revokedEventIds],
  };
}

async function insertSearchMessages(
  tx: Tx,
  messages: readonly CanonicalSearchMessageInsert[],
): Promise<number> {
  if (messages.length === 0) {
    return 0;
  }
  const indexed = await tx
    .insert(chatEventSearchMessages)
    .values([...messages])
    .onConflictDoNothing({
      target: [
        chatEventSearchMessages.chatThreadId,
        chatEventSearchMessages.seqId,
      ],
    })
    .returning({ seqId: chatEventSearchMessages.seqId });
  return indexed.length;
}

async function deleteRevokedMessages(
  tx: Tx,
  revokedEventIds: readonly string[],
): Promise<number> {
  if (revokedEventIds.length === 0) {
    return 0;
  }
  const deleted = await tx
    .delete(chatEventSearchMessages)
    .where(
      exists(
        tx
          .select({ id: chatEvents.id })
          .from(chatEvents)
          .where(
            and(
              inArray(chatEvents.id, [...revokedEventIds]),
              eq(chatEvents.chatThreadId, chatEventSearchMessages.chatThreadId),
              eq(chatEvents.seqId, chatEventSearchMessages.seqId),
            ),
          ),
      ),
    )
    .returning({
      chatThreadId: chatEventSearchMessages.chatThreadId,
      seqId: chatEventSearchMessages.seqId,
    });
  return deleted.length;
}

async function writeSearchProjectionBatch(
  tx: Tx,
  batch: SearchProjectionBatch,
): Promise<SearchProjectionWriteStats> {
  const indexedEvents = await insertSearchMessages(tx, batch.messages);
  const deletedDocs = await deleteRevokedMessages(tx, batch.revokedEventIds);
  return { indexedEvents, deletedDocs };
}

async function advanceProjectionWatermark(
  tx: Tx,
  chatThreadId: string,
  lastChatEventSeqId: number,
  progress: ThreadProjectionProgress,
): Promise<void> {
  if (!progress.lagging) {
    return;
  }
  await tx
    .insert(chatEventSearchMessageWatermarks)
    .values({
      chatThreadId,
      indexedSeqId: nextProjectionWatermark(progress.rows, lastChatEventSeqId),
    })
    .onConflictDoUpdate({
      target: chatEventSearchMessageWatermarks.chatThreadId,
      set: {
        indexedSeqId: sql`GREATEST(${chatEventSearchMessageWatermarks.indexedSeqId}, EXCLUDED.indexed_seq_id)`,
      },
    });
}

function emptyThreadProjectionStats(): ThreadProjectionStats {
  return {
    thread: 0,
    indexedEvents: 0,
    deletedDocs: 0,
  };
}

async function projectThread(
  db: Db,
  thread: CandidateThread,
): Promise<ThreadProjectionStats> {
  return await db.transaction(async (tx) => {
    const projectionThread = await loadProjectionThread(
      tx,
      thread.chatThreadId,
    );
    if (!projectionThread) {
      return emptyThreadProjectionStats();
    }
    const progress = await loadThreadProjectionProgress(
      tx,
      thread.chatThreadId,
      projectionThread.lastChatEventSeqId,
    );

    const batch = await buildSearchProjectionBatch(tx, thread, progress);
    const writes = await writeSearchProjectionBatch(tx, batch);
    await advanceProjectionWatermark(
      tx,
      thread.chatThreadId,
      projectionThread.lastChatEventSeqId,
      progress,
    );

    return {
      thread: progress.lagging ? 1 : 0,
      indexedEvents: writes.indexedEvents,
      deletedDocs: writes.deletedDocs,
    };
  });
}

function projectionThreadScope(chatThreadIds: readonly string[] | undefined) {
  return chatThreadIds === undefined
    ? undefined
    : inArray(chatThreads.id, [...chatThreadIds]);
}

function projectionWatermarkScope(
  chatThreadIds: readonly string[] | undefined,
) {
  return chatThreadIds === undefined
    ? undefined
    : inArray(chatEventSearchMessageWatermarks.chatThreadId, [
        ...chatThreadIds,
      ]);
}

/**
 * Removes a bounded set of derived rows whose canonical thread is gone.
 * A projector racing this cleanup can recreate an orphan after the selection;
 * the next cron tick will select it again.
 */
async function cleanupOrphanedSearchProjection(
  db: Db,
  options: ChatEventSearchProjectionOptions,
): Promise<number> {
  return await db.transaction(async (tx) => {
    const orphanedWatermarks = await tx
      .select({ chatThreadId: chatEventSearchMessageWatermarks.chatThreadId })
      .from(chatEventSearchMessageWatermarks)
      .where(
        and(
          projectionWatermarkScope(options.chatThreadIds),
          notExists(
            tx
              .select({ id: chatThreads.id })
              .from(chatThreads)
              .where(
                eq(
                  chatThreads.id,
                  chatEventSearchMessageWatermarks.chatThreadId,
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(chatEventSearchMessageWatermarks.chatThreadId))
      .limit(chatEventSearchThreadBatchSize());
    if (orphanedWatermarks.length === 0) {
      return 0;
    }

    const chatThreadIds = orphanedWatermarks.map((watermark) => {
      return watermark.chatThreadId;
    });
    // The watermark is the repair anchor. Remove it first so a racing projector
    // either commits before the message delete or recreates a discoverable
    // watermark after this transaction.
    const deletedWatermarks = await tx
      .delete(chatEventSearchMessageWatermarks)
      .where(
        inArray(chatEventSearchMessageWatermarks.chatThreadId, chatThreadIds),
      )
      .returning({
        chatThreadId: chatEventSearchMessageWatermarks.chatThreadId,
      });
    await tx
      .delete(chatEventSearchMessages)
      .where(inArray(chatEventSearchMessages.chatThreadId, chatThreadIds));
    return deletedWatermarks.length;
  });
}

async function loadCandidateThreads(
  db: Pick<Db, "select">,
  options: ChatEventSearchProjectionOptions,
): Promise<readonly CandidateThread[]> {
  const threadScope = projectionThreadScope(options.chatThreadIds);
  return await db
    .select({
      chatThreadId: chatThreads.id,
      userId: chatThreads.userId,
      orgId: agents.orgId,
      agentId: agents.id,
    })
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
    .where(
      and(
        threadScope,
        gt(
          chatEventSequences.lastSeqId,
          sql`COALESCE(${chatEventSearchMessageWatermarks.indexedSeqId}, 0)`,
        ),
      ),
    )
    .orderBy(asc(chatThreads.id))
    .limit(chatEventSearchThreadBatchSize());
}

async function projectionConvergence(
  db: Pick<Db, "select">,
  options: ChatEventSearchProjectionOptions,
): Promise<ChatEventSearchProjectionConvergence> {
  const eligibleScope = and(
    projectionThreadScope(options.chatThreadIds),
    gt(chatEventSequences.lastSeqId, 0),
  );
  const [stats] = await db
    .select({
      eligibleThreads: count(),
      durableCaughtUpThreads: count(
        chatEventSearchMessageWatermarks.chatThreadId,
      ),
    })
    .from(chatThreads)
    .leftJoin(
      chatEventSequences,
      eq(chatEventSequences.chatThreadId, chatThreads.id),
    )
    .leftJoin(
      chatEventSearchMessageWatermarks,
      and(
        eq(chatEventSearchMessageWatermarks.chatThreadId, chatThreads.id),
        gte(
          chatEventSearchMessageWatermarks.indexedSeqId,
          chatEventSequences.lastSeqId,
        ),
      ),
    )
    .where(eligibleScope);
  if (!stats) {
    throw new Error("Chat search projection convergence query returned no row");
  }
  return stats;
}

async function projectChatEventSearch(
  db: Db,
  options: ChatEventSearchProjectionOptions,
  signal: AbortSignal,
): Promise<ChatEventSearchProjectionStats> {
  const orphanedThreads = await cleanupOrphanedSearchProjection(db, options);
  signal.throwIfAborted();
  const candidateThreads = await loadCandidateThreads(db, options);
  signal.throwIfAborted();

  let threads = 0;
  let indexedEvents = 0;
  let deletedDocs = 0;
  for (const thread of candidateThreads) {
    signal.throwIfAborted();
    const stats = await projectThread(db, thread);
    signal.throwIfAborted();
    threads += stats.thread;
    indexedEvents += stats.indexedEvents;
    deletedDocs += stats.deletedDocs;
  }
  const convergence = await projectionConvergence(db, options);
  signal.throwIfAborted();
  return {
    threads,
    indexedEvents,
    deletedDocs,
    orphanedThreads,
    convergence,
  };
}

export const projectChatEventSearch$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<ChatEventSearchProjectionStats> => {
    const db = set(writeDb$);
    return await projectChatEventSearch(db, {}, signal);
  },
);

export const projectChatEventSearchTestScope$ = command(
  async (
    { set },
    options: ChatEventSearchTestProjectionOptions,
    signal: AbortSignal,
  ): Promise<ChatEventSearchProjectionStats> => {
    const db = set(writeDb$);
    return await projectChatEventSearch(
      db,
      { chatThreadIds: options.chatThreadIds },
      signal,
    );
  },
);
