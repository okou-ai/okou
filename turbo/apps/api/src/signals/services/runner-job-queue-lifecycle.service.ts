import { command } from "ccstate";
import { writeDb$ } from "../external/db";
import { logger } from "../../lib/log";

import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { lte, sql, type SQL } from "drizzle-orm";

import { recordSandboxOperation } from "../external/sandbox-op-log";
import { nowDate } from "../../lib/time";

interface RunnerJobQueueTimestamps {
  readonly createdAt: Date;
  readonly expiresAt: SQL;
}

export function runnerJobQueueExpiredCondition() {
  return lte(runnerJobQueue.expiresAt, sql`now()`);
}

/**
 * Capture the closest safe persisted approximation of queue availability.
 * The row is committed before notification, so this is insertion time rather
 * than commit, notification, or runner discovery time. The API clock owns the
 * FIFO/telemetry boundary, while the database clock owns queue expiry. Reuse
 * protection starts separately when the durable row is first discovered.
 */
export function runnerJobQueueTimestamps(): RunnerJobQueueTimestamps {
  return {
    createdAt: nowDate(),
    expiresAt: sql`clock_timestamp() AT TIME ZONE 'UTC' + interval '2 hours'`,
  };
}

export function recordSameThreadRunnerJobPersisted(args: {
  readonly runId: string;
  readonly createdAt: Date;
}): void {
  recordSandboxOperation({
    sandboxType: "runner",
    actionType: "same_thread_runner_job_persisted",
    durationMs: 0,
    success: true,
    runId: args.runId,
    timestamp: args.createdAt.toISOString(),
  });
}

const L = logger("CronCleanupSandboxes");

export const cleanupExpiredRunnerJobs$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    const { rowCount } = await db
      .delete(runnerJobQueue)
      .where(runnerJobQueueExpiredCondition());
    signal.throwIfAborted();

    const deletedCount = rowCount ?? 0;

    if (deletedCount > 0) {
      L.debug("Cleaned up expired runner job queue entries", {
        count: deletedCount,
      });
    }
    return deletedCount;
  },
);
