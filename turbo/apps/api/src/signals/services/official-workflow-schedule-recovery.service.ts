import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { officialWorkflowCatalogState } from "@okouai/db/schema/official-workflow-catalog";
import { workflows } from "@okouai/db/schema/workflow";
import { PROACTIVE_SUGGESTIONS_DEFINITION_NAME } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { command } from "ccstate";
import { and, asc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import {
  readAcceptedOfficialWorkflowCatalog$,
  type AcceptedOfficialWorkflowCatalog,
} from "./official-workflow-catalog-read.service";
import { acceptedDefinitionForName } from "./official-workflow-run.service";
import { proactiveSuggestionsOwnerEnabledSql } from "./proactive-suggestions-lifecycle.service";
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
  readonly agentId: string;
};

const recoverOfficialSchedule$ = command(
  async (
    { set },
    candidate: RecoveryCandidate,
    catalog: AcceptedOfficialWorkflowCatalog,
    signal: AbortSignal,
  ) => {
    const { automation, definitionName, agentId } = candidate;
    const definition =
      definitionName === null
        ? null
        : acceptedDefinitionForName(
            catalog.payload.definitions,
            definitionName,
          );
    if (
      definition?.lifecycle !== "active" ||
      !definition.blueprints.some((blueprint) => {
        return (
          blueprint.key === automation.officialBlueprintKey &&
          blueprint.fingerprint === automation.officialAppliedFingerprint
        );
      })
    ) {
      return;
    }
    const fireable = await set(
      workflowAutomationCanFire$,
      {
        automation: { ...automation, enabled: true },
        agentId,
      },
      signal,
    );
    const at = nowDate();
    const resume = fireable && automation.nextRunAt !== null;
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
      .from(officialWorkflowCatalogState)
      .where(
        and(
          observedWorkflowAutomationCondition(automation),
          eq(workflowAutomations.enabled, false),
          eq(workflowAutomations.officialIntendedEnabled, true),
          // A catalog retirement or replacement wins over this recovery attempt.
          eq(officialWorkflowCatalogState.acceptedReleaseId, catalog.releaseId),
          resume && definitionName === PROACTIVE_SUGGESTIONS_DEFINITION_NAME
            ? proactiveSuggestionsOwnerEnabledSql(
                { orgId: automation.orgId, userId: automation.ownerUserId },
                agentId,
              )
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
    const catalog = await set(readAcceptedOfficialWorkflowCatalog$, signal);
    if (catalog === null) {
      return;
    }
    // Retired or outdated rows must not occupy the bounded recovery batch.
    const acceptedBlueprints = or(
      ...catalog.payload.definitions.flatMap((definition) => {
        return definition.lifecycle === "active"
          ? definition.blueprints.map((blueprint) => {
              return and(
                eq(workflows.officialDefinitionName, definition.name),
                eq(workflowAutomations.officialBlueprintKey, blueprint.key),
                eq(
                  workflowAutomations.officialAppliedFingerprint,
                  blueprint.fingerprint,
                ),
              );
            })
          : [];
      }),
    );
    if (acceptedBlueprints === undefined) {
      return;
    }
    const candidates = await get(db$)
      .select({
        automation: workflowAutomationColumns(),
        definitionName: workflows.officialDefinitionName,
        agentId: workflows.agentId,
      })
      .from(workflowAutomations)
      .innerJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
      .where(
        and(
          eq(workflowAutomations.enabled, false),
          eq(workflowAutomations.officialIntendedEnabled, true),
          eq(workflowAutomations.officialReconciliationStatus, "current"),
          eq(workflowAutomations.kind, "schedule"),
          gte(workflowAutomations.consecutiveFailures, 3),
          eq(workflows.officialInstallationState, "installed"),
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
        set(recoverOfficialSchedule$, candidate, catalog, signal),
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
