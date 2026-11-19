import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { computed, type Computed } from "ccstate";
import {
  slackPromptFromContext,
  type SlackThreadContext,
} from "../slack-queued-launch-context.service";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
import type { PickedThreadInputEvent } from "./types";

export function createSlackThreadPrompt(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  context$: Computed<Promise<SlackThreadContext>>,
  featureSwitches$: Computed<Promise<FeatureSwitchContext>>,
): Computed<Promise<RunPromptAndSkills | null>> {
  return computed(async (get) => {
    const pickedEvent = await get(pickedEvent$);
    if (pickedEvent?.contextType !== "slack") {
      return null;
    }
    const context = await get(context$);
    if (!context) {
      return null;
    }
    const material = slackPromptFromContext({
      context,
      featureSwitchContext: await get(featureSwitches$),
    });
    const identity: string[] = [];
    if (context.senderDisplayName) {
      identity.push(`Slack display name: ${context.senderDisplayName}`);
    }
    if (context.senderUserId) {
      identity.push(`Slack user ID: ${context.senderUserId}`);
    }
    return {
      userPromptVariables: {
        message: material.prompt,
      },
      systemPromptVariables: {
        integrationContext: material.appendSystemPrompt,
        channelUserIdentity: identity.join("\n"),
      },
      skillVolumes: [],
    };
  });
}
