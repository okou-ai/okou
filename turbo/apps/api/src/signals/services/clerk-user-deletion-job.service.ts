import { command } from "ccstate";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settleIncludingAbort } from "../utils";
import {
  claimBackgroundJob,
  checkpointBackgroundJob,
  completeBackgroundJob,
  enqueueBackgroundJob,
  retryBackgroundJob,
} from "./background-job.service";
import { cleanupClerkDeletedUser$ } from "./webhooks-clerk-cleanup.service";

const L = logger("ClerkUserDeletionJob");
const JOB_KIND = "clerk-user-deletion";
const JOB_HANDLER_VERSION = 1;
const JOB_NAMESPACE = "ae6e3b21-a980-4e94-908b-795315ac47af";
const RETRY_DELAY_MS = 60_000;
const checkpointSchema = z.object({
  emptyOrgIds: z.array(z.string()).optional(),
});

export const enqueueClerkUserDeletion$ = command(
  async ({ set }, userId: string, signal: AbortSignal): Promise<string> => {
    const jobId = uuidv5(userId, JOB_NAMESPACE);
    await enqueueBackgroundJob(
      set(writeDb$),
      {
        id: jobId,
        kind: JOB_KIND,
        handlerVersion: JOB_HANDLER_VERSION,
        userId,
        orgId: "",
        input: {},
      },
      signal,
    );
    signal.throwIfAborted();
    return jobId;
  },
);

/** A request can start work promptly; cron reclaims anything it does not finish. */
export const executeClerkUserDeletionWork$ = command(
  async (
    { set },
    args: { readonly jobId?: string },
    signal: AbortSignal,
  ): Promise<{ readonly processed: number }> => {
    const db = set(writeDb$);
    const job = await claimBackgroundJob(
      db,
      {
        jobId: args.jobId,
        kind: JOB_KIND,
        handlerVersion: JOB_HANDLER_VERSION,
      },
      signal,
    );
    if (!job) {
      return { processed: 0 };
    }

    // eslint-disable-next-line api/signal-check-await -- persist the outcome even when cleanup was aborted
    const attempt = await settleIncludingAbort(async () => {
      const { emptyOrgIds } = checkpointSchema.parse(job.checkpoint);
      await set(
        cleanupClerkDeletedUser$,
        {
          userId: job.userId,
          emptyOrgIds,
          checkpointEmptyOrgIds: async (orgIds, checkpointSignal) => {
            const saved = await checkpointBackgroundJob(
              db,
              { job, checkpoint: { emptyOrgIds: orgIds } },
              checkpointSignal,
            );
            if (!saved) {
              throw new Error("User deletion lost its job lease");
            }
          },
        },
        signal,
      );
    });
    // The request or cron budget may have expired during cleanup. Persist
    // its outcome with a fresh, bounded signal so the lease can be released.
    const persistenceSignal = AbortSignal.timeout(5000);
    if (attempt.ok) {
      await completeBackgroundJob(db, { job }, persistenceSignal);
    } else {
      L.error("user.deleted cleanup failed", {
        userId: job.userId,
        error: attempt.error,
      });
      await retryBackgroundJob(
        db,
        {
          job,
          error:
            attempt.error instanceof Error
              ? attempt.error.message
              : "User deletion cleanup failed",
          availableAt: new Date(nowDate().getTime() + RETRY_DELAY_MS),
        },
        persistenceSignal,
      );
    }
    persistenceSignal.throwIfAborted();
    return { processed: 1 };
  },
);
