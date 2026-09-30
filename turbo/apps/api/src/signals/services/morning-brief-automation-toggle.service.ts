import { MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import {
  morningBriefNativeOccurrences,
  morningBriefNativeSchedules,
} from "@okouai/db/schema/morning-brief-native-schedule";
import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, desc, eq, isNull } from "drizzle-orm";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import {
  MorningBriefSnapshotChanged,
  morningBriefLogicalChoicePlan,
  morningBriefNativeRowVersionCondition,
  morningBriefScheduleWhere,
  readMorningBriefNativeScheduleForWrite,
  commitMorningBriefSnapshotOnce,
  type MorningBriefNativeScheduleRow,
} from "./morning-brief-native-schedule.service";
import { officialAutomationLifecycleCondition } from "./workflow-automation-write-condition";

type AutomationRow = typeof workflowAutomations.$inferSelect;
interface MorningBriefToggleInput {
  readonly automation: AutomationRow;
  readonly enabled: boolean;
  readonly nextRunAt: Date | null;
  readonly now: Date;
  readonly inheritedAutonomyBudget?: number;
  readonly useDurableChoice?: boolean;
}

function toggleOwner(automation: AutomationRow) {
  return automation.officialBlueprintKey ===
    MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY &&
    automation.ownerUserId !== null &&
    automation.kind === "schedule"
    ? { orgId: automation.orgId, userId: automation.ownerUserId }
    : undefined;
}

function toggleChoice(
  args: MorningBriefToggleInput,
  native: MorningBriefNativeScheduleRow | undefined,
) {
  const selected =
    native?.legacyAutomationId === args.automation.id &&
    native.legacyWorkflowId === args.automation.workflowId;
  const reconciliationOwned = selected && args.useDurableChoice === true;
  const enabled = reconciliationOwned ? native.enabled : args.enabled;
  return {
    selected,
    reconciliationOwned,
    enabled,
    values: {
      enabled,
      nextRunAt:
        enabled && (native === undefined || native.phase === "legacy")
          ? args.nextRunAt
          : null,
      consecutiveFailures: enabled ? 0 : args.automation.consecutiveFailures,
      updatedAt: args.now,
      officialIntendedEnabled: enabled,
      ...(args.inheritedAutonomyBudget === undefined
        ? {}
        : { autonomyBudget: args.inheritedAutonomyBudget }),
    },
  };
}

function enrollmentChoice(enabled: boolean, at: Date) {
  return {
    state: enabled ? ("pending" as const) : ("cancelled" as const),
    availableAt: at,
    lastError: null,
    updatedAt: at,
  };
}

function occurrenceWhere(owner: {
  readonly orgId: string;
  readonly userId: string;
}) {
  return and(
    eq(morningBriefNativeOccurrences.orgId, owner.orgId),
    eq(morningBriefNativeOccurrences.userId, owner.userId),
    isNull(morningBriefNativeOccurrences.settledAt),
  );
}

function revokedOccurrence(at: Date) {
  return {
    state: "settled" as const,
    outcome: "revoked" as const,
    settledAt: at,
    leaseToken: null,
    leaseExpiresAt: null,
    deferredUntil: null,
    deliveryPending: false,
    updatedAt: at,
  };
}

class StaleMorningBriefToggle extends Error {}

/**
 * The toggle's outcome for the generic automation writer.
 *
 * `not-applicable` hands the row to the ordinary writer; `conflict` is a lost
 * conditional write on the native row, which the caller reports as the
 * existing retryable official-workflow conflict instead of re-running.
 */
export type MorningBriefAutomationToggleResult =
  | { readonly kind: "not-applicable" }
  | { readonly kind: "applied"; readonly row: AutomationRow }
  | { readonly kind: "conflict" };

/**
 * Atomically commit the legacy automation, enrollment choice and native obligation.
 *
 * No row is locked. The native obligation is computed from the row as read and
 * written first (the documented order) under its exact row version; losing to
 * a concurrent native writer rolls the transaction back and returns
 * `conflict` once; nothing is re-read or retried here. The automation write keeps its caller-snapshot lifecycle condition,
 * whose zero-row outcome is the existing stale-toggle result.
 */
export const persistMorningBriefAutomationToggle$ = command(
  async (
    { set },
    args: MorningBriefToggleInput,
    signal: AbortSignal,
  ): Promise<MorningBriefAutomationToggleResult> => {
    const owner = toggleOwner(args.automation);
    if (owner === undefined) {
      return { kind: "not-applicable" };
    }
    const db = set(writeDb$);
    signal.throwIfAborted();
    const result = await settle(
      commitMorningBriefSnapshotOnce(() => {
        return db.transaction(async (tx) => {
          const snapshot = await readMorningBriefNativeScheduleForWrite(
            tx,
            owner,
          );
          const native = snapshot?.row;
          const choice = toggleChoice(args, native);
          if (choice.selected && snapshot !== undefined) {
            const [occurrence] = await tx
              .select()
              .from(morningBriefNativeOccurrences)
              .where(occurrenceWhere(owner))
              .orderBy(morningBriefNativeOccurrences.scheduledFor)
              .limit(1);
            const [claim] = await tx
              .select({ settlement: morningBriefScheduleClaims.settlement })
              .from(morningBriefScheduleClaims)
              .where(
                eq(morningBriefScheduleClaims.automationId, args.automation.id),
              )
              .orderBy(desc(morningBriefScheduleClaims.claimSequence))
              .limit(1);
            const plan = morningBriefLogicalChoicePlan(
              snapshot.row,
              { enabled: choice.enabled },
              occurrence,
              snapshot.row.phase === "legacy" &&
                claim?.settlement === "unsettled",
              args.now,
            );
            const [applied] = await tx
              .update(morningBriefNativeSchedules)
              .set(plan.values)
              .where(
                and(
                  morningBriefScheduleWhere(owner),
                  morningBriefNativeRowVersionCondition(snapshot.rowVersion),
                ),
              )
              .returning({
                ownerEpoch: morningBriefNativeSchedules.ownerEpoch,
              });
            if (applied === undefined) {
              throw new MorningBriefSnapshotChanged();
            }
            if (plan.revokes) {
              await tx
                .update(morningBriefNativeOccurrences)
                .set(revokedOccurrence(args.now))
                .where(
                  and(
                    occurrenceWhere(owner),
                    eq(
                      morningBriefNativeOccurrences.ownerEpoch,
                      snapshot.row.ownerEpoch,
                    ),
                  ),
                );
            }
          }
          const [row] = await tx
            .update(workflowAutomations)
            .set(choice.values)
            .where(officialAutomationLifecycleCondition(args.automation))
            .returning(workflowAutomationColumns());
          if (row === undefined) {
            throw new StaleMorningBriefToggle();
          }
          if (!choice.reconciliationOwned) {
            const values = enrollmentChoice(choice.enabled, args.now);
            await tx
              .insert(morningBriefEnrollments)
              .values({ ...owner, ...values })
              .onConflictDoUpdate({
                target: [
                  morningBriefEnrollments.orgId,
                  morningBriefEnrollments.userId,
                ],
                set: values,
              });
          }
          signal.throwIfAborted();
          return row;
        });
      }, signal),
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      if (result.error instanceof StaleMorningBriefToggle) {
        return { kind: "not-applicable" };
      }
      throw result.error;
    }
    return result.value.kind === "committed"
      ? { kind: "applied", row: result.value.value }
      : { kind: "conflict" };
  },
);
