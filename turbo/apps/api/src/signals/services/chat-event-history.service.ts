import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { computed, type Computed } from "ccstate";
import { and, asc, eq, gt } from "drizzle-orm";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";

import type { Db } from "../external/db";
import { downloadS3Buffer } from "../external/s3";
import {
  decodeChatEventSnapshotBody,
  validateChatEventSnapshotRows,
} from "./chat-event-snapshot-body.service";
import { chatEventRowFromDbRow } from "./cron-snapshot-chat-events.service";

const gunzipAsync = promisify(gunzip);
const CHAT_EVENT_HISTORY_PAGE_SIZE = 1000;

interface ChatEventHistoryRuntime {
  readonly db: Db;
  readonly bucket: string;
}

type ChatEventHistoryQueryDb = Pick<Db, "select">;

async function readPostgresTail(
  db: ChatEventHistoryQueryDb,
  chatThreadId: string,
  afterSeqId: number,
  signal: AbortSignal,
): Promise<readonly ChatEventRow[]> {
  const events: ChatEventRow[] = [];
  let cursor = afterSeqId;
  for (;;) {
    const rows = await db
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
    events.push(...rows.map(chatEventRowFromDbRow));
    const lastRow = rows[rows.length - 1];
    if (lastRow !== undefined) {
      cursor = lastRow.seqId;
    }
    if (rows.length < CHAT_EVENT_HISTORY_PAGE_SIZE) {
      return events;
    }
  }
}

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

/** Read and validate one immutable snapshot using only its published values. */
export function readChatEventSnapshotObject(
  bucket: string,
  chatThreadId: string,
  head: {
    readonly objectKey: string;
    readonly archiveSchemaVersion: number;
    readonly lastSeqId: number;
    readonly terminalEventId: string | null;
    readonly terminalSeqId: number | null;
  },
  signal: AbortSignal,
): Computed<Promise<readonly ChatEventRow[]>> {
  return computed(async (get) => {
    const compressed = await get(downloadS3Buffer(bucket, head.objectKey));
    signal.throwIfAborted();
    if (
      createHash("sha256").update(compressed).digest("hex") !==
      snapshotObjectDigest(head.objectKey)
    ) {
      throw new Error("Chat event snapshot checksum is invalid");
    }
    const decompressed = await gunzipAsync(compressed);
    const snapshot = decodeSnapshotRows(
      decompressed,
      chatThreadId,
      head.lastSeqId,
      {
        eventId: head.terminalEventId,
        seqId: head.terminalSeqId,
      },
    );
    signal.throwIfAborted();
    return snapshot;
  });
}

export function readCurrentChatEventHistoryAtSnapshot(
  runtime: Omit<ChatEventHistoryRuntime, "db"> & {
    readonly db: ChatEventHistoryQueryDb;
  },
  chatThreadId: string,
  signal: AbortSignal,
): Computed<Promise<readonly ChatEventRow[]>> {
  return computed(async (get) => {
    const [head] = await runtime.db
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

    if (head === undefined) {
      return await readPostgresTail(runtime.db, chatThreadId, 0, signal);
    }
    if (head.lastSeqId <= 0 || head.objectKey.trim().length === 0) {
      throw new Error("Chat event snapshot head is not reusable");
    }

    const snapshot = await get(
      readChatEventSnapshotObject(runtime.bucket, chatThreadId, head, signal),
    );
    signal.throwIfAborted();
    const tail = await readPostgresTail(
      runtime.db,
      chatThreadId,
      head.lastSeqId,
      signal,
    );
    return [...snapshot, ...tail];
  });
}

/** Current logical history with PostgreSQL continuation after physical coverage. */
export function readCurrentChatEventHistory(
  runtime: ChatEventHistoryRuntime,
  chatThreadId: string,
  signal: AbortSignal,
): Computed<Promise<readonly ChatEventRow[]>> {
  return computed(async (get) => {
    return await runtime.db.transaction(
      async (tx) => {
        return await get(
          readCurrentChatEventHistoryAtSnapshot(
            { ...runtime, db: tx },
            chatThreadId,
            signal,
          ),
        );
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  });
}
