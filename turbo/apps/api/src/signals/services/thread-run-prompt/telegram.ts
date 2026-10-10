import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { computed, type Computed } from "ccstate";
import { getOfficialTelegramBotConfig } from "../../external/telegram-official";
import { resolveIntegrationNotePrompt } from "../integration-note-prompt.service";
import { buildTelegramPrompt } from "../telegram-prompt";
import type { TelegramThreadContext } from "../thread-run-context.service";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
import type { PickedThreadInputEvent } from "./types";

export function createTelegramThreadPrompt(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  context$: Computed<Promise<TelegramThreadContext>>,
  featureSwitches$: Computed<Promise<FeatureSwitchContext>>,
): Computed<Promise<RunPromptAndSkills | null>> {
  return computed(async (get) => {
    const pickedEvent = await get(pickedEvent$);
    if (pickedEvent?.contextType !== "telegram") {
      return null;
    }
    const context = await get(context$);
    if (!context) {
      return null;
    }
    const officialBotConfig = getOfficialTelegramBotConfig();
    if (officialBotConfig.botId === null) {
      return null;
    }
    const identity: string[] = [];
    if (context.senderDisplayName) {
      identity.push(`Telegram display name: ${context.senderDisplayName}`);
    }
    if (context.senderUsername) {
      identity.push(`Telegram username: ${context.senderUsername}`);
    }
    if (context.senderUserId) {
      identity.push(`Telegram user ID: ${context.senderUserId}`);
    }
    if (context.senderLanguage) {
      identity.push(`Telegram language: ${context.senderLanguage}`);
    }
    return {
      userPromptVariables: { message: context.messageText },
      systemPromptVariables: {
        integrationContext: buildTelegramPrompt(
          {
            botId: officialBotConfig.botId,
            botUsername: officialBotConfig.botUsername,
            chatId: context.chatId,
            chatType: context.chatType,
            messageId: context.messageId,
            rootMessageId: context.rootMessageId,
            messageThreadId: context.messageThreadId,
          },
          resolveIntegrationNotePrompt({
            triggerSource: "telegram",
            featureSwitchContext: await get(featureSwitches$),
          }),
          context.threadContext,
        ),
        channelUserIdentity: identity.join("\n"),
      },
      skillVolumes: [],
    };
  });
}
