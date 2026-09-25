import { z } from "zod";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { command } from "ccstate";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  activeInputDeliveries,
  activeInputDeliveryItems,
} from "@okouai/db/schema/active-input-delivery";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventRetentionCursors } from "@okouai/db/schema/chat-event-retention-cursor";
import { chatEventSearchMessageWatermarks } from "@okouai/db/schema/chat-event-search";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";

import {
  executeRawRows,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { nowDate, timestampWithoutTimeZone } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";

const CHAT_EVENT_RETENTION_DAYS = 30;
const CHAT_EVENT_RETENTION_SCAN_LIMIT = 2500;
const CHAT_EVENT_RETENTION_DELETE_CHUNK = 500;
/**
 * The sweep resumes after its cursor and restarts from the oldest row once per
 * interval, so rows it had to hold are rechecked hourly rather than on every
 * run and cannot starve rows behind them.
 */
const CHAT_EVENT_RETENTION_SWEEP_RESTART_MS = 60 * 60 * 1000;
function isPendingInputEventType(eventType: string): boolean {
  return (
    eventType === "input.prompt" ||
    eventType === "input.automation" ||
    eventType === "input.goal" ||
    eventType === "input.budget"
  );
}

function isTerminalRunStatus(status: string): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled"
  );
}

export interface ChatEventRetentionStats {
  readonly cutoff: string;
  readonly scanLimit: number;
  readonly scanned: number;
  readonly deleted: number;
  readonly skippedSnapshot: number;
  readonly skippedSearchWatermark: number;
  readonly skippedPendingRunless: number;
  readonly skippedNonterminalRun: number;
  readonly skippedActiveInput: number;
  readonly hasMore: boolean;
  readonly sweepRestarted: boolean;
  readonly durationMs: number;
}

type ChatEventRetentionScope =
  | { readonly kind: "global" }
  | {
      readonly kind: "fixtures";
      readonly chatThreadIds: readonly string[];
    };

type SkipReason =
  | "snapshot"
  | "search_watermark"
  | "pending_runless"
  | "nonterminal_run"
  | "active_input";

interface ScannedEvent {
  readonly id: string;
  readonly chatThreadId: string;
  readonly runId: string | null;
  readonly eventType: string;
  readonly seqId: number;
  readonly createdAt: string;
}

const cutoffRowSchema = z.object({
  cutoff: pgTimestampWithoutTimezoneToDateSchema,
});

async function loadRetentionCutoff(db: Pick<Db, "execute">): Promise<Date> {
  const rows = await executeRawRows(
    db,
    sql`
      SELECT (
        timezone('UTC', now())
        - ${CHAT_EVENT_RETENTION_DAYS} * interval '1 day'
      )::timestamp AS cutoff
    `,
    cutoffRowSchema,
  );
  const cutoff = rows[0]?.cutoff;
  if (cutoff === undefined) {
    throw new Error("Chat event retention cutoff query returned no row");
  }
  return cutoff;
}

function scopeKey(scope: ChatEventRetentionScope): string {
  return scope.kind === "global"
    ? "global"
    : `fixtures:${[...scope.chatThreadIds].sort().join(",")}`;
}

async function scanPage(
  db: Db,
  args: {
    readonly cutoff: string;
    readonly scope: ChatEventRetentionScope;
    readonly after?: { readonly createdAt: string; readonly id: string };
  },
): Promise<readonly ScannedEvent[]> {
  return await db
    .select({
      id: chatEvents.id,
      chatThreadId: chatEvents.chatThreadId,
      runId: chatEvents.runId,
      eventType: chatEvents.eventType,
      seqId: chatEvents.seqId,
      // Text keeps microseconds so the cursor compares at full precision.
      createdAt: sql`${chatEvents.createdAt}::text`.mapWith(pgTextDecoder),
    })
    .from(chatEvents)
    .where(
      and(
        lt(chatEvents.createdAt, sql`${args.cutoff}::timestamp`),
        args.scope.kind === "global"
          ? undefined
          : inArray(chatEvents.chatThreadId, args.scope.chatThreadIds),
        args.after === undefined
          ? undefined
          : sql`(${chatEvents.createdAt}, ${chatEvents.id}) > (${args.after.createdAt}::timestamp, ${args.after.id}::uuid)`,
      ),
    )
    .orderBy(asc(chatEvents.createdAt), asc(chatEvents.id))
    .limit(CHAT_EVENT_RETENTION_SCAN_LIMIT);
}

async function archivedSeqIds(
  db: Db,
  chatThreadIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const rows = await db
    .select({
      chatThreadId: chatEventSnapshots.chatThreadId,
      lastSeqId: chatEventSnapshots.lastSeqId,
    })
    .from(chatEventSnapshots)
    .where(
      and(
        inArray(chatEventSnapshots.chatThreadId, chatThreadIds),
        eq(
          chatEventSnapshots.archiveSchemaVersion,
          CURRENT_CHAT_EVENT_SCHEMA_VERSION,
        ),
        sql`${chatEventSnapshots.objectKey} ~ '-[0-9a-f]{64}[.]ndjson[.]gz$'`,
      ),
    );
  const archived = new Map<string, number>();
  for (const row of rows) {
    archived.set(
      row.chatThreadId,
      Math.max(archived.get(row.chatThreadId) ?? 0, row.lastSeqId),
    );
  }
  return archived;
}

async function indexedSeqIds(
  db: Db,
  chatThreadIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const rows = await db
    .select({
      chatThreadId: chatEventSearchMessageWatermarks.chatThreadId,
      indexedSeqId: chatEventSearchMessageWatermarks.indexedSeqId,
    })
    .from(chatEventSearchMessageWatermarks)
    .where(
      inArray(chatEventSearchMessageWatermarks.chatThreadId, chatThreadIds),
    );
  return new Map(
    rows.map((row) => {
      return [row.chatThreadId, row.indexedSeqId];
    }),
  );
}

async function revokedEventIds(
  db: Db,
  eventIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (eventIds.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ revokesEventId: chatEvents.revokesEventId })
    .from(chatEvents)
    .where(inArray(chatEvents.revokesEventId, eventIds));
  return new Set(
    rows.flatMap((row) => {
      return row.revokesEventId === null ? [] : [row.revokesEventId];
    }),
  );
}

async function nonterminalRunIds(
  db: Db,
  runIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (runIds.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ id: agentRuns.id, status: agentRuns.status })
    .from(agentRuns)
    .where(inArray(agentRuns.id, runIds));
  return new Set(
    rows
      .filter((row) => {
        return !isTerminalRunStatus(row.status);
      })
      .map((row) => {
        return row.id;
      }),
  );
}

async function activeInputSourceIds(
  db: Db,
  eventIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const items = await db
    .select({
      sourceEventId: activeInputDeliveryItems.sourceEventId,
      deliveryId: activeInputDeliveryItems.deliveryId,
      disposition: activeInputDeliveryItems.disposition,
    })
    .from(activeInputDeliveryItems)
    .where(inArray(activeInputDeliveryItems.sourceEventId, eventIds));
  if (items.length === 0) {
    return new Set();
  }
  const openDeliveries = await db
    .select({ id: activeInputDeliveries.id })
    .from(activeInputDeliveries)
    .where(
      and(
        inArray(
          activeInputDeliveries.id,
          items.map((item) => {
            return item.deliveryId;
          }),
        ),
        eq(activeInputDeliveries.status, "open"),
      ),
    );
  const openDeliveryIds = new Set(
    openDeliveries.map((delivery) => {
      return delivery.id;
    }),
  );
  return new Set(
    items
      .filter((item) => {
        return (
          item.disposition === null || openDeliveryIds.has(item.deliveryId)
        );
      })
      .map((item) => {
        return item.sourceEventId;
      }),
  );
}

/**
 * Classify with bounded single-table reads and no locks. Every hold resolves
 * monotonically (archives and watermarks advance, runs terminate, deliveries
 * settle), so a stale read can only hold a row for one more sweep.
 */
async function classify(
  db: Db,
  events: readonly ScannedEvent[],
): Promise<ReadonlyMap<string, SkipReason | null>> {
  const eventIds = events.map((event) => {
    return event.id;
  });
  const chatThreadIds = [
    ...new Set(
      events.map((event) => {
        return event.chatThreadId;
      }),
    ),
  ];
  const runlessInputIds = events
    .filter((event) => {
      return event.runId === null && isPendingInputEventType(event.eventType);
    })
    .map((event) => {
      return event.id;
    });
  const runIds = [
    ...new Set(
      events.flatMap((event) => {
        return event.runId === null ? [] : [event.runId];
      }),
    ),
  ];
  const archived = await archivedSeqIds(db, chatThreadIds);
  const indexed = await indexedSeqIds(db, chatThreadIds);
  const revoked = await revokedEventIds(db, runlessInputIds);
  const nonterminal = await nonterminalRunIds(db, runIds);
  const activeInputs = await activeInputSourceIds(db, eventIds);

  return new Map(
    events.map((event) => {
      const archivedSeqId = archived.get(event.chatThreadId);
      const indexedSeqId = indexed.get(event.chatThreadId);
      let reason: SkipReason | null = null;
      if (archivedSeqId === undefined || archivedSeqId < event.seqId) {
        reason = "snapshot";
      } else if (indexedSeqId === undefined || indexedSeqId < event.seqId) {
        reason = "search_watermark";
      } else if (
        event.runId === null &&
        isPendingInputEventType(event.eventType) &&
        !revoked.has(event.id)
      ) {
        reason = "pending_runless";
      } else if (event.runId !== null && nonterminal.has(event.runId)) {
        reason = "nonterminal_run";
      } else if (activeInputs.has(event.id)) {
        reason = "active_input";
      }
      return [event.id, reason];
    }),
  );
}

async function deleteEvents(
  db: Db,
  eventIds: readonly string[],
  cutoff: string,
): Promise<number> {
  let deleted = 0;
  for (
    let start = 0;
    start < eventIds.length;
    start += CHAT_EVENT_RETENTION_DELETE_CHUNK
  ) {
    const rows = await db
      .delete(chatEvents)
      .where(
        and(
          inArray(
            chatEvents.id,
            eventIds.slice(start, start + CHAT_EVENT_RETENTION_DELETE_CHUNK),
          ),
          lt(chatEvents.createdAt, sql`${cutoff}::timestamp`),
        ),
      )
      .returning({ id: chatEvents.id });
    deleted += rows.length;
  }
  return deleted;
}

async function saveCursor(
  db: Db,
  key: string,
  last: ScannedEvent,
  sweepStartedAt: Date,
): Promise<void> {
  const cursor = {
    lastCreatedAt: last.createdAt,
    lastEventId: last.id,
    sweepStartedAt,
  };
  await db
    .insert(chatEventRetentionCursors)
    .values({ scopeKey: key, ...cursor })
    .onConflictDoUpdate({
      target: chatEventRetentionCursors.scopeKey,
      set: cursor,
    });
}

async function retainChatEventPage(
  db: Db,
  scope: ChatEventRetentionScope,
  signal: AbortSignal,
): Promise<Omit<ChatEventRetentionStats, "durationMs">> {
  const cutoffDate = await loadRetentionCutoff(db);
  const cutoff = timestampWithoutTimeZone(cutoffDate);
  const key = scopeKey(scope);
  const [cursor] = await db
    .select()
    .from(chatEventRetentionCursors)
    .where(eq(chatEventRetentionCursors.scopeKey, key))
    .limit(1);
  signal.throwIfAborted();
  const currentTime = nowDate();
  const sweepRestarted =
    cursor === undefined ||
    currentTime.getTime() - cursor.sweepStartedAt.getTime() >=
      CHAT_EVENT_RETENTION_SWEEP_RESTART_MS;
  const events = await scanPage(db, {
    cutoff,
    scope,
    after: sweepRestarted
      ? undefined
      : { createdAt: cursor.lastCreatedAt, id: cursor.lastEventId },
  });
  signal.throwIfAborted();
  const reasons: ReadonlyMap<string, SkipReason | null> =
    events.length === 0 ? new Map() : await classify(db, events);
  signal.throwIfAborted();
  const deletableIds = events
    .filter((event) => {
      return reasons.get(event.id) === null;
    })
    .map((event) => {
      return event.id;
    });
  const deleted = await deleteEvents(db, deletableIds, cutoff);
  signal.throwIfAborted();
  const last = events.at(-1);
  if (last !== undefined) {
    await saveCursor(
      db,
      key,
      last,
      sweepRestarted ? currentTime : cursor.sweepStartedAt,
    );
    signal.throwIfAborted();
  }

  const count = (reason: SkipReason): number => {
    return events.filter((event) => {
      return reasons.get(event.id) === reason;
    }).length;
  };
  return {
    cutoff: cutoffDate.toISOString(),
    scanLimit: CHAT_EVENT_RETENTION_SCAN_LIMIT,
    scanned: events.length,
    deleted,
    skippedSnapshot: count("snapshot"),
    skippedSearchWatermark: count("search_watermark"),
    skippedPendingRunless: count("pending_runless"),
    skippedNonterminalRun: count("nonterminal_run"),
    skippedActiveInput: count("active_input"),
    hasMore: events.length === CHAT_EVENT_RETENTION_SCAN_LIMIT,
    sweepRestarted,
  };
}

export const retainChatEvents$ = command(
  async (
    { set },
    scope: ChatEventRetentionScope,
    signal: AbortSignal,
  ): Promise<ChatEventRetentionStats> => {
    const startedAt = performance.now();
    const result = await retainChatEventPage(set(writeDb$), scope, signal);
    return {
      ...result,
      durationMs: Math.round(performance.now() - startedAt),
    };
  },
);
