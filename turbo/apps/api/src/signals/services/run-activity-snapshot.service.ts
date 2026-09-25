import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { eventConsumerPayload$ } from "../../lib/event-consumer/route";
import { logger } from "../../lib/log";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { activityRevision, mergeActivity } from "../../lib/run-activity";
import { writeDb$ } from "../external/db";
import { settleIncludingAbort } from "../utils";
import type { RunContentOwnership } from "./run-content-erasure-admission.service";

const log = logger("api:run-activity");

export const activityClock = sql`(statement_timestamp() AT TIME ZONE 'UTC')`;

/**
 * Best-effort activity capture: one primary-key read, then one compare-and-set
 * UPDATE on the run's active row. A run without an active row (terminal, or
 * created before the row existed) simply has no activity. Losing the race to
 * a concurrent delivery is acceptable; the next delivery merges again.
 */
export const captureRunActivity$ = command(
  async ({ get, set }, ownership: RunContentOwnership, signal: AbortSignal) => {
    signal.throwIfAborted();
    const payload = get(eventConsumerPayload$);
    if (!ownership.thread || mergeActivity([], payload.events).length === 0) {
      return { status: 200 };
    }
    const db = set(writeDb$);
    const identity = and(
      eq(activeAgentRuns.runId, payload.runId),
      eq(activeAgentRuns.userId, payload.context.userId),
    );
    const outcome = await settleIncludingAbort(
      (async () => {
        const [row] = await db
          .select({
            entries: activeAgentRuns.activityEntries,
            revision: activeAgentRuns.activityRevision,
          })
          .from(activeAgentRuns)
          .where(identity);
        signal.throwIfAborted();
        if (!row) {
          return;
        }
        const entries = mergeActivity(row.entries, payload.events);
        const revision = activityRevision(entries);
        if (revision === row.revision) {
          return;
        }
        await db
          .update(activeAgentRuns)
          .set({ activityEntries: entries, activityRevision: revision })
          .where(
            and(identity, eq(activeAgentRuns.activityRevision, row.revision)),
          );
      })(),
    );
    signal.throwIfAborted();
    if (outcome.ok) {
      return { status: 200 };
    }
    // Never attach a database error: driver messages can include bound
    // evidence. The SQLSTATE class code carries no content and stays.
    const errorCode = safeSqlStateCode(outcome.error);
    log.warn("Activity snapshot capture failed", {
      runId: payload.runId,
      eventCount: payload.events.length,
      ...(errorCode === undefined ? {} : { errorCode }),
    });
    return { status: 200 };
  },
);
