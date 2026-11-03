import { SEED_SKILLS } from "@okouai/core/seed-skills";

export interface SelectedAgentWorkflow {
  readonly workflowId: string;
  readonly name: string;
  readonly officialDefinitionName: string | null;
}

/** The explicit `/name` invocation; seed skills are never captured. */
export function invokedWorkflowName(prompt: string): string | null {
  const name = /^\/([a-z0-9][a-z0-9-]{0,62}[a-z0-9])(?:\s|$)/u.exec(
    prompt.trim(),
  )?.[1];
  return name === undefined || SEED_SKILLS.includes(name) ? null : name;
}

/**
 * Capture only explicit invocation identity; available-skill discovery stays
 * live. `workflows` holds the Agent's ordinary Private/Public winner per name.
 */
export function findInvokedWorkflowId(
  workflows: readonly SelectedAgentWorkflow[],
  name: string,
): string | null {
  return (
    workflows.find((workflow) => {
      return workflow.name === name && workflow.officialDefinitionName === null;
    })?.workflowId ?? null
  );
}
