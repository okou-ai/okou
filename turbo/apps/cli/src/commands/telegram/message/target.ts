import {
  parseMessageTarget,
  unsupportedTargetError,
} from "../../../lib/command/message-target";

/**
 * Telegram private chats share the user's ID, so user: and chat: targets both
 * resolve to a chat ID. The bot cannot resolve "me" to a chat.
 */
export function resolveTelegramChatId(to: string): string {
  const target = parseMessageTarget(to, () => {
    return false;
  });
  if (target.kind === "me") {
    throw unsupportedTargetError(
      "Telegram",
      target,
      "Pass your Telegram chat ID with the bot instead",
    );
  }
  return target.id;
}

export function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}
