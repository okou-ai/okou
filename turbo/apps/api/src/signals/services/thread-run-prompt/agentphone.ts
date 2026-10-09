import { computed, type Computed } from "ccstate";
import { optionalEnv } from "../../../lib/env";
import { buildAgentPhonePrompt } from "../agentphone-prompt";
import { resolveIntegrationNotePrompt } from "../integration-note-prompt.service";
import type { AgentPhoneThreadContext } from "../thread-run-context.service";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
import type { ThreadPromptSource } from "./types";

export function createAgentPhoneThreadPrompt(
  source$: Computed<Promise<ThreadPromptSource | null>>,
  context$: Computed<Promise<AgentPhoneThreadContext>>,
): Computed<Promise<RunPromptAndSkills | null>> {
  return computed(async (get) => {
    const source = await get(source$);
    if (source?.event.contextType !== "agentphone") {
      return null;
    }
    const context = await get(context$);
    if (!context) {
      return null;
    }
    return {
      userPromptVariables: { message: context.messageText },
      systemPromptVariables: {
        integrationContext: buildAgentPhonePrompt(
          {
            sharedNumber: optionalEnv("AGENTPHONE_PHONE_NUMBER") ?? "",
            phoneHandle: context.phoneHandle,
            conversationId: context.conversationId,
            channel: context.channel,
            isGroup: context.isGroup,
            messageId: context.messageId,
            agentphoneAgentId: context.agentphoneAgentId,
          },
          resolveIntegrationNotePrompt({
            triggerSource: "agentphone",
            featureSwitchContext: source.featureSwitchContext,
          }),
          context.threadContext,
        ),
        channelUserIdentity: context.phoneHandle
          ? `Text message handle: ${context.phoneHandle}`
          : "",
      },
      skillVolumes: [],
    };
  });
}
