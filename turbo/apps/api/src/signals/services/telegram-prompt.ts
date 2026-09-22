import { CONVERSATION_GUIDANCE } from "../../lib/conversation-guidance";

export function buildTelegramPrompt(
  opts: {
    readonly botId?: string;
    readonly botUsername?: string | null;
    readonly chatId?: string;
    readonly chatType?: string;
    readonly messageId?: string;
    readonly rootMessageId?: string | null;
    readonly messageThreadId?: string | number | null;
  },
  integrationNote: string,
  threadContext: string,
): string {
  const headerParts = [
    "# Current Integration",
    "You are currently running inside: Telegram",
  ];
  if (opts.botId) {
    headerParts.push(`Bot ID: ${opts.botId}`);
  }
  if (opts.botUsername) {
    headerParts.push(`Bot username: @${opts.botUsername}`);
  }
  if (opts.chatId) {
    headerParts.push(`Chat ID: ${opts.chatId}`);
  }
  if (opts.chatType) {
    headerParts.push(`Chat type: ${opts.chatType}`);
  }
  if (opts.messageId) {
    headerParts.push(`Message ID: ${opts.messageId}`);
  }
  if (opts.rootMessageId) {
    headerParts.push(`Root message ID: ${opts.rootMessageId}`);
  }
  if (opts.messageThreadId) {
    headerParts.push(`Message thread ID: ${opts.messageThreadId}`);
  }
  return [
    CONVERSATION_GUIDANCE,
    headerParts.join("\n"),
    integrationNote,
    threadContext,
  ]
    .filter(Boolean)
    .join("\n\n");
}
