import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** The migration establishes the cohort boundary once, independently of deploy retries. */
export const morningBriefRollout = pgTable("morning_brief_rollout", {
  name: text("name").primaryKey(),
  activatedAt: timestamp("activated_at")
    .default(sql`(now() AT TIME ZONE 'UTC')`)
    .notNull(),
});

/** One-time enrollment intent. Installed automations retain ownership of their enabled state. */
export const morningBriefEnrollments = pgTable(
  "morning_brief_enrollments",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    /**
     * The one installation this enrollment owns.
     *
     * Morning Brief is installed per Agent, so a member may legitimately hold
     * several installations. The preference surface manages exactly the one
     * recorded here, pinned to the Agent it was installed on rather than to
     * whichever Agent is the org default today. Callers must tolerate a null
     * or stale value: rows written before this column existed, and rows whose
     * installation was later uninstalled, resolve through the adoption rule
     * instead.
     */
    workflowId: uuid("workflow_id"),
    membershipId: text("membership_id"),
    sourceCreatedAt: timestamp("source_created_at"),
    state: text("state", {
      enum: [
        "checking",
        "pending",
        "completed",
        "cancelled",
        "ineligible",
        "departed",
      ],
    }).notNull(),
    availableAt: timestamp("available_at").defaultNow().notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.orgId, table.userId] }),
      index("idx_morning_brief_enrollments_pending")
        .on(table.availableAt)
        .where(sql`${table.state} IN ('checking', 'pending')`),
      check(
        "chk_morning_brief_enrollment_state",
        sql`${table.state} IN ('checking', 'pending', 'completed', 'cancelled', 'ineligible', 'departed')`,
      ),
    ];
  },
);
