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
    opts.channel !== "whatsapp" && opts.isGroup && opts.groupId
      ? `${integrationNote}\n- For an explicitly requested additional text message to this group, use \`okou imessage message send --to ${opts.groupId} --text "message"\`. Your final reply is delivered automatically; do not send it again with the CLI.`
      : integrationNote,
    threadContext,
  ]
    .filter(Boolean)
    .join("\n\n");
}
