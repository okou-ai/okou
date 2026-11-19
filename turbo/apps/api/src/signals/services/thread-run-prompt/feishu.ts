import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { computed, type Computed } from "ccstate";
import { FEISHU_PLATFORMS } from "@okouai/core/feishu-platform";
import {
  feishuPromptFromContext,
  type FeishuThreadContext,
} from "../feishu-queued-launch-context.service";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
import type { PickedThreadInputEvent } from "./types";

export function createFeishuThreadPrompt(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  context$: Computed<Promise<FeishuThreadContext>>,
  featureSwitches$: Computed<Promise<FeatureSwitchContext>>,
): Computed<Promise<RunPromptAndSkills | null>> {
  return computed(async (get) => {
    const pickedEvent = await get(pickedEvent$);
    if (pickedEvent?.contextType !== "feishu") {
      return null;
    }
    const context = await get(context$);
    if (!context) {
      return null;
    }
    const providerName = FEISHU_PLATFORMS[context.platform].name;
    const identity: string[] = [];
    if (context.feishuDisplayName) {
      identity.push(
        `${providerName} display name: ${context.feishuDisplayName}`,
      );
    }
    if (context.senderOpenId) {
      identity.push(`${providerName} open ID: ${context.senderOpenId}`);
    }
    const { prompt, appendSystemPrompt } = feishuPromptFromContext(
      context,
      await get(featureSwitches$),
    );
    return {
      userPromptVariables: { message: prompt },
      systemPromptVariables: {
        integrationContext: appendSystemPrompt,
        channelUserIdentity: identity.join("\n"),
      },
      skillVolumes: [],
    };
  });
}
