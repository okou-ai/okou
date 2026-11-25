import { BUILT_IN_SKILLS } from "@okouai/core/built-in-skills";
import { computed, type Computed } from "ccstate";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import { OFFICIAL_WORKFLOW_AUTOMATION_ONLY_MESSAGE } from "./official-workflow-constants";
import {
  OfficialWorkflowRunAdmissionError,
  type OfficialWorkflowObservation,
} from "./official-workflow-run.service";
import {
  isRetiredProactiveWorkflow,
  proactiveWorkflowKind,
} from "./proactive-workflow-definitions";
import type {
  createThreadAutomationSnapshot,
  ThreadAutomationTarget,
} from "./thread-automation-context.service";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";
import { builtInWorkflow } from "./builtin-workflows";

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
    workflow.visibility !== "private" ||
    automationContext.workflowName !== workflow.name
  ) {
    throw new OfficialWorkflowRunAdmissionError();
  }
  if (BUILT_IN_SKILLS.includes(workflow.name)) {
    throw new OfficialWorkflowRunAdmissionError();
  }
  const builtin = builtInWorkflow(name);
  if (
    !builtin ||
    automation.officialReconciliationStatus !== "current" ||
    builtin.blueprintKey !== automation.officialBlueprintKey ||
    builtin.fingerprint !== automation.officialAppliedFingerprint
  ) {
    throw new OfficialWorkflowRunAdmissionError();
  }
  const { name: definitionName, revision, contentBundle } = builtin;
  const source = { name: definitionName, revision, contentBundle };
  return {
    prompt: builtin.prompt,
    definitions: [{ workflowId: workflow.id, ...source }],
    provenance: { schemaVersion: 2, definitions: [source] },
  };
}

export function createThreadWorkflowContext(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  automationSnapshot$: ReturnType<typeof createThreadAutomationSnapshot>,
) {
  const officialWorkflowObservation$ = computed(
    async (get): Promise<OfficialWorkflowObservation | undefined> => {
      const event = await get(pickedEvent$);
      if (event?.contextType !== "automation") {
        return undefined;
      }
      const snapshot = await get(automationSnapshot$);
      if (!snapshot?.target) {
        return undefined;
      }
      const { event: context, target } = snapshot;
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
        const preferences = target.proactivePreferences;
        const enabled = preferences?.suggestionsEnabled;
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
