import { command } from "ccstate";
import { writeDb$ } from "../external/db";
import { logger } from "../../lib/log";

import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { lte, sql } from "drizzle-orm";

export function runnerJobQueueExpiredCondition() {
  return lte(runnerJobQueue.expiresAt, sql`now()`);
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
