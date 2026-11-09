import { computed, type Computed } from "ccstate";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import type { createEmailThreadContext } from "../email-queued-launch-context.service";
import { buildEmailPrompt } from "../email-prompt";
import { resolveIntegrationNotePrompt } from "../integration-note-prompt.service";

export function createEmailThreadPrompt(
  context$: ReturnType<typeof createEmailThreadContext>,
  featureSwitches$: Computed<Promise<FeatureSwitchContext>>,
): Computed<Promise<RunPromptAndSkills | null>> {
  return computed(async (get) => {
    const context = await get(context$);
    return context
      ? {
          userPromptVariables: { message: context.messageText },
          systemPromptVariables: {
            integrationContext: buildEmailPrompt(
              context,
              resolveIntegrationNotePrompt({
                triggerSource: "email",
                featureSwitchContext: await get(featureSwitches$),
              }),
            ),
            channelUserIdentity: `Email sender: ${context.emailAddress}`,
          },
          skillVolumes: [],
        }
      : null;
  });
}
