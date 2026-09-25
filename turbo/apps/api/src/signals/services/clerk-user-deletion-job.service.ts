import { command } from "ccstate";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { settleIncludingAbort } from "../utils";
import {
  claimBackgroundJob,
  checkpointBackgroundJob,
  completeBackgroundJob,
  enqueueBackgroundJob,
  retryBackgroundJob,
  type ClaimedBackgroundJob,
} from "./background-job.service";
import { cleanupClerkDeletedUser$ } from "./webhooks-clerk-cleanup.service";

const L = logger("ClerkUserDeletionJob");
const JOB_KIND = "clerk-user-deletion";
const JOB_HANDLER_VERSION = 1;
const JOB_NAMESPACE = "ae6e3b21-a980-4e94-908b-795315ac47af";
const RETRY_DELAY_MS = 60_000;
// Jobs enqueued by earlier releases may still carry a `phase` or `safetyHold`
// key. Zod strips unknown keys, and the legacy cleanup is idempotent.
const checkpointSchema = z.object({
  emptyOrgIds: z.array(z.string()).optional(),
});

async function settleDeletionAttempt(
  db: Db,
  job: ClaimedBackgroundJob,
  work: Promise<void>,
): Promise<void> {
  const attempt = await settleIncludingAbort(work);
  // Cleanup may have been aborted. Use a fresh deadline to release the lease.
  const persistenceSignal = AbortSignal.timeout(5000);
  if (attempt.ok) {
    const saved = await completeBackgroundJob(db, { job }, persistenceSignal);
    if (!saved) {
      throw new Error("User deletion lost its job lease");
    }
  } else {
    L.error("user.deleted cleanup failed", {
      userId: job.userId,
      error: attempt.error,
    });
    const saved = await retryBackgroundJob(
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
    if (!saved) {
      throw new Error("User deletion lost its job lease");
    }
  }
  persistenceSignal.throwIfAborted();
}

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

    const { emptyOrgIds } = checkpointSchema.parse(job.checkpoint);
    const work = set(
      cleanupClerkDeletedUser$,
      {
        userId: job.userId,
        emptyOrgIds,
        checkpointEmptyOrgIds: async (orgIds, checkpointSignal) => {
          const saved = await checkpointBackgroundJob(
            db,
            { job, checkpoint: { emptyOrgIds: [...orgIds] } },
            checkpointSignal,
          );
          if (!saved) {
            throw new Error("User deletion lost its job lease");
          }
        },
      },
      signal,
    );
    await settleDeletionAttempt(db, job, work);
    signal.throwIfAborted();
    return { processed: 1 };
  },
);
