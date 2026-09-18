import {
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { chatThreads } from "./chat-thread";

/**
 * Which implementation currently owns a member's scheduled Morning Brief.
 *
 * `legacy` and `native` are the two steady states; the two draining states are
 * the only way between them. A draining phase means one implementation has
 * already stopped admitting new work while its already-admitted work is still
 * reachable, so neither side may claim the same slot.
 */
export const MORNING_BRIEF_EXECUTION_PHASES = [
  "legacy",
  "draining",
  "native",
  "rollback-draining",
] as const;

export type MorningBriefExecutionPhase =
  (typeof MORNING_BRIEF_EXECUTION_PHASES)[number];

/** The implementation the feature switch currently asks for. */
export const MORNING_BRIEF_EXECUTION_TARGETS = ["legacy", "native"] as const;

export type MorningBriefExecutionTarget =
  (typeof MORNING_BRIEF_EXECUTION_TARGETS)[number];

/**
 * Which implementation owns the persisted `next_run_at` obligation.
 *
 * `null` is only correct for a disabled choice or for a slot whose admitted
 * execution still owes exactly one settlement. An enabled owner may never sit
 * at `null` with nobody able to settle it, so the drain and settlement paths
 * assign or clear the successor inside the same transaction that revokes the
 * predecessor.
 */
export const MORNING_BRIEF_SCHEDULE_OWNERS = ["legacy", "native"] as const;

export type MorningBriefScheduleOwner =
  (typeof MORNING_BRIEF_SCHEDULE_OWNERS)[number];

/**
 * The durable Morning Brief choice, ownership and scheduling obligation.
 *
 * This is the first Morning Brief row that is authority rather than cache. It
 * is materialized once from the installed legacy state (the selected
 * installation and its automation), and after that every Settings, enrollment,
 * timezone, generic automation, reconciliation, deletion, scheduler and
 * callback writer mutates it under the lock order documented in
 * [native scheduling](../../../../../docs/morning-brief-native-scheduling.md).
 *
 * The legacy identifiers it keeps are migration lineage used to fence and drain
 * the old path. They are never the native runtime's authority: native admission
 * must keep working once the legacy scheduler is disabled and without any live
 * Official Workflow installation or catalog reconciliation.
 */
export const morningBriefNativeSchedules = pgTable(
  "morning_brief_native_schedules",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),

    /**
     * The user's logical Morning Brief choice.
     *
     * It is the same choice Settings shows, not the legacy automation's enabled
     * bit: once materialized, disabling the legacy scheduler must not disable
     * the member's brief.
     */
    enabled: boolean("enabled").notNull(),
    /** Null only for a choice whose installed schedule was not a cron. */
    cronExpression: text("cron_expression"),
    timezone: text("timezone").notNull(),

    /**
     * The next scheduled occurrence this member is owed.
     *
     * Null means no due work: either the choice is disabled, or an admitted
     * execution holds the obligation and owes exactly one settlement.
     */
    nextRunAt: timestamp("next_run_at"),
    /** Who must settle `next_run_at`. Null exactly when `next_run_at` is null. */
    scheduleOwner: text("schedule_owner", {
      enum: MORNING_BRIEF_SCHEDULE_OWNERS,
    }),

    phase: text("phase", { enum: MORNING_BRIEF_EXECUTION_PHASES }).notNull(),
    /** The implementation the switch last asked for. */
    target: text("target", { enum: MORNING_BRIEF_EXECUTION_TARGETS }).notNull(),

    /**
     * The execution-owner epoch.
     *
     * Every revocation or transfer bumps it. Work admitted under an older epoch
     * can still be reconciled, but can never deliver, settle the schedule or be
     * resurrected by a later re-enable.
     */
    ownerEpoch: integer("owner_epoch").notNull(),

    /**
     * The membership generation admission was pinned to.
     *
     * A fresh read of the member's current generation must still equal this
     * value at every admission boundary; a cache row's existence is not enough.
     */
    membershipId: text("membership_id").notNull(),

    /** The canonical Agent the native brief speaks as. */
    agentId: uuid("agent_id").notNull(),
    /** The canonical thread. Null before the first delivery creates it. */
    chatThreadId: uuid("chat_thread_id"),

    /** Migration lineage only. Never native admission authority. */
    legacyWorkflowId: uuid("legacy_workflow_id"),
    legacyAutomationId: uuid("legacy_automation_id"),

    /**
     * The epoch whose work a draining phase is still responsible for, and the
     * bounded deadline that drain holds.
     */
    drainingEpoch: integer("draining_epoch"),
    drainDeadlineAt: timestamp("drain_deadline_at"),
    /**
     * Why a drain cannot yet be proven complete.
     *
     * An unresolved reason keeps the phase draining rather than guessing. It is
     * bounded operational metadata and never carries bodies or credentials.
     */
    drainUnresolvedReason: text("drain_unresolved_reason"),

    materializedAt: timestamp("materialized_at").notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "morning_brief_native_schedules_pk",
        columns: [table.orgId, table.userId],
      }),
      // Deliberately no foreign key to `org_members_cache` or `agents`.
      //
      // The membership cache is a disposable read-through cache of Clerk's
      // role, and an Agent may be deleted while a slot still needs its
      // content-free deduplication and drain facts. Cascading from either would
      // let an eviction or an ordinary deletion erase authoritative scheduling
      // state and make a delivered occurrence replayable. Membership loss,
      // organization and user erasure, and Agent deletion instead run the
      // explicit revocation writer, which fences admission, clears the
      // obligation and records the drain it still owes.
      foreignKey({
        name: "fk_morning_brief_native_schedules_thread",
        columns: [table.chatThreadId],
        foreignColumns: [chatThreads.id],
      }).onDelete("set null"),
      // The due-owner scan reads enabled native rows ordered by their
      // obligation, so it must not degrade into a sequential scan as the
      // migrated population grows.
      index("idx_morning_brief_native_schedules_due").on(
        table.scheduleOwner,
        table.nextRunAt,
      ),
      index("idx_morning_brief_native_schedules_phase").on(table.phase),
      index("idx_morning_brief_native_schedules_user").on(table.userId),
      index("idx_morning_brief_native_schedules_agent").on(table.agentId),
      index("idx_morning_brief_native_schedules_thread").on(table.chatThreadId),
    ];
  },
);

/** The states one native occurrence moves through, in order. */
export const MORNING_BRIEF_NATIVE_OCCURRENCE_STATES = [
  "claimed",
  "deferred",
  "settled",
] as const;

export type MorningBriefNativeOccurrenceState =
  (typeof MORNING_BRIEF_NATIVE_OCCURRENCE_STATES)[number];

/**
 * How a claimed native slot finished.
 *
 * Each value is produced by exactly one branch of the settlement matrix, so an
 * honest failure can never be read back as a healthy empty day, and an unknown
 * provider outcome can never be read back as zero spend.
 */
export const MORNING_BRIEF_NATIVE_OUTCOMES = [
  /** Collection completed and held nothing. Zero model, Chat and email work. */
  "empty-skip",
  /** The model returned a validated no-content decision. */
  "model-skip",
  /** An accepted result whose delivery work is discoverable. */
  "delivered",
  /** Collection failed, was incomplete or exhausted its attempts. */
  "collection-failed",
  /** A known terminal generation failure recorded with its observed cost. */
  "generation-failed",
  /** The provider may have been invoked and its outcome stayed unknown. */
  "generation-unknown",
  /** Configuration prevented execution and its finite deferral was exhausted. */
  "not-configured",
  /** The choice, owner, membership or epoch was revoked before admission. */
  "revoked",
] as const;

export type MorningBriefNativeOutcome =
  (typeof MORNING_BRIEF_NATIVE_OUTCOMES)[number];

/**
 * One claimed native occurrence.
 *
 * Its identity is the owner plus the frozen scheduled anchor, which is what
 * makes a slot deduplicable across overlapping ticks, restarts and later source
 * additions: a new source set or prompt revision is provenance recorded on the
 * generation row, never a second row here and never a second model request.
 *
 * Exactly one settlement per row advances the member's schedule. Delivery
 * recovery reuses the saved result and never settles again.
 */
export const morningBriefNativeOccurrences = pgTable(
  "morning_brief_native_occurrences",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    /** The frozen scheduled anchor. Never replaced by poll time. */
    scheduledFor: timestamp("scheduled_for").notNull(),

    /** The epoch that admitted this claim. */
    ownerEpoch: integer("owner_epoch").notNull(),
    /** The membership generation pinned at claim time. */
    membershipId: text("membership_id").notNull(),
    /** The reporting timezone frozen with the anchor. */
    timezone: text("timezone").notNull(),

    state: text("state", { enum: MORNING_BRIEF_NATIVE_OCCURRENCE_STATES })
      .notNull()
      .default("claimed"),
    outcome: text("outcome", { enum: MORNING_BRIEF_NATIVE_OUTCOMES }),

    /** The tick that holds this slot, and until when. */
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    attempt: integer("attempt").notNull().default(1),

    /**
     * The single generation attempt this slot reserved, if it got that far.
     *
     * Its presence is what makes a second model request impossible after a
     * crash: the reservation commits before the sole platform request, so a
     * replay reconciles that attempt instead of starting another one.
     */
    generationAttemptId: uuid("generation_attempt_id"),

    /**
     * Whether an accepted result still owes delivery recovery.
     *
     * It is cleared only by the delivery consumer, which resolves the durable
     * receipt by this occurrence identity. A pending receipt must never wedge
     * the next occurrence or re-open this one.
     */
    deliveryPending: boolean("delivery_pending").notNull().default(false),

    /** The finite pre-reservation configuration deferral. */
    deferredUntil: timestamp("deferred_until"),
    deferAttempt: integer("defer_attempt").notNull().default(0),
    deferReason: text("defer_reason"),

    claimedAt: timestamp("claimed_at").notNull(),
    settledAt: timestamp("settled_at"),
    /** The obligation this slot's one settlement installed, for audit. */
    settledNextRunAt: timestamp("settled_next_run_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "morning_brief_native_occurrences_pk",
        columns: [table.orgId, table.userId, table.scheduledFor],
      }),
      foreignKey({
        name: "fk_morning_brief_native_occurrences_schedule",
        columns: [table.orgId, table.userId],
        foreignColumns: [
          morningBriefNativeSchedules.orgId,
          morningBriefNativeSchedules.userId,
        ],
      }).onDelete("cascade"),
      // One reserved generation attempt can belong to at most one slot, so a
      // replay can never attach a second slot to a possibly invoked request.
      uniqueIndex("uq_morning_brief_native_occurrences_attempt").on(
        table.generationAttemptId,
      ),
      index("idx_morning_brief_native_occurrences_open").on(
        table.state,
        table.leaseExpiresAt,
      ),
      index("idx_morning_brief_native_occurrences_delivery").on(
        table.deliveryPending,
      ),
    ];
  },
);
