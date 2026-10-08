import { MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";

import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { officialAutomationLifecycleCondition } from "./workflow-automation-write-condition";

type AutomationRow = typeof workflowAutomations.$inferSelect;
interface MorningBriefToggleInput {
  readonly automation: AutomationRow;
  readonly enabled: boolean;
  readonly nextRunAt: Date | null;
  readonly now: Date;
  readonly inheritedAutonomyBudget?: number;
  readonly reconciliationOwned?: boolean;
}

function toggleOwner(automation: AutomationRow) {
  return automation.officialBlueprintKey ===
    MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY &&
    automation.ownerUserId !== null &&
    automation.kind === "schedule"
    ? { orgId: automation.orgId, userId: automation.ownerUserId }
    : undefined;
}

function enrollmentChoice(enabled: boolean, at: Date) {
  return {
    state: enabled ? ("pending" as const) : ("cancelled" as const),
    availableAt: at,
    lastError: null,
    updatedAt: at,
  };
}

class StaleMorningBriefToggle extends Error {}

export type MorningBriefAutomationToggleResult =
  | { readonly kind: "not-applicable" }
  | { readonly kind: "applied"; readonly row: AutomationRow }
  | { readonly kind: "conflict" };

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
      db.transaction(async (tx) => {
        const enabled = args.enabled;
        const [row] = await tx
          .update(workflowAutomations)
          .set({
            enabled,
            nextRunAt: enabled ? args.nextRunAt : null,
            consecutiveFailures: enabled
              ? 0
              : args.automation.consecutiveFailures,
            updatedAt: args.now,
            officialIntendedEnabled: enabled,
            ...(args.inheritedAutonomyBudget === undefined
              ? {}
              : { autonomyBudget: args.inheritedAutonomyBudget }),
          })
          .where(officialAutomationLifecycleCondition(args.automation))
          .returning(workflowAutomationColumns());
        if (!row) {
          throw new StaleMorningBriefToggle();
        }
        if (!args.reconciliationOwned) {
          const values = enrollmentChoice(enabled, args.now);
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
      }),
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      if (result.error instanceof StaleMorningBriefToggle) {
        return { kind: "conflict" };
      }
      throw result.error;
    }
    return { kind: "applied", row: result.value };
  },
);
