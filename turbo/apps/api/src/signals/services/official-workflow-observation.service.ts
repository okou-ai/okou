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

export function createOfficialWorkflowObservation(
  officialTarget$: Computed<Promise<OfficialWorkflowCandidate | undefined>>,
  officialWorkflows$: Computed<Promise<OfficialWorkflowContextFacts>>,
): Computed<Promise<OfficialWorkflowObservation | undefined>> {
  return computed(
    async (get): Promise<OfficialWorkflowObservation | undefined> => {
      const target = await get(officialTarget$);
      if (!target) {
        return undefined;
      }
      if (SEED_SKILLS.includes(target.workflowName)) {
        throw new OfficialWorkflowRunAdmissionError();
      }
      const facts = await get(officialWorkflows$);
      if (!facts) {
        throw new OfficialWorkflowRunAdmissionError();
      }
      const accepted = acceptedWorkflowCandidates(facts.catalog, [target]);
      const revisions = accepted.map(({ accepted: definition }) => {
        return (
          facts.revisions.get(
            JSON.stringify([definition.name, definition.revision]),
          ) ?? null
        );
      });
      return assembleWorkflowObservation(facts.catalog, accepted, revisions);
    },
  );
}

/** A run's source claim is checked against the same captured workflow selection. */
export function assertRequiredOfficialWorkflows(
  observation: OfficialWorkflowObservation | undefined,
  requiredWorkflowIds: readonly string[],
): void {
  const workflowIds = new Set(
    observation?.definitions.map((definition) => {
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
