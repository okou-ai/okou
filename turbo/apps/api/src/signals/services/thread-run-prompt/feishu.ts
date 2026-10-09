import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { computed, type Computed } from "ccstate";
import { FEISHU_PLATFORMS } from "@okouai/core/feishu-platform";
import { buildFeishuSystemPrompt } from "../feishu-dispatch.service";
import { resolveIntegrationNotePrompt } from "../integration-note-prompt.service";
import type { FeishuThreadContext } from "../thread-run-context.service";
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
            featureSwitchContext: await get(featureSwitches$),
          }),
          history: context.conversationHistory,
        }),
        channelUserIdentity: identity.join("\n"),
      },
      skillVolumes: [],
    };
  });
}
