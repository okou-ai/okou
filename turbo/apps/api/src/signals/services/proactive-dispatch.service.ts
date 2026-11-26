import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { revokeStaleProactiveInputs$ } from "./proactive-queued-input.service";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { randomUUID } from "node:crypto";
import type { ProactiveTask } from "@okouai/api-contracts/contracts/proactive";
import { proactiveSchedules } from "@okouai/db/schema/proactive-schedule";
import { command } from "ccstate";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { parseRawRows } from "../../lib/db-raw-rows";
import { object, uuid } from "zod";
import { recordApiOperationTimings } from "../external/sandbox-op-log";
import { nowDate, monotonicNow } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { canonicalChatEventAppendCtes } from "./chat-event-append.service";
import { chatThreadEventInsertSql } from "./chat-thread-event.service";
import { createUserMessageDocument } from "./chat-user-message.service";
import { officialScheduleOwnerIsActive$ } from "./official-schedule-activity.service";
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
const standalone = sql`EXISTS (SELECT 1 FROM proactive_dispatch_handoff WHERE phase='standalone')`;
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
    standalone,
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
      !expired && (await set(officialScheduleOwnerIsActive$, row, at, signal));
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

/** Completion, including rejection before launch, releases the task's outstanding slot. */
const settleProactiveOccurrences$ = command(
  async ({ set }, at: Date, signal: AbortSignal) => {
    await set(writeDb$).execute(sql`WITH terminal AS (
    SELECT o.id,CASE WHEN o.run_id IS NULL AND EXISTS (SELECT 1 FROM chat_events rejection WHERE rejection.revokes_event_id=o.id AND rejection.event_type='input.rejected')
      THEN 'failed' ELSE r.status END AS status, o.run_id FROM proactive_occurrences o LEFT JOIN agent_runs r ON r.id=o.run_id
    WHERE o.settled_at IS NULL AND (
      (o.run_id IS NOT NULL AND (r.id IS NULL OR r.status IN ('completed','failed','cancelled','timeout'))) OR
      (o.run_id IS NULL AND (EXISTS (SELECT 1 FROM chat_events e WHERE e.revokes_event_id=o.id) OR NOT EXISTS (SELECT 1 FROM chat_events e WHERE e.id=o.id))))
    ORDER BY o.scheduled_at LIMIT 200
  ), settled AS (UPDATE proactive_occurrences o SET settled_at=${at.toISOString()}::timestamp FROM terminal t
    WHERE o.id=t.id AND o.settled_at IS NULL RETURNING o.*, t.status)
  UPDATE proactive_schedules s SET last_run_id=coalesce(t.run_id,s.last_run_id),
    consecutive_failures=CASE WHEN t.status='completed' THEN 0 WHEN t.status IN ('failed','timeout') THEN s.consecutive_failures+1 ELSE s.consecutive_failures END,
    enabled=CASE WHEN t.status IN ('failed','timeout') AND s.consecutive_failures>=2 THEN false ELSE s.enabled END
    FROM settled t WHERE (s.org_id,s.user_id,s.task,s.preference_revision)=(t.org_id,t.user_id,t.task,t.preference_revision)`);
    signal.throwIfAborted();
  },
);

const recoverProactiveSchedules$ = command(
  async ({ set }, at: Date, signal: AbortSignal) => {
    const db = set(writeDb$);
    // The legacy projection also contains opted-in members awaiting their first installation.
    // A cleared cursor on an installed, reconciled schedule is a different state.
    const uninstalled = await db
      .select({
        schedule: proactiveSchedules,
        memberTimezone: orgMembersMetadata.timezone,
      })
      .from(proactiveSchedules)
      .leftJoin(
        orgMembersMetadata,
        and(
          eq(orgMembersMetadata.orgId, proactiveSchedules.orgId),
          eq(orgMembersMetadata.userId, proactiveSchedules.userId),
        ),
      )
      .where(
        and(
          eq(proactiveSchedules.intendedEnabled, true),
          isNull(proactiveSchedules.reconciliationStatus),
          currentMember,
          sql`(${proactiveSchedules.task}='suggestions' OR ${orgMembersMetadata.timezone} IS NOT NULL)`,
        ),
      )
      .limit(100);
    signal.throwIfAborted();
    for (const { schedule, memberTimezone } of uninstalled) {
      signal.throwIfAborted();
      await set(
        setStandalonePreferences$,
        {
          owner: schedule,
          tasks: [schedule.task],
          enabled: true,
          timezone: memberTimezone,
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
            standalone,
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
