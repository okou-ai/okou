import { isValidTimeZone } from "@okouai/core/timezone";
import {
  morningBriefNativeOccurrences,
  morningBriefNativeSchedules,
  type MorningBriefExecutionPhase,
  type MorningBriefExecutionTarget,
  type MorningBriefNativeOutcome,
} from "@okouai/db/schema/morning-brief-native-schedule";
import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import {
  and,
  desc,
  eq,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
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
 *   row takes the member's Morning Brief preference/admission lock first when
 *   applicable, then this row's `FOR UPDATE`, the selected legacy automation,
 *   its S7a claim/Run/callback rows, and finally any native occurrence row.
 *   Nothing else is allowed, so Settings, reconciliation, deletion and cron
 *   writers cannot deadlock against each other.
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

/** How long one tick may hold a claimed slot before another may reclaim it. */
const NATIVE_OCCURRENCE_LEASE_MS = 5 * 60 * 1000;

/**
 * The finite pre-reservation configuration deferral.
 *
 * A slot that cannot execute because its configuration is momentarily missing
 * is deferred at most this many times, each time by
 * {@link NATIVE_CONFIGURATION_DEFER_MS}. Once exhausted it settles as
 * `not-configured` and schedules the next future occurrence, so a broken
 * configuration can never hot-loop and never silently disables the member.
 */
const NATIVE_CONFIGURATION_DEFER_LIMIT = 3;
const NATIVE_CONFIGURATION_DEFER_MS = 15 * 60 * 1000;

/**
 * How long a drain may stay unresolved before it is reported rather than held
 * silently. The phase does not advance on expiry: an expired deadline is an
 * operational signal, never proof that the old writers drained.
 */
const NATIVE_DRAIN_REPORT_AFTER_MS = 60 * 60 * 1000;

/** The materialization refused, with the reason a caller can act on. */
type MorningBriefMaterializationRefusal =
  | "not-installed"
  | "installation-pending"
  | "installation-inconsistent"
  | "missing-timezone"
  | "missing-membership";

type MorningBriefMaterializationResult =
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

function occurrenceOwnerWhere(owner: MorningBriefMemberIdentity) {
  return and(
    eq(morningBriefNativeOccurrences.orgId, owner.orgId),
    eq(morningBriefNativeOccurrences.userId, owner.userId),
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
 */
export async function lockMorningBriefLegacyWriterAuthority(
  tx: MorningBriefNativeWriter,
  lineage: MorningBriefLegacyLineage,
  expected?: MorningBriefLegacyWriterFence,
): Promise<MorningBriefLegacyWriterAuthority> {
  const row = await lockMorningBriefNativeSchedule(tx, lineage);
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

async function replaceMorningBriefMembershipGeneration(
  tx: MorningBriefNativeWriter,
  owner: MorningBriefMemberIdentity,
  existing: MorningBriefNativeScheduleRow,
  args: {
    readonly membershipId: string;
    readonly at: Date;
    readonly installed: Extract<
      MorningBriefMigrationState,
      { kind: "installed" }
    >;
  },
): Promise<MorningBriefMaterializationResult> {
  // A remove/rejoin creates a new immutable Clerk membership id. Replace the
  // whole owner generation under the schedule lock: old work becomes terminal.
  await tx
    .update(morningBriefNativeOccurrences)
    .set({
      state: "settled",
      outcome: "revoked",
      settledAt: args.at,
      leaseToken: null,
      leaseExpiresAt: null,
      deferredUntil: null,
      deliveryPending: false,
      updatedAt: args.at,
    })
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, owner.orgId),
        eq(morningBriefNativeOccurrences.userId, owner.userId),
        eq(morningBriefNativeOccurrences.membershipId, existing.membershipId),
        isNull(morningBriefNativeOccurrences.settledAt),
      ),
    );
  const nextRunAt = computeNativeNextRunAt({
    enabled: args.installed.automation.enabled,
    cronExpression: args.installed.automation.cronExpression,
    timezone: args.installed.automation.timezone,
    from: args.at,
  });
  await restoreLegacyMorningBriefObligation(
    tx,
    args.installed.automation.id,
    nextRunAt,
  );
  const [replaced] = await tx
    .update(morningBriefNativeSchedules)
    .set({
      enabled: args.installed.automation.enabled,
      cronExpression: args.installed.automation.cronExpression,
      timezone: args.installed.automation.timezone,
      nextRunAt,
      scheduleOwner: nextRunAt === null ? null : "legacy",
      phase: "legacy",
      target: "legacy",
      ownerEpoch: existing.ownerEpoch + 1,
      membershipId: args.membershipId,
      agentId: args.installed.installation.agentId,
      chatThreadId: args.installed.chatThreadId,
      legacyWorkflowId: args.installed.installation.id,
      legacyAutomationId: args.installed.automation.id,
      materializedAt: args.at,
      drainingEpoch: null,
      drainDeadlineAt: null,
      drainUnresolvedReason: null,
      updatedAt: args.at,
    })
    .where(
      and(
        scheduleWhere(owner),
        eq(morningBriefNativeSchedules.ownerEpoch, existing.ownerEpoch),
        eq(morningBriefNativeSchedules.membershipId, existing.membershipId),
      ),
    )
    .returning();
  return replaced === undefined
    ? { kind: "refused", reason: "not-installed" }
    : { kind: "materialized", row: replaced };
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
  args: {
    /** The membership generation the caller resolved from Clerk. */
    readonly membershipId: string;
    readonly at: Date;
    readonly state?: MorningBriefMigrationState;
  },
): Promise<MorningBriefMaterializationResult> {
  const { membershipId, at } = args;
  const existing = await lockMorningBriefNativeSchedule(tx, owner);
  if (existing?.membershipId === membershipId) {
    return { kind: "materialized", row: existing };
  }

  const installed =
    args.state ??
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

  if (existing !== undefined) {
    return await replaceMorningBriefMembershipGeneration(tx, owner, existing, {
      membershipId,
      at,
      installed,
    });
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
    ? { kind: "refused", reason: "not-installed" }
    : { kind: "materialized", row: raced };
}

/**
 * Re-export of the single real membership-generation reader.
 *
 * The authority is Clerk's immutable organization-membership id, resolved by
 * the collection executor's existing `currentMembershipId$`. A remove and
 * rejoin issues a new id, which is what stops a new membership from reviving an
 * older occurrence. `org_members_cache` is a disposable read-through cache of
 * the member's *role* and carries no generation, so it is never read here.
 *
 * It is a network read, so callers resolve it **before** their transaction and
 * revalidate the pinned value inside it. It deliberately lives in the
 * collection executor rather than being re-exported here, so this module never
 * imports its consumer.
 */
/**
 * Which implementation's state decides whether a brief may execute right now.
 *
 * This is the single predicate S5 collection and S6 delivery consult instead of
 * reading the legacy automation's enabled bit directly. Once a member reaches
 * the `native` phase, the durable row is the whole answer — admission keeps
 * working with the legacy scheduler disabled and with no live Official Workflow
 * installation or catalog reconciliation. Every other phase keeps the existing
 * legacy behaviour untouched.
 */
type MorningBriefChoiceAuthority =
  | { readonly kind: "native"; readonly row: MorningBriefNativeScheduleRow }
  | { readonly kind: "legacy" };

export async function resolveMorningBriefChoiceAuthority(
  db: MorningBriefNativeReader,
  owner: MorningBriefMemberIdentity,
): Promise<MorningBriefChoiceAuthority> {
  const row = await readMorningBriefNativeSchedule(db, owner);
  return row !== undefined && row.phase === "native"
    ? { kind: "native", row }
    : { kind: "legacy" };
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

export type MorningBriefChoiceApplication =
  | { readonly kind: "applied"; readonly row: MorningBriefNativeScheduleRow }
  | { readonly kind: "stale"; readonly row: MorningBriefNativeScheduleRow }
  | { readonly kind: "absent" };

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
        scheduleWhere(lineage),
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
 * Consume the durable legacy obligation with the exact S7a claim transaction.
 */
export async function consumeSelectedLegacyMorningBriefObligation(
  tx: MorningBriefNativeWriter,
  lineage: MorningBriefLegacyLineage,
  authority: Exclude<MorningBriefLegacyWriterAuthority, { kind: "stale" }>,
  args: { readonly occurrenceAt: Date; readonly claimedAt: Date },
): Promise<boolean> {
  if (authority.kind === "ordinary") {
    return true;
  }
  if (
    authority.row.phase !== "legacy" ||
    !authority.row.enabled ||
    authority.row.scheduleOwner !== "legacy" ||
    authority.row.nextRunAt?.getTime() !== args.occurrenceAt.getTime()
  ) {
    return false;
  }
  const [consumed] = await tx
    .update(morningBriefNativeSchedules)
    .set({
      nextRunAt: null,
      scheduleOwner: null,
      updatedAt: args.claimedAt,
    })
    .where(
      and(
        scheduleWhere(lineage),
        eq(morningBriefNativeSchedules.ownerEpoch, authority.row.ownerEpoch),
        eq(morningBriefNativeSchedules.phase, "legacy"),
        eq(morningBriefNativeSchedules.enabled, true),
        eq(morningBriefNativeSchedules.scheduleOwner, "legacy"),
        eq(morningBriefNativeSchedules.nextRunAt, args.occurrenceAt),
        eq(morningBriefNativeSchedules.legacyWorkflowId, lineage.workflowId),
        eq(
          morningBriefNativeSchedules.legacyAutomationId,
          lineage.automationId,
        ),
      ),
    )
    .returning({ ownerEpoch: morningBriefNativeSchedules.ownerEpoch });
  return consumed !== undefined;
}

/**
 * Mirror a selected legacy settlement into durable choice and obligation.
 *
 * Callers invoke this only after the locked legacy row accepted the settlement.
 * Drain/native phases deliberately do nothing: their returning callback may
 * close its journal fact, but may not publish or pause either scheduler.
 */
export async function settleSelectedLegacyMorningBriefObligation(
  tx: MorningBriefNativeWriter,
  lineage: MorningBriefLegacyLineage,
  authority: Exclude<MorningBriefLegacyWriterAuthority, { kind: "stale" }>,
  args: {
    readonly enabled: boolean;
    readonly cronExpression: string | null;
    readonly timezone: string;
    readonly nextRunAt: Date | null;
    readonly at: Date;
  },
): Promise<boolean> {
  if (authority.kind !== "selected" || authority.row.phase !== "legacy") {
    return false;
  }
  const applied = await applyMorningBriefLogicalChoice(
    tx,
    lineage,
    {
      enabled: args.enabled,
      cronExpression: args.cronExpression,
      timezone: args.timezone,
      expectedEpoch: authority.row.ownerEpoch,
    },
    args.at,
  );
  if (applied.kind !== "applied" || applied.row.phase !== "legacy") {
    throw new Error("Morning Brief settlement authority changed");
  }
  const nextRunAt = args.enabled ? args.nextRunAt : null;
  const [settled] = await tx
    .update(morningBriefNativeSchedules)
    .set({
      nextRunAt,
      scheduleOwner: nextRunAt === null ? null : "legacy",
      updatedAt: args.at,
    })
    .where(
      and(
        scheduleWhere(lineage),
        eq(morningBriefNativeSchedules.ownerEpoch, applied.row.ownerEpoch),
        eq(morningBriefNativeSchedules.phase, "legacy"),
        eq(morningBriefNativeSchedules.legacyWorkflowId, lineage.workflowId),
        eq(
          morningBriefNativeSchedules.legacyAutomationId,
          lineage.automationId,
        ),
      ),
    )
    .returning({ ownerEpoch: morningBriefNativeSchedules.ownerEpoch });
  if (settled === undefined) {
    throw new Error("Morning Brief settlement obligation changed");
  }
  return true;
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
  if (
    patch.expectedEpoch !== undefined &&
    patch.expectedEpoch !== current.ownerEpoch
  ) {
    return { kind: "stale", row: current };
  }

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

  const inFlight = await loadUnsettledOccurrence(tx, owner);
  const legacyInFlight =
    current.phase === "legacy" && current.legacyAutomationId !== null
      ? await hasCurrentUnsettledLegacyClaim(tx, current.legacyAutomationId)
      : false;

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
  if (row !== undefined && revokes) {
    // Disable/re-enable and destination replacement revoke the old occurrence
    // immediately. A provider call that already escaped may still finish, but
    // its pinned attempt remains only deduplication evidence: it cannot deliver,
    // settle again or be resumed under the new epoch.
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
  return row === undefined ? { kind: "absent" } : { kind: "applied", row };
}

/**
 * Where the scheduling obligation stands after a logical-choice write.
 *
 * Split out of {@link applyMorningBriefLogicalChoice} so each branch is
 * readable on its own: a disabled choice owes nothing, a revocation restarts
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
        scheduleWhere(owner),
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

/** Persist the first canonical native destination without changing its epoch. */
export async function bindMorningBriefNativeThread(
  tx: MorningBriefNativeWriter,
  owner: MorningBriefMemberIdentity,
  args: {
    readonly expectedEpoch: number;
    readonly agentId: string;
    readonly chatThreadId: string;
    readonly at: Date;
  },
): Promise<boolean> {
  const [bound] = await tx
    .update(morningBriefNativeSchedules)
    .set({ chatThreadId: args.chatThreadId, updatedAt: args.at })
    .where(
      and(
        scheduleWhere(owner),
        eq(morningBriefNativeSchedules.ownerEpoch, args.expectedEpoch),
        eq(morningBriefNativeSchedules.agentId, args.agentId),
        isNull(morningBriefNativeSchedules.chatThreadId),
      ),
    )
    .returning({ chatThreadId: morningBriefNativeSchedules.chatThreadId });
  return bound !== undefined;
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

type MorningBriefTransitionResult =
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
type PhaseCommit = (
  next: MorningBriefExecutionPhase,
  patch: Partial<typeof morningBriefNativeSchedules.$inferInsert>,
) => Promise<MorningBriefNativeScheduleRow[]>;

/**
 * Commit a drain's transfer, or hold it with a bounded reason.
 *
 * Both directions install exactly one successor obligation, strictly in the
 * future, from the CURRENT logical preference, timezone and cron — never an old
 * copy and never the original enabled bit. The epoch bump is what stops an old
 * completion or a late callback from writing into the new owner's state.
 */
async function commitTransfer(
  settled: PhaseCommit,
  current: MorningBriefNativeScheduleRow,
  args: {
    readonly tx: MorningBriefNativeWriter;
    readonly drain:
      | { readonly kind: "proven" }
      | { readonly kind: "unresolved"; readonly reason: string };
    readonly at: Date;
  },
  to: "native" | "legacy",
): Promise<MorningBriefTransitionResult> {
  if (args.drain.kind !== "proven") {
    const [held] = await settled(current.phase, {
      drainUnresolvedReason: args.drain.reason,
    });
    return held === undefined
      ? { kind: "absent" }
      : { kind: "held", row: held, reason: args.drain.reason };
  }
  const nextRunAt = computeNativeNextRunAt({
    enabled: current.enabled,
    cronExpression: current.cronExpression,
    timezone: current.timezone,
    from: args.at,
  });
  if (to === "legacy") {
    const restored =
      current.legacyAutomationId !== null &&
      (await restoreReconciledLegacyMorningBriefAdmission(
        args.tx,
        current,
        current.legacyAutomationId,
        { nextRunAt, at: args.at },
      ));
    if (!restored) {
      const reason = "legacy-target-not-ready";
      const [held] = await settled(current.phase, {
        drainUnresolvedReason: reason,
      });
      return held === undefined
        ? { kind: "absent" }
        : { kind: "held", row: held, reason };
    }
  } else if (current.legacyAutomationId !== null) {
    // Native receives the successor only after legacy admission is closed.
    await closeLegacyMorningBriefAdmission(args.tx, current.legacyAutomationId);
  }
  const [row] = await settled(to, {
    ownerEpoch: current.ownerEpoch + 1,
    nextRunAt,
    scheduleOwner: nextRunAt === null ? null : to,
    drainingEpoch: null,
    drainDeadlineAt: null,
    drainUnresolvedReason: null,
  });
  return row === undefined ? { kind: "absent" } : { kind: "transitioned", row };
}

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
    // Close new legacy admission first, in the same transaction as the phase.
    // The legacy poller admits on `enabled AND next_run_at <= now`, so clearing
    // that instant is what actually stops a new claim; the user's own enabled
    // choice is untouched and the rollback path restores the obligation from
    // the current logical preference.
    if (current.legacyAutomationId !== null) {
      await closeLegacyMorningBriefAdmission(tx, current.legacyAutomationId);
    }
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
    return await commitTransfer(settled, current, { ...args, tx }, "native");
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
    return await commitTransfer(settled, current, { ...args, tx }, "legacy");
  }

  if (phase === "draining" && target === "legacy") {
    // Reversal before the cutover committed. Nothing native was ever admitted
    // under this phase, so the member simply returns to legacy with its current
    // obligation restored; no epoch is manufactured.
    return await commitTransfer(settled, current, { ...args, tx }, "legacy");
  }

  if (phase === "rollback-draining" && target === "native") {
    // Reversal during a rollback. The native side still owns its admitted work,
    // so it may go straight back to `native` once that work is settled.
    return await commitTransfer(settled, current, { ...args, tx }, "native");
  }

  // A row already at its target still records that this tick examined it. The
  // transition scan orders by `updated_at`, so touching it here is what makes
  // that scan rotate: without it, twenty-five steady rows would hold the oldest
  // prefix forever and a later owner — including a native owner with no future
  // due row — could never reach rollback.
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
        isNull(morningBriefNativeOccurrences.settledAt),
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
 * Bind one reserved S5 attempt to this slot, before any delivery effect.
 *
 * The attempt id and the delivery obligation are written here rather than at
 * settlement, so a crash between the Chat receipt COMMIT and the settlement
 * leaves a row that the receipt-first recovery can still find and associate.
 * Writing it after the effects would lose exactly that association.
 *
 * It is fenced to the exact claimant and epoch, so a stale worker returning
 * from a reclaimed slot cannot rebind it.
 */
export async function bindNativeGenerationAttempt(
  tx: MorningBriefNativeWriter,
  owner: MorningBriefMemberIdentity,
  args: {
    readonly scheduledFor: Date;
    readonly generationAttemptId: string;
    readonly expectedEpoch: number;
    readonly expectedMembershipId: string;
    readonly leaseToken: string;
    readonly at: Date;
  },
): Promise<boolean> {
  // The member's *current* authority, not just the claimant's own record. The
  // occurrence keeps the epoch it was admitted under for its whole life, so
  // comparing only that would prove the claimant is the same worker while
  // saying nothing about whether the member still owns the claim. A disable, a
  // re-enable, a destination replacement or a transfer moves the schedule's
  // epoch, and a slot admitted before that must not reach the provider.
  const schedule = await lockMorningBriefNativeSchedule(tx, owner);
  if (
    schedule === undefined ||
    schedule.ownerEpoch !== args.expectedEpoch ||
    schedule.membershipId !== args.expectedMembershipId ||
    !schedule.enabled ||
    schedule.phase !== "native"
  ) {
    return false;
  }

  const rows = await tx
    .update(morningBriefNativeOccurrences)
    .set({
      generationAttemptId: args.generationAttemptId,
      deliveryPending: true,
      updatedAt: args.at,
    })
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, owner.orgId),
        eq(morningBriefNativeOccurrences.userId, owner.userId),
        eq(morningBriefNativeOccurrences.scheduledFor, args.scheduledFor),
        eq(morningBriefNativeOccurrences.ownerEpoch, args.expectedEpoch),
        eq(
          morningBriefNativeOccurrences.membershipId,
          args.expectedMembershipId,
        ),
        eq(morningBriefNativeOccurrences.leaseToken, args.leaseToken),
        isNull(morningBriefNativeOccurrences.settledAt),
      ),
    )
    .returning({ scheduledFor: morningBriefNativeOccurrences.scheduledFor });
  return rows.length > 0;
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
    /** The epoch that admitted this claim. */
    readonly expectedEpoch: number;
    /** The exact lease this claimant still holds. */
    readonly leaseToken: string;
    readonly at: Date;
  },
): Promise<
  | { readonly kind: "settled"; readonly nextRunAt: Date | null }
  | { readonly kind: "already-settled" }
  | { readonly kind: "stale-claimant" }
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
        isNull(morningBriefNativeOccurrences.settledAt),
        // And only by the exact claimant, under the exact epoch that admitted
        // it. A worker whose lease was reclaimed, or whose epoch was revoked,
        // returns to find nothing to settle: its observations are still
        // reconcilable evidence, but it has no authority to schedule.
        eq(morningBriefNativeOccurrences.ownerEpoch, args.expectedEpoch),
        eq(morningBriefNativeOccurrences.leaseToken, args.leaseToken),
      ),
    )
    .returning();
  if (occurrence === undefined) {
    return (await claimantStillHolds(tx, owner, args))
      ? { kind: "already-settled" }
      : { kind: "stale-claimant" };
  }
  if (schedule.ownerEpoch !== args.expectedEpoch) {
    // The slot is closed as evidence, but a revoked epoch never installs a
    // successor: the revoking writer already assigned or cleared it.
    return { kind: "settled", nextRunAt: schedule.nextRunAt };
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
 * Whether the row exists and was settled by this same claimant/epoch.
 *
 * Used only to report `already-settled` — an idempotent replay of the same
 * worker — separately from `stale-claimant`, which is a fenced-out return.
 */
async function claimantStillHolds(
  tx: MorningBriefNativeWriter,
  owner: MorningBriefMemberIdentity,
  args: {
    readonly scheduledFor: Date;
    readonly expectedEpoch: number;
    readonly leaseToken: string;
  },
): Promise<boolean> {
  const [row] = await tx
    .select({
      ownerEpoch: morningBriefNativeOccurrences.ownerEpoch,
      settledAt: morningBriefNativeOccurrences.settledAt,
    })
    .from(morningBriefNativeOccurrences)
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, owner.orgId),
        eq(morningBriefNativeOccurrences.userId, owner.userId),
        eq(morningBriefNativeOccurrences.scheduledFor, args.scheduledFor),
      ),
    )
    .limit(1);
  return (
    row !== undefined &&
    row.settledAt !== null &&
    row.ownerEpoch === args.expectedEpoch
  );
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
    readonly expectedEpoch: number;
    readonly leaseToken: string;
    readonly at: Date;
  },
): Promise<
  | { readonly kind: "deferred"; readonly until: Date }
  | { readonly kind: "exhausted" }
  | { readonly kind: "stale-claimant" }
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
  if (row === undefined) {
    return { kind: "stale-claimant" };
  }
  if (
    row.ownerEpoch !== args.expectedEpoch ||
    row.leaseToken !== args.leaseToken
  ) {
    return { kind: "stale-claimant" };
  }
  if (row.deferAttempt >= NATIVE_CONFIGURATION_DEFER_LIMIT) {
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
 * Re-lease an occurrence a previous tick left unsettled.
 *
 * This is the recovery half of the claim protocol, and it is what makes the
 * finite deferral and a crashed tick actually recoverable: the claim already
 * took the schedule obligation away, so nothing would rediscover the slot
 * through {@link loadDueNativeOwners}. The anchor, timezone and admitting epoch
 * are reused exactly — a resumed slot is the *same* logical occurrence, so a
 * reserved `generation_attempt_id` still fences a second model request.
 *
 * It refuses when the member's choice, phase, membership or epoch moved, which
 * is how a revoked slot stops being resumable instead of silently re-running.
 */
export async function resumeMorningBriefNativeOccurrence(
  tx: MorningBriefNativeWriter,
  owner: MorningBriefMemberIdentity,
  args: {
    readonly scheduledFor: Date;
    readonly now: Date;
    readonly leaseToken: string;
    readonly membershipId: string;
  },
): Promise<MorningBriefNativeClaim> {
  const schedule = await lockMorningBriefNativeSchedule(tx, owner);
  if (schedule === undefined) {
    return { kind: "inadmissible", reason: "absent" };
  }
  // Resuming is reconciliation of an obligation this member's scheduler already
  // recorded, not admission of new work, so a rollback drain must still be able
  // to finish it. Without this, a crashed or deferred slot is excluded the
  // moment the switch flips, `proveNativeMorningBriefDrain` keeps refusing on
  // that same unsettled row, and the rollback can never complete. New claims
  // stay restricted to `native` in `claimMorningBriefNativeOccurrence`.
  if (schedule.phase !== "native" && schedule.phase !== "rollback-draining") {
    return { kind: "inadmissible", reason: `phase:${schedule.phase}` };
  }
  if (!schedule.enabled) {
    return { kind: "inadmissible", reason: "disabled" };
  }
  if (schedule.membershipId !== args.membershipId) {
    return { kind: "inadmissible", reason: "membership-generation" };
  }

  const leaseExpiresAt = new Date(
    args.now.getTime() + NATIVE_OCCURRENCE_LEASE_MS,
  );
  const [occurrence] = await tx
    .update(morningBriefNativeOccurrences)
    .set({
      state: "claimed",
      leaseToken: args.leaseToken,
      leaseExpiresAt,
      // The deferral is consumed here. Leaving it set would make the resumed
      // claimant's own live lease stealable the moment that timestamp passed.
      deferredUntil: null,
      attempt: sql`${morningBriefNativeOccurrences.attempt} + 1`,
      updatedAt: args.now,
    })
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, owner.orgId),
        eq(morningBriefNativeOccurrences.userId, owner.userId),
        eq(morningBriefNativeOccurrences.scheduledFor, args.scheduledFor),
        eq(morningBriefNativeOccurrences.ownerEpoch, schedule.ownerEpoch),
        isNull(morningBriefNativeOccurrences.settledAt),
        // The same receipt-first invariant, enforced on the mutation and not
        // only on the discovery query, so no other caller can bypass it.
        isNull(morningBriefNativeOccurrences.generationAttemptId),
        eq(morningBriefNativeOccurrences.deliveryPending, false),
        // Either its deferral is due, or its lease lapsed. A live lease held by
        // another tick is never taken over here.
        or(
          and(
            eq(morningBriefNativeOccurrences.state, "deferred"),
            isNotNull(morningBriefNativeOccurrences.deferredUntil),
            lte(morningBriefNativeOccurrences.deferredUntil, args.now),
          ),
          and(
            eq(morningBriefNativeOccurrences.state, "claimed"),
            or(
              isNull(morningBriefNativeOccurrences.leaseExpiresAt),
              lt(morningBriefNativeOccurrences.leaseExpiresAt, args.now),
            ),
          ),
        ),
      ),
    )
    .returning();
  return occurrence === undefined
    ? { kind: "inadmissible", reason: "held-by-another-tick" }
    : { kind: "claimed", occurrence, schedule };
}

/**
 * Unsettled slots a later tick must resume.
 *
 * These are the occurrences whose schedule obligation is already held by the
 * occurrence itself: a finite deferral that came due, or a claim whose tick
 * died before it could settle. Without this reader an enabled owner would sit
 * with `next_run_at = NULL` forever.
 */
export async function loadResumableOccurrences(
  db: MorningBriefNativeReader,
  args: {
    readonly now: Date;
    readonly limit: number;
    readonly owner?: MorningBriefMemberIdentity;
  },
): Promise<readonly MorningBriefNativeOccurrenceRow[]> {
  return await db
    .select()
    .from(morningBriefNativeOccurrences)
    .where(
      and(
        args.owner === undefined ? undefined : occurrenceOwnerWhere(args.owner),
        isNull(morningBriefNativeOccurrences.settledAt),
        // Receipt-first is a per-occurrence invariant, not a property of one
        // scan happening to fit in one batch. A slot that already bound an
        // attempt is reachable only through the receipt pass, which resolves
        // its durable receipt by occurrence identity. Resuming it would call S5
        // first, and after the real result sweep a completed collection with no
        // generation reads as a healthy empty day — bypassing a Chat receipt
        // that has already committed.
        isNull(morningBriefNativeOccurrences.generationAttemptId),
        eq(morningBriefNativeOccurrences.deliveryPending, false),
        or(
          and(
            eq(morningBriefNativeOccurrences.state, "deferred"),
            isNotNull(morningBriefNativeOccurrences.deferredUntil),
            lte(morningBriefNativeOccurrences.deferredUntil, args.now),
          ),
          and(
            eq(morningBriefNativeOccurrences.state, "claimed"),
            or(
              isNull(morningBriefNativeOccurrences.leaseExpiresAt),
              lt(morningBriefNativeOccurrences.leaseExpiresAt, args.now),
            ),
          ),
        ),
      ),
    )
    .orderBy(morningBriefNativeOccurrences.scheduledFor)
    .limit(args.limit);
}

/**
 * Members whose installed Morning Brief has no durable native row yet.
 *
 * Bounded application materialization: it reads the member's own selected
 * installation and *its* automation, never the disposable projection, the
 * enrollment state or a title match. It is the cron's bootstrap input, so a GET
 * never creates or repairs anything.
 *
 * The scan window is deliberately wider than the work budget and deterministically
 * ordered. Membership is resolved per candidate against Clerk, and an owner whose
 * membership no longer resolves cannot be materialized — an unordered window the
 * size of the budget would let a backlog of those owners occupy every slot and
 * starve the members that can still be migrated. The caller stops after its own
 * budget, so widening the window costs one bounded query, not unbounded work.
 */
export async function loadBootstrapCandidates(
  db: MorningBriefNativeReader,
  args: {
    readonly limit: number;
    readonly owner?: MorningBriefMemberIdentity;
  },
): Promise<readonly MorningBriefMemberIdentity[]> {
  const rows = await db
    .select({
      orgId: workflowAutomations.orgId,
      userId: workflowAutomations.ownerUserId,
    })
    .from(workflowAutomations)
    .leftJoin(
      morningBriefNativeSchedules,
      and(
        eq(morningBriefNativeSchedules.orgId, workflowAutomations.orgId),
        eq(morningBriefNativeSchedules.userId, workflowAutomations.ownerUserId),
      ),
    )
    .where(
      and(
        eq(
          workflowAutomations.officialBlueprintKey,
          MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
        ),
        eq(workflowAutomations.kind, "schedule"),
        args.owner === undefined
          ? undefined
          : and(
              eq(workflowAutomations.orgId, args.owner.orgId),
              eq(workflowAutomations.ownerUserId, args.owner.userId),
            ),
        isNull(morningBriefNativeSchedules.orgId),
      ),
    )
    .orderBy(workflowAutomations.createdAt, workflowAutomations.id)
    .limit(args.limit);
  return rows.map((row) => {
    return { orgId: row.orgId, userId: row.userId };
  });
}

/**
 * Close new legacy claim admission for one member, atomically with the phase.
 *
 * The legacy poller's due predicate is `enabled AND kind='schedule' AND
 * next_run_at <= now`, so clearing that automation's `next_run_at` is what
 * actually stops a new legacy claim from entering. The user's own `enabled`
 * choice is deliberately untouched: it is still what Settings shows, and the
 * rollback path restores the obligation from the current logical preference.
 */
async function closeLegacyMorningBriefAdmission(
  tx: MorningBriefNativeWriter,
  automationId: string,
): Promise<void> {
  await tx
    .update(workflowAutomations)
    .set({ nextRunAt: null })
    .where(eq(workflowAutomations.id, automationId));
}

/**
 * Hand a future obligation back to the legacy scheduler on rollback.
 *
 * It writes the same instant the native row records, so exactly one owner holds
 * the member's next occurrence after the transaction commits.
 */
async function restoreLegacyMorningBriefObligation(
  tx: MorningBriefNativeWriter,
  automationId: string,
  nextRunAt: Date | null,
): Promise<void> {
  await tx
    .update(workflowAutomations)
    .set({ nextRunAt })
    .where(eq(workflowAutomations.id, automationId));
}

/** Restore rollback only into a reconciled row carrying the current choice. */
async function restoreReconciledLegacyMorningBriefAdmission(
  tx: MorningBriefNativeWriter,
  schedule: MorningBriefNativeScheduleRow,
  automationId: string,
  args: { readonly nextRunAt: Date | null; readonly at: Date },
): Promise<boolean> {
  const [legacy] = await tx
    .select({
      kind: workflowAutomations.kind,
      blueprintKey: workflowAutomations.officialBlueprintKey,
      reconciliationStatus: workflowAutomations.officialReconciliationStatus,
    })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.id, automationId),
        eq(workflowAutomations.orgId, schedule.orgId),
        eq(workflowAutomations.ownerUserId, schedule.userId),
      ),
    )
    .for("update")
    .limit(1);
  if (
    legacy === undefined ||
    legacy.kind !== "schedule" ||
    legacy.blueprintKey !== MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY ||
    legacy.reconciliationStatus !== "current"
  ) {
    return false;
  }
  const [restored] = await tx
    .update(workflowAutomations)
    .set({
      enabled: schedule.enabled,
      officialIntendedEnabled: schedule.enabled,
      cronExpression: schedule.cronExpression,
      timezone: schedule.timezone,
      nextRunAt: args.nextRunAt,
      ...(schedule.enabled ? { consecutiveFailures: 0 } : {}),
      updatedAt: args.at,
    })
    .where(
      and(
        eq(workflowAutomations.id, automationId),
        eq(workflowAutomations.officialReconciliationStatus, "current"),
      ),
    )
    .returning({ id: workflowAutomations.id });
  return restored !== undefined;
}

/**
 * The members whose native obligation is due, oldest first.
 *
 * Bounded by the caller's batch size. It reads only rows the native owner is
 * responsible for, so a member still on legacy is never picked up here.
 */
export async function loadDueNativeOwners(
  db: MorningBriefNativeReader,
  args: {
    readonly now: Date;
    readonly limit: number;
    readonly owner?: MorningBriefMemberIdentity;
  },
): Promise<readonly MorningBriefNativeScheduleRow[]> {
  return await db
    .select()
    .from(morningBriefNativeSchedules)
    .where(
      and(
        args.owner === undefined ? undefined : scheduleWhere(args.owner),
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
  args: {
    readonly limit: number;
    readonly owner?: MorningBriefMemberIdentity;
  },
): Promise<readonly MorningBriefNativeOccurrenceRow[]> {
  return await db
    .select()
    .from(morningBriefNativeOccurrences)
    .where(
      // Both an accepted result that still owes recovery **and** an unsettled
      // slot that already bound an attempt. The second case is the crash
      // between the Chat receipt COMMIT and the settlement: without it the
      // receipt-first pass would never read that receipt, and resuming the slot
      // would go to S5 first and mistake a swept result for a healthy empty
      // day.
      and(
        args.owner === undefined ? undefined : occurrenceOwnerWhere(args.owner),
        eq(morningBriefNativeOccurrences.deliveryPending, true),
        isNotNull(morningBriefNativeOccurrences.generationAttemptId),
      ),
    )
    .orderBy(morningBriefNativeOccurrences.scheduledFor)
    .limit(args.limit);
}

/**
 * Close one recovered delivery obligation, in the documented lock order.
 *
 * The schedule row is locked **first**, exactly as the ordinary settlement path
 * does, so a returning worker and a recovering tick can never hold one row each
 * and deadlock. The occurrence update is fenced on the claim the caller
 * observed, so a slot reclaimed in the meantime keeps its new owner's flag.
 *
 * Clearing and settling are one mutation: the clear can no longer commit while
 * the settlement that should accompany it is refused.
 */
export async function closeRecoveredMorningBriefDelivery(
  tx: MorningBriefNativeWriter,
  owner: MorningBriefMemberIdentity,
  args: {
    readonly scheduledFor: Date;
    readonly expectedEpoch: number;
    readonly leaseToken: string | null;
    /** Non-null when this slot still owes its one settlement. */
    readonly settleAs: MorningBriefNativeOutcome | null;
    readonly at: Date;
  },
): Promise<"closed" | "stale-claimant" | "absent"> {
  if ((await lockMorningBriefNativeSchedule(tx, owner)) === undefined) {
    return "absent";
  }

  const cleared = await tx
    .update(morningBriefNativeOccurrences)
    .set({ deliveryPending: false, updatedAt: args.at })
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, owner.orgId),
        eq(morningBriefNativeOccurrences.userId, owner.userId),
        eq(morningBriefNativeOccurrences.scheduledFor, args.scheduledFor),
        eq(morningBriefNativeOccurrences.ownerEpoch, args.expectedEpoch),
        args.leaseToken === null
          ? isNull(morningBriefNativeOccurrences.leaseToken)
          : eq(morningBriefNativeOccurrences.leaseToken, args.leaseToken),
      ),
    )
    .returning({ scheduledFor: morningBriefNativeOccurrences.scheduledFor });
  if (cleared.length === 0) {
    return "stale-claimant";
  }

  if (args.settleAs !== null && args.leaseToken !== null) {
    // The slot bound its attempt but crashed before its own settlement. It is
    // settled here, once, from the durable receipt, under the same schedule
    // lock this function already holds.
    await settleMorningBriefNativeOccurrence(tx, owner, {
      scheduledFor: args.scheduledFor,
      outcome: args.settleAs,
      deliveryPending: false,
      expectedEpoch: args.expectedEpoch,
      leaseToken: args.leaseToken,
      at: args.at,
    });
  }
  return "closed";
}

/**
 * Members whose execution ownership may need to move.
 *
 * It is every row that is mid-transition — both draining phases — plus every
 * steady-state row, so the tick can both *initiate* a cutover for a member the
 * switch now selects and *continue* one it already started. `drain_deadline_at`
 * is only reporting metadata; it never decides whether a phase may advance.
 */
export async function loadTransitionCandidates(
  db: MorningBriefNativeReader,
  args: {
    readonly now: Date;
    readonly limit: number;
    readonly owner?: MorningBriefMemberIdentity;
  },
): Promise<readonly MorningBriefNativeScheduleRow[]> {
  return await db
    .select()
    .from(morningBriefNativeSchedules)
    // Every row is a candidate, because only the *current* switch decides the
    // target and a steady `legacy`/`legacy` row is exactly where a first
    // cutover has to start. The bounded limit and the ordering keep one tick's
    // work finite; a row already at its target costs one no-op comparison.
    .where(args.owner === undefined ? sql`true` : scheduleWhere(args.owner))
    .orderBy(morningBriefNativeSchedules.updatedAt)
    .limit(args.limit);
}
