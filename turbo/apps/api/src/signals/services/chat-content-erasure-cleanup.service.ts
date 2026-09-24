import { command } from "ccstate";
import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { chatContentErasureSubjects } from "@okouai/db/schema/chat-content-erasure-subject";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSequences } from "@okouai/db/schema/chat-event-sequence";
import { chatSlackContext } from "@okouai/db/schema/chat-slack-context";
import { chatFeishuContext } from "@okouai/db/schema/chat-feishu-context";
import { chatTeamsContext } from "@okouai/db/schema/chat-teams-context";
import { chatTelegramContext } from "@okouai/db/schema/chat-telegram-context";
import { chatAgentphoneContext } from "@okouai/db/schema/chat-agentphone-context";
import { chatGithubContext } from "@okouai/db/schema/chat-github-context";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { chatAgentRunContext } from "@okouai/db/schema/chat-agent-run-context";
import {
  chatThreadEvents,
  chatThreadEventSequences,
} from "@okouai/db/schema/chat-thread-event";
import { runOutputMaterializations } from "@okouai/db/schema/run-output-materialization";
import { runOutputMemoryCitations } from "@okouai/db/schema/run-output-memory-citation";
import { settle } from "../utils";
import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";

const L = logger("ChatContentErasureCleanup");
const SUBJECT_LIMIT = 5;
const ROW_LIMIT = 250;
const SWEEP_INTERVAL_MINUTES = 15;
type Subject = Pick<
  typeof chatContentErasureSubjects.$inferSelect,
  "subjectKind" | "subjectId"
>;

async function deleteThreadContentBatch(
  db: Db,
  table: PgTable,
  subject: Subject,
): Promise<number> {
  // Both ownership paths terminate at existing indexed roots. Contexts with a
  // deleted parent cannot arrive later because their FK remains in force.
  const owner =
    subject.subjectKind === "user"
      ? sql`thread.user_id = ${subject.subjectId}`
      : sql`EXISTS (SELECT 1 FROM agents WHERE agents.id = thread.agent_id AND agents.org_id = ${subject.subjectId})`;
  return (
    (
      await db.execute(sql`
    DELETE FROM ${table} AS content WHERE content.ctid IN (
      SELECT candidate.ctid FROM ${table} AS candidate
      INNER JOIN chat_threads AS thread ON thread.id = candidate.chat_thread_id
      WHERE ${owner}
      LIMIT ${ROW_LIMIT} FOR UPDATE OF candidate SKIP LOCKED
    )`)
    ).rowCount ?? 0
  );
}

async function deleteRunContentBatch(
  db: Db,
  table: PgTable,
  subject: Subject,
): Promise<number> {
  const owner =
    subject.subjectKind === "user"
      ? sql`run.user_id = ${subject.subjectId}`
      : sql`run.org_id = ${subject.subjectId}`;
  return (
    (
      await db.execute(sql`
    DELETE FROM ${table} AS content WHERE content.ctid IN (
      SELECT candidate.ctid FROM ${table} AS candidate
      INNER JOIN agent_runs AS run ON run.id = candidate.run_id
      WHERE ${owner}
      LIMIT ${ROW_LIMIT} FOR UPDATE OF candidate SKIP LOCKED
    )`)
    ).rowCount ?? 0
  );
}

/** Repeatable bounded maintenance, including after terminal job retirement. */
export async function cleanupLateChatContent(
  db: Db,
  subject: Subject,
  signal: AbortSignal,
): Promise<number> {
  const [receipt] = await db
    .select({ completedAt: chatContentErasureSubjects.completedAt })
    .from(chatContentErasureSubjects)
    .where(
      and(
        eq(chatContentErasureSubjects.subjectKind, subject.subjectKind),
        eq(chatContentErasureSubjects.subjectId, subject.subjectId),
        isNotNull(chatContentErasureSubjects.completedAt),
      ),
    )
    .limit(1);
  if (!receipt) {
    return 0;
  }
  let deleted = 0;
  for (const table of [
    chatEvents,
    chatSlackContext,
    chatFeishuContext,
    chatTeamsContext,
    chatTelegramContext,
    chatAgentphoneContext,
    chatGithubContext,
    chatAutomationContext,
  ]) {
    signal.throwIfAborted();
    deleted += await deleteThreadContentBatch(db, table, subject);
  }
  signal.throwIfAborted();
  // Do not reset a watermark while an earlier bounded event page remains.
  const sequenceOwner =
    subject.subjectKind === "user"
      ? sql`thread.user_id = ${subject.subjectId}`
      : sql`EXISTS (SELECT 1 FROM agents WHERE agents.id = thread.agent_id AND agents.org_id = ${subject.subjectId})`;
  deleted +=
    (
      await db.execute(sql`
    DELETE FROM ${chatEventSequences} AS sequence WHERE sequence.chat_thread_id IN (
      SELECT sequence.chat_thread_id FROM ${chatEventSequences} AS sequence
      INNER JOIN chat_threads AS thread ON thread.id = sequence.chat_thread_id
      WHERE ${sequenceOwner} AND NOT EXISTS (
        SELECT 1 FROM ${chatEvents} AS event WHERE event.chat_thread_id = sequence.chat_thread_id
      ) LIMIT ${ROW_LIMIT} FOR UPDATE OF sequence SKIP LOCKED
    )`)
    ).rowCount ?? 0;
  for (const table of [runOutputMaterializations, runOutputMemoryCitations]) {
    signal.throwIfAborted();
    deleted += await deleteRunContentBatch(db, table, subject);
  }
  const provenanceOwner =
    subject.subjectKind === "user"
      ? sql`candidate.source_user_id = ${subject.subjectId}`
      : sql`candidate.source_org_id = ${subject.subjectId}`;
  deleted +=
    (
      await db.execute(sql`
    DELETE FROM ${chatAgentRunContext} AS content WHERE content.id IN (
      SELECT candidate.id FROM ${chatAgentRunContext} AS candidate WHERE ${provenanceOwner}
      LIMIT ${ROW_LIMIT} FOR UPDATE OF candidate SKIP LOCKED
    )`)
    ).rowCount ?? 0;
  const streamOwner =
    subject.subjectKind === "user"
      ? sql`candidate.user_id = ${subject.subjectId}`
      : sql`candidate.org_id = ${subject.subjectId}`;
  deleted +=
    (
      await db.execute(sql`
    DELETE FROM ${chatThreadEvents} AS content WHERE content.id IN (
      SELECT candidate.id FROM ${chatThreadEvents} AS candidate WHERE ${streamOwner}
      LIMIT ${ROW_LIMIT} FOR UPDATE OF candidate SKIP LOCKED
    )`)
    ).rowCount ?? 0;
  signal.throwIfAborted();
  // A late sort append can recreate this FK-free stream counter after the
  // account's original root cleanup. Keep it until all bounded event pages go.
  deleted +=
    (
      await db.execute(sql`
    DELETE FROM ${chatThreadEventSequences} AS content WHERE content.ctid IN (
      SELECT candidate.ctid FROM ${chatThreadEventSequences} AS candidate
      WHERE ${streamOwner} AND NOT EXISTS (
        SELECT 1 FROM ${chatThreadEvents} AS event
        WHERE event.user_id = candidate.user_id AND event.org_id = candidate.org_id
      ) LIMIT ${ROW_LIMIT} FOR UPDATE OF candidate SKIP LOCKED
    )`)
    ).rowCount ?? 0;
  return deleted;
}

export async function sweepLateChatContent(db: Db, signal: AbortSignal) {
  // An older API may finish deletion after the schema backfill. Copy only
  // terminal, confirmed decisions before their normal local-job retention.
  signal.throwIfAborted();
  await db.execute(sql`
      INSERT INTO chat_content_erasure_subjects
        (subject_kind, subject_id, source_reference, confirmed_at, completed_at)
      SELECT 'user', job.user_id, job.id::text, job.created_at, job.completed_at
      FROM background_jobs AS job
      WHERE job.kind = 'clerk-user-deletion' AND job.status = 'completed'
        AND job.completed_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM chat_content_erasure_subjects AS receipt
          WHERE receipt.subject_kind = 'user' AND receipt.subject_id = job.user_id
            AND receipt.completed_at IS NOT NULL
        )
      ORDER BY job.id LIMIT 100
      ON CONFLICT (subject_kind, subject_id) DO UPDATE
        SET completed_at = COALESCE(chat_content_erasure_subjects.completed_at, EXCLUDED.completed_at)
    `);
  signal.throwIfAborted();
  await db.execute(sql`
      INSERT INTO chat_content_erasure_subjects
        (subject_kind, subject_id, source_reference, confirmed_at, completed_at)
      SELECT DISTINCT ON (job.subject_kind, job.subject_id)
        job.subject_kind, job.subject_id, job.decision_ref,
        job.requested_at, clock_timestamp()
      FROM account_erasure_jobs AS job
      WHERE job.state IN ('verified_erased', 'verified_no_applicable_data')
        AND NOT EXISTS (
          SELECT 1 FROM chat_content_erasure_subjects AS receipt
          WHERE receipt.subject_kind = job.subject_kind AND receipt.subject_id = job.subject_id
            AND receipt.completed_at IS NOT NULL
        )
      ORDER BY job.subject_kind, job.subject_id, job.generation DESC LIMIT 100
      ON CONFLICT (subject_kind, subject_id) DO UPDATE
        SET completed_at = COALESCE(chat_content_erasure_subjects.completed_at, EXCLUDED.completed_at)
    `);
  signal.throwIfAborted();
  const subjects = await db
    .select()
    .from(chatContentErasureSubjects)
    .where(
      and(
        isNotNull(chatContentErasureSubjects.completedAt),
        lte(chatContentErasureSubjects.nextSweepAt, sql`clock_timestamp()`),
      ),
    )
    .orderBy(
      asc(chatContentErasureSubjects.nextSweepAt),
      asc(chatContentErasureSubjects.subjectKind),
      asc(chatContentErasureSubjects.subjectId),
    )
    .limit(SUBJECT_LIMIT);
  signal.throwIfAborted();
  let deleted = 0;
  for (const subject of subjects) {
    signal.throwIfAborted();
    const startedAt = performance.now();
    const result = await settle(cleanupLateChatContent(db, subject, signal));
    signal.throwIfAborted();
    if (result.ok) {
      deleted += result.value;
      const metrics = {
        subjectKind: subject.subjectKind,
        sourceReference: subject.sourceReference,
        deleted: result.value,
        rowLimit: ROW_LIMIT,
        durationMs: performance.now() - startedAt,
      };
      L.debug("Late chat content erasure completed", metrics);
      if (result.value > 0) {
        L.warn("Late chat content collected after confirmed deletion", metrics);
      }
    } else {
      L.error("Late chat content erasure failed", {
        subjectKind: subject.subjectKind,
        sourceReference: subject.sourceReference,
        error: result.error,
      });
    }
    // Fair recurring scans outlive every local job. A failed or partially full
    // batch remains eligible on the next pass; there is no terminal clean state.
    await db
      .update(chatContentErasureSubjects)
      .set({
        nextSweepAt: sql`clock_timestamp() + ${SWEEP_INTERVAL_MINUTES} * interval '1 minute'`,
      })
      .where(
        and(
          eq(chatContentErasureSubjects.subjectKind, subject.subjectKind),
          eq(chatContentErasureSubjects.subjectId, subject.subjectId),
        ),
      );
  }
  signal.throwIfAborted();
  return { processed: subjects.length, deleted };
}

export const cleanupLateChatContent$ = command(
  async ({ set }, signal: AbortSignal) => {
    return await sweepLateChatContent(set(writeDb$), signal);
  },
);
