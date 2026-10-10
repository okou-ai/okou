import { computed, type Computed } from "ccstate";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import {
  agentStorageCacheSnapshot,
  agentStorageReadPlan,
  captureAgentStorageContext,
} from "./agent-storage-context.service";
import { OFFICIAL_WORKFLOW_AUTOMATION_ONLY_MESSAGE } from "./official-workflow-constants";
import {
  createOfficialWorkflowCatalog,
  createOfficialWorkflowFacts,
} from "./official-workflow-context.signals";
import { createOfficialWorkflowObservation } from "./official-workflow-observation.service";
import { OfficialWorkflowRunAdmissionError } from "./official-workflow-run.service";
import type { createThreadAutomationContext } from "./thread-automation-context.service";
import type { ThreadAutomationTarget } from "./thread-context.signals";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";
import type { RunWorkflowRef } from "./workflow-data.service";
import { createWorkflowSkills } from "./workflow-skills.service";

/** Official eligibility belongs to the picked event, never the shared identity. */
export function createThreadWorkflowContext(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  automationContext$: ReturnType<typeof createThreadAutomationContext>,
  automationTarget$: Computed<Promise<ThreadAutomationTarget | null>>,
) {
  const officialTarget$ = computed(
    async (get): Promise<RunWorkflowRef | undefined> => {
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
      if (context.eventType === "manual") {
        throw new OfficialWorkflowRunAdmissionError({
          message: OFFICIAL_WORKFLOW_AUTOMATION_ONLY_MESSAGE,
        });
      }
      const scope = bootstrap;
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
    },
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
  const officialCatalog$ = createOfficialWorkflowCatalog();
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
  const storageCache$ = computed(async (get) => {
    return agentStorageCacheSnapshot(await get(storage$));
  });
  return {
    workflows$,
    officialWorkflows$,
    officialWorkflowObservation$,
    workflowSkills$,
    storage$,
    storageCache$,
  };
}

export type ThreadWorkflowContext = ReturnType<
  typeof createThreadWorkflowContext
>;
