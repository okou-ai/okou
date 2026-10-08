import { computed, type Computed } from "ccstate";
import { FEISHU_PLATFORMS } from "@okouai/core/feishu-platform";
import { buildFeishuSystemPrompt } from "../feishu-dispatch.service";
import { resolveIntegrationNotePrompt } from "../integration-note-prompt.service";
import type { FeishuThreadContext } from "../thread-run-context.service";
import type { IntegrationPromptVariables, ThreadPromptSource } from "./types";

export function createFeishuThreadPrompt(
  source$: Computed<Promise<ThreadPromptSource | null>>,
  context$: Computed<Promise<FeishuThreadContext>>,
): Computed<Promise<IntegrationPromptVariables | null>> {
  return computed(async (get) => {
    const [source, context] = await Promise.all([get(source$), get(context$)]);
    if (!source || !context) {
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
    return {
      userPromptVariables: { message: context.messageText },
      systemPromptVariables: {
        integrationContext: buildFeishuSystemPrompt({
          platform: context.platform,
          chatType: context.chatType,
          installationId: context.installationId,
          tenantKey: context.tenantKey,
          chatId: context.chatId,
          threadId: context.threadId,
          messageId: context.messageId,
          senderOpenId: context.senderOpenId,
          integrationNote: resolveIntegrationNotePrompt({
            triggerSource: context.platform,
            featureSwitchContext: source.featureSwitchContext,
          }),
          history: context.conversationHistory,
        }),
        channelUserIdentity: identity.join("\n"),
      },
    };
  });
}
