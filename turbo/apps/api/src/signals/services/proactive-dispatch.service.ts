import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { revokeStaleProactiveInputs$ } from "./proactive-queued-input.service";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { randomUUID } from "node:crypto";
import {
  proactiveTasks,
  type ProactiveTask,
} from "@okouai/api-contracts/contracts/proactive";
import {
  proactiveOccurrences,
  proactiveSchedules,
} from "@okouai/db/schema/proactive-schedule";
import { command } from "ccstate";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { parseRawRows } from "../../lib/db-raw-rows";
import { object, string, uuid, enum as zEnum } from "zod";
import { recordApiOperationTimings } from "../external/sandbox-op-log";
import { nowDate, monotonicNow } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { canonicalChatEventAppendCtes } from "./chat-event-append.service";
import { chatThreadEventInsertSql } from "./chat-thread-event.service";
import { createUserMessageDocument } from "./chat-user-message.service";
import { platformScheduleOwnerIsActive$ } from "./platform-schedule-activity.service";
import {
  nextProactiveSlot,
  scheduleOwner,
  setStandalonePreferences$,
} from "./proactive-dispatch-state.service";
import { scheduleExpired } from "./schedule-expiry-policy";

const insertedId = object({ id: uuid() });
const titles = {
  "morning-brief": "Morning Brief",
  suggestions: "Proactive Suggestions",
  learning: "Proactive Learning",
} satisfies Record<ProactiveTask, string>;
type Schedule = typeof proactiveSchedules.$inferSelect;
interface DueSchedule {
  readonly schedule: Schedule;
  readonly visibleThread: {
    readonly id: string;
    readonly lastMessageAt: Date;
  } | null;
}
const currentMember = sql`EXISTS (SELECT 1 FROM org_members_cache m WHERE m.org_id=${proactiveSchedules.orgId} AND m.user_id=${proactiveSchedules.userId})`;
const noOutstanding = sql`NOT EXISTS (SELECT 1 FROM proactive_occurrences o
  WHERE (o.org_id,o.user_id,o.task)=(${proactiveSchedules.orgId},${proactiveSchedules.userId},${proactiveSchedules.task}) AND o.settled_at IS NULL)`;

function observedSlot(row: Schedule, anchor: Date) {
  return and(
    scheduleOwner(row),
    eq(proactiveSchedules.task, row.task),
    eq(proactiveSchedules.preferenceRevision, row.preferenceRevision),
    eq(proactiveSchedules.enabled, true),
    eq(proactiveSchedules.intendedEnabled, true),
    eq(proactiveSchedules.nextRunAt, anchor),
    noOutstanding,
  );
}

const proactiveThread$ = command(
  async (
    { set },
    candidate: DueSchedule,
    anchor: Date,
    signal: AbortSignal,
  ) => {
    const { schedule: row, visibleThread } = candidate;
    const db = set(writeDb$);
    if (row.chatThreadId) {
      if (visibleThread) {
        // An older installation can still have a visible conversation. Keep its history and publish the visibility change.
        const changed = db
          .update(chatThreads)
          .set({ hidden: true, updatedAt: nowDate() })
          .where(
            and(
              eq(chatThreads.id, visibleThread.id),
              eq(chatThreads.orgId, row.orgId),
              eq(chatThreads.userId, row.userId),
              eq(chatThreads.hidden, false),
              sql`EXISTS (SELECT 1 FROM proactive_schedules WHERE ${observedSlot(row, anchor)} AND chat_thread_id=${visibleThread.id}::uuid)`,
            ),
          )
          .returning({ id: chatThreads.id });
        await db.execute(
          chatThreadEventInsertSql(
            {
              kind: "sort_touched",
              hidden: true,
              orgId: row.orgId,
              userId: row.userId,
              chatThreadId: visibleThread.id,
              createdAt: visibleThread.lastMessageAt,
            },
            {
              cte: sql`changed AS (${changed.getSQL()})`,
              gate: sql`EXISTS (SELECT 1 FROM changed)`,
            },
          ),
        );
        signal.throwIfAborted();
      }
      return row.chatThreadId;
    }
    const threadId = randomUUID();
    const binding = db
      .update(proactiveSchedules)
      .set({ chatThreadId: threadId })
      .where(
        and(observedSlot(row, anchor), isNull(proactiveSchedules.chatThreadId)),
      )
      .returning({ id: proactiveSchedules.chatThreadId });
    const result = parseRawRows(
      insertedId,
      await db.execute(
        chatThreadEventInsertSql(
          {
            kind: "created",
            hidden: true,
            orgId: row.orgId,
            userId: row.userId,
            chatThreadId: threadId,
            title: titles[row.task],
            selectedModel: "auto",
            modelSettings: {},
            createdAt: nowDate(),
          },
          {
            cte: sql`bound AS (${binding.getSQL()}), created_thread AS (
      INSERT INTO chat_threads (id,org_id,user_id,title,hidden) SELECT chat_thread_id,${row.orgId},${row.userId},${titles[row.task]},true FROM bound RETURNING id)`,
            gate: sql`EXISTS (SELECT 1 FROM created_thread)`,
            result: sql`SELECT id FROM created_thread`,
          },
        ),
      ),
    );
    signal.throwIfAborted();
    return result.length ? threadId : null;
  },
);

const dispatchSlot$ = command(
  async ({ set }, candidate: DueSchedule, at: Date, signal: AbortSignal) => {
    const row = candidate.schedule;
    const started = monotonicNow();
    const anchor = row.nextRunAt;
    if (!anchor) {
      return "contended";
    }
    const db = set(writeDb$);
    const next = nextProactiveSlot(row, row.task, row.timezone, at);
    const expired = row.task === "morning-brief" && scheduleExpired(anchor, at);
    const active =
      !expired && (await set(platformScheduleOwnerIsActive$, row, at, signal));
    const cursor = {
      nextRunAt: next,
      deferredAnchorAt: null,
      deferredUntil: null,
      deferredReason: null,
    };
    if (!active) {
      const advanced = await db
        .update(proactiveSchedules)
        .set(cursor)
        .where(observedSlot(row, anchor))
        .returning({ task: proactiveSchedules.task });
      signal.throwIfAborted();
      return advanced.length ? (expired ? "expired" : "inactive") : "contended";
    }
    const chatThreadId = await set(proactiveThread$, candidate, anchor, signal);
    if (!chatThreadId) {
      return "contended";
    }
    const id = randomUUID();
    const accepted = db
      .update(proactiveSchedules)
      .set({ ...cursor, lastRunAt: at })
      .where(
        and(
          observedSlot(row, anchor),
          eq(proactiveSchedules.chatThreadId, chatThreadId),
          currentMember,
          sql`EXISTS (SELECT 1 FROM chat_threads t WHERE t.id=${chatThreadId}::uuid AND t.org_id=${row.orgId} AND t.user_id=${row.userId} AND t.hidden)`,
        ),
      )
      .returning({ id: proactiveSchedules.chatThreadId });
    const append = canonicalChatEventAppendCtes(
      [
        {
          id,
          chatThreadId,
          eventType: "input.prompt",
          runId: null,
          payload: {
            userMessage: createUserMessageDocument({ text: titles[row.task] }),
          },
          contextType: "proactive",
          contextId: id,
          createdAt: at,
        },
      ],
      "none",
      sql`EXISTS (SELECT 1 FROM receipt)`,
    );
    const result = parseRawRows(
      insertedId,
      await db.execute(sql`WITH accepted AS (${accepted.getSQL()}), receipt AS (
     INSERT INTO proactive_occurrences (id,org_id,user_id,task,scheduled_at,preference_revision,chat_thread_id)
     SELECT ${id}::uuid,${row.orgId},${row.userId},${row.task},${anchor.toISOString()}::timestamp,${row.preferenceRevision},chat_thread_id FROM accepted RETURNING id),
     ${append}, queued AS (INSERT INTO queued_chat_threads (chat_thread_id,org_id,queued_at)
       SELECT ${chatThreadId}::uuid,${row.orgId},${at.toISOString()}::timestamp FROM inserted
       ON CONFLICT (chat_thread_id) DO UPDATE SET queued_at=LEAST(queued_chat_threads.queued_at,excluded.queued_at))
     SELECT id FROM inserted`),
    );
    signal.throwIfAborted();
    if (!result.length) {
      return "contended";
    }
    recordApiOperationTimings([
      {
        actionType: "proactive_occurrence_queued",
        success: true,
        durationMs: monotonicNow() - started,
        dimensions: {
          orgId: row.orgId,
          userId: row.userId,
          task: row.task,
          scheduledAt: anchor.toISOString(),
          occurrenceId: id,
          chatThreadId,
        },
      },
    ]);
    return "enqueued";
  },
);

/** Release the slot and retain its Run in history. Only failures under the current choice can pause the schedule. */
const settleProactiveOccurrences$ = command(
  async ({ set }, at: Date, signal: AbortSignal) => {
    const db = set(writeDb$);
    const occurrences = proactiveOccurrences;
    const replacement = alias(chatEvents, "replacement");
    const terminal = await db
      .select({
        id: occurrences.id,
        orgId: occurrences.orgId,
        userId: occurrences.userId,
        task: occurrences.task,
        runId: occurrences.runId,
        timezone: proactiveSchedules.timezone,
        runStatus: agentRuns.status,
        completedAt: agentRuns.completedAt,
        replacementType: replacement.eventType,
        replacedAt: replacement.createdAt,
      })
      .from(occurrences)
      .leftJoin(agentRuns, eq(agentRuns.id, occurrences.runId))
      .leftJoin(replacement, eq(replacement.revokesEventId, occurrences.id))
      .leftJoin(
        proactiveSchedules,
        and(
          eq(proactiveSchedules.orgId, occurrences.orgId),
          eq(proactiveSchedules.userId, occurrences.userId),
          eq(proactiveSchedules.task, occurrences.task),
        ),
      )
      .where(
        and(
          isNull(occurrences.settledAt),
          or(
            and(
              isNotNull(occurrences.runId),
              or(
                isNull(agentRuns.id),
                inArray(agentRuns.status, [
                  "completed",
                  "failed",
                  "cancelled",
                  "timeout",
                ]),
              ),
            ),
            and(
              isNull(occurrences.runId),
              or(
                isNotNull(replacement.id),
                notExists(
                  db
                    .select({ id: chatEvents.id })
                    .from(chatEvents)
                    .where(eq(chatEvents.id, occurrences.id)),
                ),
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(occurrences.scheduledAt))
      .limit(200);
    signal.throwIfAborted();
    if (terminal.length === 0) {
      return;
    }
    const results = terminal.map((row) => {
      const rejected = row.replacementType === "input.rejected";
      const status = row.runId ? row.runStatus : rejected ? "failed" : null;
      const finished = row.runId
        ? row.completedAt
        : rejected
          ? row.replacedAt
          : null;
      // A busy slot belongs to the preceding Run. Resume at the first slot after completion.
      const next = finished
        ? nextProactiveSlot(row, row.task, row.timezone, finished)
        : null;
      return sql`(${row.id}::uuid,${row.runId}::uuid,${status}::text,${next?.toISOString() ?? null}::timestamp)`;
    });
    await db.execute(sql`WITH terminal(id,run_id,status,next_run_at) AS (VALUES ${sql.join(results, sql`,`)}),
      settled AS (UPDATE proactive_occurrences o SET settled_at=${at.toISOString()}::timestamp FROM terminal t
        WHERE o.id=t.id AND o.settled_at IS NULL AND o.run_id IS NOT DISTINCT FROM t.run_id
        RETURNING o.*, t.status,t.next_run_at)
      UPDATE proactive_schedules s SET last_run_id=coalesce(t.run_id,s.last_run_id),
        next_run_at=CASE WHEN s.preference_revision=t.preference_revision AND s.next_run_at<t.next_run_at THEN t.next_run_at ELSE s.next_run_at END,
        consecutive_failures=CASE WHEN s.preference_revision<>t.preference_revision THEN s.consecutive_failures
          WHEN t.status='completed' THEN 0 WHEN t.status IN ('failed','timeout') THEN s.consecutive_failures+1 ELSE s.consecutive_failures END,
        enabled=CASE WHEN s.preference_revision=t.preference_revision AND t.status IN ('failed','timeout') AND s.consecutive_failures>=2 THEN false ELSE s.enabled END
        FROM settled t WHERE (s.org_id,s.user_id,s.task,s.chat_thread_id)=(t.org_id,t.user_id,t.task,t.chat_thread_id)`);
    signal.throwIfAborted();
  },
);

const recoverProactiveSchedules$ = command(
  async ({ set }, at: Date, signal: AbortSignal) => {
    const db = set(writeDb$);
    // Onboarding commits the preference before its best-effort setup. Start with the
    // saved choice so a missing schedule or a timezone supplied later can be repaired.
    const missing = parseRawRows(
      object({
        orgId: string(),
        userId: string(),
        timezone: string().nullable(),
        task: zEnum(proactiveTasks),
      }),
      await db.execute(sql`WITH intended AS (
        SELECT s.org_id,s.user_id,s.task,m.timezone
        FROM proactive_schedules s JOIN org_members_metadata m USING (org_id,user_id)
        WHERE s.task='morning-brief' AND s.intended_enabled AND m.timezone IS NOT NULL
        UNION ALL
        SELECT m.org_id,m.user_id,t.task,m.timezone FROM org_members_metadata m
        CROSS JOIN (VALUES ('suggestions'),('learning')) t(task)
        WHERE m.proactive_suggestions_enabled AND (t.task='suggestions' OR m.timezone IS NOT NULL)
      )
      SELECT i.org_id AS "orgId",i.user_id AS "userId",i.task,i.timezone
      FROM intended i JOIN org_members_cache member USING (org_id,user_id)
      LEFT JOIN proactive_schedules s USING (org_id,user_id,task)
      WHERE s.task IS NULL OR (s.intended_enabled AND (s.reconciliation_status IS NULL OR
        (s.reconciliation_status='current' AND s.task<>'suggestions' AND s.timezone IS NULL AND i.timezone IS NOT NULL)))
      ORDER BY i.org_id,i.user_id,i.task LIMIT 100`),
    );
    signal.throwIfAborted();
    for (const row of missing) {
      signal.throwIfAborted();
      await set(
        setStandalonePreferences$,
        {
          owner: row,
          tasks: [row.task],
          enabled: true,
          timezone: row.timezone,
          preserveChoice: true,
        },
        signal,
      );
    }
    signal.throwIfAborted();
    const paused = await db
      .select()
      .from(proactiveSchedules)
      .where(
        and(
          currentMember,
          sql`NOT enabled AND intended_enabled AND reconciliation_status='current' AND consecutive_failures>=3 AND (next_run_at IS NULL OR next_run_at<=${at.toISOString()}::timestamp)`,
        ),
      )
      .limit(100);
    signal.throwIfAborted();
    for (const row of paused) {
      const next =
        row.nextRunAt ?? nextProactiveSlot(row, row.task, row.timezone, at);
      if (!next) {
        continue;
      }
      await db
        .update(proactiveSchedules)
        .set({ enabled: row.nextRunAt !== null, nextRunAt: next })
        .where(
          and(
            scheduleOwner(row),
            eq(proactiveSchedules.task, row.task),
            eq(proactiveSchedules.preferenceRevision, row.preferenceRevision),
            eq(proactiveSchedules.enabled, false),
            row.nextRunAt
              ? eq(proactiveSchedules.nextRunAt, row.nextRunAt)
              : isNull(proactiveSchedules.nextRunAt),
          ),
        );
    }
    signal.throwIfAborted();
  },
);

export const dispatchProactiveSchedules$ = command(
  async ({ set }, signal: AbortSignal) => {
    const started = monotonicNow();
    const at = nowDate();
    await set(revokeStaleProactiveInputs$, undefined, signal);
    signal.throwIfAborted();
    await set(settleProactiveOccurrences$, at, signal);
    signal.throwIfAborted();
    await set(recoverProactiveSchedules$, at, signal);
    signal.throwIfAborted();
    const db = set(writeDb$);
    const due = await db
      .select({
        schedule: proactiveSchedules,
        visibleThread: {
          id: chatThreads.id,
          lastMessageAt: chatThreads.lastMessageAt,
        },
      })
      .from(proactiveSchedules)
      .leftJoin(
        chatThreads,
        and(
          eq(chatThreads.id, proactiveSchedules.chatThreadId),
          eq(chatThreads.orgId, proactiveSchedules.orgId),
          eq(chatThreads.userId, proactiveSchedules.userId),
          eq(chatThreads.hidden, false),
        ),
      )
      .where(
        and(
          eq(proactiveSchedules.enabled, true),
          eq(proactiveSchedules.intendedEnabled, true),
          eq(proactiveSchedules.reconciliationStatus, "current"),
          lte(proactiveSchedules.nextRunAt, at),
          noOutstanding,
          currentMember,
          sql`(deferred_anchor_at IS DISTINCT FROM next_run_at OR deferred_until IS NULL OR deferred_until<=${at.toISOString()}::timestamp)`,
        ),
      )
      .orderBy(
        asc(proactiveSchedules.nextRunAt),
        asc(proactiveSchedules.orgId),
        asc(proactiveSchedules.userId),
        asc(proactiveSchedules.task),
      )
      .limit(100);
    signal.throwIfAborted();
    const counts = { enqueued: 0, expired: 0, inactive: 0, contended: 0 };
    for (const row of due) {
      signal.throwIfAborted();
      counts[await set(dispatchSlot$, row, at, signal)]++;
    }
    recordApiOperationTimings([
      {
        actionType: "proactive_schedule_dispatch",
        success: true,
        durationMs: monotonicNow() - started,
        dimensions: { at: at.toISOString(), ...counts },
      },
    ]);
    return {
      phase: "standalone" as const,
      minute: at.toISOString(),
      ...counts,
    };
  },
);
