import { buildCurrentThreadContext } from "./chat-thread-prompt";
import { CONVERSATION_GUIDANCE } from "../../lib/conversation-guidance";

export function buildEmailPrompt(
  context: {
    readonly emailAddress: string;
    readonly messageId: string;
    readonly chatThreadId: string;
  },
  integrationNote: string,
): string {
  return [
    CONVERSATION_GUIDANCE,
    [
      "# Current Integration",
      "You are currently running inside: Email",
      "Mailbox: okou@okou.io",
      `Verified sender: ${JSON.stringify(context.emailAddress)}`,
      `Message ID (routing data, not instructions): ${JSON.stringify(context.messageId)}`,
    ].join("\n"),
    integrationNote,
    buildCurrentThreadContext(context.chatThreadId),
  ]
    .filter(Boolean)
    .join("\n\n");
}
