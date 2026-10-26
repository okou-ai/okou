import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import { chatEventResponse } from "@okouai/api-contracts/contracts/chat-threads";

import { safeJsonParse, safeSync } from "../utils";

export type ChatEventSnapshotProjectionSubstage = "current_contract";

export type ChatEventSnapshotProjectionVariant = "invalid_event_shape";

export class ChatEventSnapshotProjectionError extends Error {
  readonly projectionSubstage: ChatEventSnapshotProjectionSubstage =
    "current_contract";
  readonly projectionVariant: ChatEventSnapshotProjectionVariant =
    "invalid_event_shape";

  constructor() {
    super("Chat Event Snapshot projection failed");
    this.name = "ChatEventSnapshotProjectionError";
  }
}

function snapshotRawLines(body: Buffer): readonly string[] {
  const text = body.toString("utf8");
  if (text.length === 0) {
    return [];
  }
  if (!text.endsWith("\n")) {
    throw new Error("Chat Event snapshot must be newline-delimited JSON");
  }
  return text.slice(0, -1).split("\n");
}

export function decodeChatEventSnapshotBody(
  body: Buffer,
): readonly ChatEventRow[] {
  return snapshotRawLines(body).map((raw) => {
    const parsed = safeJsonParse(raw);
    if (parsed === undefined) {
      throw new Error("Chat Event snapshot contains invalid JSON");
    }
    return chatEventRowSchema.parse(parsed);
  });
}

/**
 * Readers project snapshot rows without validating them again, so publication
 * is where every row must satisfy the public ChatEvent contract.
 */
export function validateChatEventSnapshotRows(
  rows: readonly ChatEventRow[],
): void {
  for (const row of rows) {
    const projected = safeSync(() => {
      chatEventResponse(chatEventFromRow(row));
    });
    if ("error" in projected) {
      throw new ChatEventSnapshotProjectionError();
    }
  }
}
