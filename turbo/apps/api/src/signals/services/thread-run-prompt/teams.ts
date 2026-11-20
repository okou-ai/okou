import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { computed, type Computed } from "ccstate";
import {
  teamsPromptFromContext,
  type TeamsThreadContext,
} from "../teams-queued-launch-context.service";
import type { RunPrompt } from "../run-prompt-and-skills";
import type { PickedThreadInputEvent } from "./types";

export function createTeamsThreadPrompt(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  context$: Computed<Promise<TeamsThreadContext>>,
  featureSwitches$: Computed<Promise<FeatureSwitchContext>>,
): Computed<Promise<RunPrompt | null>> {
  return computed(async (get) => {
    const pickedEvent = await get(pickedEvent$);
    if (pickedEvent?.contextType !== "teams") {
      return null;
    }
    const context = await get(context$);
    if (!context) {
      return null;
    }
    const material = teamsPromptFromContext(
      context,
      await get(featureSwitches$),
    );
    const identity: string[] = [];
    if (context.senderDisplayName) {
      identity.push(`Teams display name: ${context.senderDisplayName}`);
    }
    if (context.senderPrincipalName) {
      identity.push(
        `Teams user principal name: ${context.senderPrincipalName}`,
      );
    }
    if (context.senderUserId) {
      identity.push(`Teams user ID: ${context.senderUserId}`);
    }
    return {
      userPromptVariables: {
        message: material.prompt,
      },
      systemPromptVariables: {
        integrationContext: material.appendSystemPrompt,
        channelUserIdentity: identity.join("\n"),
      },
    };
  });
}
