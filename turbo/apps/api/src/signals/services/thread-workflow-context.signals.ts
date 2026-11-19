import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { BUILT_IN_SKILLS } from "@okouai/core/built-in-skills";
import { computed, type Computed } from "ccstate";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import {
  acceptedCatalogFromRow,
  acceptedRevisionFromRow,
} from "./official-workflow-catalog-read.service";
import { OFFICIAL_WORKFLOW_AUTOMATION_ONLY_MESSAGE } from "./official-workflow-constants";
import {
  acceptedDefinitionForName,
  assembleWorkflowObservation,
  OfficialWorkflowRunAdmissionError,
  type OfficialWorkflowObservation,
} from "./official-workflow-run.service";
import {
  isRetiredProactiveWorkflow,
  proactiveWorkflowKind,
} from "./proactive-workflow-definitions";
import type { createThreadAutomationContext } from "./thread-automation-context.service";
import type { ThreadAutomationTarget } from "./thread-context.signals";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

function assertOfficialManualEvent(
  eventType: string | null,
  definitionName: string,
) {
  const kind = proactiveWorkflowKind(definitionName);
  if (eventType === "manual" && kind !== "learning") {
    throw new OfficialWorkflowRunAdmissionError({
      message: OFFICIAL_WORKFLOW_AUTOMATION_ONLY_MESSAGE,
    });
  }
}

function officialObservationFromTarget(
  target: ThreadAutomationTarget,
  name: string,
  scope: AgentRunContextSignals,
  eventType: string,
  automationContext: {
    readonly eventType: string | null;
    readonly workflowName: string | null;
  },
): OfficialWorkflowObservation {
  const { automation, workflow } = target;
  if (
    eventType !== "input.automation" ||
    automationContext.eventType === null ||
    automation.officialBlueprintKey === null ||
    automation.orgId !== scope.orgId ||
    automation.ownerUserId !== scope.userId ||
    workflow.orgId !== scope.orgId ||
    workflow.ownerUserId !== scope.userId ||
    workflow.agentId !== scope.agentId ||
    workflow.visibility !== "private" ||
    workflow.officialInstallationState !== "installed" ||
    automationContext.workflowName !== workflow.name
  ) {
    throw new OfficialWorkflowRunAdmissionError();
  }
  if (BUILT_IN_SKILLS.includes(workflow.name)) {
    throw new OfficialWorkflowRunAdmissionError();
  }
  const catalog = acceptedCatalogFromRow(target.officialCatalog ?? undefined);
  const definition =
    catalog && acceptedDefinitionForName(catalog.payload.definitions, name);
  if (
    !definition ||
    !target.officialRevision ||
    automation.officialReconciliationStatus !== "current" ||
    !definition.blueprints.some((blueprint) => {
      return (
        blueprint.key === automation.officialBlueprintKey &&
        blueprint.fingerprint === automation.officialAppliedFingerprint
      );
    })
  ) {
    throw new OfficialWorkflowRunAdmissionError();
  }
  return assembleWorkflowObservation(
    workflow.id,
    definition,
    acceptedRevisionFromRow(target.officialRevision),
  );
}

export function createThreadWorkflowContext(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  automationContext$: ReturnType<typeof createThreadAutomationContext>,
  automationTarget$: Computed<Promise<ThreadAutomationTarget | null>>,
) {
  const officialWorkflowObservation$ = computed(
    async (get): Promise<OfficialWorkflowObservation | undefined> => {
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
      const name = workflow.officialDefinitionName;
      if (isRetiredProactiveWorkflow(name)) {
        throw new OfficialWorkflowRunAdmissionError({
          message: "This proactive workflow has been retired.",
        });
      }
      const kind = proactiveWorkflowKind(name);
      if (kind !== null) {
        if (
          !isFeatureEnabled(
            kind === "suggestions"
              ? FeatureSwitchKey.AgentSuggestion
              : FeatureSwitchKey.ProactiveLearning,
            await get(bootstrap.featureSwitches$),
          )
        ) {
          throw new OfficialWorkflowRunAdmissionError({
            message: "Proactive workflow is not enabled.",
          });
        }
        const preferences = target.proactivePreferences;
        const enabled =
          kind === "suggestions"
            ? preferences?.suggestionsEnabled
            : preferences?.learningEnabled;
        if (
          !preferences ||
          (context.eventType !== "manual" && (!automation.enabled || !enabled))
        ) {
          throw new OfficialWorkflowRunAdmissionError({
            message: "Proactive workflow was paused before launch.",
          });
        }
      }
      return officialObservationFromTarget(
        target,
        name,
        bootstrap,
        event.eventType,
        context,
      );
    },
  );
  return { officialWorkflowObservation$ };
}

export type ThreadWorkflowContext = ReturnType<
  typeof createThreadWorkflowContext
>;
