import { command } from "ccstate";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { settleIncludingAbort } from "../utils";
import {
  BACKGROUND_JOB_LEASE_MS,
  claimBackgroundJob,
  checkpointBackgroundJob,
  completeBackgroundJob,
  enqueueBackgroundJob,
  retryBackgroundJob,
  yieldBackgroundJob,
  type ClaimedBackgroundJob,
} from "./background-job.service";
import {
  captureUserErasureWork,
  verifyUserErasureWork,
} from "./account-erasure-user-executor";
import { markMorningBriefCollectionOwnershipRevoked } from "./morning-brief-collection-occurrence.service";
import { cleanupClerkDeletedUser$ } from "./webhooks-clerk-cleanup.service";

const L = logger("ClerkUserDeletionJob");
const JOB_KIND = "clerk-user-deletion";
const JOB_HANDLER_VERSION = 1;
const JOB_NAMESPACE = "ae6e3b21-a980-4e94-908b-795315ac47af";
const RETRY_DELAY_MS = 60_000;
const checkpointSchema = z.object({
  emptyOrgIds: z.array(z.string()).optional(),
  phase: z.enum(["capture", "legacy", "verify"]),
});

type DeletionCheckpoint = z.infer<typeof checkpointSchema>;

async function settleDeletionAttempt(
  db: Db,
  job: ClaimedBackgroundJob,
  work: Promise<DeletionCheckpoint | null>,
): Promise<void> {
  const attempt = await settleIncludingAbort(work);
  // Cleanup may have been aborted. Use a fresh deadline to release the lease.
  const persistenceSignal = AbortSignal.timeout(5000);
  if (attempt.ok) {
    const saved = attempt.value
      ? await yieldBackgroundJob(
          db,
          {
            job,
            checkpoint: attempt.value,
            availableAt: new Date(nowDate().getTime() + RETRY_DELAY_MS),
          },
          persistenceSignal,
        )
      : await completeBackgroundJob(db, { job }, persistenceSignal);
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
    await set(writeDb$).transaction(async (tx) => {
      await enqueueBackgroundJob(
        tx,
        {
          id: jobId,
          kind: JOB_KIND,
          handlerVersion: JOB_HANDLER_VERSION,
          userId,
          orgId: "",
          input: {},
          checkpoint: { phase: "capture" },
        },
        signal,
      );
      // Stop new collections at the durable receipt without destroying the
      // occurrences B1 must capture before the legacy cleanup removes them.
      await markMorningBriefCollectionOwnershipRevoked(
        tx,
        { kind: "user", userId },
        nowDate(),
      );
    });
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

    const work = (async (): Promise<DeletionCheckpoint | null> => {
      const checkpoint = checkpointSchema.safeParse(job.checkpoint);
      if (!checkpoint.success) {
        // A pre-upgrade worker may already have removed catalog rows whose
        // external locators B1 must capture. Never infer completion from an
        // empty inventory when that earlier progress is unknown.
        throw new Error("account_erasure:legacy_job_capture_unproven");
      }
      if (checkpoint.data.phase === "capture") {
        const workSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(BACKGROUND_JOB_LEASE_MS - 15_000),
        ]);
        const sealed = await captureUserErasureWork(db, job, workSignal);
        return { ...checkpoint.data, phase: sealed ? "legacy" : "capture" };
      }
      if (checkpoint.data.phase === "legacy") {
        // Empty organizations need their own object and relational capture
        // before their legacy owner rows disappear. Keep the user job retryable
        // until that obligation is registered.
        if (checkpoint.data.emptyOrgIds?.length) {
          throw new Error("Empty organization erasure capture is unresolved");
        }
        await set(
          cleanupClerkDeletedUser$,
          {
            userId: job.userId,
            emptyOrgIds: checkpoint.data.emptyOrgIds,
            checkpointEmptyOrgIds: async (orgIds, checkpointSignal) => {
              const saved = await checkpointBackgroundJob(
                db,
                {
                  job,
                  checkpoint: { ...checkpoint.data, emptyOrgIds: orgIds },
                },
                checkpointSignal,
              );
              if (!saved) {
                throw new Error("User deletion lost its job lease");
              }
              if (orgIds.length > 0) {
                throw new Error(
                  "Empty organization erasure capture is unresolved",
                );
              }
            },
          },
          signal,
        );
        return { ...checkpoint.data, phase: "verify" };
      }
      const workSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(BACKGROUND_JOB_LEASE_MS - 15_000),
      ]);
      const finished = await verifyUserErasureWork(db, job, workSignal);
      return finished ? null : checkpoint.data;
    })();
    await settleDeletionAttempt(db, job, work);
    signal.throwIfAborted();
    return { processed: 1 };
  },
);
