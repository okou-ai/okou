import type { DiscordMessage } from "../signals/external/discord-client";

import {
  CHANNEL_CONTEXT_MESSAGE_LIMIT,
  THREAD_CONTEXT_MESSAGE_LIMIT,
  formatConversationContext,
} from "./integration-conversation-context";

export function discordMessageContent(
  message: {
    readonly content: string;
    readonly mentions: readonly {
      readonly id: string;
      readonly username?: string;
      readonly global_name?: string | null;
    }[];
  },
  includeUserId = false,
) {
  const mentionDisplayNames: Record<string, string> = {};
  for (const mention of message.mentions) {
    const name = mention.global_name ?? mention.username;
    if (name) {
      mentionDisplayNames[mention.id] = name;
    }
  }
  return {
    displayContent: message.content.replace(
      /<@!?(\d+)>/g,
      (match, id: string) => {
        const name = mentionDisplayNames[id];
        return name === undefined
          ? match
          : includeUserId
            ? `@${name} (${id})`
            : `@${name}`;
      },
    ),
    mentionDisplayNames,
  };
}

/** Keep provider IDs for authorized file reads, never signed attachment URLs. */
export function discordConversationContext(args: {
  readonly messages: readonly DiscordMessage[];
  readonly contextType: "thread" | "channel";
  readonly priorityMessageIds: readonly string[];
  readonly referencedMessageId?: string;
}): string {
  const limit =
    args.contextType === "thread"
      ? THREAD_CONTEXT_MESSAGE_LIMIT
      : CHANNEL_CONTEXT_MESSAGE_LIMIT;
  const messages = [
    ...new Map(
      args.messages.map((message) => {
        return [message.id, message];
      }),
    ).values(),
  ]
    .filter((message) => {
      return message.content.length > 0 || message.attachments.length > 0;
    })
    .sort((left, right) => {
      const priority =
        Number(args.priorityMessageIds.includes(right.id)) -
        Number(args.priorityMessageIds.includes(left.id));
      if (priority !== 0) {
        return priority;
      }
      return BigInt(left.id) > BigInt(right.id) ? -1 : 1;
    })
    .slice(0, limit)
    .sort((left, right) => {
      return BigInt(left.id) < BigInt(right.id) ? -1 : 1;
    });
  return formatConversationContext({
    integration: "Discord",
    contextType: args.contextType,
    messages: messages.map((message) => {
      const reference = message.message_reference;
      const text = [];
      if (message.id === args.referencedMessageId) {
        text.push("[Referenced by current message]");
      }
      if (
        reference?.message_id &&
        (reference.type === undefined || reference.type === 0)
      ) {
        text.push(
          `[Reply to message] ${reference.message_id} (channel ${reference.channel_id ?? message.channel_id})`,
        );
      }
      text.push(
        discordMessageContent(
          {
            content: message.content,
            mentions: message.mentions ?? [],
          },
          true,
        ).displayContent,
      );
      return {
        sender: {
          id: message.author.id,
          name: message.author.global_name ?? message.author.username,
        },
        text: text.join("\n"),
        files: message.attachments.map((attachment) => {
          return [
            `[Discord file] ${attachment.filename} (${attachment.content_type ?? "file"})`,
            `   [ID] ${attachment.id}`,
            `   [Channel ID] ${message.channel_id}`,
            `   [Message ID] ${message.id}`,
            `   [Size] ${attachment.size} bytes`,
          ].join("\n");
        }),
      };
    }),
  });
}
