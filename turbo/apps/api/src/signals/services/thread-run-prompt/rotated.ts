import { computed, type Computed } from "ccstate";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";

/** Preserve incomplete-round recovery independently of native continuation. */
export function createRotatedPrompt(
  incompleteContext$: Computed<Promise<string>>,
): Computed<Promise<RunPromptAndSkills>> {
  return computed(async (get) => {
    return {
      systemPromptVariables: {
        continuationContext: await get(incompleteContext$),
      },
      userPromptVariables: {},
      skillVolumes: [],
    };
  });
}
