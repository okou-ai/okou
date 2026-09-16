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
import {
  assertErasureSubjectWritable,
  erasureSubjectOpenCondition,
  type ErasureSubject,
} from "@okouai/db/operations/account-erasure";
import { agents } from "@okouai/db/schema/agent";
import {
  chatEventSearchMessages,
  chatEventSearchMessageWatermarks,
} from "@okouai/db/schema/chat-event-search";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { chatSearchIndexText } from "../../lib/chat-search-bigram";
import type { Tx } from "../../lib/db-types";
import { optionalEnv } from "../../lib/env";
import { isLockNotAvailable } from "../../lib/pg-errors";
import { writeDb$, type Db } from "../external/db";
import { settle } from "../utils";
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
  readonly closedThreads: number;
  readonly deferredThreads: number;
  readonly convergence: ChatEventSearchProjectionConvergence;
}

interface ChatEventSearchProjectionConvergence {
  readonly eligibleThreads: number;
  readonly durableCaughtUpThreads: number;
}

/**
 * Canonical ownership of one thread-scoped derived copy: the thread's own user
 * plus the identity, owner and organization of the Agent the thread belongs to.
 * It is content free, so it can be resolved and admitted before any owner-bound
 * message text is read. The persisted projection labels stay `userId`/`orgId`/
 * `agentId`; `agentOwner` only widens the admitted subject set.
 */
interface ProjectionThreadIdentity {
  readonly chatThreadId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly agentOwner: string;
  readonly orgId: string;
}

interface ProjectionThreadSnapshot {
  readonly identity: ProjectionThreadIdentity;
  readonly lastChatEventSeqId: number;
}

interface ThreadProjectionStats {
  readonly thread: number;
  readonly indexedEvents: number;
  readonly deletedDocs: number;
}

/**
 * `missing` is a resolved absent parent, `closed` is B1's exact subject closure
 * and `deferred` is a bounded lock wait or an exhausted ownership race that the
 * next tick retries. They stay separate so a database or cancellation failure
 * is never reported as account closure.
 */
type ThreadProjectionOutcome =
  | { readonly kind: "projected"; readonly stats: ThreadProjectionStats }
  | { readonly kind: "missing" }
  | { readonly kind: "closed" }
  | { readonly kind: "deferred" };

class ProjectionOwnershipChangedError extends Error {
  constructor() {
    super("Chat search projection ownership changed while acquiring locks");
    this.name = "ProjectionOwnershipChangedError";
  }
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
const OWNERSHIP_ATTEMPTS = 3;
/**
 * The repository's ordinary content-write budget. Waiting is now possible
 * because the fence conflicts with thread deletion, Agent transfer/deletion and
 * an exclusive erasure holder, so one contended thread must not consume the
 * minute-cadence tick: it is deferred after a second and reselected next tick
 * with its watermark untouched. The statement limit bounds the unchanged
 * per-thread work, which is still capped at one thread and `THREAD_EVENT_LIMIT`
 * events.
 */
const PROJECTION_LOCK_TIMEOUT = "1s";
const PROJECTION_STATEMENT_TIMEOUT = "5s";

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

async function setProjectionDeadlines(tx: Tx): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('lock_timeout', ${PROJECTION_LOCK_TIMEOUT}, true)`,
  );
  await tx.execute(
    sql`SELECT set_config('statement_timeout', ${PROJECTION_STATEMENT_TIMEOUT}, true)`,
  );
}

/**
 * Resolves canonical ownership from the real persisted parents. The previously
 * selected candidate and the stored projection labels are never authority here.
 * The Agent join is the same one candidate selection uses, so a thread without
 * a resolvable Agent has no canonical owner and is not projected.
 */
async function loadProjectionThread(
  tx: Tx,
  chatThreadId: string,
): Promise<ProjectionThreadSnapshot | null> {
  const [thread] = await tx
    .select({
      chatThreadId: chatThreads.id,
      userId: chatThreads.userId,
      agentId: agents.id,
      agentOwner: agents.owner,
      orgId: agents.orgId,
      lastChatEventSeqId: chatThreads.lastChatEventSeqId,
    })
    .from(chatThreads)
    .innerJoin(agents, eq(chatThreads.agentId, agents.id))
    .where(eq(chatThreads.id, chatThreadId))
    .limit(1);
  if (!thread) {
    return null;
  }
  const { lastChatEventSeqId, ...identity } = thread;
  return { identity, lastChatEventSeqId };
}

function projectionSubjects(
  identity: ProjectionThreadIdentity,
): ErasureSubject[] {
  // User and organization are separate subject domains; the thread user and the
  // Agent owner are distinct user subjects whenever an Agent is shared.
  const subjects: ErasureSubject[] = [
    { subjectKind: "user", subjectId: identity.userId },
    { subjectKind: "user", subjectId: identity.agentOwner },
    { subjectKind: "organization", subjectId: identity.orgId },
  ];
  return [
    ...new Map(
      subjects.map((subject) => {
        return [JSON.stringify(subject), subject];
      }),
    ).values(),
  ];
}

/** Sorted shared B1 admission, before any business-row lock and before any
 * owner-bound content read. Only B1's exact closure error denies the write;
 * every other failure, including a bounded lock wait, propagates unchanged.
 */
async function admitProjectionSubjects(
  tx: Tx,
  identity: ProjectionThreadIdentity,
): Promise<boolean> {
  const result = await settle(
    assertErasureSubjectWritable(tx, projectionSubjects(identity)),
  );
  if (result.ok) {
    return true;
  }
  if (
    result.error instanceof Error &&
    result.error.message === "account_erasure:subject_closed"
  ) {
    return false;
  }
  throw result.error;
}

function sameProjectionIdentity(
  left: ProjectionThreadIdentity,
  right: ProjectionThreadIdentity,
): boolean {
  return (
    left.chatThreadId === right.chatThreadId &&
    left.userId === right.userId &&
    left.agentId === right.agentId &&
    left.agentOwner === right.agentOwner &&
    left.orgId === right.orgId
  );
}

/**
 * Retains the canonical identity locks through COMMIT, in the Agent -> thread
 * order the run-output writer already uses.
 *
 * `agents` carries the `(id, org_id, owner)` unique key, so KEY SHARE conflicts
 * with an owner/organization transfer and with Agent deletion, which cascades
 * this thread. `chat_threads` has no unique key over `user_id`/`agent_id` and
 * no production writer updates either column; its KEY SHARE conflicts with the
 * FOR UPDATE that thread deletion takes before removing the projection rows.
 * Both are re-read under the retained locks, so a transfer committed between
 * selection and lock acquisition rolls this attempt back instead of relabelling
 * already prepared content or expanding the admitted subject set afterwards.
 */
async function lockProjectionOwnership(
  tx: Tx,
  identity: ProjectionThreadIdentity,
): Promise<ProjectionThreadSnapshot | null> {
  await tx
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, identity.agentId))
    .for("key share");
  await tx
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.id, identity.chatThreadId))
    .for("key share");
  const current = await loadProjectionThread(tx, identity.chatThreadId);
  if (!current) {
    return null;
  }
  if (!sameProjectionIdentity(current.identity, identity)) {
    throw new ProjectionOwnershipChangedError();
  }
  return current;
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
  thread: ProjectionThreadIdentity,
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
  thread: ProjectionThreadIdentity,
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

/**
 * Owns one bounded per-thread transaction: ownership snapshot -> shared B1
 * admission -> Agent and thread identity locks -> revalidation -> content read
 * and projection writes, with every barrier retained through COMMIT. A missing
 * parent or an exactly closed subject performs no insert, no revocation delete
 * and no watermark advance.
 */
async function projectThreadOnce(
  db: Db,
  chatThreadId: string,
): Promise<ThreadProjectionOutcome> {
  return await db.transaction(
    async (tx): Promise<ThreadProjectionOutcome> => {
      await setProjectionDeadlines(tx);
      const selected = await loadProjectionThread(tx, chatThreadId);
      if (!selected) {
        return { kind: "missing" };
      }
      if (!(await admitProjectionSubjects(tx, selected.identity))) {
        return { kind: "closed" };
      }
      const projectionThread = await lockProjectionOwnership(
        tx,
        selected.identity,
      );
      if (!projectionThread) {
        return { kind: "missing" };
      }
      const { identity, lastChatEventSeqId } = projectionThread;
      const progress = await loadThreadProjectionProgress(
        tx,
        chatThreadId,
        lastChatEventSeqId,
      );

      const batch = await buildSearchProjectionBatch(tx, identity, progress);
      const writes = await writeSearchProjectionBatch(tx, batch);
      await advanceProjectionWatermark(
        tx,
        chatThreadId,
        lastChatEventSeqId,
        progress,
      );

      return {
        kind: "projected",
        stats: {
          thread: progress.lagging ? 1 : 0,
          indexedEvents: writes.indexedEvents,
          deletedDocs: writes.deletedDocs,
        },
      };
    },
    { isolationLevel: "read committed" },
  );
}

/**
 * Rolls back and reselects a finite number of times when ownership moves under
 * the locks, then defers the thread to the next tick. Bounded lock waits defer
 * the same way; cancellation and every other database failure keep their
 * existing propagation.
 */
async function projectThread(
  db: Db,
  chatThreadId: string,
): Promise<ThreadProjectionOutcome> {
  for (let attempt = 1; ; attempt++) {
    const result = await settle(projectThreadOnce(db, chatThreadId));
    if (result.ok) {
      return result.value;
    }
    if (isLockNotAvailable(result.error)) {
      return { kind: "deferred" };
    }
    if (!(result.error instanceof ProjectionOwnershipChangedError)) {
      throw result.error;
    }
    if (attempt === OWNERSHIP_ATTEMPTS) {
      return { kind: "deferred" };
    }
  }
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
 * Indexed eligibility filter over the same canonical subject domains the
 * per-thread transaction admits. It keeps closed threads out of the bounded
 * candidate batch so they cannot starve later open threads, and keeps the
 * reported convergence honest instead of counting work this fence will never
 * index. It is a filter, not admission: `admitProjectionSubjects` still decides
 * inside the transaction, so a closure committed after selection still stops
 * the write.
 */
function openProjectionSubjectsCondition(
  db: Pick<Db, "select"> | Tx,
  columns: {
    readonly userId: typeof chatThreads.userId;
    readonly agentOwner: typeof agents.owner;
    readonly orgId: typeof agents.orgId;
  },
) {
  return erasureSubjectOpenCondition(db, [
    { subjectKind: "user", subjectId: columns.userId },
    { subjectKind: "user", subjectId: columns.agentOwner },
    { subjectKind: "organization", subjectId: columns.orgId },
  ]);
}

/**
 * Removes a bounded set of derived rows whose canonical thread is gone. This
 * repairs pre-fence orphans and any older producer; it is not a substitute for
 * the per-thread fence, which now blocks a projector from recreating an orphan
 * behind a committed or in-flight thread deletion.
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

/** Selection carries no identity: the per-thread transaction resolves the
 * canonical owner itself, so a transfer between selection and that transaction
 * cannot label content from a previously observed candidate row.
 */
async function loadCandidateThreads(
  db: Pick<Db, "select">,
  options: ChatEventSearchProjectionOptions,
): Promise<readonly string[]> {
  const threadScope = projectionThreadScope(options.chatThreadIds);
  const candidates = await db
    .select({ chatThreadId: chatThreads.id })
    .from(chatThreads)
    .innerJoin(agents, eq(chatThreads.agentId, agents.id))
    .leftJoin(
      chatEventSearchMessageWatermarks,
      eq(chatEventSearchMessageWatermarks.chatThreadId, chatThreads.id),
    )
    .where(
      and(
        threadScope,
        gt(
          chatThreads.lastChatEventSeqId,
          sql`COALESCE(${chatEventSearchMessageWatermarks.indexedSeqId}, 0)`,
        ),
        openProjectionSubjectsCondition(db, {
          userId: chatThreads.userId,
          agentOwner: agents.owner,
          orgId: agents.orgId,
        }),
      ),
    )
    .orderBy(asc(chatThreads.id))
    .limit(chatEventSearchThreadBatchSize());
  return candidates.map((candidate) => {
    return candidate.chatThreadId;
  });
}

/**
 * Eligible now means "has events and no closed canonical subject". A thread the
 * fence refuses to index is excluded rather than reported as outstanding or
 * silently counted as caught up; its watermark is never advanced to converge.
 * The Agent join stays outer so a thread without a resolvable Agent keeps its
 * previous eligibility, exactly as before this fence.
 */
async function projectionConvergence(
  db: Pick<Db, "select">,
  options: ChatEventSearchProjectionOptions,
): Promise<ChatEventSearchProjectionConvergence> {
  const eligibleScope = and(
    projectionThreadScope(options.chatThreadIds),
    gt(chatThreads.lastChatEventSeqId, 0),
    openProjectionSubjectsCondition(db, {
      userId: chatThreads.userId,
      agentOwner: agents.owner,
      orgId: agents.orgId,
    }),
  );
  const [stats] = await db
    .select({
      eligibleThreads: count(),
      durableCaughtUpThreads: count(
        chatEventSearchMessageWatermarks.chatThreadId,
      ),
    })
    .from(chatThreads)
    .leftJoin(agents, eq(chatThreads.agentId, agents.id))
    .leftJoin(
      chatEventSearchMessageWatermarks,
      and(
        eq(chatEventSearchMessageWatermarks.chatThreadId, chatThreads.id),
        gte(
          chatEventSearchMessageWatermarks.indexedSeqId,
          chatThreads.lastChatEventSeqId,
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
  signal: AbortSignal,
  options: ChatEventSearchProjectionOptions,
): Promise<ChatEventSearchProjectionStats> {
  const orphanedThreads = await cleanupOrphanedSearchProjection(db, options);
  signal.throwIfAborted();
  const candidateThreads = await loadCandidateThreads(db, options);
  signal.throwIfAborted();

  let threads = 0;
  let indexedEvents = 0;
  let deletedDocs = 0;
  let closedThreads = 0;
  let deferredThreads = 0;
  for (const chatThreadId of candidateThreads) {
    const outcome = await projectThread(db, chatThreadId);
    signal.throwIfAborted();
    if (outcome.kind === "projected") {
      threads += outcome.stats.thread;
      indexedEvents += outcome.stats.indexedEvents;
      deletedDocs += outcome.stats.deletedDocs;
    } else if (outcome.kind === "closed") {
      closedThreads += 1;
    } else if (outcome.kind === "deferred") {
      deferredThreads += 1;
    }
  }
  const convergence = await projectionConvergence(db, options);
  signal.throwIfAborted();
  return {
    threads,
    indexedEvents,
    deletedDocs,
    orphanedThreads,
    closedThreads,
    deferredThreads,
    convergence,
  };
}

export const projectChatEventSearch$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<ChatEventSearchProjectionStats> => {
    const db = set(writeDb$);
    return await projectChatEventSearch(db, signal, {});
  },
);

export const projectChatEventSearchTestScope$ = command(
  async (
    { set },
    options: ChatEventSearchTestProjectionOptions,
    signal: AbortSignal,
  ): Promise<ChatEventSearchProjectionStats> => {
    const db = set(writeDb$);
    return await projectChatEventSearch(db, signal, {
      chatThreadIds: options.chatThreadIds,
    });
  },
);
