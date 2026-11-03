import type { OfficialWorkflowDefinitionRevisionPayload } from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { synthesizeWorkflowSkillMd } from "./skill-document";

export const OFFICIAL_WORKFLOW_DEFINITION_MANIFEST_PATH =
  ".vm0/official-workflow-definition.json";

interface ArtifactFile {
  readonly path: string;
  readonly content: string;
}

/** Execution bytes exclude catalog/revision metadata and Blueprint definitions. */
export function officialWorkflowExecutionFiles(
  definition: Pick<
    OfficialWorkflowDefinitionRevisionPayload,
    "name" | "workflow"
  >,
): readonly ArtifactFile[] {
  return [
    {
      path: "SKILL.md",
      content: synthesizeWorkflowSkillMd({
        name: definition.name,
        description: definition.workflow.description,
        instruction: definition.workflow.instruction,
      }),
    },
    ...definition.workflow.files,
  ];
}
