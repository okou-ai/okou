import { CANCELLATION_RECOVERY_STALE_AFTER_MS } from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { command } from "ccstate";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  notInArray,
  sql,
} from "drizzle-orm";
import { eventConsumerPayload$ } from "../../lib/event-consumer/route";
import { logger } from "../../lib/log";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { activityRevision, mergeActivity } from "../../lib/run-activity";
import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { settleIncludingAbort } from "../utils";

const log = logger("api:run-activity");

export const activityClock = sql`(statement_timestamp() AT TIME ZONE 'UTC')`;

const STALE_RELEASE_LIMIT = 500;

/**
 * Best-effort activity capture: one primary-key read, then one compare-and-set
 * UPDATE on the run's active row. A run without an active row (terminal, or
 * created before the row existed) simply has no activity. Losing the race to
 * a concurrent delivery is acceptable; the next delivery merges again.
 */
export const captureRunActivity$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const payload = get(eventConsumerPayload$);
    if (mergeActivity([], payload.events).length === 0) {
      return { status: 200 };
    }
    const db = set(writeDb$);
    const identity = and(
      eq(activeAgentRuns.runId, payload.runId),
      eq(activeAgentRuns.userId, payload.context.userId),
      isNotNull(activeAgentRuns.chatThreadId),
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

/**
 * A run that reached `running` keeps its active row after it turns terminal
 * until the runner reports completion. When the runner never does, release the
 * row once the run has been terminal and its sandbox silent for the
 * cancellation-recovery grace. Three bounded statements, no transaction.
 */
export const releaseStaleTerminalActiveAgentRuns$ = command(
  async ({ set }, runIds: readonly string[] | null, signal: AbortSignal) => {
    const db = set(writeDb$);
    const staleBefore = new Date(
      nowDate().getTime() - CANCELLATION_RECOVERY_STALE_AFTER_MS,
    );
    const outcome = await settleIncludingAbort(
      (async () => {
        // Newest silence first: long-queued rows never heartbeat and must not
        // crowd out runs that just ended.
        const silent = await db
          .select({ runId: activeAgentRuns.runId })
          .from(activeAgentRuns)
          .where(
            and(
              lt(activeAgentRuns.lastHeartbeatAt, staleBefore),
              runIds === null
                ? undefined
                : inArray(activeAgentRuns.runId, runIds),
            ),
          )
          .orderBy(desc(activeAgentRuns.lastHeartbeatAt))
          .limit(STALE_RELEASE_LIMIT);
        signal.throwIfAborted();
        if (silent.length === 0) {
          return;
        }
        const ended = await db
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(
            and(
              inArray(
                agentRuns.id,
                silent.map((row) => {
                  return row.runId;
                }),
              ),
              notInArray(agentRuns.status, ["queued", "pending", "running"]),
              lt(agentRuns.completedAt, staleBefore),
            ),
          );
        signal.throwIfAborted();
        if (ended.length === 0) {
          return;
        }
        // Recheck the silence: a sandbox that resumed heartbeating since the
        // candidate read still has a runner and keeps its row.
        await db.delete(activeAgentRuns).where(
          and(
            inArray(
              activeAgentRuns.runId,
              ended.map((row) => {
                return row.id;
              }),
            ),
            lt(activeAgentRuns.lastHeartbeatAt, staleBefore),
          ),
        );
      })(),
    );
    signal.throwIfAborted();
    if (outcome.ok) {
      return;
    }
    const errorCode = safeSqlStateCode(outcome.error);
    log.warn(
      "Stale active run release failed",
      errorCode === undefined ? {} : { errorCode },
    );
  },
);
