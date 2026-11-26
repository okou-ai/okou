import { legacyProactiveClaimAllowed } from "./proactive-dispatch-ownership.service";
import { automationWorkflowJoinCondition } from "./workflow-visibility";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, asc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { BUILTIN_WORKFLOWS } from "./builtin-workflows";
import { proactiveWorkflowOwnerEnabledSql } from "./proactive-workflow-owner";
import { proactiveWorkflowKind } from "./proactive-workflow-definitions";
import { advanceTimeAutomationAfterCompletion } from "./time-automation";
import { workflowAutomationCanFire$ } from "./workflow-automation-access.service";
import {
  observedWorkflowAutomationCondition,
  type WorkflowAutomationSnapshot,
} from "./workflow-automation-snapshot";

const log = logger("OfficialWorkflowScheduleRecovery");
type RecoveryCandidate = {
  readonly automation: typeof workflowAutomations.$inferSelect &
    WorkflowAutomationSnapshot;
  readonly definitionName: string | null;
};

const recoverOfficialSchedule$ = command(
  async ({ set }, candidate: RecoveryCandidate, signal: AbortSignal) => {
    const { automation, definitionName } = candidate;
    const fireable = await set(
      workflowAutomationCanFire$,
      {
        automation: { ...automation, enabled: true },
      },
      signal,
    );
    const at = nowDate();
    const resume = fireable && automation.nextRunAt !== null;
    const proactiveKind = proactiveWorkflowKind(definitionName);
    if (
      automation.scheduleType !== "cron" &&
      automation.scheduleType !== "loop"
    ) {
      return;
    }
    const nextRunAt = resume
      ? automation.nextRunAt
      : advanceTimeAutomationAfterCompletion({
          scheduleType: automation.scheduleType,
          cronExpression: automation.cronExpression,
          intervalSeconds: automation.intervalSeconds,
          timezone: automation.timezone,
          completedAt: at,
          shouldDisable: false,
        });
    const [updated] = await set(writeDb$)
      .update(workflowAutomations)
      .set({ enabled: resume, nextRunAt, updatedAt: at })
      .where(
        and(
          observedWorkflowAutomationCondition(automation),
          eq(workflowAutomations.enabled, false),
          eq(workflowAutomations.officialIntendedEnabled, true),
          resume && proactiveKind !== null
            ? proactiveWorkflowOwnerEnabledSql({
                orgId: automation.orgId,
                userId: automation.ownerUserId,
              })
            : undefined,
        ),
      )
      .returning({ id: workflowAutomations.id });
    signal.throwIfAborted();
    if (updated) {
      log.warn(
        resume
          ? "Resuming paused Official Workflow schedule"
          : "Official Workflow recovery scheduled for its next period",
        {
          automationId: updated.id,
          workflowId: automation.workflowId,
          consecutiveFailures: automation.consecutiveFailures,
          nextRunAt: nextRunAt?.toISOString() ?? null,
        },
      );
    }
  },
);

/** Runtime recovery runs every cron tick, independently of catalog publication. */
export const recoverDueOfficialWorkflowSchedules$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const acceptedBlueprints = or(
      ...BUILTIN_WORKFLOWS.map((builtin) => {
        return and(
          eq(workflows.officialDefinitionName, builtin.name),
          eq(workflowAutomations.officialBlueprintKey, builtin.blueprintKey),
          eq(
            workflowAutomations.officialAppliedFingerprint,
            builtin.fingerprint,
          ),
        );
      }),
    );
    const candidates = await get(db$)
      .select({
        automation: workflowAutomationColumns(),
        definitionName: workflows.officialDefinitionName,
      })
      .from(workflowAutomations)
      .innerJoin(workflows, automationWorkflowJoinCondition())
      .where(
        and(
          eq(workflowAutomations.enabled, false),
          eq(workflowAutomations.officialIntendedEnabled, true),
          eq(workflowAutomations.officialReconciliationStatus, "current"),
          eq(workflowAutomations.kind, "schedule"),
          gte(workflowAutomations.consecutiveFailures, 3),
          legacyProactiveClaimAllowed(),
          acceptedBlueprints,
          or(
            lte(workflowAutomations.nextRunAt, nowDate()),
            isNull(workflowAutomations.nextRunAt),
          ),
        ),
      )
      .orderBy(asc(workflowAutomations.nextRunAt), asc(workflowAutomations.id))
      .limit(100);
    signal.throwIfAborted();
    for (const candidate of candidates) {
      const result = await settle(
        set(recoverOfficialSchedule$, candidate, signal),
        signal,
      );
      if (!result.ok) {
        log.error("Official Workflow schedule recovery failed", {
          automationId: candidate.automation.id,
          error: result.error,
        });
      }
    }
  },
);
