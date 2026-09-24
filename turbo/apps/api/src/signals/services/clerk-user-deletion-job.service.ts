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
  // Tasks enqueued before B1 have no phase. Their legacy cleanup is
  // idempotent, so capturing whatever remains first is safe.
  phase: z.enum(["capture", "legacy", "verify"]).default("capture"),
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
      let checkpoint = checkpointSchema.parse(job.checkpoint);
      const save = async (
        next: DeletionCheckpoint,
        saveSignal: AbortSignal,
      ): Promise<void> => {
        const saved = await checkpointBackgroundJob(
          db,
          { job, checkpoint: next },
          saveSignal,
        );
        if (!saved) {
          throw new Error("User deletion lost its job lease");
        }
        checkpoint = next;
      };
      const workSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(BACKGROUND_JOB_LEASE_MS - 15_000),
      ]);
      if (checkpoint.phase === "capture") {
        if (!(await captureUserErasureWork(db, job, workSignal))) {
          return checkpoint;
        }
        await save({ ...checkpoint, phase: "legacy" }, signal);
      }
      if (checkpoint.phase === "legacy") {
        await set(
          cleanupClerkDeletedUser$,
          {
            userId: job.userId,
            emptyOrgIds: checkpoint.emptyOrgIds,
            checkpointEmptyOrgIds: async (emptyOrgIds, checkpointSignal) => {
              await save({ ...checkpoint, emptyOrgIds }, checkpointSignal);
            },
          },
          signal,
        );
        await save({ ...checkpoint, phase: "verify" }, signal);
      }
      return (await verifyUserErasureWork(db, job, workSignal))
        ? null
        : checkpoint;
    })();
    await settleDeletionAttempt(db, job, work);
    signal.throwIfAborted();
    return { processed: 1 };
  },
);
