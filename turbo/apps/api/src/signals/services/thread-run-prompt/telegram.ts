import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { computed, type Computed } from "ccstate";
import { getOfficialTelegramBotConfig } from "../../external/telegram-official";
import {
  telegramPromptFromContext,
  type TelegramThreadContext,
} from "../telegram-queued-launch-context.service";
import type { RunPrompt } from "../run-prompt-and-skills";
import type { PickedThreadInputEvent } from "./types";

export function createTelegramThreadPrompt(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  context$: Computed<Promise<TelegramThreadContext>>,
  featureSwitches$: Computed<Promise<FeatureSwitchContext>>,
): Computed<Promise<RunPrompt | null>> {
  return computed(async (get) => {
    const pickedEvent = await get(pickedEvent$);
    if (pickedEvent?.contextType !== "telegram") {
      return null;
    }
    const context = await get(context$);
    if (!context) {
      return null;
    }
    const { botId, botUsername } = getOfficialTelegramBotConfig();
    if (botId === null) {
      return null;
    }
    const material = telegramPromptFromContext(
      context,
      { botId, botUsername },
      await get(featureSwitches$),
    );
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
      userPromptVariables: { message: material.prompt },
      systemPromptVariables: {
        integrationContext: material.appendSystemPrompt,
        channelUserIdentity: identity.join("\n"),
      },
    };
  });
}
