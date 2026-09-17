import {
  MORNING_BRIEF_CHAT_COLLECTION_BUDGET,
  type MorningBriefChatCollection,
  type MorningBriefChatItem,
  type MorningBriefChatSkipReason,
  type MorningBriefChatTruncation,
} from "@okouai/api-contracts/contracts/morning-brief-chat-collection-preview";
import {
  assertErasureSubjectWritable,
  erasureSubjectOpenCondition,
  type ErasureSubject,
} from "@okouai/db/operations/account-erasure";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import {
  chatEventTerminalPredicate,
  chatEvents,
} from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { command } from "ccstate";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";

import {
  nullableDriverValueDecoder,
  pgIntegerDecoder,
} from "../../lib/db-structured-result";
import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { clerk$ } from "../external/clerk";
import { type Db, writeDb$ } from "../external/db";
import { settle, settleIncludingAbort } from "../utils";
import {
  canonicalChatEventContent,
  canonicalChatEventUserMessage,
} from "./canonical-chat-event-read.service";
import { visibleChatEventCondition } from "./chat-event-shared.service";
import {
  chatEventTextCondition,
  chatEventTypeIn,
  runOwnedChatEventCondition,
} from "./chat-event-type.service";
import { visibleJoinedAgentCondition } from "./agent-data.service";
import {
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./chat-user-message.service";
import {
  admitMorningBriefCollection,
  morningBriefScopeIsCurrent,
  startMorningBriefSourceDeadline,
  type MorningBriefCollectionScope,
  type MorningBriefSourceDeadline,
} from "./morning-brief-connector-reader.service";
import {
  MORNING_BRIEF_CHAT_THREAD_PROVENANCE,
  ORDINARY_CHAT_THREAD_PROVENANCE,
} from "./morning-brief-thread-provenance.service";

/**
 * Bounded collection of the member's unread Chat for one Morning Brief
 * occurrence.
 *
 * It is a read: nothing here advances a read watermark, writes a message, Run,
 * result or e-mail, and nothing repairs or backfills thread provenance. Only a
 * thread positively classified as ordinary Chat may release content. An unknown
 * classification skips the **whole** thread rather than guessing from a title,
 * a plausible-looking input, or an unbroken run of event sequence numbers, and
 * that gap is reported instead of hidden.
 *
 * Source text is data. Nothing read here is an instruction to anything
 * downstream.
 */

/** One over the processing limit, so overflow is observed rather than assumed. */
const CANDIDATE_SELECT_LIMIT = 51;
const CANDIDATE_PROCESS_LIMIT = 50;
/** One over the per-thread excerpt limit, for the same reason. */
const EXCERPT_SELECT_LIMIT = 11;
const EXCERPT_LIMIT = 10;
const EXCERPT_BYTE_CAP = 4 * 1024;
const COLLECTION_TEXT_BYTE_BUDGET = 64 * 1024;
/** A stored event larger than this is a coverage gap, never a decoded excerpt. */
const EVENT_PAYLOAD_BYTE_CAP = 64 * 1024;
/**
 * One absolute budget for the whole attempt, taken before admission, and the
 * tail of it candidate work may not spend.
 *
 * The final authority check is part of the attempt, not extra time after it, so
 * candidate discovery and every thread read stop at the reserve. Without it a
 * loop that used the whole budget would leave the fence nothing, and content
 * that cannot be re-authorized may not be released at all — the reserve is what
 * makes a truthful partial collection possible instead of an all-or-nothing one.
 */
const COLLECTION_DEADLINE_MS = MORNING_BRIEF_CHAT_COLLECTION_BUDGET.deadlineMs;
const FINAL_AUTHORITY_RESERVE_MS =
  MORNING_BRIEF_CHAT_COLLECTION_BUDGET.finalAuthorityReserveMs;
const THREAD_LOCK_TIMEOUT_MS = 2000;
const THREAD_STATEMENT_TIMEOUT_MS = 5000;
/** Guards against an anchor far outside the occurrence it claims to describe. */
const ANCHOR_MAX_FUTURE_MS = 5 * 60 * 1000;
const ANCHOR_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const ACTIVE_RUN_STATUSES = ["queued", "pending", "running"] as const;
const EXCERPT_EVENT_TYPES = ["input.prompt", "output.message"] as const;

interface MorningBriefChatCollectionOwner {
  readonly orgId: string;
  readonly userId: string;
}

type MorningBriefChatCollectionResult =
  | { readonly kind: "invalid-anchor"; readonly message: string }
  | { readonly kind: "not-installed" }
  | { readonly kind: "owner-unavailable" }
  /** The attempt did not finish inside its budget, so it released nothing. */
  | { readonly kind: "deadline-exceeded" }
  | {
      readonly kind: "collected";
      readonly collection: MorningBriefChatCollection;
    };

/**
 * One attempt's absolute time budget.
 *
 * Every wait spends the same budget: admission, including its network
 * membership read, candidate discovery, each thread read, and the final
 * authority check. Nothing here starts a second clock.
 */
interface AttemptBudget {
  /**
   * The shared source deadline, handed to admission so the preflight spends
   * this attempt's budget instead of starting a second one.
   */
  readonly deadline: MorningBriefSourceDeadline;
  /** The instant the whole attempt must have finished by. */
  readonly deadlineAt: number;
  /** Where candidate work stops, leaving the final fence its reserve. */
  readonly candidateDeadlineAt: number;
  /** Caller cancellation merged with this attempt's own deadline. */
  readonly signal: AbortSignal;
  /** Milliseconds left before `limit`, never negative. */
  readonly remaining: (limit: number) => number;
  readonly exhausted: (limit: number) => boolean;
}

function attemptBudget(signal: AbortSignal): AttemptBudget {
  const deadline = startMorningBriefSourceDeadline(COLLECTION_DEADLINE_MS);
  const remaining = (limit: number): number => {
    return Math.max(0, limit - nowDate().getTime());
  };
  return {
    deadline,
    deadlineAt: deadline.at,
    candidateDeadlineAt: deadline.at - FINAL_AUTHORITY_RESERVE_MS,
    signal: AbortSignal.any([signal, deadline.signal]),
    remaining,
    // The timer bit only flips once its callback has run, so the clock decides
    // and the timer is left to interrupt I/O already in flight.
    exhausted: (limit) => {
      return deadline.signal.aborted || remaining(limit) === 0;
    },
  };
}

type BudgetedStep<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false };

/**
 * Await one step of the attempt and re-read the clock on the way out.
 *
 * A step that returned at or after the boundary is expired even when it
 * succeeded: the fact it produced was only known to be true before the wait.
 * Caller cancellation still propagates, and a failure that is not the budget is
 * a real failure rather than a quiet empty result.
 */
async function withinBudget<T>(
  work: Promise<T>,
  budget: AttemptBudget,
  limit: number,
  signal: AbortSignal,
): Promise<BudgetedStep<T>> {
  const settled = await settleIncludingAbort(work);
  signal.throwIfAborted();
  if (budget.exhausted(limit)) {
    return { ok: false };
  }
  if (settled.ok) {
    return { ok: true, value: settled.value };
  }
  throw settled.error;
}

/**
 * Keep one transaction inside the remaining budget.
 *
 * PostgreSQL enforces both server-side, so a wait that would outlive the
 * attempt is cancelled at the database rather than abandoned as detached work
 * behind a promise race. Its own caps still apply: the budget can shorten a
 * wait, never lengthen it.
 */
async function boundTransaction(
  tx: Tx,
  budget: AttemptBudget,
  limit: number,
): Promise<void> {
  // PostgreSQL reads `0` as "no timeout", so an already-spent budget still
  // bounds the transaction at the smallest real value rather than removing the
  // bound entirely.
  const remaining = Math.max(1, budget.remaining(limit));
  const lockTimeout = Math.min(THREAD_LOCK_TIMEOUT_MS, remaining);
  const statementTimeout = Math.min(THREAD_STATEMENT_TIMEOUT_MS, remaining);
  await tx.execute(
    sql`SELECT set_config('lock_timeout', ${`${lockTimeout.toString()}ms`}, true)`,
  );
  await tx.execute(
    sql`SELECT set_config('statement_timeout', ${`${statementTimeout.toString()}ms`}, true)`,
  );
}

interface CandidateThread {
  readonly threadId: string;
  readonly agentId: string;
  readonly agentOwner: string;
  readonly provenance: string | null;
  readonly seqBound: number;
  readonly terminalEventId: string;
  readonly terminalRunId: string | null;
  readonly terminalSeqId: number;
  readonly terminalAt: Date;
}

interface ThreadOutcome {
  readonly item?: MorningBriefChatItem;
  readonly skip?: MorningBriefChatSkipReason;
  readonly truncations: readonly MorningBriefChatTruncation[];
  readonly textBytes: number;
}

function ownerErasureSubjects(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentOwner?: string;
}): readonly ErasureSubject[] {
  const subjects: ErasureSubject[] = [
    { subjectKind: "organization", subjectId: args.orgId },
    { subjectKind: "user", subjectId: args.userId },
  ];
  if (args.agentOwner !== undefined && args.agentOwner !== args.userId) {
    subjects.push({ subjectKind: "user", subjectId: args.agentOwner });
  }
  return subjects;
}

/**
 * The shared erasure admission, used here purely as a content fence.
 *
 * Collection writes nothing, but a closed subject must not release that
 * subject's Chat content either. Taking the same shared admission means a
 * closure waits for an in-flight collection instead of completing while one is
 * still reading, and only its exact closure error denies the read.
 */
async function erasureAdmitted(
  tx: Tx,
  subjects: readonly ErasureSubject[],
): Promise<boolean> {
  const result = await settle(assertErasureSubjectWritable(tx, subjects));
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

/** Bytes a UTF-8 encoder would produce for this text. */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function truncateToUtf8Bytes(
  value: string,
  byteCap: number,
): { readonly text: string; readonly truncated: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= byteCap) {
    return { text: value, truncated: false };
  }
  // Never split a multi-byte code point: walk back over continuation bytes.
  let end = byteCap;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return {
    text: new TextDecoder().decode(bytes.subarray(0, end)),
    truncated: true,
  };
}

function noActiveRunCondition(db: Pick<Db, "select">) {
  return notExists(
    db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.chatThreadId, chatThreads.id),
          inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
          isNotNull(agentRuns.triggerSource),
        ),
      ),
  );
}

/**
 * The newest terminal marker at or before the frozen anchor.
 *
 * Ordering matches the existing unread read-state query, so "unread" keeps one
 * meaning across the product, while the anchor bound keeps output produced
 * after the occurrence out of the occurrence's own collection.
 */
function anchoredTerminalEvent(db: Pick<Db, "select">, anchor: Date) {
  return db
    .select({
      eventId: chatEvents.id,
      runId: chatEvents.runId,
      seqId: chatEvents.seqId,
      createdAt: chatEvents.createdAt,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, chatThreads.id),
        chatEventTerminalPredicate(chatEvents.eventType),
        lte(chatEvents.createdAt, anchor),
      ),
    )
    .orderBy(sql`${desc(chatEvents.createdAt)} NULLS LAST`, desc(chatEvents.id))
    .limit(1)
    .as("anchored_terminal_event");
}

/**
 * Unread threads the member may read, across every Agent they are authorized
 * for in the current organization.
 *
 * Deliberately without the sidebar's seven-day presentation window: that limit
 * exists to keep an indicator list short, not to define what the member has
 * left unread. Erasure state filters candidates here as indexed selection only;
 * the per-thread admission below remains the authority.
 */
async function loadUnreadCandidates(
  db: Db,
  owner: MorningBriefChatCollectionOwner,
  anchor: Date,
  budget: AttemptBudget,
): Promise<readonly CandidateThread[]> {
  return await db.transaction(async (tx) => {
    // Selection can queue behind a writer of the same rows, so it is bounded by
    // what is left of the attempt rather than by nothing at all.
    await boundTransaction(tx, budget, budget.candidateDeadlineAt);
    return await selectUnreadCandidates(tx, owner, anchor);
  });
}

async function selectUnreadCandidates(
  db: Tx,
  owner: MorningBriefChatCollectionOwner,
  anchor: Date,
): Promise<readonly CandidateThread[]> {
  const terminal = anchoredTerminalEvent(db, anchor);
  const rows = await db
    .select({
      threadId: chatThreads.id,
      agentId: agents.id,
      agentOwner: agents.owner,
      provenance: chatThreads.provenance,
      seqBound: chatThreads.lastChatEventSeqId,
      terminalEventId: terminal.eventId,
      terminalRunId: terminal.runId,
      terminalSeqId: terminal.seqId,
      terminalAt: terminal.createdAt,
    })
    .from(chatThreads)
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .crossJoinLateral(terminal)
    .where(
      and(
        eq(chatThreads.userId, owner.userId),
        eq(agents.orgId, owner.orgId),
        visibleJoinedAgentCondition(owner.userId),
        or(
          isNull(chatThreads.lastReadAt),
          gt(terminal.createdAt, chatThreads.lastReadAt),
        ),
        noActiveRunCondition(db),
        erasureSubjectOpenCondition(db, [
          { subjectKind: "user", subjectId: chatThreads.userId },
          { subjectKind: "user", subjectId: agents.owner },
          { subjectKind: "organization", subjectId: agents.orgId },
        ]),
      ),
    )
    .orderBy(desc(terminal.createdAt), desc(chatThreads.id))
    .limit(CANDIDATE_SELECT_LIMIT);
  return rows.map((row) => {
    return { ...row, provenance: row.provenance ?? null };
  });
}

/** The stored payload, or NULL when it is too large to decode safely. */
function boundedEventPayload() {
  return sql`CASE
    WHEN octet_length(${chatEvents.payload}::text) <= ${EVENT_PAYLOAD_BYTE_CAP}
      THEN ${chatEvents.payload}
    ELSE NULL
  END`;
}

/**
 * Visible message excerpts belonging to the unread terminal Run.
 *
 * Scoped to that one Run so an unrelated Run's output in the same thread cannot
 * be reported as this brief's context, bounded by the thread's frozen sequence
 * position so nothing appended after selection appears, and restricted to the
 * two event types that carry a visible message. Thinking, control rows,
 * automation instruction bodies, budget and usage rows, and any revoked or
 * replaced input are excluded by construction.
 */
async function loadThreadExcerpts(
  tx: Tx,
  candidate: CandidateThread,
  runId: string,
) {
  const payload = boundedEventPayload();
  return await tx
    .select({
      eventId: chatEvents.id,
      seqId: chatEvents.seqId,
      eventType: chatEvents.eventType,
      createdAt: chatEvents.createdAt,
      payloadBytes: sql`octet_length(${chatEvents.payload}::text)`.mapWith(
        nullableDriverValueDecoder(pgIntegerDecoder),
      ),
      content: canonicalChatEventContent(payload),
      userMessage: canonicalChatEventUserMessage(payload),
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, candidate.threadId),
        eq(chatEvents.runId, runId),
        runOwnedChatEventCondition(),
        chatEventTypeIn([...EXCERPT_EVENT_TYPES]),
        lte(chatEvents.seqId, candidate.seqBound),
        chatEventTextCondition(),
        visibleChatEventCondition(tx),
      ),
    )
    .orderBy(asc(chatEvents.seqId), asc(chatEvents.id))
    .limit(EXCERPT_SELECT_LIMIT);
}

type ExcerptRow = Awaited<ReturnType<typeof loadThreadExcerpts>>[number];

function excerptText(row: ExcerptRow): string | null {
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

function classifyProvenance(
  provenance: string | null,
): "eligible" | MorningBriefChatSkipReason {
  if (provenance === ORDINARY_CHAT_THREAD_PROVENANCE) {
    return "eligible";
  }
  if (provenance === MORNING_BRIEF_CHAT_THREAD_PROVENANCE) {
    return "morning_brief_thread";
  }
  return provenance === null
    ? "unknown_thread_provenance"
    : "unsupported_thread_provenance";
}

function skipped(
  reason: MorningBriefChatSkipReason,
  truncations: readonly MorningBriefChatTruncation[] = [],
): ThreadOutcome {
  return { skip: reason, truncations, textBytes: 0 };
}

/**
 * Read one candidate under the locks that actually exclude a concurrent
 * classification change.
 *
 * Lock order is Agent, then thread, matching the existing canonical writers.
 * The Agent lock is `FOR KEY SHARE`: `agents` carries the `(id, org_id, owner)`
 * unique key, so an owner or organization transfer, and Agent deletion, which
 * cascades this thread, conflict with it. The thread lock is
 * `FOR NO KEY UPDATE` rather than `FOR KEY SHARE`, because the exclusion write
 * only updates a non-key column: a `KEY SHARE` lock would not conflict with it
 * at all, and the two transactions would interleave freely.
 *
 * That gives an actual linearization point, the thread row lock:
 *
 * - If this read acquires it first, an official Brief admission for the same
 *   thread waits, and the content released here is the pre-admission content
 *   inside the frozen sequence bound.
 * - If the Brief admission commits first, this read waits, re-reads the
 *   classification it now sees, and discards the entire thread without
 *   releasing a body.
 *
 * A collection that already returned a body is not retracted by a later
 * transition; the guarantee is about which side of this boundary the data came
 * from, not about revoking data after the fact.
 */
interface EligibleThread {
  readonly terminalEventId: string;
  readonly terminalRunId: string;
  readonly terminalSeqId: number;
  readonly terminalAt: Date;
}

/** Re-resolve everything the frozen candidate claimed, under the locks. */
async function revalidateThread(
  tx: Tx,
  owner: MorningBriefChatCollectionOwner,
  candidate: CandidateThread,
  anchor: Date,
): Promise<EligibleThread | MorningBriefChatSkipReason> {
  await tx
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, candidate.agentId))
    .for("key share");
  await tx
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.id, candidate.threadId))
    .for("no key update");

  const [current] = await tx
    .select({
      userId: chatThreads.userId,
      agentId: agents.id,
      agentOwner: agents.owner,
      agentVisibility: agents.visibility,
      orgId: agents.orgId,
      provenance: chatThreads.provenance,
      lastReadAt: chatThreads.lastReadAt,
    })
    .from(chatThreads)
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(eq(chatThreads.id, candidate.threadId))
    .limit(1);
  if (
    !current ||
    current.userId !== owner.userId ||
    current.orgId !== owner.orgId ||
    current.agentId !== candidate.agentId ||
    current.agentOwner !== candidate.agentOwner
  ) {
    return "thread_unavailable";
  }
  if (
    current.agentVisibility === "private" &&
    current.agentOwner !== owner.userId
  ) {
    return "owner_context_unavailable";
  }
  const provenance = classifyProvenance(current.provenance);
  if (provenance !== "eligible") {
    return provenance;
  }

  const [terminal] = await tx
    .select({
      eventId: chatEvents.id,
      runId: chatEvents.runId,
      seqId: chatEvents.seqId,
      createdAt: chatEvents.createdAt,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, candidate.threadId),
        chatEventTerminalPredicate(chatEvents.eventType),
        lte(chatEvents.createdAt, anchor),
      ),
    )
    .orderBy(sql`${desc(chatEvents.createdAt)} NULLS LAST`, desc(chatEvents.id))
    .limit(1);
  if (
    !terminal ||
    terminal.eventId !== candidate.terminalEventId ||
    (current.lastReadAt !== null && current.lastReadAt >= terminal.createdAt)
  ) {
    return "read_state_advanced";
  }

  const [activeRun] = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.chatThreadId, candidate.threadId),
        inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
        isNotNull(agentRuns.triggerSource),
      ),
    )
    .limit(1);
  if (activeRun) {
    return "active_run";
  }
  if (terminal.runId === null) {
    return "no_visible_excerpts";
  }
  return {
    terminalEventId: terminal.eventId,
    terminalRunId: terminal.runId,
    terminalSeqId: terminal.seqId,
    terminalAt: terminal.createdAt,
  };
}

/** Normalize the bounded rows into excerpts within the remaining budgets. */
function buildExcerpts(
  rows: readonly ExcerptRow[],
  remainingTextBytes: number,
): {
  readonly excerpts: MorningBriefChatItem["excerpts"];
  readonly truncations: ReadonlySet<MorningBriefChatTruncation>;
  readonly textBytes: number;
} {
  const truncations = new Set<MorningBriefChatTruncation>();
  if (rows.length > EXCERPT_LIMIT) {
    truncations.add("excerpt_limit");
  }
  const excerpts: MorningBriefChatItem["excerpts"][number][] = [];
  let textBytes = 0;
  for (const row of rows.slice(0, EXCERPT_LIMIT)) {
    if (
      row.payloadBytes === null ||
      row.payloadBytes > EVENT_PAYLOAD_BYTE_CAP
    ) {
      truncations.add("oversized_event_payload");
      continue;
    }
    const text = excerptText(row);
    if (text === null) {
      continue;
    }
    const bounded = truncateToUtf8Bytes(text, EXCERPT_BYTE_CAP);
    if (bounded.truncated) {
      truncations.add("excerpt_bytes");
    }
    const bytes = utf8ByteLength(bounded.text);
    if (textBytes + bytes > remainingTextBytes) {
      truncations.add("output_budget");
      break;
    }
    textBytes += bytes;
    excerpts.push({
      eventId: row.eventId,
      seqId: row.seqId,
      role: row.eventType === "output.message" ? "assistant" : "user",
      at: row.createdAt.toISOString(),
      text: bounded.text,
    });
  }
  return { excerpts, truncations, textBytes };
}

async function collectThread(
  db: Db,
  args: {
    readonly owner: MorningBriefChatCollectionOwner;
    readonly candidate: CandidateThread;
    readonly anchor: Date;
    readonly remainingTextBytes: number;
    readonly budget: AttemptBudget;
  },
): Promise<ThreadOutcome> {
  const { owner, candidate, anchor, remainingTextBytes, budget } = args;
  return await db.transaction(async (tx) => {
    await boundTransaction(tx, budget, budget.candidateDeadlineAt);
    const admitted = await erasureAdmitted(
      tx,
      ownerErasureSubjects({ ...owner, agentOwner: candidate.agentOwner }),
    );
    if (!admitted) {
      return skipped("owner_context_unavailable");
    }

    const eligible = await revalidateThread(tx, owner, candidate, anchor);
    if (typeof eligible === "string") {
      return skipped(eligible);
    }

    const rows = await loadThreadExcerpts(
      tx,
      candidate,
      eligible.terminalRunId,
    );
    const { excerpts, truncations, textBytes } = buildExcerpts(
      rows,
      remainingTextBytes,
    );
    if (excerpts.length === 0) {
      return skipped("no_visible_excerpts", [...truncations]);
    }
    return {
      item: {
        threadId: candidate.threadId,
        agentId: candidate.agentId,
        provenance: ORDINARY_CHAT_THREAD_PROVENANCE,
        terminal: {
          eventId: eligible.terminalEventId,
          runId: eligible.terminalRunId,
          seqId: eligible.terminalSeqId,
          at: eligible.terminalAt.toISOString(),
        },
        excerpts,
        truncations: [...truncations],
      },
      truncations: [...truncations],
      textBytes,
    };
  });
}

function validateAnchor(
  scheduledFor: Date,
  currentTime: Date,
): string | undefined {
  if (Number.isNaN(scheduledFor.getTime())) {
    return "scheduledFor must be a valid timestamp";
  }
  if (scheduledFor.getTime() - currentTime.getTime() > ANCHOR_MAX_FUTURE_MS) {
    return "scheduledFor is too far in the future for a collectable occurrence";
  }
  if (currentTime.getTime() - scheduledFor.getTime() > ANCHOR_MAX_AGE_MS) {
    return "scheduledFor is older than the collectable Chat history";
  }
  return undefined;
}

/** Reasons that describe a gap in what the collection could see. */
const UNKNOWN_COVERAGE_REASONS = [
  "unknown_thread_provenance",
  "unsupported_thread_provenance",
  "thread_unavailable",
  "owner_context_unavailable",
  "read_state_advanced",
  "active_run",
  "thread_read_failed",
  "no_visible_excerpts",
] as const satisfies readonly MorningBriefChatSkipReason[];

interface InspectedCandidates {
  readonly items: readonly MorningBriefChatItem[];
  readonly skips: readonly {
    readonly threadId: string;
    readonly reason: MorningBriefChatSkipReason;
  }[];
  readonly truncations: ReadonlySet<MorningBriefChatTruncation>;
  readonly inspectedThreads: number;
}

async function inspectCandidates(
  db: Db,
  args: {
    readonly owner: MorningBriefChatCollectionOwner;
    readonly anchor: Date;
    readonly candidates: readonly CandidateThread[];
    readonly destinationThreadId: string | null;
    readonly budget: AttemptBudget;
  },
  signal: AbortSignal,
): Promise<InspectedCandidates> {
  const { budget } = args;
  const limit = budget.candidateDeadlineAt;
  const truncations = new Set<MorningBriefChatTruncation>();
  const items: MorningBriefChatItem[] = [];
  const skips: { threadId: string; reason: MorningBriefChatSkipReason }[] = [];
  let remainingTextBytes = COLLECTION_TEXT_BYTE_BUDGET;
  let inspectedThreads = 0;

  for (const candidate of args.candidates) {
    if (budget.exhausted(limit)) {
      truncations.add("deadline_exceeded");
      break;
    }
    if (candidate.threadId === args.destinationThreadId) {
      inspectedThreads += 1;
      skips.push({
        threadId: candidate.threadId,
        reason: "destination_thread",
      });
      continue;
    }
    const outcome = await settle(
      collectThread(db, {
        owner: args.owner,
        candidate,
        anchor: args.anchor,
        remainingTextBytes,
        budget,
      }),
    );
    signal.throwIfAborted();
    // A lock wait, a statement or the read itself can outlast the boundary.
    // Content that arrived at or after it is expired, so neither the excerpts
    // nor the refusal reason — both facts about this member's threads — is
    // reported, and the gap is declared instead.
    if (budget.exhausted(limit)) {
      truncations.add("deadline_exceeded");
      break;
    }
    inspectedThreads += 1;
    if (!outcome.ok) {
      // A bounded read that could not complete — a lock wait, a statement
      // timeout, or a transient database failure — is a coverage gap for one
      // thread, never a partially reported thread and never a failed
      // collection. The reason stays a fixed token; provider or database
      // detail is not part of the envelope.
      skips.push({
        threadId: candidate.threadId,
        reason: "thread_read_failed",
      });
      continue;
    }
    for (const truncation of outcome.value.truncations) {
      truncations.add(truncation);
    }
    if (outcome.value.skip !== undefined) {
      skips.push({ threadId: candidate.threadId, reason: outcome.value.skip });
      continue;
    }
    if (outcome.value.item) {
      items.push(outcome.value.item);
      remainingTextBytes -= outcome.value.textBytes;
    }
  }
  return { items, skips, truncations, inspectedThreads };
}

/**
 * Collect one occurrence's eligible unread Chat.
 *
 * The owner comes from the caller's authenticated identity and the destination
 * from the member's canonical Morning Brief state; neither is accepted as
 * input. Database work stays in short per-thread transactions so nothing holds
 * a lock across the whole collection.
 *
 * Admission freezes the exact authority the attempt speaks for — the member's
 * immutable Clerk membership generation, the canonical installation, its Agent
 * and the destination thread — and the same shared fence that admitted it is
 * the one that has to agree again before any envelope is released. One absolute
 * budget covers admission, discovery, every thread read and that final check.
 */
export const collectMorningBriefChat$ = command(
  async (
    { get, set },
    args: {
      readonly owner: MorningBriefChatCollectionOwner;
      readonly scheduledFor: Date;
    },
    signal: AbortSignal,
  ): Promise<MorningBriefChatCollectionResult> => {
    const db = set(writeDb$);
    const clerk = get(clerk$);
    const startedAt = nowDate();
    const anchorProblem = validateAnchor(args.scheduledFor, startedAt);
    if (anchorProblem !== undefined) {
      return { kind: "invalid-anchor", message: anchorProblem };
    }
    // Established before admission, because admission itself waits on the
    // network and that wait is part of this attempt.
    const budget = attemptBudget(signal);

    const admitted = await withinBudget(
      admitMorningBriefCollection(
        {
          db,
          clerk,
          orgId: args.owner.orgId,
          userId: args.owner.userId,
          anchor: args.scheduledFor,
          deadline: budget.deadline,
        },
        signal,
      ),
      budget,
      budget.deadlineAt,
      signal,
    );
    if (!admitted.ok || admitted.value.kind === "unavailable") {
      // Admission spent the budget the collection would have needed; it is an
      // unfinished attempt, not a member without a brief.
      return { kind: "deadline-exceeded" };
    }
    if (admitted.value.kind !== "ok") {
      return { kind: "not-installed" };
    }
    const scope: MorningBriefCollectionScope = admitted.value.scope;
    // Admission proves the canonical brief and this member's generation; the
    // release fence additionally proves the brief's own Agent is visible to
    // them. Running it here too means an admitted scope is one the release
    // check would accept right now, at the cost of one extra membership read.
    const authorized = await withinBudget(
      morningBriefScopeIsCurrent({ db, clerk, scope }, budget.signal),
      budget,
      budget.deadlineAt,
      signal,
    );
    if (!authorized.ok) {
      return { kind: "deadline-exceeded" };
    }
    if (!authorized.value) {
      return { kind: "not-installed" };
    }

    const discovered = await withinBudget(
      loadUnreadCandidates(db, args.owner, args.scheduledFor, budget),
      budget,
      budget.candidateDeadlineAt,
      signal,
    );
    if (!discovered.ok) {
      // Discovery that outlived the boundary leaves nothing that can still be
      // fenced, so this is an unfinished attempt rather than a quiet inbox.
      return { kind: "deadline-exceeded" };
    }
    const candidates = discovered.value;

    const inspected = await inspectCandidates(
      db,
      {
        owner: args.owner,
        anchor: args.scheduledFor,
        candidates: candidates.slice(0, CANDIDATE_PROCESS_LIMIT),
        destinationThreadId: scope.chatThreadId,
        budget,
      },
      signal,
    );
    const truncations = new Set(inspected.truncations);
    if (candidates.length > CANDIDATE_PROCESS_LIMIT) {
      truncations.add("candidate_overflow");
    }
    const { items, skips } = inspected;

    // Nothing is released while the admitted authority is in doubt, and a
    // whole-owner invalidation releases none of it. A membership that was
    // revoked, or revoked and rejoined under a new id, a replaced or disabled
    // installation, a different Agent and a closed subject all fail here, and
    // an unrelated enabled installation is not a substitute for this one.
    const released = await withinBudget(
      morningBriefScopeIsCurrent({ db, clerk, scope }, budget.signal),
      budget,
      budget.deadlineAt,
      signal,
    );
    if (!released.ok) {
      // Unverifiable at the boundary: neither the excerpts nor the thread ids
      // that would describe them may leave.
      return { kind: "deadline-exceeded" };
    }
    if (!released.value) {
      return { kind: "owner-unavailable" };
    }

    const unknownCoverage = skips.some((skip) => {
      return UNKNOWN_COVERAGE_REASONS.some((reason) => {
        return reason === skip.reason;
      });
    });
    return {
      kind: "collected",
      collection: {
        source: "chat",
        anchor: args.scheduledFor.toISOString(),
        collectedAt: startedAt.toISOString(),
        result:
          candidates.length === 0
            ? "empty"
            : items.length > 0
              ? "collected"
              : "no-eligible-content",
        coverage:
          unknownCoverage || truncations.size > 0 ? "partial" : "complete",
        scope: {
          unreadCandidates: Math.min(
            candidates.length,
            CANDIDATE_PROCESS_LIMIT,
          ),
          inspectedThreads: inspected.inspectedThreads,
        },
        items: [...items],
        skipped: [...skips],
        truncations: [...truncations],
      },
    };
  },
);
