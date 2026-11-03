import { userMessageDocumentSchema } from "@okouai/api-contracts/validators/chat-threads";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { i18n } from "../../i18n/index.ts";
import { CHAT_ATTACHMENT_HEADINGS } from "../../i18n/resources.ts";
import {
  isRecord,
  jsonParseOr,
  settle,
  throwIfAbort,
  withCleanup,
} from "../utils.ts";

const CHAT_MESSAGE_CLIPBOARD_ATTR = "data-okou-chat-message";

export interface ChatClipboardAttachment {
  id: string | null;
  url: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface ChatClipboardPayload {
  text: string;
  attachments: ChatClipboardAttachment[];
  userMessage?: UserMessageDocument;
}

function isChatClipboardAttachment(
  value: unknown,
): value is ChatClipboardAttachment {
  if (!isRecord(value)) {
    return false;
  }
  const id = value.id;
  return (
    (typeof id === "string" || id === null) &&
    typeof value.url === "string" &&
    typeof value.filename === "string" &&
    typeof value.contentType === "string" &&
    typeof value.size === "number"
  );
}

function parseChatClipboardPayload(
  serialized: string,
): ChatClipboardPayload | null {
  const parsed = jsonParseOr<unknown>(serialized, null);
  if (!isRecord(parsed) || typeof parsed.text !== "string") {
    return null;
  }
  if (!Array.isArray(parsed.attachments)) {
    return null;
  }
  if (!parsed.attachments.every(isChatClipboardAttachment)) {
    return null;
  }
  const userMessage =
    parsed.userMessage === undefined
      ? undefined
      : userMessageDocumentSchema.safeParse(parsed.userMessage);
  if (userMessage !== undefined && !userMessage.success) {
    return null;
  }
  return {
    text: parsed.text,
    attachments: parsed.attachments,
    ...(userMessage?.success ? { userMessage: userMessage.data } : {}),
  };
}

function decodeClipboardPayload(value: string): string | null {
  // eslint-disable-next-line no-restricted-syntax -- clipboard HTML is untrusted, so malformed URI payloads must be ignored
  try {
    return decodeURIComponent(value);
  } catch (error: unknown) {
    throwIfAbort(error);
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function attachmentHeading(): string {
  return i18n.t(($) => {
    return $.chat.attachments.title;
  });
}

function supportedAttachmentHeadings(): readonly string[] {
  return Array.from(new Set(Object.values(CHAT_ATTACHMENT_HEADINGS)));
}

function formatPlainText(payload: ChatClipboardPayload): string {
  if (payload.attachments.length === 0) {
    return payload.text;
  }
  const attachments = payload.attachments
    .map((attachment) => {
      return `- ${attachment.filename}: ${attachment.url}`;
    })
    .join("\n");
  return [payload.text.trim(), `${attachmentHeading()}:\n${attachments}`]
    .filter(Boolean)
    .join("\n\n");
}

function textFromPlainClipboardFallback(plainText: string): string {
  for (const heading of supportedAttachmentHeadings()) {
    const standaloneMarker = `${heading}:\n`;
    const attachmentsMarker = `\n\n${standaloneMarker}`;
    const markerIndex = plainText.indexOf(attachmentsMarker);
    if (markerIndex !== -1) {
      return plainText.slice(0, markerIndex).trim();
    }
    if (plainText.startsWith(standaloneMarker)) {
      return "";
    }
  }
  return plainText.trim();
}

function formatMessageHtml(payload: ChatClipboardPayload): string {
  const encoded = escapeHtml(encodeURIComponent(JSON.stringify(payload)));
  const textHtml = payload.text
    ? `<div>${escapeHtml(payload.text).replace(/\n/g, "<br>")}</div>`
    : "";
  const attachmentLinksHtml = payload.attachments
    .map((attachment) => {
      const name = escapeHtml(attachment.filename);
      const url = escapeHtml(attachment.url);
      return `<div><a href="${url}" data-okou-attachment-id="${escapeHtml(attachment.id ?? "")}">${name}</a></div>`;
    })
    .join("");
  const attachmentsHtml = attachmentLinksHtml
    ? `<div>${escapeHtml(attachmentHeading())}:</div>${attachmentLinksHtml}`
    : "";
  return `<div ${CHAT_MESSAGE_CLIPBOARD_ATTR}="${encoded}">${textHtml}${attachmentsHtml}</div>`;
}

function executeLegacyCopyCommand(): boolean {
  const command: unknown = Reflect.get(document, "execCommand");
  if (typeof command !== "function") {
    return false;
  }
  return Reflect.apply(command, document, ["copy"]) === true;
}

async function runLegacyClipboardCopy(
  prepare: () => void,
  cleanup: () => void,
): Promise<boolean> {
  const execute = async (): Promise<boolean> => {
    prepare();
    const copied = executeLegacyCopyCommand();
    await Promise.resolve();
    return copied;
  };
  // eslint-disable-next-line ccstate/no-with-cleanup, ccstate/no-settle -- Legacy 20261022/20261029: existing withCleanup and settle only; do not add new usages.
  const result = await withCleanup(settle(execute()), cleanup);
  return result.ok ? result.value : false;
}

async function writeLegacyRichClipboard(
  plainText: string,
  html: string,
): Promise<boolean> {
  const body = document.body;
  if (!body) {
    return false;
  }

  const selection = window.getSelection();
  const previousRanges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => {
        return selection.getRangeAt(index).cloneRange();
      })
    : [];
  const copyTarget = document.createElement("div");
  copyTarget.contentEditable = "true";
  copyTarget.setAttribute("aria-hidden", "true");
  copyTarget.style.position = "fixed";
  copyTarget.style.left = "-9999px";
  copyTarget.style.top = "-9999px";
  copyTarget.innerHTML = html;
  body.appendChild(copyTarget);

  const copyRange = document.createRange();
  copyRange.selectNodeContents(copyTarget);
  selection?.removeAllRanges();
  selection?.addRange(copyRange);

  let copied = false;
  const handleCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) {
      return;
    }
    event.preventDefault();
    event.clipboardData.setData("text/plain", plainText);
    event.clipboardData.setData("text/html", html);
    copied = true;
  };
  document.addEventListener("copy", handleCopy, { once: true });
  const commandSucceeded = await runLegacyClipboardCopy(
    () => {
      selection?.removeAllRanges();
      selection?.addRange(copyRange);
    },
    () => {
      document.removeEventListener("copy", handleCopy);
      copyTarget.remove();
      selection?.removeAllRanges();
      for (const previousRange of previousRanges) {
        selection?.addRange(previousRange);
      }
    },
  );
  return commandSucceeded && copied;
}

/**
 * Write text to the clipboard once and report whether the browser accepted it.
 */
export async function writeToClipboard(text: string): Promise<boolean> {
  // eslint-disable-next-line no-restricted-syntax -- clipboard failures are reported through the existing boolean result
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error: unknown) {
    throwIfAbort(error);
    return false;
  }
}

export async function writeChatMessageToClipboard(
  payload: ChatClipboardPayload,
): Promise<boolean> {
  const plainText = formatPlainText(payload);
  if (payload.attachments.length === 0 && !payload.userMessage) {
    return await writeToClipboard(plainText);
  }

  const html = formatMessageHtml(payload);
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    return await writeLegacyRichClipboard(plainText, html);
  }
  const baseItems: Record<string, Blob> = {
    "text/plain": new Blob([plainText], { type: "text/plain" }),
    "text/html": new Blob([html], { type: "text/html" }),
  };

  // eslint-disable-next-line no-restricted-syntax -- clipboard failures are reported through the existing boolean result
  try {
    await navigator.clipboard.write([new ClipboardItem(baseItems)]);
    return true;
  } catch (error: unknown) {
    throwIfAbort(error);
    return false;
  }
}

function encodedChatMessageFromDocument(doc: Document): string | null {
  return (
    doc
      .querySelector(`[${CHAT_MESSAGE_CLIPBOARD_ATTR}]`)
      ?.getAttribute(CHAT_MESSAGE_CLIPBOARD_ATTR) ?? null
  );
}

export function readChatMessageFromClipboard(
  clipboardData: DataTransfer,
): ChatClipboardPayload | null {
  const html = clipboardData.getData("text/html");
  if (!html) {
    return null;
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const encoded = encodedChatMessageFromDocument(doc);
  if (!encoded) {
    return null;
  }
  const serialized = decodeClipboardPayload(encoded);
  const payload = serialized ? parseChatClipboardPayload(serialized) : null;
  if (!payload) {
    return null;
  }
  if (payload.text.trim()) {
    return payload;
  }
  const plainText = clipboardData.getData("text/plain");
  return {
    ...payload,
    text: textFromPlainClipboardFallback(plainText),
  };
}
