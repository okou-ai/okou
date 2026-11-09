import { computed, type Computed } from "ccstate";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
import {
  EMAIL_SYSTEM_PROMPT,
  type createEmailThreadContext,
} from "../email-queued-launch-context.service";

export function createEmailThreadPrompt(
  context$: ReturnType<typeof createEmailThreadContext>,
): Computed<Promise<RunPromptAndSkills | null>> {
  return computed(async (get) => {
    const context = await get(context$);
    return context
      ? {
          userPromptVariables: { message: context.messageText },
          systemPromptVariables: { integrationContext: EMAIL_SYSTEM_PROMPT },
          skillVolumes: [],
        }
      : null;
  });
}
