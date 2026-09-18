import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { workflowAutomations } from "./workflow";

/**
 * How far this occurrence got through the chat queue. `queued` is written with
 * the queue event in the claim transaction; `claimed` is written when the Run
 * transaction claims that exact event.
 */
export type MorningBriefScheduleClaimQueueDisposition = "queued" | "claimed";

/** Whether this occurrence already advanced the schedule. */
export type MorningBriefScheduleClaimSettlement =
  | "unsettled"
  | "completed"
  | "failed"
  | "pre_run_failure";

/**
 * Content-free execution journal for the legacy Morning Brief schedule.
 *
 * The legacy poller destroys the occurrence it fired: it clears `next_run_at`,
 * stamps the poll clock, and only later creates a queue event and a Run. This
 * table records the occurrence the poller actually claimed, in the same
 * transaction that clears the schedule and inserts the queue event, so the
 * completion callback can settle exactly that occurrence exactly once.
 *
 * Only the canonical Morning Brief automation a member owns is journaled.
 * Additional installations, manual runs and every other automation kind keep
 * their existing untracked behavior.
 *
 * Bounded metadata only: no prompt, provider payload, result, email address,
 * credential or free-form error string is ever written here.
 */
export const morningBriefScheduleClaims = pgTable(
  "morning_brief_schedule_claims",
  {
    /** Server-generated execution identity; also the claim token. */
    id: uuid("id").defaultRandom().primaryKey(),
    /**
     * The journal is a child of the automation it fires, so automation, owner
     * and organization deletion remove it through the existing cascade rather
     * than through a separate cleanup job.
     */
    automationId: uuid("automation_id")
      .notNull()
      .references(
        () => {
          return workflowAutomations.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: text("org_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    workflowId: uuid("workflow_id").notNull(),
    /** The exact `next_run_at` this claim consumed, read before it was cleared. */
    scheduledAnchorAt: timestamp("scheduled_anchor_at").notNull(),
    /** Actual poll clock. `firedAt` presentation keeps using this, not the anchor. */
    claimedAt: timestamp("claimed_at").notNull(),
    /**
     * Monotonic per automation. The highest sequence is the current claim, so a
     * callback from a superseded claim settles nothing. It fences newer
     * journaled claims only: it is not a user-choice, Settings or rollback
     * epoch, and it does not detect an ABA schedule replacement.
     */
    claimSequence: integer("claim_sequence").notNull(),
    /**
     * Exact original queue event and Run. These are deliberately not foreign
     * keys: chat events and Runs have their own retention and erasure
     * lifecycles, and losing one must not erase the record that this
     * occurrence was already journaled and settled.
     */
    queueEventId: uuid("queue_event_id"),
    runId: uuid("run_id"),
    queueDisposition: varchar("queue_disposition", { length: 16 })
      .$type<MorningBriefScheduleClaimQueueDisposition>()
      .notNull()
      .default("queued"),
    settlement: varchar("settlement", { length: 16 })
      .$type<MorningBriefScheduleClaimSettlement>()
      .notNull()
      .default("unsettled"),
    settledAt: timestamp("settled_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      // One logical occurrence per scheduled instant: a retried admission of
      // the same anchor can never produce a second execution identity.
      uniqueIndex("idx_morning_brief_schedule_claims_anchor").on(
        table.automationId,
        table.scheduledAnchorAt,
      ),
      uniqueIndex("idx_morning_brief_schedule_claims_queue_event")
        .on(table.queueEventId)
        .where(sql`${table.queueEventId} IS NOT NULL`),
      uniqueIndex("idx_morning_brief_schedule_claims_run")
        .on(table.runId)
        .where(sql`${table.runId} IS NOT NULL`),
      // Settlement reads the current claim for an automation by sequence.
      uniqueIndex("idx_morning_brief_schedule_claims_sequence").on(
        table.automationId,
        table.claimSequence,
      ),
      index("idx_morning_brief_schedule_claims_owner").on(
        table.orgId,
        table.ownerUserId,
      ),
      check(
        "chk_morning_brief_schedule_claims_queue_disposition",
        sql`${table.queueDisposition} IN ('queued', 'claimed')`,
      ),
      check(
        "chk_morning_brief_schedule_claims_settlement",
        sql`(
            ${table.settlement} = 'unsettled' AND ${table.settledAt} IS NULL
          ) OR (
            ${table.settlement} IN ('completed', 'failed', 'pre_run_failure')
            AND ${table.settledAt} IS NOT NULL
          )`,
      ),
      check(
        "chk_morning_brief_schedule_claims_sequence",
        sql`${table.claimSequence} >= 1`,
      ),
    ];
  },
);
