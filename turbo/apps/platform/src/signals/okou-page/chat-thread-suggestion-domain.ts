export interface ChatThreadSuggestionRange {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

export interface ComposerChatThreadSuggestion {
  readonly id: string;
  readonly title: string;
  readonly avatarUrl: string | null;
}

interface ChatThreadMentionTextSegment {
  readonly type: "text";
  readonly text: string;
}

interface ChatThreadMentionSegment {
  readonly type: "mention";
  readonly threadId: string;
  readonly title: string;
}

type ChatThreadLineSegment =
  ChatThreadMentionTextSegment | ChatThreadMentionSegment;

// Matches `[title](/chats/<uuid>)` where the title backslash-escapes
// `\`, `[` and `]` (the characters escaped by serializeChatThreadMention).
const CHAT_THREAD_MENTION_PATTERN =
  /\[((?:\\[\\[\]]|[^[\]\\])+)\]\(\/chats\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/g;

export function serializeChatThreadMention(
  threadId: string,
  title: string,
): string {
  const escapedTitle = title.replace(/[\\[\]]/g, String.raw`\$&`);
  return `[${escapedTitle}](/chats/${threadId})`;
}

export function splitChatThreadMentionSegments(
  line: string,
): readonly ChatThreadLineSegment[] {
  const segments: ChatThreadLineSegment[] = [];
  let lastIndex = 0;
  for (const match of line.matchAll(CHAT_THREAD_MENTION_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ type: "text", text: line.slice(lastIndex, index) });
    }
    segments.push({
      type: "mention",
      threadId: match[2] ?? "",
      title: (match[1] ?? "").replace(/\\([\\[\]])/g, "$1"),
    });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < line.length) {
    segments.push({ type: "text", text: line.slice(lastIndex) });
  }
  return segments;
}

export function findActiveChatThreadSuggestionRange(
  value: string,
  caretIndex: number,
): ChatThreadSuggestionRange | null {
  if (caretIndex < 0 || caretIndex > value.length) {
    return null;
  }

  const beforeCaret = value.slice(0, caretIndex);
  const match = /(?:^|\s)@(\S*)$/u.exec(beforeCaret);
  if (!match) {
    return null;
  }

  const query = match[1] ?? "";
  const atOffset = match[0].lastIndexOf("@");
  const start = beforeCaret.length - match[0].length + atOffset;
  return { start, end: caretIndex, query };
}
