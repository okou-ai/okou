const ARCHIVED_CHAT_THREAD_EMOJI = "✅";
const UNARCHIVED_CHAT_THREAD_FALLBACK_TITLE = "New Thread";

export const CHAT_THREAD_EMOJI_OPTIONS = [
  { emoji: "✅" },
  { emoji: "🔥" },
  { emoji: "❌" },
  { emoji: "⚠️" },
  { emoji: "💡" },
  { emoji: "❓" },
  { emoji: "⏳" },
  { emoji: "👀" },
  { emoji: "🚀" },
] as const;

const CHAT_THREAD_EMOJI_PATTERN =
  /(?:[\u{1f1e6}-\u{1f1ff}]{2}|[#*0-9]\ufe0f?\u20e3|\p{Extended_Pictographic}(?:\ufe0f|\ufe0e)?(?:[\u{1f3fb}-\u{1f3ff}])?(?:\u200d\p{Extended_Pictographic}(?:\ufe0f|\ufe0e)?(?:[\u{1f3fb}-\u{1f3ff}])?)*)/u;

interface ChatThreadTitleParts {
  readonly emoji: string | null;
  readonly text: string;
}

export function getChatThreadTitleParts(
  title: string | null | undefined,
): ChatThreadTitleParts {
  const trimmedTitle = title?.trim() ?? "";
  if (!trimmedTitle) {
    return { emoji: null, text: "" };
  }

  const match = trimmedTitle.match(CHAT_THREAD_EMOJI_PATTERN);
  if (!match || match.index === undefined) {
    return { emoji: null, text: trimmedTitle };
  }

  const beforeEmoji = trimmedTitle.slice(0, match.index).trim();
  const afterEmoji = trimmedTitle.slice(match.index + match[0].length).trim();
  return {
    emoji: match[0],
    text: [beforeEmoji, afterEmoji].filter(Boolean).join(" "),
  };
}

export function applyChatThreadEmoji(
  title: string | null | undefined,
  emoji: string,
): string {
  const { text } = getChatThreadTitleParts(title);
  return text ? `${emoji} ${text}` : emoji;
}

export function removeChatThreadEmoji(
  title: string | null | undefined,
): string {
  return getChatThreadTitleParts(title).text;
}

export function isChatThreadArchived(
  title: string | null | undefined,
): boolean {
  return getChatThreadTitleParts(title).emoji === ARCHIVED_CHAT_THREAD_EMOJI;
}

export function archiveChatThreadTitle(
  title: string | null | undefined,
): string {
  return applyChatThreadEmoji(title, ARCHIVED_CHAT_THREAD_EMOJI);
}

export function unarchiveChatThreadTitle(
  title: string | null | undefined,
): string {
  return removeChatThreadEmoji(title) || UNARCHIVED_CHAT_THREAD_FALLBACK_TITLE;
}
