import { MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { assertErasureSubjectWritable } from "@okouai/db/operations/account-erasure";
import {
  morningBriefScheduleClaims,
  type MorningBriefScheduleClaimSettlement,
} from "@okouai/db/schema/morning-brief-schedule-claim";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, desc, eq, gt, isNull, notExists, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Tx } from "../../lib/db-types";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import {
  loadMorningBriefMigrationState,
  type MorningBriefStateReader,
} from "./morning-brief-migration-state.service";
import { advanceTimeAutomationAfterCompletion } from "./time-automation";

type AutomationRow = typeof workflowAutomations.$inferSelect;

const log = logger("MorningBriefScheduleClaim");

/** Mirrors the legacy poller and callback policy; they share one constant. */
const MAX_CONSECUTIVE_FAILURES = 3;

export type MorningBriefScheduleClaimRow =
  typeof morningBriefScheduleClaims.$inferSelect;

/**
 * The owner identity a claim is written for, resolved before the claim
 * transaction and re-verified against the locked automation row inside it.
 */
export interface MorningBriefScheduleClaimOwner {
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly workflowId: string;
}

export type MorningBriefScheduleClaimAttempt =
  | { readonly kind: "claimed"; readonly claim: MorningBriefScheduleClaimRow }
  /** The locked row no longer matches the due occurrence this tick resolved. */
  | { readonly kind: "unavailable" };

/**
 * Whether the poller should journal this automation.
 *
 * Only the installation S1's canonical selection reports as the member's
 * installed Morning Brief is journaled. The cheap blueprint predicate keeps the
 * canonical read off every unrelated due automation.
 */
export async function isCanonicalMorningBriefAutomation(
  db: MorningBriefStateReader,
  automation: AutomationRow,
): Promise<boolean> {
  if (
    automation.kind !== "schedule" ||
    automation.scheduleType !== "cron" ||
    automation.officialBlueprintKey !== MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY
  ) {
    return false;
  }
  const state = await loadMorningBriefMigrationState(db, {
    orgId: automation.orgId,
    userId: automation.ownerUserId,
  });
  return state.kind === "installed" && state.automation.id === automation.id;
}

async function nextClaimSequence(
  tx: Tx,
  automationId: string,
): Promise<number> {
  const [current] = await tx
    .select({ claimSequence: morningBriefScheduleClaims.claimSequence })
    .from(morningBriefScheduleClaims)
    .where(eq(morningBriefScheduleClaims.automationId, automationId))
    .orderBy(desc(morningBriefScheduleClaims.claimSequence))
    .limit(1);
  return (current?.claimSequence ?? 0) + 1;
}

/**
 * Consume the due occurrence and journal it in the caller's transaction.
 *
 * The erasure subjects are admitted before the automation row is locked, the
 * locked row must still be the same enabled automation whose `next_run_at` is
 * the anchor this tick resolved, and clearing the schedule, recording
 * `last_run_at` and inserting the journal row all commit together. A caller
 * that aborts leaves the schedule exactly as it found it.
 */
export async function claimMorningBriefSchedule(
  tx: Tx,
  args: {
    readonly automationId: string;
    readonly owner: MorningBriefScheduleClaimOwner;
    readonly scheduledAnchorAt: Date;
    readonly claimedAt: Date;
  },
): Promise<MorningBriefScheduleClaimAttempt> {
  await assertErasureSubjectWritable(tx, [
    { subjectKind: "organization", subjectId: args.owner.orgId },
    { subjectKind: "user", subjectId: args.owner.ownerUserId },
  ]);
  const [locked] = await tx
    .select(workflowAutomationColumns())
    .from(workflowAutomations)
    .where(eq(workflowAutomations.id, args.automationId))
    .limit(1)
    .for("update");
  if (
    !locked ||
    !locked.enabled ||
    locked.orgId !== args.owner.orgId ||
    locked.ownerUserId !== args.owner.ownerUserId ||
    locked.workflowId !== args.owner.workflowId ||
    locked.nextRunAt?.getTime() !== args.scheduledAnchorAt.getTime()
  ) {
    return { kind: "unavailable" };
  }

  const claimSequence = await nextClaimSequence(tx, args.automationId);
  const [claim] = await tx
    .insert(morningBriefScheduleClaims)
    .values({
      automationId: args.automationId,
      orgId: locked.orgId,
      ownerUserId: locked.ownerUserId,
      workflowId: locked.workflowId,
      scheduledAnchorAt: args.scheduledAnchorAt,
      claimedAt: args.claimedAt,
      claimSequence,
    })
    .returning();
  if (!claim) {
    throw new Error("Morning Brief schedule claim insert returned no row");
  }
  await tx
    .update(workflowAutomations)
    .set({
      nextRunAt: null,
      lastRunAt: args.claimedAt,
      updatedAt: args.claimedAt,
    })
    .where(
      and(
        eq(workflowAutomations.id, args.automationId),
        eq(workflowAutomations.nextRunAt, args.scheduledAnchorAt),
      ),
    );
  return { kind: "claimed", claim };
}

/** Bind the exact queue event this claim inserted, in the same transaction. */
export async function bindMorningBriefScheduleClaimQueueEvent(
  tx: Tx,
  args: { readonly claimId: string; readonly queueEventId: string },
): Promise<void> {
  const bound = await tx
    .update(morningBriefScheduleClaims)
    .set({ queueEventId: args.queueEventId, updatedAt: nowDate() })
    .where(
      and(
        eq(morningBriefScheduleClaims.id, args.claimId),
        isNull(morningBriefScheduleClaims.queueEventId),
      ),
    )
    .returning({ id: morningBriefScheduleClaims.id });
  if (bound.length === 0) {
    throw new Error("Morning Brief schedule claim already bound a queue event");
  }
}

/**
 * The journaled occupant of a pending queue event, read under the thread's
 * admission lock so a coalescing tick can tell a recorded replay of its own
 * occurrence from a genuinely untracked event.
 */
export async function loadMorningBriefScheduleClaimByQueueEvent(
  tx: Tx,
  queueEventId: string,
): Promise<MorningBriefScheduleClaimRow | undefined> {
  const [claim] = await tx
    .select()
    .from(morningBriefScheduleClaims)
    .where(eq(morningBriefScheduleClaims.queueEventId, queueEventId))
    .limit(1);
  return claim;
}

/**
 * Bind the Run inside the authoritative launch transaction.
 *
 * The caller invokes this only after the exact original queue event has been
 * claimed, and the surrounding transaction still has to insert the Run, so a
 * lost claim or a rolled-back Run INSERT leaves no binding at all.
 */
export async function bindMorningBriefScheduleClaimRun(
  tx: Tx,
  args: { readonly queueEventId: string; readonly runId: string },
): Promise<void> {
  await tx
    .update(morningBriefScheduleClaims)
    .set({
      runId: args.runId,
      queueDisposition: "claimed",
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(morningBriefScheduleClaims.queueEventId, args.queueEventId),
        isNull(morningBriefScheduleClaims.runId),
      ),
    );
}

/**
 * True unless a newer journaled claim already superseded the occurrence this
 * Run belongs to.
 *
 * The launch transaction commits the Run and its journal binding together, but
 * the last-run fields are written after that transaction returns. This guards
 * that late write so a slow launch cannot overwrite the last-run fields a newer
 * claim has already published. An unjournaled Run matches no occurrence and is
 * always allowed, which keeps every other automation's behavior unchanged.
 */
export function morningBriefScheduleClaimIsNotSuperseded(
  db: Pick<Db, "select">,
  runId: string,
): SQL {
  const newer = alias(morningBriefScheduleClaims, "newer_schedule_claim");
  return notExists(
    db
      .select({ id: newer.id })
      .from(newer)
      .innerJoin(
        morningBriefScheduleClaims,
        and(
          eq(morningBriefScheduleClaims.runId, runId),
          eq(newer.automationId, morningBriefScheduleClaims.automationId),
          gt(newer.claimSequence, morningBriefScheduleClaims.claimSequence),
        ),
      ),
  );
}

/** How the caller identifies the occurrence it is settling. */
export type MorningBriefScheduleSettlementSubject =
  | { readonly kind: "claim"; readonly claimId: string }
  | { readonly kind: "run"; readonly runId: string };

export interface MorningBriefScheduleSettlementOutcome {
  readonly settled: boolean;
  readonly nextRunAt?: Date | null;
}

async function loadSettlementClaim(
  tx: Tx,
  automationId: string,
  subject: MorningBriefScheduleSettlementSubject,
): Promise<MorningBriefScheduleClaimRow | undefined> {
  const [claim] = await tx
    .select()
    .from(morningBriefScheduleClaims)
    .where(
      and(
        eq(morningBriefScheduleClaims.automationId, automationId),
        subject.kind === "claim"
          ? eq(morningBriefScheduleClaims.id, subject.claimId)
          : eq(morningBriefScheduleClaims.runId, subject.runId),
      ),
    )
    .limit(1)
    .for("update");
  return claim;
}

async function isCurrentClaim(
  tx: Tx,
  claim: MorningBriefScheduleClaimRow,
): Promise<boolean> {
  const [current] = await tx
    .select({ claimSequence: morningBriefScheduleClaims.claimSequence })
    .from(morningBriefScheduleClaims)
    .where(eq(morningBriefScheduleClaims.automationId, claim.automationId))
    .orderBy(desc(morningBriefScheduleClaims.claimSequence))
    .limit(1);
  return current?.claimSequence === claim.claimSequence;
}

interface SettleMorningBriefScheduleArgs {
  readonly automationId: string;
  readonly subject: MorningBriefScheduleSettlementSubject;
  readonly settlement: Exclude<
    MorningBriefScheduleClaimSettlement,
    "unsettled"
  >;
  /** Insufficient credits never counts as a failure or disables the schedule. */
  readonly isCreditError: boolean;
  readonly settledAt: Date;
}

/**
 * The one operation that advances the legacy Morning Brief schedule.
 *
 * Both the completion callback and the outer pre-run failure path call it. It
 * locks the automation and its journaled occurrence together, then refuses to
 * act unless that occurrence is still the current claim, is still unsettled,
 * belongs to an enabled automation, and no writer has already published a new
 * `next_run_at`. The recurrence is computed from the schedule and timezone
 * read under that lock, so a timezone edit made while the claim was active is
 * the one that takes effect. Schedule advance and settlement commit together,
 * which makes a duplicate callback, a failed-Run callback racing the outer
 * error path, and a callback from a superseded claim all no-ops.
 */
export async function settleMorningBriefSchedule(
  tx: Tx,
  args: SettleMorningBriefScheduleArgs,
): Promise<MorningBriefScheduleSettlementOutcome> {
  const [automation] = await tx
    .select(workflowAutomationColumns())
    .from(workflowAutomations)
    .where(eq(workflowAutomations.id, args.automationId))
    .limit(1)
    .for("update");
  if (!automation) {
    return { settled: false };
  }
  const claim = await loadSettlementClaim(tx, args.automationId, args.subject);
  if (!claim || claim.settlement !== "unsettled") {
    return { settled: false };
  }
  if (!(await isCurrentClaim(tx, claim))) {
    // A newer journaled claim already owns the schedule.
    return { settled: false };
  }
  if (
    !automation.enabled ||
    automation.nextRunAt !== null ||
    automation.scheduleType !== "cron"
  ) {
    // A user action already published the schedule this occurrence would have
    // written, or the automation is no longer a running cron schedule. The
    // occurrence is still consumed so a later duplicate cannot advance it.
    await markSettled(tx, claim.id, args);
    return { settled: true };
  }

  const consecutiveFailures =
    args.settlement === "completed"
      ? 0
      : automation.consecutiveFailures + (args.isCreditError ? 0 : 1);
  const shouldDisable =
    !args.isCreditError && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
  const nextRunAt = advanceTimeAutomationAfterCompletion({
    scheduleType: "cron",
    cronExpression: automation.cronExpression,
    intervalSeconds: automation.intervalSeconds,
    timezone: automation.timezone,
    completedAt: args.settledAt,
    shouldDisable,
  });
  await tx
    .update(workflowAutomations)
    .set({
      consecutiveFailures,
      ...(shouldDisable ? { enabled: false } : {}),
      nextRunAt,
      updatedAt: args.settledAt,
    })
    .where(
      and(
        eq(workflowAutomations.id, args.automationId),
        eq(workflowAutomations.enabled, true),
        isNull(workflowAutomations.nextRunAt),
      ),
    );
  await markSettled(tx, claim.id, args);
  if (shouldDisable) {
    log.warn(
      "Morning Brief schedule auto-disabled after consecutive failures",
      {
        automationId: args.automationId,
        orgId: claim.orgId,
        userId: claim.ownerUserId,
        consecutiveFailures,
      },
    );
  }
  return { settled: true, nextRunAt };
}

async function markSettled(
  tx: Tx,
  claimId: string,
  args: SettleMorningBriefScheduleArgs,
): Promise<void> {
  await tx
    .update(morningBriefScheduleClaims)
    .set({
      settlement: args.settlement,
      settledAt: args.settledAt,
      updatedAt: args.settledAt,
    })
    .where(
      and(
        eq(morningBriefScheduleClaims.id, claimId),
        eq(morningBriefScheduleClaims.settlement, "unsettled"),
      ),
    );
}

/**
 * Settle a journaled occurrence identified by its Run.
 *
 * Returns false when the Run has no journal binding, which is the exact
 * compatibility signal the legacy callback uses to keep its existing
 * unjournaled behavior.
 */
export async function settleMorningBriefScheduleForRun(
  db: Db,
  args: {
    readonly automationId: string;
    readonly runId: string;
    readonly settlement: Exclude<
      MorningBriefScheduleClaimSettlement,
      "unsettled" | "pre_run_failure"
    >;
    /** Read only for a recognized occurrence, so unjournaled callbacks add no query. */
    readonly resolveIsCreditError: () => Promise<boolean>;
    readonly settledAt: Date;
  },
): Promise<boolean> {
  const [binding] = await db
    .select({ id: morningBriefScheduleClaims.id })
    .from(morningBriefScheduleClaims)
    .where(
      and(
        eq(morningBriefScheduleClaims.automationId, args.automationId),
        eq(morningBriefScheduleClaims.runId, args.runId),
      ),
    )
    .limit(1);
  if (!binding) {
    return false;
  }
  const isCreditError = await args.resolveIsCreditError();
  await db.transaction(async (tx) => {
    return await settleMorningBriefSchedule(tx, {
      automationId: args.automationId,
      subject: { kind: "run", runId: args.runId },
      settlement: args.settlement,
      isCreditError,
      settledAt: args.settledAt,
    });
  });
  return true;
}

/**
 * Recover a claim whose queue admission never committed a queue event.
 *
 * The claim and its queue event commit together, so an unbound claim can only
 * exist when the claim transaction itself failed after the insert — the
 * journal row then rolls back with it. This guard covers the remaining case:
 * the poller consumed the schedule and then failed before a Run could be
 * created, which settles here through the same operation the callback uses.
 */
export async function settleMorningBriefSchedulePreRunFailure(
  db: Db,
  args: {
    readonly automationId: string;
    readonly claimId: string;
    readonly isCreditError: boolean;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    return await settleMorningBriefSchedule(tx, {
      automationId: args.automationId,
      subject: { kind: "claim", claimId: args.claimId },
      settlement: "pre_run_failure",
      isCreditError: args.isCreditError,
      settledAt: nowDate(),
    });
  });
}
