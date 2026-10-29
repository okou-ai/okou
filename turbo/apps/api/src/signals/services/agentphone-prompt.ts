import { CONVERSATION_GUIDANCE } from "../../lib/conversation-guidance";

export function buildAgentPhonePrompt(
  opts: {
    readonly sharedNumber: string;
    readonly phoneHandle: string;
    readonly conversationId?: string | null;
    readonly groupId?: string | null;
    readonly channel?: string | null;
    readonly isGroup?: boolean;
    readonly messageId?: string;
    readonly agentphoneAgentId?: string;
  },
  integrationNote: string,
  threadContext: string,
): string {
  const headerParts = [
    opts.channel === "whatsapp"
      ? "# Current Integration\nYou are currently running inside: WhatsApp"
      : "# Current Integration\nYou are currently running inside: Phone text messaging (iMessage/SMS)",
  ];
  headerParts.push(`Shared phone number: ${opts.sharedNumber}`);
  headerParts.push(`User phone handle: ${opts.phoneHandle}`);
  if (opts.agentphoneAgentId) {
    headerParts.push(`Phone agent ID: ${opts.agentphoneAgentId}`);
  }
  if (opts.channel) {
    headerParts.push(`Channel: ${opts.channel}`);
  }
  if (opts.isGroup !== undefined) {
    headerParts.push(`Conversation type: ${opts.isGroup ? "group" : "dm"}`);
  }
  if (opts.conversationId) {
    headerParts.push(`Conversation ID: ${opts.conversationId}`);
  }
  if (opts.isGroup && opts.groupId) {
    headerParts.push(`Group ID: ${opts.groupId}`);
  }
  if (opts.messageId) {
    headerParts.push(`Message ID: ${opts.messageId}`);
  }
  return [
    CONVERSATION_GUIDANCE,
    headerParts.join("\n"),
    opts.channel === "whatsapp"
      ? "# Integration Note\nYour final reply is automatically delivered to this WhatsApp conversation. Do not duplicate it with a message command. Use concise plain text. For an explicitly requested additional message, use `okou whatsapp message send --help`; it sends only to this user's independently verified WhatsApp account. Free-form sends require the customer's 24-hour service window. Never fall back to SMS/iMessage or retry an uncertain send. Incoming `[Web file]` blocks use `okou web download-file -h`. Historical `[Phone file]` attachments use `okou phone download-file -h`. File upload is not available on this integration yet; share an accessible artifact link when appropriate."
      : integrationNote,
    threadContext,
  ]
    .filter(Boolean)
    .join("\n\n");
}
