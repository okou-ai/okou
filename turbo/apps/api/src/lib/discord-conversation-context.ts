const MAX_CONTEXT_MESSAGES = 20;
const MAX_CONTEXT_CHARACTERS = 16_000;
const MAX_MESSAGE_CHARACTERS = 2000;

interface DiscordContextMessage {
  readonly id: string;
  readonly content: string;
  readonly author: {
    readonly id: string;
    readonly username: string;
    readonly global_name?: string | null;
  };
}

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

/** A bounded, attributed snapshot. Provider content remains untrusted text. */
export function discordConversationContext(
  messages: readonly DiscordContextMessage[],
): string {
  const newestFirst = [...messages]
    .sort((left, right) => {
      const leftId = BigInt(left.id);
      const rightId = BigInt(right.id);
      return leftId > rightId ? -1 : leftId < rightId ? 1 : 0;
    })
    .slice(0, MAX_CONTEXT_MESSAGES);
  const snapshots: {
    readonly messageId: string;
    readonly authorId: string;
    readonly authorName: string;
    readonly text: string;
  }[] = [];
  let remaining = MAX_CONTEXT_CHARACTERS - 2;
  for (const message of newestFirst) {
    // Without MESSAGE_CONTENT, Discord legitimately omits ordinary history.
    if (!message.content) {
      continue;
    }
    const snapshot = {
      messageId: message.id,
      authorId: message.author.id,
      authorName: message.author.global_name ?? message.author.username,
      text: message.content.slice(0, MAX_MESSAGE_CHARACTERS),
    };
    const length = JSON.stringify(snapshot).length + 1;
    if (length > remaining) {
      break;
    }
    snapshots.unshift(snapshot);
    remaining -= length;
  }
  return JSON.stringify(snapshots);
}
