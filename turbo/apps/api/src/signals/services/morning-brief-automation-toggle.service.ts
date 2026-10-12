import { MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { sql } from "drizzle-orm";

import { writeDb$ } from "../external/db";
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
    const columns = workflowAutomationColumns();
    const update = db
      .update(workflowAutomations)
      .set({
        enabled: args.enabled,
        nextRunAt: args.enabled ? args.nextRunAt : null,
        consecutiveFailures: args.enabled
          ? 0
          : args.automation.consecutiveFailures,
        updatedAt: args.now,
        officialIntendedEnabled: args.enabled,
        ...(args.inheritedAutonomyBudget === undefined
          ? {}
          : { autonomyBudget: args.inheritedAutonomyBudget }),
      })
      .where(officialAutomationLifecycleCondition(args.automation))
      .returning({
        ...columns,
        observedUpdatedAt: columns.observedUpdatedAt.as("observedUpdatedAt"),
        observedXmin: columns.observedXmin.as("observedXmin"),
      });
    const updated = db.$with("updated_morning_brief_automation").as(update);
    const values = enrollmentChoice(args.enabled, args.now);
    // Drizzle INSERT SELECT requires every column. Keep the omitted enrollment
    // fields on their database defaults, and gate publication on UPDATE RETURNING.
    const published = db.$with("published_morning_brief_choice", {}).as(sql`
      INSERT INTO ${morningBriefEnrollments}
        (org_id, user_id, state, available_at, last_error, updated_at)
      SELECT ${owner.orgId}, ${owner.userId}, ${values.state},
        ${sql.param(values.availableAt, morningBriefEnrollments.availableAt)}, NULL,
        ${sql.param(values.updatedAt, morningBriefEnrollments.updatedAt)}
      FROM ${updated}
      ON CONFLICT (org_id, user_id) DO UPDATE SET
        state = EXCLUDED.state,
        available_at = EXCLUDED.available_at,
        last_error = EXCLUDED.last_error,
        updated_at = EXCLUDED.updated_at
    `);
    // A data-modifying CTE executes even without a returned enrollment row.
    // Read the actual automation RETURNING values with their schema decoders.
    const [row] = args.reconciliationOwned
      ? await update
      : await db.with(updated, published).select().from(updated);
    signal.throwIfAborted();
    return row ? { kind: "applied", row } : { kind: "conflict" };
  },
);
