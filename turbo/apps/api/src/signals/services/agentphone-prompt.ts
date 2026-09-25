import { CONVERSATION_GUIDANCE } from "../../lib/conversation-guidance";

export function buildAgentPhonePrompt(
  opts: {
    readonly sharedNumber: string;
    readonly phoneHandle: string;
    readonly conversationId?: string | null;
    readonly channel?: string | null;
    readonly isGroup?: boolean;
    readonly messageId?: string;
    readonly agentphoneAgentId?: string;
  },
  integrationNote: string,
  threadContext: string,
): string {
  const headerParts = [
    "# Current Integration\nYou are currently running inside: Phone text messaging (iMessage/SMS)",
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
  if (opts.messageId) {
    headerParts.push(`Message ID: ${opts.messageId}`);
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
