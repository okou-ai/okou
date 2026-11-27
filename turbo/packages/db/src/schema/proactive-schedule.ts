import type { ProactiveTask } from "@okouai/api-contracts/contracts/proactive";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  pgView,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { chatThreads } from "./chat-thread";

function scheduleColumns() {
  return {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    task: text("task").$type<ProactiveTask>().notNull(),
    intendedEnabled: boolean("intended_enabled").notNull(),
    // An opted-in member can be paused, awaiting installation or in flight.
    enabled: boolean("enabled").notNull(),
    timezone: text("timezone"),
    nextRunAt: timestamp("next_run_at"),
    lastRunAt: timestamp("last_run_at"),
    lastRunId: uuid("last_run_id"),
    consecutiveFailures: integer("consecutive_failures").notNull(),
    reconciliationStatus: text("reconciliation_status"),
    deferredAnchorAt: timestamp("deferred_anchor_at"),
    deferredUntil: timestamp("deferred_until"),
    deferredReason: text("deferred_reason"),
  };
}

/** Independent destination for the three built-in tasks. No Workflow owns these rows. */
export const proactiveSchedules = pgTable(
  "proactive_schedules",
  {
    ...scheduleColumns(),
    // Changes to the member's choice invalidate only occurrences that have not started.
    preferenceRevision: integer("preference_revision").default(0).notNull(),
    chatThreadId: uuid("chat_thread_id").references(
      () => {
        return chatThreads.id;
      },
      {
        onDelete: "set null",
      },
    ),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.orgId, table.userId, table.task] }),
      check(
        "chk_proactive_schedule_task",
        sql`${table.task} IN ('morning-brief', 'suggestions', 'learning')`,
      ),
      index("idx_proactive_schedules_due")
        .on(table.nextRunAt)
        .where(sql`${table.enabled} AND ${table.nextRunAt} IS NOT NULL`),
      index("idx_proactive_schedules_user").on(table.userId),
      index("idx_proactive_schedules_thread")
        .on(table.chatThreadId)
        .where(sql`${table.chatThreadId} IS NOT NULL`),
    ];
  },
);

/**
 * Live handoff input while Automation owns dispatch. Read the same projection
 * for the initial copy, shadow comparisons and the final copy after draining.
 * A missing slot on an installed schedule must survive the transfer as NULL.
 */
export const legacyProactiveSchedules = pgView("legacy_proactive_schedules", {
  ...scheduleColumns(),
  chatThreadId: uuid("chat_thread_id"),
  installed: boolean("installed").notNull(),
  memberTimezone: text("member_timezone"),
}).with({ securityInvoker: true }).as(sql`
  WITH definitions(name, task, blueprint) AS (
    VALUES ('morning-brief', 'morning-brief', 'daily-delivery'),
           ('internal-test-morning-brief', 'morning-brief', 'daily-delivery'),
           ('agent-suggestions', 'suggestions', 'hourly-check'),
           ('proactive-learning', 'learning', 'nightly-learning')
  ), installations AS (
    SELECT w.org_id, w.owner_user_id AS user_id, d.task, d.blueprint, w.id
    FROM workflows w JOIN definitions d ON d.name = w.official_definition_name
    WHERE w.visibility = 'private'
  ), owners AS (
    SELECT org_id, user_id, task FROM installations
    UNION
    SELECT org_id, user_id, 'morning-brief' FROM morning_brief_enrollments
    WHERE state IN ('pending', 'cancelled')
    UNION
    SELECT m.org_id, m.user_id, d.task FROM org_members_metadata m
    CROSS JOIN (VALUES ('suggestions'), ('learning')) d(task)
    WHERE m.proactive_suggestions_enabled IS TRUE
  )
  SELECT o.org_id, o.user_id, o.task,
    CASE WHEN o.task = 'morning-brief'
      THEN COALESCE(a.official_intended_enabled, e.state = 'pending', false)
      ELSE COALESCE(m.proactive_suggestions_enabled, false)
    END AS intended_enabled,
    COALESCE(a.enabled, false) AS enabled,
    COALESCE(a.timezone, CASE WHEN o.task = 'suggestions' THEN 'UTC' ELSE m.timezone END) AS timezone,
    a.next_run_at, a.last_run_at, a.last_run_id,
    COALESCE(a.consecutive_failures, 0) AS consecutive_failures,
    a.official_reconciliation_status AS reconciliation_status,
    a.deferred_anchor_at, a.deferred_until, a.deferred_reason,
    t.id AS chat_thread_id, a.id IS NOT NULL AS installed, m.timezone AS member_timezone
  FROM owners o
  LEFT JOIN installations i USING (org_id, user_id, task)
  LEFT JOIN workflow_automations a ON a.workflow_id = i.id
    AND a.org_id = o.org_id AND a.owner_user_id = o.user_id
    AND a.official_blueprint_key = i.blueprint AND a.kind = 'schedule' AND a.schedule_type = 'cron'
  LEFT JOIN morning_brief_enrollments e ON o.task = 'morning-brief'
    AND e.org_id = o.org_id AND e.user_id = o.user_id
  LEFT JOIN org_members_metadata m ON m.org_id = o.org_id AND m.user_id = o.user_id
  LEFT JOIN workflow_user_automation_threads b ON b.workflow_id = i.id
    AND b.org_id = o.org_id AND b.user_id = o.user_id
  LEFT JOIN chat_threads t ON t.id = b.chat_thread_id AND t.org_id = o.org_id AND t.user_id = o.user_id
  WHERE e.state IS DISTINCT FROM 'departed'
`);

/** One release-wide handoff; ordinary member automations never consult it. */
export const proactiveDispatchHandoff = pgTable(
  "proactive_dispatch_handoff",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    phase: text("phase")
      .$type<"automation" | "draining" | "standalone">()
      .notNull(),
    changedAt: timestamp("changed_at").defaultNow().notNull(),
    // The first verified API release with archive readers is a compatible rollback target.
    archiveReaderRelease: text("archive_reader_release"),
    archiveReaderVerifiedAt: timestamp("archive_reader_verified_at"),
  },
  (table) => {
    return [
      check("chk_proactive_handoff_singleton", sql`${table.singleton}`),
      check(
        "chk_proactive_handoff_phase",
        sql`${table.phase} IN ('automation', 'draining', 'standalone')`,
      ),
    ];
  },
);

/** The original time, input identity and Run receipt survive preference changes. */
export const proactiveOccurrences = pgTable(
  "proactive_occurrences",
  {
    id: uuid("id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    task: text("task").$type<ProactiveTask>().notNull(),
    scheduledAt: timestamp("scheduled_at").notNull(),
    preferenceRevision: integer("preference_revision").notNull(),
    chatThreadId: uuid("chat_thread_id").notNull(),
    runId: uuid("run_id"),
    suggestionsEnabled: boolean("suggestions_enabled"),
    cardDeliveryEnabled: boolean("card_delivery_enabled"),
    settledAt: timestamp("settled_at"),
  },
  (table) => {
    return [
      check(
        "chk_proactive_occurrence_task",
        sql`${table.task} IN ('morning-brief','suggestions','learning')`,
      ),
      index("idx_proactive_occurrence_thread").on(table.chatThreadId),
      uniqueIndex("uq_proactive_occurrence_slot").on(
        table.orgId,
        table.userId,
        table.task,
        table.scheduledAt,
      ),
      uniqueIndex("uq_proactive_occurrence_run")
        .on(table.runId)
        .where(sql`${table.runId} IS NOT NULL`),
      uniqueIndex("uq_proactive_occurrence_outstanding")
        .on(table.orgId, table.userId, table.task)
        .where(sql`${table.settledAt} IS NULL`),
    ];
  },
);
