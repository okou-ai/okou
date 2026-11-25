import { isDeepStrictEqual } from "node:util";
import {
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES,
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { isValidTimeZone } from "@okouai/core/timezone";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import {
  officialWorkflowAutomationIdentities,
  workflows,
} from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { command } from "ccstate";
import { and, eq, exists, inArray, notExists, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { AUTONOMY_BUDGET_CEILING } from "../autonomy-budget-limit";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { observedWorkflowAutomationCondition } from "./workflow-automation-snapshot";
import { morningBriefCronExpression } from "./official-workflow-owner-schedule";
import { calculateNextRun } from "./time-automation";
import { builtInWorkflow } from "./builtin-workflows";

type OfficialAutomationRow = typeof workflowAutomations.$inferSelect;
interface InstallationOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
}

/** Reconfiguration must leave the current Official claim's empty slot for its completion callback. */
function reconciledScheduleAnchor(
  automation: OfficialAutomationRow,
  nextRunAt: Date | null,
) {
  if (nextRunAt === null) {
    return nextRunAt;
  }
  return sql`CASE WHEN (SELECT settlement FROM morning_brief_schedule_claims WHERE automation_id = ${automation.id}::uuid ORDER BY claim_sequence DESC LIMIT 1) = 'unsettled' THEN NULL ELSE ${nextRunAt}::timestamp END`;
}

/**
 * Moving the Morning Brief start earlier must not skip a day: when the new time
 * already passed since the last run, keep the pending occurrence once. Its
 * completion callback then advances on the new schedule.
 */
function keepSkippedMorningBriefOccurrence(
  current: OfficialAutomationRow,
  refreshed: {
    readonly cronExpression: string;
    readonly timezone: string;
    readonly nextRunAt: Date | null;
  },
  currentTime: Date,
): Date | null {
  const pending = current.nextRunAt;
  const next = refreshed.nextRunAt;
  if (
    pending === null ||
    next === null ||
    current.timezone !== refreshed.timezone ||
    pending.getTime() <= currentTime.getTime() ||
    pending.getTime() >= next.getTime()
  ) {
    return next;
  }
  const skipped = calculateNextRun(
    refreshed.cronExpression,
    refreshed.timezone,
    current.lastRunAt ?? current.createdAt,
  );
  return skipped !== null && skipped.getTime() <= currentTime.getTime()
    ? pending
    : next;
}

/** Both the read and the conditional update must observe the same owner's active schedule. */
function ownedMorningBriefSchedule(owner: InstallationOwner) {
  const query = new QueryBuilder();
  const identities = officialWorkflowAutomationIdentities;
  return query
    .select({
      automationId: identities.automationId,
      definitionName: workflows.officialDefinitionName,
      timezone: orgMembersMetadata.timezone,
    })
    .from(workflows)
    .innerJoin(
      identities,
      and(
        eq(identities.workflowId, workflows.id),
        eq(identities.blueprintKey, MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY),
        eq(identities.state, "active"),
      ),
    )
    .innerJoin(
      orgMembersMetadata,
      and(
        eq(orgMembersMetadata.orgId, workflows.orgId),
        eq(orgMembersMetadata.userId, workflows.ownerUserId),
      ),
    )
    .where(
      and(
        eq(workflows.id, owner.workflowId),
        eq(workflows.orgId, owner.orgId),
        eq(workflows.ownerUserId, owner.userId),
        eq(workflows.officialInstallationState, "installed"),
        inArray(
          workflows.officialDefinitionName,
          MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES,
        ),
        notExists(
          query
            .select({ userId: morningBriefEnrollments.userId })
            .from(morningBriefEnrollments)
            .where(
              and(
                eq(morningBriefEnrollments.orgId, owner.orgId),
                eq(morningBriefEnrollments.userId, owner.userId),
                eq(morningBriefEnrollments.state, "departed"),
              ),
            ),
        ),
      ),
    )
    .as("owned_morning_brief_schedule");
}

export const repairMorningBriefSchedule$ = command(
  async ({ get, set }, owner: InstallationOwner, signal: AbortSignal) => {
    const schedule = ownedMorningBriefSchedule(owner);
    const [target] = await get(db$)
      .select({
        automation: workflowAutomationColumns(),
        definitionName: schedule.definitionName,
        timezone: schedule.timezone,
      })
      .from(workflowAutomations)
      .innerJoin(schedule, eq(schedule.automationId, workflowAutomations.id))
      .where(
        and(
          eq(
            workflowAutomations.officialBlueprintKey,
            MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
          ),
          eq(workflowAutomations.kind, "schedule"),
          eq(workflowAutomations.scheduleType, "cron"),
          inArray(workflowAutomations.officialReconciliationStatus, [
            "current",
            "needs_reconfiguration",
          ]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const builtin = builtInWorkflow(target?.definitionName ?? null);
    if (
      !target?.definitionName ||
      !builtin ||
      !target.timezone ||
      !isValidTimeZone(target.timezone)
    ) {
      return false;
    }
    const { automation, definitionName, timezone } = target;
    if (automation.officialIntendedEnabled === null) {
      return false;
    }
    const cronExpression = morningBriefCronExpression(owner);
    const bindings = [{ key: "cron", value: cronExpression }];
    // The failure recovery poller owns the next retry after three consecutive failures.
    const waitingForRetry =
      automation.officialIntendedEnabled &&
      !automation.enabled &&
      automation.consecutiveFailures >= 3;
    const enabled = automation.officialIntendedEnabled && !waitingForRetry;
    if (
      automation.officialReconciliationStatus === "current" &&
      automation.officialAppliedFingerprint === builtin.blueprint.fingerprint &&
      automation.cronExpression === cronExpression &&
      automation.timezone === timezone &&
      automation.enabled === enabled &&
      isDeepStrictEqual(automation.officialParameterBindings, bindings)
    ) {
      return true;
    }
    const updatedAt = nowDate();
    const nextRunAt = waitingForRetry
      ? automation.nextRunAt
      : enabled
        ? calculateNextRun(cronExpression, timezone, updatedAt)
        : null;
    const db = set(writeDb$);
    const [updated] = await db
      .update(workflowAutomations)
      .set({
        cronExpression,
        timezone,
        enabled,
        updatedAt,
        autonomyBudget: AUTONOMY_BUDGET_CEILING,
        officialAppliedFingerprint: builtin.blueprint.fingerprint,
        officialReconciliationStatus: "current",
        officialParameterBindings: bindings,
        nextRunAt: reconciledScheduleAnchor(
          automation,
          keepSkippedMorningBriefOccurrence(
            automation,
            { cronExpression, timezone, nextRunAt },
            updatedAt,
          ),
        ),
      })
      .where(
        and(
          observedWorkflowAutomationCondition(automation),
          exists(
            db
              .select({ id: schedule.automationId })
              .from(schedule)
              .where(
                and(
                  eq(schedule.automationId, automation.id),
                  eq(schedule.definitionName, definitionName),
                  eq(schedule.timezone, timezone),
                ),
              ),
          ),
        ),
      )
      .returning({ id: workflowAutomations.id });
    signal.throwIfAborted();
    return updated !== undefined;
  },
);
