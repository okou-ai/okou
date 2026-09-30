import { isValidTimeZone } from "@okouai/core/timezone";
import {
  morningBriefNativeOccurrences,
  morningBriefNativeSchedules,
  type MorningBriefExecutionPhase,
  type MorningBriefExecutionTarget,
} from "@okouai/db/schema/morning-brief-native-schedule";
import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { pgTextDecoder } from "../../lib/db-structured-result";
import type { ReadonlyDb } from "../external/db";
import { settle } from "../utils";
import type { MorningBriefMemberIdentity } from "./morning-brief-enrollment-data.service";
import { calculateNextRun } from "./time-automation";

/**
 * The durable Morning Brief choice, execution ownership and schedule.
 *
 * Every rule in this module is described in
 * [native scheduling](../../../../../../docs/morning-brief-native-scheduling.md).
 * Two of them are load-bearing everywhere else:
 *
 * - **Lock order.** A writer that touches both the legacy automation and this
 *   row takes the member's Morning Brief preference/admission lock first when
 *   applicable (outgoing preference writers only; current ones hold no lock
 *   across their operation), then the owner key while this row is still
 *   absent, then this row's `FOR UPDATE`, the selected legacy automation, its S7a
 *   claim/Run/callback rows, and finally any native occurrence row. Nothing
 *   else is allowed, so Settings, reconciliation, deletion and cron writers
 *   cannot deadlock against each other.
 * - **Fresh predicates.** Every mutation revalidates the epoch and phase it
 *   read before it commits. External preflight (Clerk, provider, Slack) happens
 *   outside the transaction, and the transaction re-reads what it depends on.
 */

export type MorningBriefNativeScheduleRow =
  typeof morningBriefNativeSchedules.$inferSelect;

export type MorningBriefNativeOccurrenceRow =
  typeof morningBriefNativeOccurrences.$inferSelect;

/** Any reader, including a transaction, that can read the native state. */
type MorningBriefNativeReader = Pick<ReadonlyDb, "select">;

/** The smallest writer this module needs. A transaction always satisfies it. */
type MorningBriefNativeWriter = Tx;

/**
 * How long a drain may stay unresolved before it is reported rather than held
 * silently. The phase does not advance on expiry: an expired deadline is an
 * operational signal, never proof that the old writers drained.
 */
const NATIVE_DRAIN_REPORT_AFTER_MS = 60 * 60 * 1000;

export function morningBriefScheduleWhere(owner: MorningBriefMemberIdentity) {
  return and(
    eq(morningBriefNativeSchedules.orgId, owner.orgId),
    eq(morningBriefNativeSchedules.userId, owner.userId),
  );
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
    .where(morningBriefScheduleWhere(owner))
    .limit(1)
    .for("update");
  return row;
}

/**
 * Serialize this owner's Morning Brief writers while no durable row exists.
 *
 * `SELECT ... FOR UPDATE` locks rows, so it cannot fence an owner key that has
 * no row yet: reading the absence inside a transaction is not a lock on it.
 * First materialization would otherwise publish a legacy snapshot it sampled
 * without holding anything, while a selected legacy writer that classified the
 * same absent key as `ordinary` mutated the automation and skipped the durable
 * mirror it now owes. This transaction-scoped advisory lock is that missing
 * boundary.
 *
 * It sits between the member preference/admission lock and the durable schedule
 * row in the documented order, and is taken only while the row is absent, so a
 * materialized owner keeps its existing row-lock fence and pays nothing.
 */
export function morningBriefNativeOwnerCompatibilitySql(
  owner: MorningBriefMemberIdentity,
) {
  // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
  return sql`SELECT pg_advisory_xact_lock(hashtextextended('morning-brief-native-owner:' || ${owner.orgId}::text || ':' || ${owner.userId}::text, 0))`;
}

async function lockAbsentMorningBriefOwnerKey(
  tx: Pick<Tx, "execute">,
  owner: MorningBriefMemberIdentity,
): Promise<void> {
  await tx.execute(morningBriefNativeOwnerCompatibilitySql(owner));
}

/**
 * Take durable authority over this owner, including before its first row.
 *
 * Every writer that decides what the member's selected legacy automation may do
 * enters here, so first materialization and that decision share one real
 * database boundary. A writer that finds no row waits on the owner key and then
 * re-reads it: it either observes the first row that committed while it waited
 * and continues under it, or it holds the key and no first row can appear until
 * it commits.
 */
export async function lockMorningBriefNativeScheduleForWrite(
  tx: MorningBriefNativeWriter,
  owner: MorningBriefMemberIdentity,
): Promise<MorningBriefNativeScheduleRow | undefined> {
  const existing = await lockMorningBriefNativeSchedule(tx, owner);
  if (existing !== undefined) {
    return existing;
  }
  await lockAbsentMorningBriefOwnerKey(tx, owner);
  return await lockMorningBriefNativeSchedule(tx, owner);
}

/** A native row together with the exact row version it was read at. */
export interface MorningBriefNativeScheduleSnapshot {
  readonly row: MorningBriefNativeScheduleRow;
  readonly rowVersion: string;
}

async function readMorningBriefNativeScheduleSnapshot(
  tx: MorningBriefNativeWriter,
  owner: MorningBriefMemberIdentity,
): Promise<MorningBriefNativeScheduleSnapshot | undefined> {
  const [snapshot] = await tx
    .select({
      row: morningBriefNativeSchedules,
      rowVersion: sql`${morningBriefNativeSchedules}.xmin::text`.mapWith(
        pgTextDecoder,
      ),
    })
    .from(morningBriefNativeSchedules)
    .where(morningBriefScheduleWhere(owner))
    .limit(1);
  return snapshot;
}

/**
 * Read durable authority for a writer that commits with a conditional UPDATE.
 *
 * No row lock is taken. A materialized row is read with its row version, and
 * the writer's UPDATE must carry {@link morningBriefNativeRowVersionCondition}
 * so a concurrent commit turns it into zero rows instead of a lost update.
 * While the row is still absent the pre-existing owner key is taken, so first
 * materialization cannot appear under a writer that classified it as absent.
 */
export async function readMorningBriefNativeScheduleForWrite(
  tx: MorningBriefNativeWriter,
  owner: MorningBriefMemberIdentity,
): Promise<MorningBriefNativeScheduleSnapshot | undefined> {
  const existing = await readMorningBriefNativeScheduleSnapshot(tx, owner);
  if (existing !== undefined) {
    return existing;
  }
  await lockAbsentMorningBriefOwnerKey(tx, owner);
  return await readMorningBriefNativeScheduleSnapshot(tx, owner);
}

/** The native row is still exactly the version a writer read. */
export function morningBriefNativeRowVersionCondition(rowVersion: string) {
  return sql`${morningBriefNativeSchedules}.xmin::text = ${rowVersion}`;
}

/**
 * A conditional Morning Brief write lost to a concurrent commit.
 *
 * Thrown inside the writer's transaction so every write it already made rolls
 * back; {@link commitMorningBriefSnapshotOnce} turns it into a `changed`
 * result that the caller maps to its deterministic conflict outcome.
 */
export class MorningBriefSnapshotChanged extends Error {}

export type MorningBriefSnapshotCommit<T> =
  | { readonly kind: "committed"; readonly value: T }
  | { readonly kind: "changed" };

/**
 * Run one read-compute-conditional-write transaction exactly once.
 *
 * A lost race is a result, never a retry: the transaction rolled back and the
 * caller returns its own deterministic conflict/deferral outcome. The winner's
 * commit is the current state; nothing here re-reads it.
 */
export async function commitMorningBriefSnapshotOnce<T>(
  attempt: () => Promise<T>,
  signal?: AbortSignal,
): Promise<MorningBriefSnapshotCommit<T>> {
  signal?.throwIfAborted();
  const result = await settle(attempt(), signal);
  if (result.ok) {
    return { kind: "committed", value: result.value };
  }
  if (result.error instanceof MorningBriefSnapshotChanged) {
    return { kind: "changed" };
  }
  throw result.error;
}

/** The selected legacy row a reconciliation, claim or callback may mutate. */
export interface MorningBriefLegacyLineage extends MorningBriefMemberIdentity {
  readonly workflowId: string;
  readonly automationId: string;
}

/**
 * Exact durable state a multi-transaction legacy writer is allowed to resume.
 *
 * Epoch alone cannot fence a timezone edit because schedule-only edits
 * deliberately keep the epoch. The phase, choice, obligation and lineage are
 * therefore carried together; a compensation that finds any one changed must
 * fail closed rather than restore its older copy.
 */
export interface MorningBriefLegacyWriterFence {
  readonly kind: "ordinary" | "selected";
  readonly phase?: MorningBriefExecutionPhase;
  readonly target?: MorningBriefExecutionTarget;
  readonly ownerEpoch?: number;
  readonly enabled?: boolean;
  readonly cronExpression?: string | null;
  readonly timezone?: string;
  readonly nextRunAt?: Date | null;
  readonly scheduleOwner?: MorningBriefNativeScheduleRow["scheduleOwner"];
  readonly legacyWorkflowId?: string | null;
  readonly legacyAutomationId?: string | null;
  readonly updatedAt?: Date;
}

export type MorningBriefLegacyWriterAuthority =
  | {
      readonly kind: "ordinary";
      readonly fence: MorningBriefLegacyWriterFence;
    }
  | {
      readonly kind: "selected";
      readonly row: MorningBriefNativeScheduleRow;
      readonly fence: MorningBriefLegacyWriterFence;
    }
  | { readonly kind: "stale" };

function legacyWriterFence(
  row: MorningBriefNativeScheduleRow | undefined,
  lineage: MorningBriefLegacyLineage,
): MorningBriefLegacyWriterFence {
  if (
    row === undefined ||
    row.legacyWorkflowId !== lineage.workflowId ||
    row.legacyAutomationId !== lineage.automationId
  ) {
    return { kind: "ordinary" };
  }
  return {
    kind: "selected",
    phase: row.phase,
    target: row.target,
    ownerEpoch: row.ownerEpoch,
    enabled: row.enabled,
    cronExpression: row.cronExpression,
    timezone: row.timezone,
    nextRunAt: row.nextRunAt,
    scheduleOwner: row.scheduleOwner,
    legacyWorkflowId: row.legacyWorkflowId,
    legacyAutomationId: row.legacyAutomationId,
    updatedAt: row.updatedAt,
  };
}

function sameInstant(
  left: Date | null | undefined,
  right: Date | null | undefined,
): boolean {
  return left === null ||
    left === undefined ||
    right === null ||
    right === undefined
    ? left === right
    : left.getTime() === right.getTime();
}

function sameLegacyWriterFence(
  expected: MorningBriefLegacyWriterFence,
  current: MorningBriefLegacyWriterFence,
): boolean {
  if (expected.kind !== current.kind) {
    return false;
  }
  if (expected.kind === "ordinary") {
    return true;
  }
  return (
    expected.phase === current.phase &&
    expected.target === current.target &&
    expected.ownerEpoch === current.ownerEpoch &&
    expected.enabled === current.enabled &&
    expected.cronExpression === current.cronExpression &&
    expected.timezone === current.timezone &&
    sameInstant(expected.nextRunAt, current.nextRunAt) &&
    expected.scheduleOwner === current.scheduleOwner &&
    expected.legacyWorkflowId === current.legacyWorkflowId &&
    expected.legacyAutomationId === current.legacyAutomationId &&
    sameInstant(expected.updatedAt, current.updatedAt)
  );
}

/**
 * Lock durable authority before a selected legacy automation.
 *
 * Callers pass the prior fence when they resume after external work. An
 * `ordinary` fence is meaningful too: materialization or lineage adoption
 * between stages turns it stale instead of letting the older stage bypass the
 * newly authoritative row.
 *
 * An `ordinary` result for an owner with no row at all is decided under the
 * owner key, so it cannot be carried across a concurrent first materialization.
 */
export async function lockMorningBriefLegacyWriterAuthority(
  tx: MorningBriefNativeWriter,
  lineage: MorningBriefLegacyLineage,
  expected?: MorningBriefLegacyWriterFence,
): Promise<MorningBriefLegacyWriterAuthority> {
  const row = await lockMorningBriefNativeScheduleForWrite(tx, lineage);
  return morningBriefLegacyWriterAuthorityFromRow(row, lineage, expected);
}

/** Classify an already-locked row without carrying its database handle. */
export function morningBriefLegacyWriterAuthorityFromRow(
  row: MorningBriefNativeScheduleRow | undefined,
  lineage: MorningBriefLegacyLineage,
  expected?: MorningBriefLegacyWriterFence,
): MorningBriefLegacyWriterAuthority {
  const current = legacyWriterFence(row, lineage);
  if (expected !== undefined && !sameLegacyWriterFence(expected, current)) {
    return { kind: "stale" };
  }
  if (current.kind === "ordinary" || row === undefined) {
    return { kind: "ordinary", fence: current };
  }
  return { kind: "selected", row, fence: current };
}

/** Refresh a selected authority after this transaction mutates its row. */
async function refreshedLegacyWriterAuthority(
  tx: MorningBriefNativeWriter,
  lineage: MorningBriefLegacyLineage,
): Promise<MorningBriefLegacyWriterAuthority> {
  const row = await lockMorningBriefNativeSchedule(tx, lineage);
  if (
    row === undefined ||
    row.legacyWorkflowId !== lineage.workflowId ||
    row.legacyAutomationId !== lineage.automationId
  ) {
    return { kind: "stale" };
  }
  return { kind: "selected", row, fence: legacyWriterFence(row, lineage) };
}

/**
 * The next occurrence strictly after `from` under a current schedule.
 *
 * It always uses the persisted cron and timezone as they are at settlement, so
 * a timezone or cron edit that arrived during an in-flight execution takes
 * effect on that execution's one settlement rather than by cancelling it.
 */
function computeNativeNextRunAt(args: {
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

/** What a logical-choice writer intends to change. */
interface MorningBriefLogicalChoicePatch {
  readonly enabled?: boolean;
  readonly cronExpression?: string | null;
  readonly timezone?: string;
  readonly chatThreadId?: string | null;
  readonly agentId?: string;
  /**
   * The epoch the caller's own preflight observed.
   *
   * A writer that read live state outside this transaction — a reconciliation
   * restore, an enable compensation, a Settings round trip — passes what it saw.
   * The mutation then refuses if the epoch moved, so a stale compensation can
   * never restore an older epoch's state over a newer writer. A writer with no
   * preflight of its own omits it and takes whatever it locks.
   */
  readonly expectedEpoch?: number;
}

interface MorningBriefReconciledAutomationState {
  readonly kind: string;
  readonly scheduleType: string | null;
  readonly cronExpression: string | null;
  readonly timezone: string;
  readonly nextRunAt: Date | null;
}

interface MorningBriefLegacyAutomationOverrides {
  readonly enabled?: boolean;
  readonly officialIntendedEnabled?: boolean;
  readonly nextRunAt?: Date | null;
}

/**
 * Fence one Official Workflow reconciliation mutation for the selected row.
 *
 * Reconciliation owns configuration readiness, not the member's choice. A
 * selected row therefore always retains the durable enabled bit. Outside the
 * `legacy` phase its admission instant is forced closed; in `legacy`, a current
 * S7a claim keeps the obligation until its one settlement. Configuration
 * changes are copied to durable authority without revoking an in-flight slot.
 */
export async function prepareMorningBriefLegacyReconciliationMutation(
  tx: MorningBriefNativeWriter,
  lineage: MorningBriefLegacyLineage,
  authority: Exclude<MorningBriefLegacyWriterAuthority, { kind: "stale" }>,
  args:
    | {
        readonly mode: "configured";
        readonly proposed: MorningBriefReconciledAutomationState;
        readonly at: Date;
      }
    | { readonly mode: "paused"; readonly at: Date },
): Promise<{
  readonly automation: MorningBriefLegacyAutomationOverrides;
  readonly authority: Exclude<
    MorningBriefLegacyWriterAuthority,
    { kind: "stale" }
  >;
}> {
  if (authority.kind === "ordinary") {
    return { automation: {}, authority };
  }

  const schedule = authority.row;
  let automation: MorningBriefLegacyAutomationOverrides = {
    enabled: args.mode === "configured" ? schedule.enabled : false,
    officialIntendedEnabled: schedule.enabled,
    nextRunAt: null,
  };
  let schedulePatch:
    | Partial<typeof morningBriefNativeSchedules.$inferInsert>
    | undefined;

  if (args.mode === "paused") {
    if (schedule.phase === "legacy") {
      schedulePatch = { nextRunAt: null, scheduleOwner: null };
    }
  } else if (
    args.proposed.kind === "schedule" &&
    args.proposed.scheduleType === "cron" &&
    args.proposed.cronExpression !== null &&
    isValidTimeZone(args.proposed.timezone)
  ) {
    if (schedule.phase === "legacy") {
      const claimInFlight =
        schedule.legacyAutomationId !== null &&
        (await hasCurrentUnsettledLegacyClaim(tx, schedule.legacyAutomationId));
      const nextRunAt =
        schedule.enabled && !claimInFlight ? args.proposed.nextRunAt : null;
      automation = { ...automation, nextRunAt };
      schedulePatch = {
        cronExpression: args.proposed.cronExpression,
        timezone: args.proposed.timezone,
        nextRunAt,
        scheduleOwner: nextRunAt === null ? null : "legacy",
      };
    } else {
      const inFlight = await loadUnsettledOccurrence(tx, lineage);
      const obligation = resolveObligationAfterChoice({
        current: schedule,
        enabled: schedule.enabled,
        cronExpression: args.proposed.cronExpression,
        timezone: args.proposed.timezone,
        revokes: false,
        inFlight,
        legacyInFlight: false,
        at: args.at,
      });
      schedulePatch = {
        cronExpression: args.proposed.cronExpression,
        timezone: args.proposed.timezone,
        ...obligation,
      };
    }
  } else if (schedule.phase === "legacy") {
    // An unreconciled non-cron replacement is not a runnable legacy target.
    schedulePatch = { nextRunAt: null, scheduleOwner: null };
  }

  if (schedulePatch === undefined) {
    return { automation, authority };
  }
  const [updated] = await tx
    .update(morningBriefNativeSchedules)
    .set({ ...schedulePatch, updatedAt: args.at })
    .where(
      and(
        morningBriefScheduleWhere(lineage),
        eq(morningBriefNativeSchedules.ownerEpoch, schedule.ownerEpoch),
        eq(morningBriefNativeSchedules.phase, schedule.phase),
        eq(morningBriefNativeSchedules.legacyWorkflowId, lineage.workflowId),
        eq(
          morningBriefNativeSchedules.legacyAutomationId,
          lineage.automationId,
        ),
      ),
    )
    .returning();
  if (updated === undefined) {
    throw new Error("Morning Brief reconciliation authority changed");
  }
  const refreshed = await refreshedLegacyWriterAuthority(tx, lineage);
  if (refreshed.kind === "stale") {
    throw new Error("Morning Brief reconciliation lineage changed");
  }
  return { automation, authority: refreshed };
}

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
export function morningBriefLogicalChoicePlan(
  current: MorningBriefNativeScheduleRow,
  patch: MorningBriefLogicalChoicePatch,
  inFlight: MorningBriefNativeOccurrenceRow | undefined,
  legacyInFlight: boolean,
  at: Date,
) {
  const enabled = patch.enabled ?? current.enabled;
  const cronExpression =
    patch.cronExpression === undefined
      ? current.cronExpression
      : patch.cronExpression;
  const timezone = patch.timezone ?? current.timezone;
  const enabledChanged = enabled !== current.enabled;
  // Replacing the canonical Agent or destination thread replaces the execution
  // owner's identity, so admitted work must not deliver into the old one.
  const destinationReplaced =
    (patch.agentId !== undefined && patch.agentId !== current.agentId) ||
    (patch.chatThreadId !== undefined &&
      patch.chatThreadId !== current.chatThreadId);
  const revokes = enabledChanged || destinationReplaced;

  // Only an enabled-choice change or a destination replacement revokes. A
  // schedule or timezone edit is deliberately not a revocation.
  const ownerEpoch = revokes ? current.ownerEpoch + 1 : current.ownerEpoch;

  const { nextRunAt, scheduleOwner } = resolveObligationAfterChoice({
    current,
    enabled,
    cronExpression,
    timezone,
    revokes,
    inFlight,
    legacyInFlight,
    at,
  });

  return {
    revokes,
    values: {
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
    },
  };
}

/**
 * Where the scheduling obligation stands after a logical-choice write.
 *
 * The pure choice planner keeps each branch readable: a disabled choice owes nothing, a revocation restarts
 * from now, an in-flight execution keeps the obligation it already holds, and a
 * future unconsumed slot is recomputed under the edited recurrence.
 */
function resolveObligationAfterChoice(args: {
  readonly current: MorningBriefNativeScheduleRow;
  readonly enabled: boolean;
  readonly cronExpression: string | null;
  readonly timezone: string;
  readonly revokes: boolean;
  readonly inFlight: MorningBriefNativeOccurrenceRow | undefined;
  readonly legacyInFlight: boolean;
  readonly at: Date;
}): {
  readonly nextRunAt: Date | null;
  readonly scheduleOwner: MorningBriefNativeScheduleRow["scheduleOwner"];
} {
  const { current, enabled, cronExpression, timezone, at } = args;
  if (!enabled) {
    return { nextRunAt: null, scheduleOwner: null };
  }
  const recomputed = computeNativeNextRunAt({
    enabled,
    cronExpression,
    timezone,
    from: at,
  });
  if (args.revokes) {
    // Re-enabling — or continuing after a replacement — starts from now, never
    // from the revoked slot.
    return {
      nextRunAt: recomputed,
      scheduleOwner:
        recomputed === null ? null : scheduleOwnerForPhase(current.phase),
    };
  }
  if (
    args.legacyInFlight ||
    (args.inFlight !== undefined &&
      args.inFlight.ownerEpoch === current.ownerEpoch)
  ) {
    // The in-flight execution still owns the obligation; leave it to settle.
    return {
      nextRunAt: current.nextRunAt,
      scheduleOwner: current.scheduleOwner,
    };
  }
  if (current.nextRunAt !== null) {
    // A future unconsumed slot is already authoritative, but the recurrence
    // itself may have changed, so it is recomputed under the current schedule.
    return {
      nextRunAt: recomputed,
      scheduleOwner: recomputed === null ? null : current.scheduleOwner,
    };
  }
  return {
    nextRunAt: recomputed,
    scheduleOwner:
      recomputed === null ? null : scheduleOwnerForPhase(current.phase),
  };
}

/**
 * Which implementation owns a successor obligation while in this phase.
 *
 * `draining` still belongs to legacy: the transfer has not committed, so legacy
 * must keep settling. `rollback-draining` still belongs to native for the same
 * reason in the other direction — new native claims are already closed (claim
 * requires `phase === "native"`), but the obligation cannot be handed to legacy
 * until the rollback drain commits. Assigning legacy in both drain phases would
 * let legacy claim a slot native still owes.
 */
function scheduleOwnerForPhase(
  phase: MorningBriefExecutionPhase,
): MorningBriefNativeScheduleRow["scheduleOwner"] {
  switch (phase) {
    case "legacy":
    case "draining": {
      return "legacy";
    }
    case "native":
    case "rollback-draining": {
      return "native";
    }
  }
}

async function hasCurrentUnsettledLegacyClaim(
  db: MorningBriefNativeReader,
  automationId: string,
): Promise<boolean> {
  const [claim] = await db
    .select({ settlement: morningBriefScheduleClaims.settlement })
    .from(morningBriefScheduleClaims)
    .where(eq(morningBriefScheduleClaims.automationId, automationId))
    .orderBy(desc(morningBriefScheduleClaims.claimSequence))
    .limit(1);
  return claim?.settlement === "unsettled";
}

/** The unsettled occurrence a member currently owes, if any. */
async function loadUnsettledOccurrence(
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
        isNull(morningBriefNativeOccurrences.settledAt),
      ),
    )
    .orderBy(morningBriefNativeOccurrences.scheduledFor)
    .limit(1);
  return row;
}

/**
 * Revoke this member's native execution authority.
 *
 * Used by membership loss, Agent or thread deletion and account deletion. It bumps the
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
      enabled: false,
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
        morningBriefScheduleWhere(owner),
        eq(morningBriefNativeSchedules.ownerEpoch, current.ownerEpoch),
      ),
    )
    .returning();
  if (row !== undefined) {
    // A lifecycle deletion has no destination to which old work may deliver.
    // Terminally suppress every recorded obligation from the revoked epoch in
    // the same schedule → occurrence transaction. Attempt ids and anchors stay
    // durable deduplication evidence, so a late provider result cannot reopen
    // the slot or trigger a second POST.
    await tx
      .update(morningBriefNativeOccurrences)
      .set({
        state: "settled",
        outcome: "revoked",
        settledAt: at,
        leaseToken: null,
        leaseExpiresAt: null,
        deferredUntil: null,
        deliveryPending: false,
        updatedAt: at,
      })
      .where(
        and(
          eq(morningBriefNativeOccurrences.orgId, owner.orgId),
          eq(morningBriefNativeOccurrences.userId, owner.userId),
          eq(morningBriefNativeOccurrences.ownerEpoch, current.ownerEpoch),
          isNull(morningBriefNativeOccurrences.settledAt),
        ),
      );
  }
  return row;
}

/** Revoke the exact canonical thread before its deletion can cascade content. */
export async function revokeMorningBriefNativeThreadAuthority(
  tx: MorningBriefNativeWriter,
  args: MorningBriefMemberIdentity & { readonly chatThreadId: string },
  at: Date,
): Promise<MorningBriefNativeScheduleRow | undefined> {
  const owner = { orgId: args.orgId, userId: args.userId };
  const current = await lockMorningBriefNativeSchedule(tx, owner);
  if (current?.chatThreadId !== args.chatThreadId) {
    return undefined;
  }
  return await revokeMorningBriefNativeAuthority(tx, owner, at);
}

/**
 * Revoke every native owner whose canonical Agent is being deleted.
 *
 * Rows are locked in the same stable owner order used by cleanup, before the
 * Agent lifecycle lock. This prevents an Agent delete from racing a native
 * delivery that has already validated its epoch and destination.
 */
export async function lockMorningBriefNativeAgentAuthorities(
  tx: MorningBriefNativeWriter,
  args: { readonly orgId: string; readonly agentId: string },
): Promise<readonly MorningBriefNativeScheduleRow[]> {
  return await tx
    .select()
    .from(morningBriefNativeSchedules)
    .where(
      and(
        eq(morningBriefNativeSchedules.orgId, args.orgId),
        eq(morningBriefNativeSchedules.agentId, args.agentId),
      ),
    )
    .orderBy(
      morningBriefNativeSchedules.orgId,
      morningBriefNativeSchedules.userId,
    )
    .for("update");
}
