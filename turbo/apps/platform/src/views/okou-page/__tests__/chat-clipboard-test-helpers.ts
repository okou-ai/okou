import { waitFor } from "@testing-library/react";
import { expect } from "vitest";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";

export async function readSingleRichClipboardWrite(clipboard: {
  readonly writes: ClipboardItem[][];
}): Promise<ClipboardItem> {
  await waitFor(() => {
    expect(clipboard.writes).toHaveLength(1);
    expect(clipboard.writes[0]).toHaveLength(1);
  });
  const item = clipboard.writes[0]?.[0];
  if (!item) {
    throw new Error("clipboard item not found");
  }
  return item;
}

export async function readClipboardItemText(
  item: ClipboardItem,
  type: string,
): Promise<string> {
  const blob = await item.getType(type);
  return await blob.text();
}

export function parseChatClipboardPayload(html: string): {
  text: string;
  attachments: {
    id: string | null;
    url: string;
    filename: string;
    contentType: string;
    size: number;
  }[];
  userMessage?: UserMessageDocument;
} {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const encoded = doc.querySelector<HTMLElement>("[data-okou-chat-message]")
    ?.dataset.okouChatMessage;
  if (!encoded) {
    throw new Error("chat clipboard payload not found");
  }
  return JSON.parse(decodeURIComponent(encoded)) as {
    text: string;
    attachments: {
      id: string | null;
      url: string;
      filename: string;
      contentType: string;
      size: number;
    }[];
    userMessage?: UserMessageDocument;
  };
}
