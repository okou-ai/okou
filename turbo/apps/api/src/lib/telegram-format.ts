/** Maximum message length allowed by Telegram */
const MAX_MESSAGE_LENGTH = 4096;

/**
 * Escape HTML special characters for Telegram HTML parse mode.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * Convert standard Markdown to Telegram-supported HTML subset.
 *
 * Supported conversions (ported from the removed `apps/web` app; no
 * upstream copy remains, so nothing here needs to be kept in sync):
 * - **bold** -> <b>bold</b>
 * - *italic* -> <i>italic</i>
 * - `code` -> <code>code</code>
 * - ```lang\nblock\n``` -> <pre>block</pre>
 * - [text](url) -> <a href="url">text</a>
 */
function markdownToTelegramHtml(markdown: string): string {
  let result = "";
  let remaining = markdown;

  while (remaining.length > 0) {
    const codeBlockMatch = remaining.match(/^```[^\n]*\n([\s\S]*?)```/);
    if (codeBlockMatch) {
      const content = codeBlockMatch[1] as string;
      result += `<pre>${escapeHtml(content)}</pre>`;
      remaining = remaining.slice(codeBlockMatch[0].length);
      continue;
    }

    const inlineCodeMatch = remaining.match(/^`([^`]+)`/);
    if (inlineCodeMatch) {
      const content = inlineCodeMatch[1] as string;
      result += `<code>${escapeHtml(content)}</code>`;
      remaining = remaining.slice(inlineCodeMatch[0].length);
      continue;
    }

    const imageMatch = remaining.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (imageMatch) {
      const altText = (imageMatch[1] as string) || "image";
      const imageUrl = imageMatch[2] as string;
      result += `<a href="${escapeHtml(imageUrl)}">🖼 ${escapeHtml(altText)}</a>`;
      remaining = remaining.slice(imageMatch[0].length);
      continue;
    }

    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      const linkText = linkMatch[1] as string;
      const linkUrl = linkMatch[2] as string;
      result += `<a href="${escapeHtml(linkUrl)}">${escapeHtml(linkText)}</a>`;
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      const content = boldMatch[1] as string;
      result += `<b>${escapeHtml(content)}</b>`;
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    const italicMatch = remaining.match(/^\*([^*]+)\*/);
    if (italicMatch) {
      const content = italicMatch[1] as string;
      result += `<i>${escapeHtml(content)}</i>`;
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    const char = remaining[0] as string;
    result += escapeHtml(char);
    remaining = remaining.slice(1);
  }

  return result;
}

function mutedTelegramFooter(text: string): string {
  return `<i>${text}</i>`;
}

/**
 * Build a Telegram response with converted Markdown content + optional footer.
 */
export function buildTelegramResponse(
  markdown: string,
  footerText?: string,
): string {
  const content = markdownToTelegramHtml(markdown);
  return footerText
    ? `${content}\n\n${mutedTelegramFooter(footerText)}`
    : content;
}

/**
 * Split a message into chunks that fit within Telegram's message length limit.
 */
export function splitMessage(
  text: string,
  maxLength: number = MAX_MESSAGE_LENGTH,
): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    const window = remaining.slice(0, maxLength);
    const codeBlockOpens = (window.match(/```/g) ?? []).length;
    if (codeBlockOpens % 2 !== 0) {
      const lastOpenIndex = window.lastIndexOf("```");
      if (lastOpenIndex > 0) {
        chunks.push(remaining.slice(0, lastOpenIndex).trimEnd());
        remaining = remaining.slice(lastOpenIndex);
        continue;
      }
      const closingIndex = remaining.indexOf("```", 3);
      if (closingIndex !== -1) {
        const endIndex = closingIndex + 3;
        chunks.push(remaining.slice(0, endIndex));
        remaining = remaining.slice(endIndex).replace(/^\n/, "");
        continue;
      }
    }

    const lastParagraph = window.lastIndexOf("\n\n");
    if (lastParagraph > maxLength / 4) {
      chunks.push(remaining.slice(0, lastParagraph).trimEnd());
      remaining = remaining.slice(lastParagraph + 2);
      continue;
    }

    const lastNewline = window.lastIndexOf("\n");
    if (lastNewline > maxLength / 4) {
      chunks.push(remaining.slice(0, lastNewline).trimEnd());
      remaining = remaining.slice(lastNewline + 1);
      continue;
    }

    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }

  return chunks;
}
