import { computed, type Computed } from "ccstate";
import {
  buildSlackSystemPrompt,
  canonicalSlackAgentPrompt,
  resolveUserMentions,
} from "../../../lib/slack-webhook-context";
import { resolveIntegrationNotePrompt } from "../integration-note-prompt.service";
import type { SlackThreadContext } from "../thread-run-context.service";
import type { IntegrationPromptVariables, ThreadPromptSource } from "./types";

export function createSlackThreadPrompt(
  source$: Computed<Promise<ThreadPromptSource | null>>,
  context$: Computed<Promise<SlackThreadContext>>,
): Computed<Promise<IntegrationPromptVariables | null>> {
  return computed(async (get) => {
    const source = await get(source$);
    if (source?.event.contextType !== "slack") {
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
            featureSwitchContext: source.featureSwitchContext,
          }),
          executionContext: context.conversationContext,
        }),
        channelUserIdentity: identity.join("\n"),
      },
    };
  });
}
