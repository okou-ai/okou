import { computed, type Computed } from "ccstate";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
import { createIncompletePrompt } from "./incomplete";
import type { PickedThreadInputEvent } from "./types";

/** Preserve incomplete-round recovery independently of native continuation. */
export function createRotatedPrompt(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
): Computed<Promise<RunPromptAndSkills>> {
  const incomplete$ = createIncompletePrompt(pickedEvent$);
  return computed(async (get) => {
    return {
      systemPromptVariables: { continuationContext: await get(incomplete$) },
      userPromptVariables: {},
      skillVolumes: [],
    };
  });
}
