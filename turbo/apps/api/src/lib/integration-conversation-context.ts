export const CHANNEL_CONTEXT_MESSAGE_LIMIT = 10;
export const THREAD_CONTEXT_MESSAGE_LIMIT = 100;

interface ConversationSender {
  readonly id: string;
  readonly name?: string;
  readonly email?: string;
  readonly timezone?: string;
}

interface ConversationMessage {
  readonly sender: ConversationSender;
  readonly text: string;
  readonly files: readonly string[];
}

function formatSenderBlock(info: ConversationSender): string {
  const parts = [`id: ${info.id}`];
  if (info.name) {
    parts.push(`name: ${info.name}`);
  }
  if (info.email) {
    parts.push(`email: ${info.email}`);
  }
  if (info.timezone) {
    parts.push(`timezone: ${info.timezone}`);
  }
  return `- SENDER: {${parts.join(", ")}}`;
}

export function formatConversationContext(args: {
  readonly integration: "Slack" | "Discord" | "WeChat";
  readonly contextType: "thread" | "channel";
  readonly messages: readonly ConversationMessage[];
}): string {
  if (args.messages.length === 0) {
    return "";
  }
  const header =
    args.contextType === "thread"
      ? `# ${args.integration} Thread Context`
      : "# Recent Channel Messages";
  const preamble = [
    `The messages below are from a ${args.integration} conversation. When responding:`,
    "- Messages closer to RELATIVE_INDEX 0 are more recent — prioritize them.",
  ].join("\n");
  const messages = args.messages.map((message, index) => {
    return [
      "---",
      "",
      `- RELATIVE_INDEX: ${index - args.messages.length}`,
      formatSenderBlock(message.sender),
      "",
      message.text,
      ...message.files,
    ].join("\n");
  });
  return `${header}\n\n${preamble}\n\n${messages.join("\n\n")}\n\n---`;
}
