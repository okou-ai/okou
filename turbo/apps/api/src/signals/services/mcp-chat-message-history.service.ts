import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { computed, type Computed } from "ccstate";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";

import { pgInt8ToSafeIntegerDecoder } from "../../lib/db-structured-result";
import type { Tx } from "../../lib/db-types";
import { safeSqlStateCode } from "../../lib/pg-errors";
import type { Db } from "../external/db";
import {
  downloadS3BufferWithMaxBytes,
  S3ObjectSizeLimitError,
} from "../external/s3";
import { awaitWithSignal, safeJsonParse, settleIncludingAbort } from "../utils";
import { chatEventRowFromDbRow } from "./cron-snapshot-chat-events.service";

const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_HISTORY_ROWS = 50_000;
const HISTORY_TIMEOUT_MS = 15_000;
const SQL_TIMEOUT_MS = 3000;
const TAIL_PAGE_SIZE = 1000;
const gunzipAsync = promisify(gunzip);

export class McpMessageHistoryError extends Error {
  constructor(
    readonly kind: "history_limit" | "history_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "McpMessageHistoryError";
  }
}

interface HistoryBudget {
  readonly check: () => void;
  readonly remainingMs: () => number;
  bytes: number;
  rows: number;
}

function createHistoryBudget(signal: AbortSignal): HistoryBudget {
  const deadline = performance.now() + HISTORY_TIMEOUT_MS;
  const check = () => {
    signal.throwIfAborted();
    if (performance.now() >= deadline) {
      throw new McpMessageHistoryError(
        "history_limit",
        "Chat history exceeded the 15 second read budget.",
      );
    }
  };
  return {
    check,
    remainingMs: () => {
      check();
      return Math.max(1, Math.floor(deadline - performance.now()));
    },
    bytes: 0,
    rows: 0,
  };
}

async function boundHistoryQuery(tx: Tx, budget: HistoryBudget): Promise<void> {
  const milliseconds = Math.min(SQL_TIMEOUT_MS, budget.remainingMs());
  await tx.execute(
    sql`SELECT set_config('statement_timeout', ${`${milliseconds.toString()}ms`}, true)`,
  );
  budget.check();
}

function addHistorySize(
  budget: HistoryBudget,
  bytes: number,
  rows: number,
): void {
  budget.check();
  budget.bytes += bytes;
  budget.rows += rows;
  if (budget.bytes > MAX_HISTORY_BYTES || budget.rows > MAX_HISTORY_ROWS) {
    throw new McpMessageHistoryError(
      "history_limit",
      "Chat history exceeds the 32 MiB or 50,000 event read limit.",
    );
  }
}

interface SnapshotHead {
  readonly lastSeqId: number;
  readonly terminalSeqId: number | null;
  readonly terminalEventId: string | null;
  readonly objectKey: string;
}

function decodeHistoryArchive(
  body: Buffer,
  head: SnapshotHead,
  threadId: string,
  budget: HistoryBudget,
): ChatEventRow[] {
  addHistorySize(budget, body.length, 0);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  const rows: ChatEventRow[] = [];
  let start = 0;
  let previousSeqId = 0;
  while (start < text.length) {
    addHistorySize(budget, 0, 1);
    const end = text.indexOf("\n", start);
    if (end === -1) {
      throw new Error("Chat history archive is not newline delimited");
    }
    const row = chatEventRowSchema.parse(safeJsonParse(text.slice(start, end)));
    if (
      row.chatThreadId !== threadId ||
      !Number.isSafeInteger(row.seqId) ||
      row.seqId <= previousSeqId ||
      row.seqId > head.lastSeqId
    ) {
      throw new Error("Chat history archive ordering is invalid");
    }
    chatEventFromRow(row);
    rows.push(row);
    previousSeqId = row.seqId;
    start = end + 1;
  }
  if (
    (rows.at(-1)?.id ?? null) !== head.terminalEventId ||
    (rows.at(-1)?.seqId ?? 0) !== head.terminalSeqId
  ) {
    throw new Error("Chat history archive terminal cursor is invalid");
  }
  budget.check();
  return rows;
}

function historyArchive(
  bucket: string,
  head: SnapshotHead,
  threadId: string,
  budget: HistoryBudget,
  signal: AbortSignal,
): Computed<Promise<ChatEventRow[]>> {
  return computed(async (get) => {
    if (
      !Number.isSafeInteger(head.lastSeqId) ||
      head.lastSeqId <= 0 ||
      head.terminalSeqId === null ||
      !Number.isSafeInteger(head.terminalSeqId) ||
      !(
        (head.terminalSeqId === 0 && head.terminalEventId === null) ||
        (head.terminalSeqId > 0 &&
          head.terminalSeqId <= head.lastSeqId &&
          head.terminalEventId !== null)
      )
    ) {
      throw new Error("Chat history archive pointer is invalid");
    }
    const digest = /-([0-9a-f]{64})\.ndjson\.gz$/u.exec(head.objectKey)?.[1];
    if (digest === undefined) {
      throw new Error("Chat history archive object key is invalid");
    }
    budget.check();
    const compressed = await get(
      downloadS3BufferWithMaxBytes(
        bucket,
        head.objectKey,
        MAX_COMPRESSED_BYTES,
        signal,
      ),
    );
    budget.check();
    if (createHash("sha256").update(compressed).digest("hex") !== digest) {
      throw new Error("Chat history archive checksum is invalid");
    }
    const body = await gunzipAsync(compressed, {
      maxOutputLength: MAX_HISTORY_BYTES,
    });
    budget.check();
    return decodeHistoryArchive(body, head, threadId, budget);
  });
}

interface TailPage {
  readonly afterSeqId: number;
  readonly lastSeqId: number;
  readonly count: number;
}

/**
 * Never fetch unbounded payloads to discover they exceed the read budget.
 * PostgreSQL measures its JSON text before returning any body. The fixed
 * allowance covers UUIDs, sequence/time fields and JSON property names;
 * variable text columns receive the maximum JSON escaping expansion as well.
 */
async function preflightHistoryTail(
  tx: Tx,
  threadId: string,
  afterSeqId: number,
  budget: HistoryBudget,
): Promise<readonly TailPage[]> {
  const pages: TailPage[] = [];
  let cursor = afterSeqId;
  for (;;) {
    await boundHistoryQuery(tx, budget);
    const metadata = await tx
      .select({
        seqId: chatEvents.seqId,
        bytes: sql`(
          COALESCE(octet_length(${chatEvents.payload}::text), 0)::bigint
          + 1024
          + 6 * (
            COALESCE(octet_length(${chatEvents.contextType}), 0)::bigint
            + COALESCE(octet_length(${chatEvents.runEventId}), 0)::bigint
            + COALESCE(octet_length(${chatEvents.failureReason}), 0)::bigint
          )
        )`.mapWith(pgInt8ToSafeIntegerDecoder),
      })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, threadId),
          gt(chatEvents.seqId, cursor),
        ),
      )
      .orderBy(asc(chatEvents.seqId))
      .limit(Math.min(TAIL_PAGE_SIZE, MAX_HISTORY_ROWS - budget.rows + 1));
    budget.check();
    for (const row of metadata) {
      addHistorySize(budget, row.bytes, 1);
    }
    const last = metadata.at(-1);
    if (last === undefined) {
      return pages;
    }
    pages.push({
      afterSeqId: cursor,
      lastSeqId: last.seqId,
      count: metadata.length,
    });
    cursor = last.seqId;
    if (metadata.length < TAIL_PAGE_SIZE) {
      return pages;
    }
  }
}

async function readHistoryTail(
  tx: Tx,
  threadId: string,
  pages: readonly TailPage[],
  budget: HistoryBudget,
): Promise<readonly ChatEventRow[]> {
  const events: ChatEventRow[] = [];
  for (const page of pages) {
    await boundHistoryQuery(tx, budget);
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
          eq(chatEvents.chatThreadId, threadId),
          gt(chatEvents.seqId, page.afterSeqId),
          lte(chatEvents.seqId, page.lastSeqId),
        ),
      )
      .orderBy(asc(chatEvents.seqId))
      .limit(page.count);
    budget.check();
    if (rows.length !== page.count) {
      throw new Error("Chat history tail changed inside its read snapshot");
    }
    for (const row of rows) {
      budget.check();
      const event = chatEventRowFromDbRow(row);
      chatEventFromRow(event);
      events.push(event);
    }
  }
  return events;
}

function historyReadFailure(error: unknown): McpMessageHistoryError {
  if (error instanceof McpMessageHistoryError) {
    return error;
  }
  if (
    error instanceof S3ObjectSizeLimitError ||
    (error instanceof RangeError &&
      "code" in error &&
      error.code === "ERR_BUFFER_TOO_LARGE") ||
    safeSqlStateCode(error) === "57014"
  ) {
    return new McpMessageHistoryError(
      "history_limit",
      "Chat history exceeded its byte or database query budget.",
    );
  }
  return new McpMessageHistoryError(
    "history_unavailable",
    "Chat history could not be read completely. Retry the request later.",
  );
}

/** Authorized, complete history within an explicit resource envelope. */
export function readMcpChatMessageHistory(
  runtime: { readonly db: Db; readonly bucket: string },
  principal: { readonly userId: string; readonly orgId: string },
  threadId: string,
  signal: AbortSignal,
): Computed<Promise<readonly ChatEventRow[] | null>> {
  return computed(async (get) => {
    const budget = createHistoryBudget(signal);
    budget.check();
    const historySignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(HISTORY_TIMEOUT_MS),
    ]);
    // Bound the response even while pg is waiting to acquire a pooled client.
    // The transaction promise stays observed if cancellation wins. A late
    // acquisition checks the budget before business reads, then Drizzle owns
    // rollback/release; in-flight SELECTs also have server-side deadlines.
    const result = await settleIncludingAbort(
      awaitWithSignal(
        runtime.db.transaction(
          async (tx) => {
            budget.check();
            await boundHistoryQuery(tx, budget);
            const [owned] = await tx
              .select({ id: chatThreads.id })
              .from(chatThreads)
              .innerJoin(agents, eq(agents.id, chatThreads.agentId))
              .where(
                and(
                  eq(chatThreads.id, threadId),
                  eq(chatThreads.userId, principal.userId),
                  eq(agents.orgId, principal.orgId),
                ),
              )
              .limit(1);
            budget.check();
            if (owned === undefined) {
              return null;
            }
            await boundHistoryQuery(tx, budget);
            const [head] = await tx
              .select({
                lastSeqId: chatEventSnapshots.lastSeqId,
                terminalSeqId: chatEventSnapshots.terminalSeqId,
                terminalEventId: chatEventSnapshots.terminalEventId,
                objectKey: chatEventSnapshots.objectKey,
              })
              .from(chatEventSnapshots)
              .where(
                and(
                  eq(chatEventSnapshots.chatThreadId, threadId),
                  eq(
                    chatEventSnapshots.archiveSchemaVersion,
                    CURRENT_CHAT_EVENT_SCHEMA_VERSION,
                  ),
                ),
              )
              .limit(1);
            budget.check();
            const archive = head
              ? await get(
                  historyArchive(
                    runtime.bucket,
                    head,
                    threadId,
                    budget,
                    historySignal,
                  ),
                )
              : [];
            const pages = await preflightHistoryTail(
              tx,
              threadId,
              head?.lastSeqId ?? 0,
              budget,
            );
            const tail = await readHistoryTail(tx, threadId, pages, budget);
            const history = [...archive, ...tail];
            const eventIds = new Set<string>();
            for (const event of history) {
              budget.check();
              if (eventIds.has(event.id)) {
                // Historical archives can contain IDs that the canonical
                // snapshot writer has not normalized yet. Their revoke and
                // content references are ambiguous until that repair lands.
                throw new Error("Chat history event identity is ambiguous");
              }
              eventIds.add(event.id);
            }
            budget.check();
            return history;
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        ),
        historySignal,
      ),
    );
    budget.check();
    if (!result.ok) {
      throw historyReadFailure(result.error);
    }
    return result.value;
  });
}
