import { parseMessageTarget } from "../../../lib/command/message-target";

/**
 * Telegram private chats share the user's ID, so user: and chat: targets both
 * resolve to a chat ID. "me" is resolved by the API to the caller's private
 * chat with the official Okou bot.
 */
export function resolveTelegramChatId(to: string): string {
  const target = parseMessageTarget(to, () => {
    return false;
  });
  return target.kind === "me" ? "me" : target.id;
}

export function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}
