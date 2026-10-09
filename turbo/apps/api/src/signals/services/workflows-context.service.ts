import { computed, type Computed } from "ccstate";
import { getCustomSkillStorageName } from "@okouai/core/storage-names";
import { OfficialWorkflowRunAdmissionError } from "./official-workflow-run.service";
import type { RunPromptAndSkills, SkillVolume } from "./run-prompt-and-skills";
import type { WorkflowSkills } from "./workflow-skills.service";

export function createWorkflowsContext(
  workflowSkills$: Computed<Promise<WorkflowSkills>>,
): Computed<Promise<RunPromptAndSkills>> {
  return computed(async (get): Promise<RunPromptAndSkills> => {
    const skills = await get(workflowSkills$);
    const skillVolumes = skills.workflows.map((workflow): SkillVolume => {
      if (workflow.officialDefinitionName === null) {
        return {
          // Storage is keyed by workflow identity; its skill mounts at the slug.
          name: getCustomSkillStorageName(workflow.workflowId),
          skillName: workflow.name,
          source: "workflow_skill",
        };
      }
      const definition = skills.official?.definitions.find((candidate) => {
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
