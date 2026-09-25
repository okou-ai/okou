import {
  recordChatContentDeletion,
  completeChatContentDeletion,
} from "@okouai/db/operations/chat-content-erasure";
import { command } from "ccstate";
import { cliTokens } from "@okouai/db/schema/cli-tokens";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { eq } from "drizzle-orm";
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
import { closePiStableContextErasureSubject } from "./pi-stable-context-erasure.service";
import {
  cancelDeletedUserRuns$,
  cleanupClerkDeletedUser$,
} from "./webhooks-clerk-cleanup.service";

const L = logger("ClerkUserDeletionJob");
const JOB_KIND = "clerk-user-deletion";
const JOB_HANDLER_VERSION = 1;
const JOB_NAMESPACE = "ae6e3b21-a980-4e94-908b-795315ac47af";
const RETRY_DELAY_MS = 60_000;
// Stopgap: do not enter either the legacy cleanup or captured erasure work
// while deleting an Agent can cascade into another member's data. The durable
// job and its original phase stay resumable when a safe owner-scoped sweep is
// implemented. This is deliberately not a runtime feature switch.
const HOLD_USER_DELETION = true;
const SAFETY_HOLD_DELAY_MS = 24 * 60 * 60 * 1000;
const checkpointSchema = z.object({
  emptyOrgIds: z.array(z.string()).optional(),
  // Tasks enqueued before B1 have no phase. Their legacy cleanup is
  // idempotent, so capturing whatever remains first is safe.
  phase: z.enum(["capture", "verify"]).default("capture"),
  safetyHold: z.literal("agent-cascade-risk").optional(),
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
      : await db.transaction(async (tx) => {
          const completed = await completeBackgroundJob(
            tx,
            { job },
            persistenceSignal,
          );
          if (!completed) {
            throw new Error("User deletion lost its job lease");
          }
          // Capture/verification yields do not complete the local cleanup.
          // The receipt survives retirement of either durable job projection.
          await completeChatContentDeletion(tx, {
            subjectKind: "user",
            subjectId: job.userId,
            sourceReference: job.id,
          });
          return completed;
        });
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
      // The hold skips legacy identity cleanup. Close cached authority under
      // the same lock as delayed membership refills before acknowledging the
      // webhook; a late refresh cannot restore this deleted user's access.
      await closePiStableContextErasureSubject(tx, {
        subjectKind: "user",
        subjectId: userId,
      });
      await recordChatContentDeletion(tx, {
        subjectKind: "user",
        subjectId: userId,
        sourceReference: jobId,
      });
      signal.throwIfAborted();
      await tx
        .delete(orgMembersCache)
        .where(eq(orgMembersCache.userId, userId));
      await tx.delete(cliTokens).where(eq(cliTokens.userId, userId));
      signal.throwIfAborted();
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

    if (HOLD_USER_DELETION) {
      await set(cancelDeletedUserRuns$, job.userId, signal);
      signal.throwIfAborted();
      const checkpoint = checkpointSchema.parse(job.checkpoint);
      const saved = await yieldBackgroundJob(
        db,
        {
          job,
          checkpoint: { ...checkpoint, safetyHold: "agent-cascade-risk" },
          availableAt: new Date(nowDate().getTime() + SAFETY_HOLD_DELAY_MS),
        },
        AbortSignal.timeout(5000),
      );
      signal.throwIfAborted();
      if (!saved) {
        throw new Error("User deletion safety hold lost its job lease");
      }
      return { processed: 1 };
    }

    const work = (async (): Promise<DeletionCheckpoint | null> => {
      let checkpoint = checkpointSchema.parse(job.checkpoint);
      const workSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(BACKGROUND_JOB_LEASE_MS - 15_000),
      ]);
      if (checkpoint.phase === "verify") {
        return (await verifyUserErasureWork(db, job, workSignal))
          ? null
          : checkpoint;
      }
      // A sealed capture returns immediately, so a replay after an interrupted
      // cleanup resumes that cleanup without a separate checkpoint.
      if (!(await captureUserErasureWork(db, job, workSignal))) {
        return checkpoint;
      }
      await set(
        cleanupClerkDeletedUser$,
        {
          userId: job.userId,
          emptyOrgIds: checkpoint.emptyOrgIds,
          checkpointEmptyOrgIds: async (emptyOrgIds, checkpointSignal) => {
            const next = { ...checkpoint, emptyOrgIds: [...emptyOrgIds] };
            const saved = await checkpointBackgroundJob(
              db,
              { job, checkpoint: next },
              checkpointSignal,
            );
            if (!saved) {
              throw new Error("User deletion lost its job lease");
            }
            checkpoint = next;
          },
        },
        signal,
      );
      // Verification gets its own invocation and time budget.
      return { ...checkpoint, phase: "verify" };
    })();
    await settleDeletionAttempt(db, job, work);
    signal.throwIfAborted();
    return { processed: 1 };
  },
);
