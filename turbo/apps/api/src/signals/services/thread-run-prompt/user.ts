import { computed, type Computed } from "ccstate";
import type { ExecutionMemberMetadata } from "../execution-member-metadata.service";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";

export function createUserPrompt(
  memberMetadata$: Computed<Promise<ExecutionMemberMetadata>>,
): Computed<Promise<RunPromptAndSkills>> {
  return computed(async (get): Promise<RunPromptAndSkills> => {
    const member = await get(memberMetadata$);
    const lines = ["# Current User Info"];
    if (member.profile?.name) {
      lines.push(`Name: ${member.profile.name}`);
    }
    if (member.profile?.email) {
      lines.push(`Email: ${member.profile.email}`);
    }
    lines.push(`Timezone: ${member.preferences?.timezone ?? "UTC"}`);
    return {
      systemPromptVariables: { userIdentity: lines.join("\n") },
      userPromptVariables: {},
      skillVolumes: [],
    };
  });
}
