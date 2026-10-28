import { object } from "zod";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { command } from "ccstate";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventRetentionCursors } from "@okouai/db/schema/chat-event-retention-cursor";
import { chatEventSearchMessageWatermarks } from "@okouai/db/schema/chat-event-search";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";

import {
  parseRawRows,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import { retentionEventRowSelection } from "./chat-event-row-read.service";
import { nowDate, timestampWithoutTimeZone } from "../../lib/time";
import { db$, rawSqlReadDb$, writeDb$ } from "../external/db";

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
  readonly hasMore: boolean;
  readonly sweepRestarted: boolean;
  readonly durationMs: number;
}

type SkipReason =
  "snapshot" | "search_watermark" | "pending_runless" | "nonterminal_run";

interface ScannedEvent {
  readonly id: string;
  readonly chatThreadId: string;
  readonly runId: string | null;
  readonly eventType: string;
  readonly seqId: number;
  readonly createdAt: string;
}

const cutoffRowSchema = object({
  cutoff: pgTimestampWithoutTimezoneToDateSchema,
});

const scanPage$ = command(
  async (
    { get },
    args: {
      readonly cutoff: string;
      readonly after?: { readonly createdAt: string; readonly id: string };
    },
  ): Promise<readonly ScannedEvent[]> => {
    const db = get(db$);
    return await db
      .select(retentionEventRowSelection())
      .from(chatEvents)
      .where(
        and(
          lt(chatEvents.createdAt, sql`${args.cutoff}::timestamp`),
          args.after === undefined
            ? undefined
            : sql`(${chatEvents.createdAt}, ${chatEvents.id}) > (${args.after.createdAt}::timestamp, ${args.after.id}::uuid)`,
        ),
      )
      .orderBy(asc(chatEvents.createdAt), asc(chatEvents.id))
      .limit(CHAT_EVENT_RETENTION_SCAN_LIMIT);
  },
);

/**
 * Classify with bounded single-table reads and no locks. Every hold resolves
 * monotonically (archives and watermarks advance, runs terminate), so a
 * stale read can only hold a row for one more sweep.
 */
const classify$ = command(
  async (
    { get },
    events: readonly ScannedEvent[],
  ): Promise<ReadonlyMap<string, SkipReason | null>> => {
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
    const db = get(db$);
    const archived = await (async (): Promise<ReadonlyMap<string, number>> => {
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
    })();
    const indexed = await (async (): Promise<ReadonlyMap<string, number>> => {
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
    })();
    const revoked = await (async (): Promise<ReadonlySet<string>> => {
      const eventIds = runlessInputIds;

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
    })();
    const nonterminal = await (async (): Promise<ReadonlySet<string>> => {
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
    })();

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
        }
        return [event.id, reason];
      }),
    );
  },
);

const deleteEvents$ = command(
  async (
    { set },
    eventIds: readonly string[],
    cutoff: string,
  ): Promise<number> => {
    const db = set(writeDb$);
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
  },
);

const loadRetentionScanStart$ = command(async ({ get }) => {
  const db = get(rawSqlReadDb$);
  const cutoffQuery = sql`
      SELECT (
        timezone('UTC', now())
        - ${CHAT_EVENT_RETENTION_DAYS} * interval '1 day'
      )::timestamp AS cutoff
    `;
  const rowSchema = cutoffRowSchema;
  const rows = await (async () => {
    return parseRawRows(rowSchema, await db.execute(cutoffQuery));
  })();
  const cutoffDate = rows[0]?.cutoff;
  if (cutoffDate === undefined) {
    throw new Error("Chat event retention cutoff query returned no row");
  }
  const cutoff = timestampWithoutTimeZone(cutoffDate);
  const key = "global";
  const readDb = get(db$);
  const [cursor] = await readDb
    .select()
    .from(chatEventRetentionCursors)
    .where(eq(chatEventRetentionCursors.scopeKey, key))
    .limit(1);
  return { cutoffDate, cutoff, key, cursor };
});

const retainChatEventPage$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<Omit<ChatEventRetentionStats, "durationMs">> => {
    const { cutoffDate, cutoff, key, cursor } = await set(
      loadRetentionScanStart$,
    );
    signal.throwIfAborted();
    const currentTime = nowDate();
    const sweepRestarted =
      cursor === undefined ||
      currentTime.getTime() - cursor.sweepStartedAt.getTime() >=
        CHAT_EVENT_RETENTION_SWEEP_RESTART_MS;
    const events = await set(scanPage$, {
      cutoff,
      after: sweepRestarted
        ? undefined
        : { createdAt: cursor.lastCreatedAt, id: cursor.lastEventId },
    });
    signal.throwIfAborted();
    const reasons: ReadonlyMap<string, SkipReason | null> =
      events.length === 0 ? new Map() : await set(classify$, events);
    signal.throwIfAborted();
    const deletableIds = events
      .filter((event) => {
        return reasons.get(event.id) === null;
      })
      .map((event) => {
        return event.id;
      });
    const deleted = await set(deleteEvents$, deletableIds, cutoff);
    signal.throwIfAborted();
    const last = events.at(-1);
    if (last !== undefined) {
      const sweepStartedAt = sweepRestarted
        ? currentTime
        : cursor.sweepStartedAt;
      await (async (): Promise<void> => {
        const db = set(writeDb$);

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
      })();
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
      hasMore: events.length === CHAT_EVENT_RETENTION_SCAN_LIMIT,
      sweepRestarted,
    };
  },
);

export const retainChatEvents$ = command(
  async ({ set }, signal: AbortSignal): Promise<ChatEventRetentionStats> => {
    const startedAt = performance.now();
    set(writeDb$);
    const result = await set(retainChatEventPage$, signal);
    return {
      ...result,
      durationMs: Math.round(performance.now() - startedAt),
    };
  },
);
