import { and, eq } from "drizzle-orm";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { db$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { proactiveWorkflowKind } from "./proactive-workflow-definitions";
import { proactiveWorkflowOwnerEnabledSql } from "./proactive-workflow-owner";
import { computed, type Computed } from "ccstate";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import {
  agentStorageReadPlan,
  captureAgentStorageContext,
} from "./agent-storage-context.service";
import { OFFICIAL_WORKFLOW_AUTOMATION_ONLY_MESSAGE } from "./official-workflow-constants";
import { createOfficialWorkflowFacts } from "./official-workflow-context.signals";
import { createOfficialWorkflowObservation } from "./official-workflow-observation.service";
import { OfficialWorkflowRunAdmissionError } from "./official-workflow-run.service";
import type { createThreadAutomationContext } from "./thread-automation-context.service";
import type { ThreadAutomationTarget } from "./thread-context.signals";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";
import type { RunWorkflowRef } from "./workflow-data.service";
import { createWorkflowSkills } from "./workflow-skills.service";

function createProactiveTargetEligibility(
  bootstrap: AgentRunContextSignals,
  automationContext$: ReturnType<typeof createThreadAutomationContext>,
  automationTarget$: Computed<Promise<ThreadAutomationTarget | null>>,
) {
  return computed(async (get) => {
    const [context, target] = await Promise.all([
      get(automationContext$),
      get(automationTarget$),
    ]);
    if (!context || !target) {
      return;
    }
    const { automation, workflow } = target;
    const scope = bootstrap;
    const proactiveKind = proactiveWorkflowKind(
      workflow.officialDefinitionName,
    );
    const nightly =
      proactiveKind === "learning" || proactiveKind === "planning";
    if (proactiveKind !== null) {
      if (
        !isFeatureEnabled(
          FeatureSwitchKey.ProactiveAgent,
          await get(bootstrap.featureSwitches$),
        )
      ) {
        throw new OfficialWorkflowRunAdmissionError({
          message: "Proactive Agent is not enabled.",
        });
      }
      const [eligible] = await get(db$)
        .select({ id: orgMetadata.orgId })
        .from(orgMetadata)
        .where(
          and(
            eq(orgMetadata.orgId, scope.orgId),
            proactiveWorkflowOwnerEnabledSql(
              { orgId: scope.orgId, userId: scope.userId },
              scope.agentId,
              proactiveKind,
              context.eventType !== "manual",
            ),
          ),
        )
        .limit(1);
      if (
        !eligible ||
        (context.eventType !== "manual" && !automation.enabled)
      ) {
        throw new OfficialWorkflowRunAdmissionError({
          message: "Proactive workflow was paused before launch.",
        });
      }
      if (nightly && context.eventType !== "manual") {
        const cutoff = context.eventPayload?.["reviewCutoff"];
        const deadline =
          typeof cutoff === "string"
            ? Date.parse(cutoff) +
              (proactiveKind === "learning" ? 4 : 3) * 60 * 60_000
            : Number.NaN;
        if (!Number.isFinite(deadline) || nowDate().getTime() >= deadline) {
          throw new OfficialWorkflowRunAdmissionError({
            message: "Nightly review expired before launch.",
          });
        }
      }
    }
  });
}

function assertOfficialManualEvent(
  eventType: string | null,
  definitionName: string,
) {
  const kind = proactiveWorkflowKind(definitionName);
  if (eventType === "manual" && kind !== "learning" && kind !== "planning") {
    throw new OfficialWorkflowRunAdmissionError({
      message: OFFICIAL_WORKFLOW_AUTOMATION_ONLY_MESSAGE,
    });
  }
}

function createOfficialWorkflowTarget(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  automationContext$: ReturnType<typeof createThreadAutomationContext>,
  automationTarget$: Computed<Promise<ThreadAutomationTarget | null>>,
) {
  const proactiveEligibility$ = createProactiveTargetEligibility(
    bootstrap,
    automationContext$,
    automationTarget$,
  );
  return computed(async (get): Promise<RunWorkflowRef | undefined> => {
    const event = await get(pickedEvent$);
    if (event?.contextType !== "automation") {
      return undefined;
    }
    const [context, target] = await Promise.all([
      get(automationContext$),
      get(automationTarget$),
    ]);
    if (!context || !target) {
      return undefined;
    }
    const { automation, workflow } = target;
    if (workflow.officialDefinitionName === null) {
      if (automation.officialBlueprintKey !== null) {
        throw new OfficialWorkflowRunAdmissionError();
      }
      return undefined;
    }
    assertOfficialManualEvent(
      context.eventType,
      workflow.officialDefinitionName,
    );
    const scope = bootstrap;
    await get(proactiveEligibility$);
    if (
      event.eventType !== "input.automation" ||
      context.eventType === null ||
      automation.officialBlueprintKey === null ||
      automation.orgId !== scope.orgId ||
      automation.ownerUserId !== scope.userId ||
      workflow.orgId !== scope.orgId ||
      workflow.ownerUserId !== scope.userId ||
      workflow.agentId !== scope.agentId ||
      workflow.visibility !== "private" ||
      workflow.officialInstallationState !== "installed" ||
      context.workflowName !== workflow.name
    ) {
      throw new OfficialWorkflowRunAdmissionError();
    }
    return {
      workflowId: workflow.id,
      name: workflow.name,
      officialDefinitionName: workflow.officialDefinitionName,
    };
  });
}

/** Official eligibility belongs to the picked event, never the shared identity. */
export function createThreadWorkflowContext(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  automationContext$: ReturnType<typeof createThreadAutomationContext>,
  automationTarget$: Computed<Promise<ThreadAutomationTarget | null>>,
) {
  const officialTarget$ = createOfficialWorkflowTarget(
    bootstrap,
    pickedEvent$,
    automationContext$,
    automationTarget$,
  );
  const workflows$ = computed(async (get) => {
    const [ordinary, official] = await Promise.all([
      get(bootstrap.workflows$),
      get(officialTarget$),
    ]);
    // The exact official target outranks the ordinary Private/Public winner.
    return official
      ? [
          official,
          ...ordinary.filter((workflow) => {
            return workflow.name !== official.name;
          }),
        ]
      : ordinary;
  });
  // The global catalog is shared by every context of this bootstrap.
  const officialCatalog$ = computed((get) => {
    return get(bootstrap.officialCatalog$);
  });
  const officialWorkflows$ = createOfficialWorkflowFacts(
    workflows$,
    officialCatalog$,
  );
  const officialWorkflowObservation$ = createOfficialWorkflowObservation(
    workflows$,
    officialWorkflows$,
  );
  const workflowSkills$ = createWorkflowSkills(
    workflows$,
    officialWorkflowObservation$,
  );
  const storage$ = computed(async (get) => {
    const [ordinary, workflows, official] = await Promise.all([
      get(bootstrap.storage$),
      get(workflows$),
      get(officialWorkflows$),
    ]);
    if (!official) {
      return ordinary;
    }
    const plan = agentStorageReadPlan(
      bootstrap,
      await Promise.all([
        get(bootstrap.agent$),
        workflows,
        get(bootstrap.connectorSelection$),
        get(bootstrap.catalog$),
        official,
      ]),
    );
    return captureAgentStorageContext(plan, ordinary.index);
  });
  return {
    workflows$,
    officialWorkflows$,
    officialWorkflowObservation$,
    workflowSkills$,
    storage$,
  };
}

export type ThreadWorkflowContext = ReturnType<
  typeof createThreadWorkflowContext
>;
