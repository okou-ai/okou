import { computed, type Computed } from "ccstate";
import { getOfficialTelegramBotConfig } from "../../external/telegram-official";
import { resolveIntegrationNotePrompt } from "../integration-note-prompt.service";
import { buildTelegramPrompt } from "../telegram-prompt";
import type { TelegramThreadContext } from "../thread-run-context.service";
import type { IntegrationPromptVariables, ThreadPromptSource } from "./types";

export function createTelegramThreadPrompt(
  source$: Computed<Promise<ThreadPromptSource | null>>,
  context$: Computed<Promise<TelegramThreadContext>>,
): Computed<Promise<IntegrationPromptVariables | null>> {
  return computed(async (get) => {
    const source = await get(source$);
    if (source?.event.contextType !== "telegram") {
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
            featureSwitchContext: source.featureSwitchContext,
          }),
          context.threadContext,
        ),
        channelUserIdentity: identity.join("\n"),
      },
    };
  });
}
