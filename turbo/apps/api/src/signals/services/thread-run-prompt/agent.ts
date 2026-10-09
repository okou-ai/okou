import { computed, type Computed } from "ccstate";
import type { BootstrapAgent } from "../agent-data.service";
import { buildAgentIdentityPrompt } from "../agent-identity-prompt.service";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";

export function createAgentPrompt(
  agent$: Computed<
    Promise<Pick<
      BootstrapAgent,
      "id" | "defaultAgentId" | "displayName" | "description" | "sound"
    > | null>
  >,
): Computed<Promise<RunPromptAndSkills>> {
  return computed(async (get): Promise<RunPromptAndSkills> => {
    const agent = await get(agent$);
    return {
      systemPromptVariables: {
        agentIdentity: agent ? (buildAgentIdentityPrompt(agent) ?? "") : "",
      },
      userPromptVariables: {},
      skillVolumes: [],
    };
  });
}
