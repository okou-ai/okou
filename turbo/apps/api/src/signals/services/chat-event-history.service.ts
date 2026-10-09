import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { command } from "ccstate";
import { and, asc, eq, gt } from "drizzle-orm";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";

import { writeDb$ } from "../external/db";
import { env } from "../../lib/env";
import { downloadS3Buffer } from "../external/s3";
import {
  decodeChatEventSnapshotBody,
  validateChatEventSnapshotRows,
} from "./chat-event-snapshot-body.service";
import { chatEventRowFromDbRow } from "./cron-snapshot-chat-events.service";

const gunzipAsync = promisify(gunzip);
const CHAT_EVENT_HISTORY_PAGE_SIZE = 1000;

/** Shared-thread reader: capture the SQL snapshot before downloading immutable bytes. */
export const readSharedThreadChatEventHistory$ = command(
  async (
    { get, set },
    chatThreadId: string,
    signal: AbortSignal,
  ): Promise<readonly ChatEventRow[]> => {
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0090; new non-billing transactions are prohibited.
    const captured = await set(writeDb$).transaction(
      async (tx) => {
        const [head] = await tx
          .select({
            lastSeqId: chatEventSnapshots.lastSeqId,
            terminalSeqId: chatEventSnapshots.terminalSeqId,
            terminalEventId: chatEventSnapshots.terminalEventId,
            objectKey: chatEventSnapshots.objectKey,
            archiveSchemaVersion: chatEventSnapshots.archiveSchemaVersion,
          })
          .from(chatEventSnapshots)
          .where(
            and(
              eq(chatEventSnapshots.chatThreadId, chatThreadId),
              eq(
                chatEventSnapshots.archiveSchemaVersion,
                CURRENT_CHAT_EVENT_SCHEMA_VERSION,
              ),
            ),
          )
          .limit(1);
        signal.throwIfAborted();
        if (
          head &&
          (head.lastSeqId <= 0 || head.objectKey.trim().length === 0)
        ) {
          throw new Error("Chat event snapshot head is not reusable");
        }
        const tail: ChatEventRow[] = [];
        let cursor = head?.lastSeqId ?? 0;
        for (;;) {
          const rows = await tx
            .select({
              id: chatEvents.id,
              chatThreadId: chatEvents.chatThreadId,
              runId: chatEvents.runId,
              revokesEventId: chatEvents.revokesEventId,
              eventType: chatEvents.eventType,
              payload: chatEvents.payload,
              failureReason: chatEvents.failureReason,
              contextType: chatEvents.contextType,
              contextId: chatEvents.contextId,
              runEventSequenceNumber: chatEvents.runEventSequenceNumber,
              runEventId: chatEvents.runEventId,
              seqId: chatEvents.seqId,
              createdAt: chatEvents.createdAt,
            })
            .from(chatEvents)
            .where(
              and(
                eq(chatEvents.chatThreadId, chatThreadId),
                gt(chatEvents.seqId, cursor),
              ),
            )
            .orderBy(asc(chatEvents.seqId))
            .limit(CHAT_EVENT_HISTORY_PAGE_SIZE);
          signal.throwIfAborted();
          tail.push(...rows.map(chatEventRowFromDbRow));
          const last = rows.at(-1);
          if (last) {
            cursor = last.seqId;
          }
          if (rows.length < CHAT_EVENT_HISTORY_PAGE_SIZE) {
            return { head, tail };
          }
        }
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    signal.throwIfAborted();
    if (!captured.head) {
      return captured.tail;
    }
    const compressed = await get(
      downloadS3Buffer(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        captured.head.objectKey,
      ),
    );
    signal.throwIfAborted();
    if (
      createHash("sha256").update(compressed).digest("hex") !==
      snapshotObjectDigest(captured.head.objectKey)
    ) {
      throw new Error("Chat event snapshot checksum is invalid");
    }
    const decompressed = await gunzipAsync(compressed);
    signal.throwIfAborted();
    const snapshot = decodeSnapshotRows(
      decompressed,
      chatThreadId,
      captured.head.lastSeqId,
      {
        eventId: captured.head.terminalEventId,
        seqId: captured.head.terminalSeqId,
      },
    );
    return [...snapshot, ...captured.tail];
  },
);

function decodeSnapshotRows(
  body: Buffer,
  chatThreadId: string,
  lastSeqId: number,
  terminalCursor: {
    readonly eventId: string | null;
    readonly seqId: number | null;
  },
): readonly ChatEventRow[] {
  const rows = decodeChatEventSnapshotBody(body);
  validateChatEventSnapshotRows(rows);
  let previousSeqId: number | null = null;
  for (const row of rows) {
    if (
      row.chatThreadId !== chatThreadId ||
      (previousSeqId !== null && row.seqId <= previousSeqId) ||
      row.seqId > lastSeqId
    ) {
      throw new Error("Chat event snapshot ordering metadata is invalid");
    }
    previousSeqId = row.seqId;
  }
  const storedTerminal = {
    id: rows.at(-1)?.id ?? null,
    seqId: rows.at(-1)?.seqId ?? 0,
  };
  if (
    terminalCursor.seqId !== null &&
    (storedTerminal.id !== terminalCursor.eventId ||
      storedTerminal.seqId !== terminalCursor.seqId)
  ) {
    throw new Error("Chat event snapshot terminal metadata is invalid");
  }
  return rows;
}

function snapshotObjectDigest(objectKey: string): string {
  const digest = /-([0-9a-f]{64})\.ndjson\.gz$/u.exec(objectKey)?.[1];
  if (digest === undefined) {
    throw new Error("Chat event snapshot object key is invalid");
  }
  return digest;
}
