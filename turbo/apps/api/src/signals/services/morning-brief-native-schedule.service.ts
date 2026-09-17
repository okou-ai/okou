import { isValidTimeZone } from "@okouai/core/timezone";
import {
  morningBriefNativeOccurrences,
  morningBriefNativeSchedules,
  type MorningBriefExecutionPhase,
  type MorningBriefExecutionTarget,
  type MorningBriefNativeOutcome,
} from "@okouai/db/schema/morning-brief-native-schedule";
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import type { ReadonlyDb } from "../external/db";
import type { MorningBriefMemberIdentity } from "./morning-brief-enrollment-data.service";
import {
  loadMorningBriefMigrationState,
  type MorningBriefMigrationState,
  type MorningBriefStateReader,
} from "./morning-brief-migration-state.service";
import { calculateNextRun } from "./time-automation";

/**
 * The durable Morning Brief choice, execution ownership and schedule.
 *
 * Every rule in this module is described in
 * [native scheduling](../../../../../../docs/morning-brief-native-scheduling.md).
 * Two of them are load-bearing everywhere else:
 *
 * - **Lock order.** A writer that touches both the legacy automation and this
 *   row takes the member's Morning Brief preference advisory lock first, then
 *   this row's `FOR UPDATE`, then any occurrence row. Nothing else is allowed,
 *   so the Settings, reconciliation, deletion and cron writers can never
 *   deadlock against each other.
 * - **Fresh predicates.** Every mutation revalidates the epoch and phase it
 *   read before it commits. External preflight (Clerk, provider, Slack) happens
 *   outside the transaction, and the transaction re-reads what it depends on.
 */

export type MorningBriefNativeScheduleRow =
  typeof morningBriefNativeSchedules.$inferSelect;

export type MorningBriefNativeOccurrenceRow =
  typeof morningBriefNativeOccurrences.$inferSelect;

/** Any reader, including a transaction, that can read the native state. */
export type MorningBriefNativeReader = Pick<ReadonlyDb, "select">;

/** The smallest writer this module needs. A transaction always satisfies it. */
export type MorningBriefNativeWriter = Tx;

/** How long one tick may hold a claimed slot before another may reclaim it. */
export const NATIVE_OCCURRENCE_LEASE_MS = 5 * 60 * 1000;

/**
 * The finite pre-reservation configuration deferral.
 *
 * A slot that cannot execute because its configuration is momentarily missing
 * is deferred at most this many times, each time by
 * {@link NATIVE_CONFIGURATION_DEFER_MS}. Once exhausted it settles as
 * `not-configured` and schedules the next future occurrence, so a broken
 * configuration can never hot-loop and never silently disables the member.
 */
export const NATIVE_CONFIGURATION_DEFER_LIMIT = 3;
export const NATIVE_CONFIGURATION_DEFER_MS = 15 * 60 * 1000;

/**
 * How long a drain may stay unresolved before it is reported rather than held
 * silently. The phase does not advance on expiry: an expired deadline is an
 * operational signal, never proof that the old writers drained.
 */
export const NATIVE_DRAIN_REPORT_AFTER_MS = 60 * 60 * 1000;

/** The materialization refused, with the reason a caller can act on. */
export type MorningBriefMaterializationRefusal =
  | "not-installed"
  | "installation-pending"
  | "installation-inconsistent"
  | "missing-timezone"
  | "missing-membership";

export type MorningBriefMaterializationResult =
  | {
      readonly kind: "materialized";
      readonly row: MorningBriefNativeScheduleRow;
    }
  | {
      readonly kind: "refused";
      readonly reason: MorningBriefMaterializationRefusal;
    };

function scheduleWhere(owner: MorningBriefMemberIdentity) {
  return and(
    eq(morningBriefNativeSchedules.orgId, owner.orgId),
    eq(morningBriefNativeSchedules.userId, owner.userId),
  );
}

/**
 * Read the native row without locking it.
 *
 * GET paths use this. It never creates, repairs or schedules anything.
 */
export async function readMorningBriefNativeSchedule(
  db: MorningBriefNativeReader,
  owner: MorningBriefMemberIdentity,
): Promise<MorningBriefNativeScheduleRow | undefined> {
  const [row] = await db
    .select()
    .from(morningBriefNativeSchedules)
    .where(scheduleWhere(owner))
    .limit(1);
  return row;
}

/**
 * Take the row lock in the documented order.
 *
 * Returns `undefined` when the member has no native row yet, which is the
 * normal pre-materialization state rather than an error.
 */
export async function lockMorningBriefNativeSchedule(
  tx: MorningBriefNativeWriter,
  owner: MorningBriefMemberIdentity,
): Promise<MorningBriefNativeScheduleRow | undefined> {
  const [row] = await tx
    .select()
    .from(morningBriefNativeSchedules)
    .where(scheduleWhere(owner))
    .limit(1)
    .for("update");
  return row;
}

/**
 * The next occurrence strictly after `from` under a current schedule.
 *
 * It always uses the persisted cron and timezone as they are at settlement, so
 * a timezone or cron edit that arrived during an in-flight execution takes
 * effect on that execution's one settlement rather than by cancelling it.
 */
export function computeNativeNextRunAt(args: {
  readonly enabled: boolean;
  readonly cronExpression: string | null;
  readonly timezone: string;
  readonly from: Date;
}): Date | null {
  if (!args.enabled || args.cronExpression === null) {
    return null;
  }
  if (!isValidTimeZone(args.timezone)) {
    return null;
  }
  return calculateNextRun(args.cronExpression, args.timezone, args.from);
}

/**
 * Materialize the durable native row from the member's installed legacy state.
 *
 * The authority is the selected installation and *its automation's* enabled
 * state and schedule — never enrollment completion, never the disposable S3a
 * projection, never a title match. Additional installations stay inventory and
 * are neither adopted nor mutated. A disabled installed choice materializes as
 * disabled, and a disabled row is never given a scheduling obligation.
 *
 * It is idempotent: an existing row is authority and is returned untouched, so
 * re-running the migration can never overwrite a choice made after cutover.
 */
export async function materializeMorningBriefNativeSchedule(
  tx: MorningBriefNativeWriter,
  owner: MorningBriefMemberIdentity,
  at: Date,
  state?: MorningBriefMigrationState,
): Promise<MorningBriefMaterializationResult> {
  const existing = await lockMorningBriefNativeSchedule(tx, owner);
  if (existing !== undefined) {
    return { kind: "materialized", row: existing };
  }

  const installed =
    state ??
    (await loadMorningBriefMigrationState(
      tx as unknown as MorningBriefStateReader,
      owner,
    ));
  if (installed.kind === "absent") {
    return { kind: "refused", reason: "not-installed" };
  }
  if (installed.kind === "pending") {
    return { kind: "refused", reason: "installation-pending" };
  }
  if (installed.kind === "inconsistent") {
    return { kind: "refused", reason: "installation-inconsistent" };
  }
  if (!isValidTimeZone(installed.automation.timezone)) {
    return { kind: "refused", reason: "missing-timezone" };
  }

  const membershipId = await loadCurrentMembershipGeneration(tx, owner);
  if (membershipId === null) {
    return { kind: "refused", reason: "missing-membership" };
  }

  // The first row keeps the legacy owner: materialization is bootstrap, never
  // a cutover. Only an explicit transition may move the schedule obligation.
  const [row] = await tx
    .insert(morningBriefNativeSchedules)
    .values({
      orgId: owner.orgId,
      userId: owner.userId,
      enabled: installed.automation.enabled,
      cronExpression: installed.automation.cronExpression,
      timezone: installed.automation.timezone,
      nextRunAt: installed.automation.enabled
        ? installed.automation.nextRunAt
        : null,
      scheduleOwner:
        installed.automation.enabled && installed.automation.nextRunAt !== null
          ? "legacy"
          : null,
      phase: "legacy",
      target: "legacy",
      ownerEpoch: 1,
      membershipId,
      agentId: installed.installation.agentId,
      chatThreadId: installed.chatThreadId,
      legacyWorkflowId: installed.installation.id,
      legacyAutomationId: installed.automation.id,
      materializedAt: at,
      updatedAt: at,
    })
    // A concurrent tick may have materialized the same member first. That row
    // is authority; this one must not overwrite any of its fields.
    .onConflictDoNothing()
    .returning();
  if (row !== undefined) {
    return { kind: "materialized", row };
  }
  const raced = await lockMorningBriefNativeSchedule(tx, owner);
  return raced === undefined
    ? { kind: "refused", reason: "missing-membership" }
    : { kind: "materialized", row: raced };
}

/**
 * The member's current membership generation.
 *
 * Read fresh at every admission boundary. The cached row merely existing is not
 * evidence the member is still admitted, so callers compare this value with the
 * generation pinned on the native row and on the claimed occurrence.
 */
export async function loadCurrentMembershipGeneration(
  db: MorningBriefNativeReader,
  owner: MorningBriefMemberIdentity,
): Promise<string | null> {
  const rows = await db
    .select({ membershipId: sql<string>`membership_id` })
    .from(sql`org_members_cache`)
    .where(
      sql`org_id = ${owner.orgId} AND user_id = ${owner.userId} AND deleted_at IS NULL`,
    )
    .limit(1);
  return rows[0]?.membershipId ?? null;
}

/** What a logical-choice writer intends to change. */
export interface MorningBriefLogicalChoicePatch {
  readonly enabled?: boolean;
  readonly cronExpression?: string | null;
  readonly timezone?: string;
  readonly chatThreadId?: string | null;
  readonly agentId?: string;
}

export type MorningBriefChoiceApplication =
  | { readonly kind: "applied"; readonly row: MorningBriefNativeScheduleRow }
  | { readonly kind: "absent" };

/**
 * Apply a logical Settings-level change coherently.
 *
 * The contract this encodes:
 *
 * - A **timezone-only or cron-only** edit never revokes an in-flight execution.
 *   The epoch is untouched and an occurrence that already holds the obligation
 *   keeps its frozen anchor, window and epoch; its one settlement then computes
 *   the next occurrence from the schedule as edited here.
 * - **Disabling** revokes: it bumps the epoch, clears the obligation, and by
 *   doing so invalidates every slot admitted under the old epoch. Re-enabling
 *   later bumps the epoch again and schedules the next *future* occurrence, so
 *   the revoked slot is never replayed.
 * - An enabled row always leaves this function with either a scheduling
 *   obligation or an admitted occurrence that owes its settlement. It is never
 *   left wedged at `next_run_at = NULL` with no owner.
 */
export async function applyMorningBriefLogicalChoice(
  tx: MorningBriefNativeWriter,
  owner: MorningBriefMemberIdentity,
  patch: MorningBriefLogicalChoicePatch,
  at: Date,
): Promise<MorningBriefChoiceApplication> {
  const current = await lockMorningBriefNativeSchedule(tx, owner);
  if (current === undefined) {
    return { kind: "absent" };
  }

  const enabled = patch.enabled ?? current.enabled;
  const cronExpression =
    patch.cronExpression === undefined
      ? current.cronExpression
      : patch.cronExpression;
  const timezone = patch.timezone ?? current.timezone;
  const enabledChanged = enabled !== current.enabled;

  const inFlight = await loadUnsettledOccurrence(tx, owner);

  // Only a change of the enabled choice revokes. A schedule or timezone edit is
  // deliberately not a revocation.
  const ownerEpoch = enabledChanged
    ? current.ownerEpoch + 1
    : current.ownerEpoch;

  let nextRunAt: Date | null;
  let scheduleOwner: MorningBriefNativeScheduleRow["scheduleOwner"];
  if (!enabled) {
    nextRunAt = null;
    scheduleOwner = null;
  } else if (enabledChanged) {
    // Re-enabling starts from now, never from the revoked slot.
    nextRunAt = computeNativeNextRunAt({
      enabled,
      cronExpression,
      timezone,
      from: at,
    });
    scheduleOwner =
      nextRunAt === null ? null : scheduleOwnerForPhase(current.phase);
  } else if (
    inFlight !== undefined &&
    inFlight.ownerEpoch === current.ownerEpoch
  ) {
    // The in-flight execution still owns the obligation; leave it to settle.
    nextRunAt = current.nextRunAt;
    scheduleOwner = current.scheduleOwner;
  } else if (current.nextRunAt !== null) {
    // A future unconsumed slot is already authoritative. Recompute it only
    // because the recurrence itself may have changed, and never move it
    // backwards past a slot a worker may already be about to claim.
    const recomputed = computeNativeNextRunAt({
      enabled,
      cronExpression,
      timezone,
      from: at,
    });
    nextRunAt = recomputed;
    scheduleOwner = recomputed === null ? null : current.scheduleOwner;
  } else {
    nextRunAt = computeNativeNextRunAt({
      enabled,
      cronExpression,
      timezone,
      from: at,
    });
    scheduleOwner =
      nextRunAt === null ? null : scheduleOwnerForPhase(current.phase);
  }

  const [row] = await tx
    .update(morningBriefNativeSchedules)
    .set({
      enabled,
      cronExpression,
      timezone,
      nextRunAt,
      scheduleOwner,
      ownerEpoch,
      ...(patch.chatThreadId === undefined
        ? {}
        : { chatThreadId: patch.chatThreadId }),
      ...(patch.agentId === undefined ? {} : { agentId: patch.agentId }),
      updatedAt: at,
    })
    .where(
      and(
        scheduleWhere(owner),
        // The fresh predicate: a compensation that read an older epoch cannot
        // restore that epoch's state over a newer writer.
        eq(morningBriefNativeSchedules.ownerEpoch, current.ownerEpoch),
      ),
    )
    .returning();
  return row === undefined ? { kind: "absent" } : { kind: "applied", row };
}

function scheduleOwnerForPhase(
  phase: MorningBriefExecutionPhase,
): MorningBriefNativeScheduleRow["scheduleOwner"] {
  return phase === "native" ? "native" : "legacy";
}

/** The unsettled occurrence a member currently owes, if any. */
export async function loadUnsettledOccurrence(
  db: MorningBriefNativeReader,
  owner: MorningBriefMemberIdentity,
): Promise<MorningBriefNativeOccurrenceRow | undefined> {
  const [row] = await db
    .select()
    .from(morningBriefNativeOccurrences)
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, owner.orgId),
        eq(morningBriefNativeOccurrences.userId, owner.userId),
        sql`${morningBriefNativeOccurrences.settledAt} IS NULL`,
      ),
    )
    .orderBy(morningBriefNativeOccurrences.scheduledFor)
    .limit(1);
  return row;
}

/**
 * Revoke this member's native execution authority.
 *
 * Used by membership loss, Agent or thread deletion and erasure. It bumps the
 * epoch so no admitted work can deliver or settle, and clears the obligation in
 * the same transaction. It never deletes an occurrence row: the content-free
 * deduplication and drain facts must outlive content retention.
 */
export async function revokeMorningBriefNativeAuthority(
  tx: MorningBriefNativeWriter,
  owner: MorningBriefMemberIdentity,
  at: Date,
): Promise<MorningBriefNativeScheduleRow | undefined> {
  const current = await lockMorningBriefNativeSchedule(tx, owner);
  if (current === undefined) {
    return undefined;
  }
  const [row] = await tx
    .update(morningBriefNativeSchedules)
    .set({
      nextRunAt: null,
      scheduleOwner: null,
      ownerEpoch: current.ownerEpoch + 1,
      // Work admitted under the old epoch is still reachable, so the phase
      // records that it owes a drain rather than pretending it vanished.
      ...(current.phase === "native"
        ? {
            phase: "rollback-draining" as const,
            drainingEpoch: current.ownerEpoch,
            drainDeadlineAt: new Date(
              at.getTime() + NATIVE_DRAIN_REPORT_AFTER_MS,
            ),
            drainUnresolvedReason: "authority-revoked",
          }
        : {}),
      updatedAt: at,
    })
    .where(
      and(
        scheduleWhere(owner),
        eq(morningBriefNativeSchedules.ownerEpoch, current.ownerEpoch),
      ),
    )
    .returning();
  return row;
}

export type MorningBriefTransitionResult =
  | { readonly kind: "unchanged"; readonly row: MorningBriefNativeScheduleRow }
  | {
      readonly kind: "transitioned";
      readonly row: MorningBriefNativeScheduleRow;
    }
  | {
      readonly kind: "held";
      readonly row: MorningBriefNativeScheduleRow;
      readonly reason: string;
    }
  | { readonly kind: "absent" };

/**
 * Ask for a target implementation and advance the phase machine by one legal
 * step under the current drain evidence.
 *
 * The only legal edges are `legacy → draining → native` and
 * `native → rollback-draining → legacy`. Turning the switch off while native
 * work exists enters or continues rollback; it never reopens legacy alongside
 * that work. Repeated flips converge on the current target without opening both
 * owners or manufacturing extra epochs.
 *
 * `drainProven` is supplied by the caller because proving it needs the real
 * legacy journal, queue, Run and outbox reads, which are not this module's
 * concern. An unproven drain stays draining and records why.
 */
export async function advanceMorningBriefExecutionPhase(
  tx: MorningBriefNativeWriter,
  owner: MorningBriefMemberIdentity,
  args: {
    readonly target: MorningBriefExecutionTarget;
    readonly drain:
      | { readonly kind: "proven" }
      | { readonly kind: "unresolved"; readonly reason: string };
    readonly at: Date;
  },
): Promise<MorningBriefTransitionResult> {
  const current = await lockMorningBriefNativeSchedule(tx, owner);
  if (current === undefined) {
    return { kind: "absent" };
  }

  const phase = current.phase;
  const target = args.target;
  const at = args.at;

  const settled = (
    next: MorningBriefExecutionPhase,
    patch: Partial<typeof morningBriefNativeSchedules.$inferInsert>,
  ) => {
    return tx
      .update(morningBriefNativeSchedules)
      .set({ phase: next, target, updatedAt: at, ...patch })
      .where(
        and(
          scheduleWhere(owner),
          eq(morningBriefNativeSchedules.phase, phase),
          eq(morningBriefNativeSchedules.ownerEpoch, current.ownerEpoch),
        ),
      )
      .returning();
  };

  if (phase === "legacy" && target === "native") {
    // Close new legacy admission first; the old scheduled-anchor obligation is
    // preserved until the drain transfers it.
    const [row] = await settled("draining", {
      drainingEpoch: current.ownerEpoch,
      drainDeadlineAt: new Date(at.getTime() + NATIVE_DRAIN_REPORT_AFTER_MS),
      drainUnresolvedReason: "legacy-work-not-yet-proven-drained",
    });
    return row === undefined
      ? { kind: "absent" }
      : { kind: "transitioned", row };
  }

  if (phase === "draining" && target === "native") {
    if (args.drain.kind !== "proven") {
      const [row] = await settled("draining", {
        drainUnresolvedReason: args.drain.reason,
      });
      return row === undefined
        ? { kind: "absent" }
        : { kind: "held", row, reason: args.drain.reason };
    }
    // The transfer installs exactly one native obligation, strictly in the
    // future under the current clock and the current recurrence.
    const nextRunAt = computeNativeNextRunAt({
      enabled: current.enabled,
      cronExpression: current.cronExpression,
      timezone: current.timezone,
      from: at,
    });
    const [row] = await settled("native", {
      ownerEpoch: current.ownerEpoch + 1,
      nextRunAt,
      scheduleOwner: nextRunAt === null ? null : "native",
      drainingEpoch: null,
      drainDeadlineAt: null,
      drainUnresolvedReason: null,
    });
    return row === undefined
      ? { kind: "absent" }
      : { kind: "transitioned", row };
  }

  if (phase === "native" && target === "legacy") {
    // Stop new native claims first and keep the already-admitted native
    // invocation, result and delivery obligations under explicit drain
    // authority. Legacy is not restored yet.
    const [row] = await settled("rollback-draining", {
      drainingEpoch: current.ownerEpoch,
      drainDeadlineAt: new Date(at.getTime() + NATIVE_DRAIN_REPORT_AFTER_MS),
      drainUnresolvedReason: "native-work-not-yet-settled",
    });
    return row === undefined
      ? { kind: "absent" }
      : { kind: "transitioned", row };
  }

  if (phase === "rollback-draining" && target === "legacy") {
    if (args.drain.kind !== "proven") {
      const [row] = await settled("rollback-draining", {
        drainUnresolvedReason: args.drain.reason,
      });
      return row === undefined
        ? { kind: "absent" }
        : { kind: "held", row, reason: args.drain.reason };
    }
    // Legacy is restored from the CURRENT logical preference and timezone and
    // the next future unconsumed slot — never an old copy or the original
    // enabled bit.
    const nextRunAt = computeNativeNextRunAt({
      enabled: current.enabled,
      cronExpression: current.cronExpression,
      timezone: current.timezone,
      from: at,
    });
    const [row] = await settled("legacy", {
      ownerEpoch: current.ownerEpoch + 1,
      nextRunAt,
      scheduleOwner: nextRunAt === null ? null : "legacy",
      drainingEpoch: null,
      drainDeadlineAt: null,
      drainUnresolvedReason: null,
    });
    return row === undefined
      ? { kind: "absent" }
      : { kind: "transitioned", row };
  }

  // A flip back to the phase's own steady target only records the intent.
  if (current.target === target) {
    return { kind: "unchanged", row: current };
  }
  const [row] = await settled(phase, {});
  return row === undefined ? { kind: "absent" } : { kind: "unchanged", row };
}

export type MorningBriefNativeClaim =
  | {
      readonly kind: "claimed";
      readonly occurrence: MorningBriefNativeOccurrenceRow;
      readonly schedule: MorningBriefNativeScheduleRow;
    }
  | { readonly kind: "not-due" }
  | { readonly kind: "inadmissible"; readonly reason: string };

/**
 * Claim one native occurrence for this member under the current fences.
 *
 * The slot identity is the owner plus the frozen anchor, so overlapping ticks,
 * restarts and a later source-set change all converge on the same row. The
 * claim also takes the obligation off the schedule: from here exactly one
 * settlement puts it back.
 */
export async function claimMorningBriefNativeOccurrence(
  tx: MorningBriefNativeWriter,
  owner: MorningBriefMemberIdentity,
  args: {
    readonly now: Date;
    readonly leaseToken: string;
    readonly membershipId: string;
  },
): Promise<MorningBriefNativeClaim> {
  const schedule = await lockMorningBriefNativeSchedule(tx, owner);
  if (schedule === undefined) {
    return { kind: "inadmissible", reason: "absent" };
  }
  if (schedule.phase !== "native") {
    return { kind: "inadmissible", reason: `phase:${schedule.phase}` };
  }
  if (!schedule.enabled) {
    return { kind: "inadmissible", reason: "disabled" };
  }
  if (schedule.membershipId !== args.membershipId) {
    return { kind: "inadmissible", reason: "membership-generation" };
  }
  if (schedule.scheduleOwner !== "native" || schedule.nextRunAt === null) {
    return { kind: "not-due" };
  }
  if (schedule.nextRunAt.getTime() > args.now.getTime()) {
    return { kind: "not-due" };
  }

  const anchor = schedule.nextRunAt;
  const leaseExpiresAt = new Date(
    args.now.getTime() + NATIVE_OCCURRENCE_LEASE_MS,
  );

  // Missed ticks coalesce: the obligation moves to the anchor being claimed and
  // its settlement computes the next one from the settlement clock, so a long
  // outage produces one brief rather than a burst of old ones.
  const [occurrence] = await tx
    .insert(morningBriefNativeOccurrences)
    .values({
      orgId: owner.orgId,
      userId: owner.userId,
      scheduledFor: anchor,
      ownerEpoch: schedule.ownerEpoch,
      membershipId: args.membershipId,
      timezone: schedule.timezone,
      state: "claimed",
      leaseToken: args.leaseToken,
      leaseExpiresAt,
      claimedAt: args.now,
      updatedAt: args.now,
    })
    .onConflictDoUpdate({
      target: [
        morningBriefNativeOccurrences.orgId,
        morningBriefNativeOccurrences.userId,
        morningBriefNativeOccurrences.scheduledFor,
      ],
      set: {
        leaseToken: args.leaseToken,
        leaseExpiresAt,
        attempt: sql`${morningBriefNativeOccurrences.attempt} + 1`,
        updatedAt: args.now,
      },
      // Only an unsettled slot whose lease actually lapsed may be taken over,
      // and only within the epoch that admitted it. A settled slot and a live
      // lease are both untouchable, which is what keeps a second model request
      // impossible for a slot another tick may still be executing.
      setWhere: and(
        sql`${morningBriefNativeOccurrences.settledAt} IS NULL`,
        sql`${morningBriefNativeOccurrences.leaseExpiresAt} < ${args.now}`,
        eq(morningBriefNativeOccurrences.ownerEpoch, schedule.ownerEpoch),
      ),
    })
    .returning();
  if (occurrence === undefined) {
    return { kind: "inadmissible", reason: "held-by-another-tick" };
  }

  const [held] = await tx
    .update(morningBriefNativeSchedules)
    .set({ nextRunAt: null, scheduleOwner: null, updatedAt: args.now })
    .where(
      and(
        scheduleWhere(owner),
        eq(morningBriefNativeSchedules.ownerEpoch, schedule.ownerEpoch),
        eq(morningBriefNativeSchedules.nextRunAt, anchor),
      ),
    )
    .returning();
  if (held === undefined) {
    return { kind: "inadmissible", reason: "schedule-moved" };
  }
  return { kind: "claimed", occurrence, schedule: held };
}

/**
 * Settle a claimed slot exactly once and install the next obligation.
 *
 * The next run comes from a fresh settlement clock and the CURRENT persisted
 * recurrence, which is how a timezone edit made during the execution takes
 * effect. The frozen anchor stays on the occurrence for reporting and
 * deduplication and is never replaced by poll time.
 *
 * When the admitting epoch has since been revoked, the obligation is not handed
 * back to it: the current row's own state decides, which is what transfers or
 * clears the successor in the same transaction that consumed the predecessor.
 */
export async function settleMorningBriefNativeOccurrence(
  tx: MorningBriefNativeWriter,
  owner: MorningBriefMemberIdentity,
  args: {
    readonly scheduledFor: Date;
    readonly outcome: MorningBriefNativeOutcome;
    readonly deliveryPending: boolean;
    readonly generationAttemptId?: string | null;
    readonly at: Date;
  },
): Promise<
  | { readonly kind: "settled"; readonly nextRunAt: Date | null }
  | { readonly kind: "already-settled" }
  | { readonly kind: "absent" }
> {
  const schedule = await lockMorningBriefNativeSchedule(tx, owner);
  if (schedule === undefined) {
    return { kind: "absent" };
  }

  const [occurrence] = await tx
    .update(morningBriefNativeOccurrences)
    .set({
      state: "settled",
      outcome: args.outcome,
      deliveryPending: args.deliveryPending,
      ...(args.generationAttemptId === undefined
        ? {}
        : { generationAttemptId: args.generationAttemptId }),
      leaseToken: null,
      leaseExpiresAt: null,
      settledAt: args.at,
      updatedAt: args.at,
    })
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, owner.orgId),
        eq(morningBriefNativeOccurrences.userId, owner.userId),
        eq(morningBriefNativeOccurrences.scheduledFor, args.scheduledFor),
        // Exactly one settlement per slot. A delivery retry re-entering here
        // matches nothing and therefore cannot advance the schedule again.
        sql`${morningBriefNativeOccurrences.settledAt} IS NULL`,
      ),
    )
    .returning();
  if (occurrence === undefined) {
    return { kind: "already-settled" };
  }

  const nextRunAt =
    schedule.nextRunAt !== null &&
    schedule.nextRunAt.getTime() > args.at.getTime()
      ? // A newer owner already installed a future obligation. Do not overwrite.
        schedule.nextRunAt
      : computeNativeNextRunAt({
          enabled: schedule.enabled,
          cronExpression: schedule.cronExpression,
          timezone: schedule.timezone,
          from: args.at,
        });

  await tx
    .update(morningBriefNativeSchedules)
    .set({
      nextRunAt,
      scheduleOwner:
        nextRunAt === null ? null : scheduleOwnerForPhase(schedule.phase),
      updatedAt: args.at,
    })
    .where(
      and(
        scheduleWhere(owner),
        eq(morningBriefNativeSchedules.ownerEpoch, schedule.ownerEpoch),
      ),
    );

  await tx
    .update(morningBriefNativeOccurrences)
    .set({ settledNextRunAt: nextRunAt })
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, owner.orgId),
        eq(morningBriefNativeOccurrences.userId, owner.userId),
        eq(morningBriefNativeOccurrences.scheduledFor, args.scheduledFor),
      ),
    );

  return { kind: "settled", nextRunAt };
}

/**
 * Record one finite pre-reservation configuration deferral.
 *
 * Returns `exhausted` once the bounded policy is used up, which is the caller's
 * cue to settle the slot as `not-configured`. No provider call, no false
 * invocation receipt and no hot loop can come out of this path.
 */
export async function deferMorningBriefNativeOccurrence(
  tx: MorningBriefNativeWriter,
  owner: MorningBriefMemberIdentity,
  args: {
    readonly scheduledFor: Date;
    readonly reason: string;
    readonly at: Date;
  },
): Promise<
  | { readonly kind: "deferred"; readonly until: Date }
  | { readonly kind: "exhausted" }
> {
  const [row] = await tx
    .select()
    .from(morningBriefNativeOccurrences)
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, owner.orgId),
        eq(morningBriefNativeOccurrences.userId, owner.userId),
        eq(morningBriefNativeOccurrences.scheduledFor, args.scheduledFor),
      ),
    )
    .limit(1)
    .for("update");
  if (
    row === undefined ||
    row.deferAttempt >= NATIVE_CONFIGURATION_DEFER_LIMIT
  ) {
    return { kind: "exhausted" };
  }
  const until = new Date(args.at.getTime() + NATIVE_CONFIGURATION_DEFER_MS);
  await tx
    .update(morningBriefNativeOccurrences)
    .set({
      state: "deferred",
      deferAttempt: row.deferAttempt + 1,
      deferredUntil: until,
      deferReason: args.reason,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: args.at,
    })
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, owner.orgId),
        eq(morningBriefNativeOccurrences.userId, owner.userId),
        eq(morningBriefNativeOccurrences.scheduledFor, args.scheduledFor),
        eq(morningBriefNativeOccurrences.deferAttempt, row.deferAttempt),
      ),
    );
  return { kind: "deferred", until };
}

/**
 * The members whose native obligation is due, oldest first.
 *
 * Bounded by the caller's batch size. It reads only rows the native owner is
 * responsible for, so a member still on legacy is never picked up here.
 */
export async function loadDueNativeOwners(
  db: MorningBriefNativeReader,
  args: { readonly now: Date; readonly limit: number },
): Promise<readonly MorningBriefNativeScheduleRow[]> {
  return await db
    .select()
    .from(morningBriefNativeSchedules)
    .where(
      and(
        eq(morningBriefNativeSchedules.scheduleOwner, "native"),
        eq(morningBriefNativeSchedules.enabled, true),
        eq(morningBriefNativeSchedules.phase, "native"),
        isNotNull(morningBriefNativeSchedules.nextRunAt),
        lte(morningBriefNativeSchedules.nextRunAt, args.now),
      ),
    )
    .orderBy(morningBriefNativeSchedules.nextRunAt)
    .limit(args.limit);
}

/**
 * Members whose accepted result still owes delivery recovery.
 *
 * A pending receipt here never blocks the future scheduler: the slot is already
 * settled, so the next occurrence can become due while this recovery runs.
 */
export async function loadPendingDeliveryOccurrences(
  db: MorningBriefNativeReader,
  args: { readonly limit: number },
): Promise<readonly MorningBriefNativeOccurrenceRow[]> {
  return await db
    .select()
    .from(morningBriefNativeOccurrences)
    .where(eq(morningBriefNativeOccurrences.deliveryPending, true))
    .orderBy(morningBriefNativeOccurrences.scheduledFor)
    .limit(args.limit);
}

/** Clear the delivery obligation once a durable receipt proves it delivered. */
export async function clearMorningBriefDeliveryObligation(
  tx: MorningBriefNativeWriter,
  owner: MorningBriefMemberIdentity,
  args: { readonly scheduledFor: Date; readonly at: Date },
): Promise<void> {
  await tx
    .update(morningBriefNativeOccurrences)
    .set({ deliveryPending: false, updatedAt: args.at })
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, owner.orgId),
        eq(morningBriefNativeOccurrences.userId, owner.userId),
        eq(morningBriefNativeOccurrences.scheduledFor, args.scheduledFor),
      ),
    );
}

/** Rows whose drain deadline lapsed, for bounded operational reporting only. */
export async function loadUnresolvedDrains(
  db: MorningBriefNativeReader,
  args: { readonly now: Date; readonly limit: number },
): Promise<readonly MorningBriefNativeScheduleRow[]> {
  return await db
    .select()
    .from(morningBriefNativeSchedules)
    .where(
      and(
        isNotNull(morningBriefNativeSchedules.drainDeadlineAt),
        lte(morningBriefNativeSchedules.drainDeadlineAt, args.now),
      ),
    )
    .limit(args.limit);
}

/** The current wall clock, isolated so settlement tests can pin it. */
export function nativeScheduleNow(): Date {
  return nowDate();
}
