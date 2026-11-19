import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { computed, type Computed } from "ccstate";
import {
  agentphoneSystemPromptFromContext,
  type AgentPhoneThreadContext,
} from "../agentphone-queued-launch-context.service";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
import type { PickedThreadInputEvent } from "./types";

export function createAgentPhoneThreadPrompt(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  context$: Computed<Promise<AgentPhoneThreadContext>>,
  featureSwitches$: Computed<Promise<FeatureSwitchContext>>,
): Computed<Promise<RunPromptAndSkills | null>> {
  return computed(async (get) => {
    const pickedEvent = await get(pickedEvent$);
    if (pickedEvent?.contextType !== "agentphone") {
      return null;
    }
    const context = await get(context$);
    if (!context) {
      return null;
    }
    const integrationContext = agentphoneSystemPromptFromContext(
      context,
      await get(featureSwitches$),
    );
    return {
      userPromptVariables: { message: context.messageText },
      systemPromptVariables: {
        integrationContext,
        channelUserIdentity: context.phoneHandle
          ? `Text message handle: ${context.phoneHandle}`
          : "",
      },
      skillVolumes: [],
    };
  });
}
