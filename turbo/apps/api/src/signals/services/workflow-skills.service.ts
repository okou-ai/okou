import { computed, type Computed } from "ccstate";
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import type { OfficialWorkflowContextFacts } from "./official-workflow-context.signals";
import {
  acceptedWorkflowCandidates,
  assembleWorkflowObservation,
  OfficialWorkflowRunAdmissionError,
  type OfficialWorkflowCandidate,
  type OfficialWorkflowObservation,
} from "./official-workflow-run.service";
import type { RunWorkflowRef } from "./workflow-data.service";

/** Identity-scoped workflow selection and exact official artifacts, without mounts. */
export interface WorkflowSkills {
  readonly workflows: readonly RunWorkflowRef[];
  readonly official: OfficialWorkflowObservation | undefined;
}

export function createWorkflowSkills(
  workflows$: Computed<Promise<readonly RunWorkflowRef[]>>,
  officialWorkflows$: Computed<Promise<OfficialWorkflowContextFacts>>,
): Computed<Promise<WorkflowSkills>> {
  return computed(async (get): Promise<WorkflowSkills> => {
    const selected = await get(workflows$);
    for (const workflow of selected) {
      if (
        workflow.officialDefinitionName !== null &&
        SEED_SKILLS.includes(workflow.name)
      ) {
        throw new OfficialWorkflowRunAdmissionError();
      }
    }
    const workflows = selected.filter((workflow) => {
      return !SEED_SKILLS.includes(workflow.name);
    });
    const candidates = workflows.flatMap(
      (workflow): readonly OfficialWorkflowCandidate[] => {
        return workflow.officialDefinitionName === null
          ? []
          : [
              {
                workflowId: workflow.workflowId,
                workflowName: workflow.name,
                definitionName: workflow.officialDefinitionName,
              },
            ];
      },
    );
    if (candidates.length === 0) {
      return { workflows, official: undefined };
    }
    const facts = await get(officialWorkflows$);
    if (!facts) {
      throw new OfficialWorkflowRunAdmissionError();
    }
    const accepted = acceptedWorkflowCandidates(facts.catalog, candidates);
    const revisions = accepted.map(({ accepted: definition }) => {
      return (
        facts.revisions.get(
          JSON.stringify([definition.name, definition.revision]),
        ) ?? null
      );
    });
    return {
      workflows,
      official: assembleWorkflowObservation(facts.catalog, accepted, revisions),
    };
  });
}

/** A run's source claim is checked against the same captured workflow selection. */
export function assertRequiredOfficialWorkflows(
  skills: WorkflowSkills,
  requiredWorkflowIds: readonly string[],
): void {
  const workflowIds = new Set(
    skills.official?.definitions.map((definition) => {
      return definition.workflowId;
    }),
  );
  if (
    new Set(requiredWorkflowIds).size !== requiredWorkflowIds.length ||
    requiredWorkflowIds.some((workflowId) => {
      return !workflowIds.has(workflowId);
    })
  ) {
    throw new OfficialWorkflowRunAdmissionError();
  }
}
