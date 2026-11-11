import { computed, type Computed } from "ccstate";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import type { createEmailThreadContext } from "../email-queued-launch-context.service";
import { buildEmailPrompt, type EmailMailboxConnection } from "../email-prompt";
import { resolveIntegrationNotePrompt } from "../integration-note-prompt.service";

export function createEmailThreadPrompt(
  context$: ReturnType<typeof createEmailThreadContext>,
  featureSwitches$: Computed<Promise<FeatureSwitchContext>>,
  mailboxes$: Computed<Promise<readonly EmailMailboxConnection[]>>,
): Computed<Promise<RunPromptAndSkills | null>> {
  return computed(async (get) => {
    const context = await get(context$);
    const mailboxes = context ? await get(mailboxes$) : [];
    return context
      ? {
          userPromptVariables: { message: context.messageText },
          systemPromptVariables: {
            integrationContext: buildEmailPrompt(
              context,
              resolveIntegrationNotePrompt({
                triggerSource: "email",
                featureSwitchContext: await get(featureSwitches$),
                emailHasConnectedMailbox: mailboxes.length > 0,
              }),
              mailboxes,
            ),
            channelUserIdentity: `Email sender: ${context.emailAddress}`,
          },
          skillVolumes: [],
        }
      : null;
  });
}
