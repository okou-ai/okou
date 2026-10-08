const DISCORD_MESSAGE_LIMIT = 2000;

function closingFence(text: string): string {
  return text.endsWith("\n") ? "```" : "\n```";
}

function safeChunkEnd(text: string, maximum: number): number {
  let end = Math.min(text.length, maximum);
  // Keep Unicode surrogate pairs together while using the conservative UTF-16 limit.
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd8_00 && last <= 0xdb_ff) {
    end -= 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end - 1);
    if (space >= end / 2) {
      end = space + 1;
    }
  }
  return end;
}

function parseFenceLine(
  line: string,
  fence: string | undefined,
): { readonly next: string | undefined } | undefined {
  if (fence !== undefined) {
    return /^```[ \t]*(?:\r?\n)?$/u.test(line)
      ? { next: undefined }
      : undefined;
  }
  // Keep oversized or malformed opening lines literal so an opening marker
  // cannot exhaust a whole chunk before any source text fits.
  if (line.length >= DISCORD_MESSAGE_LIMIT - 4) {
    return undefined;
  }
  if (/^```([\w#+.-]{0,100})[ \t]*\r?\n$/u.test(line)) {
    return { next: "```" + line.slice(3).trim() + "\n" };
  }
  return undefined;
}

/** Preserve message text, normalizing closing-fence whitespace and wrapping code. */
export function splitDiscordMessage(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const chunks: string[] = [];
  let current = "";
  let fence: string | undefined;
  let sourceLength = 0;
  const flush = () => {
    if (sourceLength === 0) {
      return;
    }
    chunks.push(current + (fence === undefined ? "" : closingFence(current)));
    current = fence ?? "";
    sourceLength = 0;
  };

  for (const match of content.matchAll(/[^\n]*\n|[^\n]+$/gu)) {
    const line = match[0];
    const fenceLine = parseFenceLine(line, fence);
    if (fenceLine && fenceLine.next === undefined) {
      // Whitespace after a closing marker has no rendered meaning. Normalize it
      // to the reserved four characters instead of sending an empty whitespace
      // chunk, which Discord rejects. Code and ordinary message text stay intact.
      current += line.endsWith("\n") ? "```\n" : "```";
      sourceLength += line.length;
      fence = undefined;
      continue;
    } else if (fenceLine) {
      if (current.length + line.length + 4 > DISCORD_MESSAGE_LIMIT) {
        flush();
      }
      current += line;
      sourceLength += line.length;
      fence = fenceLine.next;
      continue;
    }

    const reserved = fence === undefined ? 0 : 4;
    if (
      line.length <= DISCORD_MESSAGE_LIMIT - (fence?.length ?? 0) - reserved &&
      line.length > DISCORD_MESSAGE_LIMIT - current.length - reserved
    ) {
      flush();
    }
    let remaining = line;
    while (remaining.length > 0) {
      const available =
        DISCORD_MESSAGE_LIMIT - current.length - (fence === undefined ? 0 : 4);
      const end = safeChunkEnd(remaining, available);
      if (end === 0) {
        flush();
        continue;
      }
      current += remaining.slice(0, end);
      sourceLength += end;
      remaining = remaining.slice(end);
      if (remaining.length > 0) {
        flush();
      }
    }
  }
  flush();
  return chunks;
}

export function discordMessageUrl(args: {
  readonly guildId?: string;
  readonly channelId: string;
  readonly messageId: string;
}): string {
  return `https://discord.com/channels/${args.guildId ?? "@me"}/${args.channelId}/${args.messageId}`;
}
