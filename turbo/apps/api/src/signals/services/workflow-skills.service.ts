import { computed, type Computed } from "ccstate";
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { getCustomSkillStorageName } from "@okouai/core/storage-names";
import {
  OfficialWorkflowRunAdmissionError,
  type OfficialWorkflowObservation,
} from "./official-workflow-run.service";
import type { RunPromptAndSkills, SkillVolume } from "./run-prompt-and-skills";
import type { RunWorkflowRef } from "./workflow-data.service";

export function createWorkflowSkills(
  workflows$: Computed<Promise<readonly RunWorkflowRef[]>>,
  officialWorkflowObservation$: Computed<
    Promise<OfficialWorkflowObservation | undefined>
  >,
): Computed<Promise<RunPromptAndSkills>> {
  return computed(async (get): Promise<RunPromptAndSkills> => {
    const [workflows, official] = await Promise.all([
      get(workflows$),
      get(officialWorkflowObservation$),
    ]);
    const skillVolumes = workflows
      .filter((workflow) => {
        return !SEED_SKILLS.includes(workflow.name);
      })
      .map((workflow): SkillVolume => {
        if (workflow.officialDefinitionName === null) {
          return {
            // Storage is keyed by workflow identity; its skill mounts at the slug.
            name: getCustomSkillStorageName(workflow.workflowId),
            skillName: workflow.name,
            source: "workflow_skill",
          };
        }
        const definition = official?.definitions.find((candidate) => {
          return candidate.workflowId === workflow.workflowId;
        });
        if (!definition) {
          throw new OfficialWorkflowRunAdmissionError();
        }
        return {
          name: definition.artifact.storageName,
          version: definition.artifact.storageVersion,
          skillName: workflow.name,
          system: true,
          expectedStorageId: definition.artifact.storageId,
          source: "official_workflow",
        };
      });
    return {
      systemPromptVariables: {},
      userPromptVariables: {},
      skillVolumes,
    };
  });
}
