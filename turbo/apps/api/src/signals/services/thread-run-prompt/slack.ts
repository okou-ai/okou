import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { computed, type Computed } from "ccstate";
import {
  buildSlackSystemPrompt,
  canonicalSlackAgentPrompt,
  resolveUserMentions,
} from "../../../lib/slack-webhook-context";
import { resolveIntegrationNotePrompt } from "../integration-note-prompt.service";
import type { SlackThreadContext } from "../thread-run-context.service";
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
    const messagePrompt = resolveUserMentions(
      context.messageText,
      new Map(
        Object.entries(context.mentionDisplayNames).map(([id, name]) => {
          return [id, { id, name }] as const;
        }),
      ),
    );
    const identity: string[] = [];
    if (context.senderDisplayName) {
      identity.push(`Slack display name: ${context.senderDisplayName}`);
    }
    if (context.senderUserId) {
      identity.push(`Slack user ID: ${context.senderUserId}`);
    }
    return {
      userPromptVariables: {
        message: canonicalSlackAgentPrompt(
          messagePrompt,
          context.messageFiles,
          context.messageAssets,
        ),
      },
      systemPromptVariables: {
        integrationContext: buildSlackSystemPrompt({
          botUserId: context.botUserId,
          channelId: context.channelId,
          channelType: context.channelType,
          threadTs: context.threadTs,
          integrationNote: resolveIntegrationNotePrompt({
            triggerSource: "slack",
            featureSwitchContext: await get(featureSwitches$),
          }),
          executionContext: context.conversationContext,
        }),
        channelUserIdentity: identity.join("\n"),
      },
      skillVolumes: [],
    };
  });
}
