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
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { command } from "ccstate";
import { and, asc, eq, gt, sql, type SQLWrapper } from "drizzle-orm";
import { pgInt8ToSafeIntegerDecoder } from "../../lib/db-structured-result";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import {
  downloadS3BufferWithMaxBytes,
  S3ObjectSizeLimitError,
} from "../external/s3";
import { awaitWithSignal, safeJsonParse, settleIncludingAbort } from "../utils";
import { chatEventRowFromDbRow } from "./cron-snapshot-chat-events.service";

const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
export const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
export const MAX_HISTORY_ROWS = 50_000;
const HISTORY_TIMEOUT_MS = 15_000;
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
export interface HistoryBudget {
  readonly check: () => void;
  bytes: number;
  rows: number;
}
export function createMcpChatHistoryBudget(signal: AbortSignal): HistoryBudget {
  const deadline = performance.now() + HISTORY_TIMEOUT_MS;
  return {
    check() {
      signal.throwIfAborted();
      if (performance.now() >= deadline) {
        throw new McpMessageHistoryError(
          "history_limit",
          "Chat history exceeded the 15 second read budget.",
        );
      }
    },
    bytes: 0,
    rows: 0,
  };
}
export function addHistorySize(
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
export function historyReadFailure(error: unknown): McpMessageHistoryError {
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

/** Preflight payloads before transferring them, shared by targeted input reads. */
export function chatEventHistoryBytes(columns: {
  readonly payload: SQLWrapper;
  readonly contextType: SQLWrapper;
  readonly runEventId: SQLWrapper;
  readonly failureReason: SQLWrapper;
}) {
  return sql`(COALESCE(octet_length(${columns.payload}::text), 0)::bigint + 1024 + 6 * (COALESCE(octet_length(${columns.contextType}), 0)::bigint + COALESCE(octet_length(${columns.runEventId}), 0)::bigint + COALESCE(octet_length(${columns.failureReason}), 0)::bigint))`.mapWith(
    pgInt8ToSafeIntegerDecoder,
  );
}

interface HistoryQueryFacts {
  readonly principal: { readonly userId: string; readonly orgId: string };
  readonly threadId: string;
}

/** The owning command keeps all SQL in one authorized repeatable-read snapshot. */
const readHistorySnapshot$ = command(
  async (
    { set },
    { principal, threadId }: HistoryQueryFacts,
    budget: HistoryBudget,
    signal: AbortSignal,
  ) => {
    const selected = await awaitWithSignal(
      // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0180; new non-billing transactions are prohibited.
      set(writeDb$).transaction(
        async (tx) => {
          budget.check();
          await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
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
          if (!owned) {
            return null;
          }
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
          // Measure JSON/text before requesting payloads. The fixed overhead covers
          // identifiers, timestamps and keys; six is the maximal JSON escaping cost.
          const metadata = await tx
            .select({
              seqId: chatEvents.seqId,
              bytes: chatEventHistoryBytes(chatEvents),
            })
            .from(chatEvents)
            .where(
              and(
                eq(chatEvents.chatThreadId, threadId),
                gt(chatEvents.seqId, head?.lastSeqId ?? 0),
              ),
            )
            .orderBy(asc(chatEvents.seqId))
            .limit(MAX_HISTORY_ROWS - budget.rows + 1);
          for (const row of metadata) {
            addHistorySize(budget, row.bytes, 1);
          }
          const tail = await tx
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
                gt(chatEvents.seqId, head?.lastSeqId ?? 0),
              ),
            )
            .orderBy(asc(chatEvents.seqId))
            .limit(metadata.length + 1);
          budget.check();
          if (tail.length !== metadata.length) {
            throw new Error(
              "Chat history tail changed inside its read snapshot",
            );
          }
          return { head, tail: tail.map(chatEventRowFromDbRow) };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      ),
      signal,
    );
    budget.check();
    return selected;
  },
);

function historyArchiveDigest(head: SnapshotHead): string {
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
  return digest;
}

/** Archive IO is a separate finite read after the SQL snapshot releases its client. */
const readHistoryArchive$ = command(
  async (
    { get },
    {
      head,
      threadId,
    }: { readonly head: SnapshotHead; readonly threadId: string },
    budget: HistoryBudget,
    signal: AbortSignal,
  ): Promise<ChatEventRow[]> => {
    const digest = historyArchiveDigest(head);
    const compressed = await get(
      downloadS3BufferWithMaxBytes(
        env("R2_USER_STORAGES_BUCKET_NAME"),
        head.objectKey,
        MAX_COMPRESSED_BYTES,
        signal,
      ),
    );
    signal.throwIfAborted();
    budget.check();
    if (createHash("sha256").update(compressed).digest("hex") !== digest) {
      throw new Error("Chat history archive checksum is invalid");
    }
    const body = await gunzipAsync(compressed, {
      maxOutputLength: Math.max(1, MAX_HISTORY_BYTES - budget.bytes),
    });
    signal.throwIfAborted();
    budget.check();
    return decodeHistoryArchive(body, head, threadId, budget);
  },
);

function projectHistory(
  archive: readonly ChatEventRow[],
  tail: readonly ChatEventRow[],
  budget: HistoryBudget,
): readonly ChatEventRow[] {
  const history = [...archive, ...tail];
  const eventIds = new Set<string>();
  for (const event of history) {
    budget.check();
    chatEventFromRow(event);
    if (eventIds.has(event.id)) {
      throw new Error("Chat history event identity is ambiguous");
    }
    eventIds.add(event.id);
  }
  return history;
}

/** Snapshot pointer/preflight/tail stay atomic; archive IO runs outside SQL. */
export const readMcpChatMessageHistory$ = command(
  async (
    { set },
    principal: { readonly userId: string; readonly orgId: string },
    threadId: string,
    budget: HistoryBudget,
    signal: AbortSignal,
  ): Promise<readonly ChatEventRow[] | null> => {
    const operationSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(HISTORY_TIMEOUT_MS),
    ]);
    const result = await settleIncludingAbort(
      (async () => {
        const selected = await set(
          readHistorySnapshot$,
          { principal, threadId },
          budget,
          operationSignal,
        );
        budget.check();
        if (!selected) {
          return null;
        }
        const { head, tail } = selected;
        const archive = head
          ? await set(
              readHistoryArchive$,
              { head, threadId },
              budget,
              operationSignal,
            )
          : [];
        return projectHistory(archive, tail, budget);
      })(),
    );
    signal.throwIfAborted();
    budget.check();
    if (!result.ok) {
      throw historyReadFailure(result.error);
    }
    return result.value;
  },
);
