import type { DiscordMessage } from "../signals/external/discord-client";

const MAX_CONTEXT_MESSAGES = 20;
const MAX_CONTEXT_CHARACTERS = 16_000;
const MAX_MESSAGE_CHARACTERS = 2000;

export function discordMessageContent(message: {
  readonly content: string;
  readonly mentions: readonly {
    readonly id: string;
    readonly username?: string;
    readonly global_name?: string | null;
  }[];
}) {
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
        return name === undefined ? match : `@${name}`;
      },
    ),
    mentionDisplayNames,
  };
}

/** A bounded, attributed snapshot. Never serialize signed attachment URLs. */
export function discordConversationContext(
  messages: readonly DiscordMessage[],
  priorityMessageIds: readonly string[] = [],
  referencedMessageId?: string,
): string {
  const newestFirst = [
    ...new Map(
      messages.map((message) => {
        return [message.id, message];
      }),
    ).values(),
  ]
    .sort((left, right) => {
      const priority =
        Number(priorityMessageIds.includes(right.id)) -
        Number(priorityMessageIds.includes(left.id));
      if (priority !== 0) {
        return priority;
      }
      return BigInt(left.id) > BigInt(right.id)
        ? -1
        : BigInt(left.id) < BigInt(right.id)
          ? 1
          : 0;
    })
    .slice(0, MAX_CONTEXT_MESSAGES);
  const snapshots = [];
  let remaining = MAX_CONTEXT_CHARACTERS - 2;
  for (const message of newestFirst) {
    if (!message.content && message.attachments.length === 0) {
      continue;
    }
    const reference = message.message_reference;
    const snapshot = {
      messageId: message.id,
      channelId: message.channel_id,
      ...(message.id === referencedMessageId
        ? { referencedByCurrentMessage: true }
        : {}),
      authorId: message.author.id,
      authorName: message.author.global_name ?? message.author.username,
      text: discordMessageContent({
        content: message.content,
        mentions: message.mentions ?? [],
      }).displayContent.slice(0, MAX_MESSAGE_CHARACTERS),
      ...(reference?.message_id &&
      (reference.type === undefined || reference.type === 0)
        ? {
            replyTo: {
              messageId: reference.message_id,
              channelId: reference.channel_id ?? message.channel_id,
            },
          }
        : {}),
      attachments: message.attachments.slice(0, 10).map((attachment) => {
        return {
          attachmentId: attachment.id,
          filename: attachment.filename.slice(0, 256),
          size: attachment.size,
          ...(attachment.content_type !== undefined
            ? { contentType: attachment.content_type.slice(0, 200) }
            : {}),
        };
      }),
    };
    const length = JSON.stringify(snapshot).length + 1;
    if (length > remaining) {
      continue;
    }
    snapshots.push(snapshot);
    remaining -= length;
  }
  snapshots.sort((left, right) => {
    return BigInt(left.messageId) < BigInt(right.messageId)
      ? -1
      : BigInt(left.messageId) > BigInt(right.messageId)
        ? 1
        : 0;
  });
  return JSON.stringify(snapshots);
}
