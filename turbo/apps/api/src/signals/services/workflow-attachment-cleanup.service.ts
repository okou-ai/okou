import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { object as zObject, uuid as zUuid, string as zString } from "zod";
import type { WorkflowAttachments } from "@okouai/api-contracts/contracts/workflow-attachments";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { claimedWorkflowAttachments } from "@okouai/db/schema/claimed-workflow-attachment";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { workflows } from "@okouai/db/schema/workflow";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { abortMultipartS3Upload, deleteS3Objects } from "../external/s3";
import { settle } from "../utils";
import {
  claimBackgroundJob$,
  transitionBackgroundJob$,
} from "./background-job-command.service";

export const WORKFLOW_ATTACHMENT_CLEANUP_KIND = "workflow-attachment-cleanup";
const MAX_CLEANUP_FAILURES = 5;

const cleanupInputSchema = zObject({
  workflowId: zUuid(),
  objectKey: zString(),
  uploadId: zString().min(1).optional(),
}).strict();

export function assertWorkflowAttachmentOwner(
  orgId: string,
  workflowId: string,
  objectKey: string,
): void {
  if (
    !objectKey.startsWith(`workflow-attachments/${orgId}/${workflowId}/`) ||
    !/^workflow-attachments\/[^/]+\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/archive\.tar\.gz$/u.test(
      objectKey,
    )
  ) {
    throw new Error("Workflow attachment package has a foreign owner");
  }
}

export function workflowAttachmentCleanupValues(input: {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
  readonly objectKey: string;
  readonly uploadId?: string;
}) {
  assertWorkflowAttachmentOwner(input.orgId, input.workflowId, input.objectKey);
  return {
    id: randomUUID(),
    kind: WORKFLOW_ATTACHMENT_CLEANUP_KIND,
    handlerVersion: 1,
    orgId: input.orgId,
    userId: input.userId,
    input: {
      workflowId: input.workflowId,
      objectKey: input.objectKey,
      ...(input.uploadId === undefined ? {} : { uploadId: input.uploadId }),
    },
  };
}

/** The owner's reference removal and this exact target commit together. */
export function retireWorkflowAttachmentSql(
  owner: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
  },
  attachments: WorkflowAttachments | null,
  admitted: SQL,
): SQL {
  if (attachments?.kind !== "bundle") {
    return sql`SELECT NULL WHERE false`;
  }
  const job = workflowAttachmentCleanupValues({
    ...owner,
    objectKey: attachments.objectKey,
  });
  return sql`INSERT INTO ${backgroundJobs} (id, kind, handler_version, org_id, user_id, input)
    SELECT ${job.id}::uuid, ${job.kind}, ${job.handlerVersion}, ${job.orgId}, ${job.userId}, ${JSON.stringify(job.input)}::jsonb
    WHERE ${admitted}`;
}

/**
 * A candidate's cleanup row is its real durable deletion work, not a Workflow
 * revision. Publication consumes only a pristine pending row. Once a worker starts
 * deletion or records failure, publication may not adopt that object later.
 * Failed admission re-enqueues the consumed target in the same statement.
 */
export function consumeWorkflowAttachmentCandidateSql(
  jobId: string | null,
  publicationCondition?: SQL,
): SQL {
  return jobId === null
    ? sql`SELECT true AS consumed`
    : sql`DELETE FROM ${backgroundJobs}
        WHERE ${and(eq(backgroundJobs.id, jobId), eq(backgroundJobs.kind, WORKFLOW_ATTACHMENT_CLEANUP_KIND), eq(backgroundJobs.handlerVersion, 1), eq(backgroundJobs.status, "pending"), eq(backgroundJobs.failureCount, 0), eq(backgroundJobs.checkpoint, {}), publicationCondition)}
        RETURNING *`;
}

export function restoreWorkflowAttachmentCandidateSql(
  jobId: string | null,
  published: SQL,
): SQL {
  return jobId === null
    ? sql`SELECT NULL WHERE false`
    : sql`INSERT INTO ${backgroundJobs} (id, kind, handler_version, org_id, user_id, input)
        SELECT gen_random_uuid(), kind, handler_version, org_id, user_id, input
        FROM consumed_attachment_candidate WHERE NOT EXISTS (${published})`;
}

const attachmentIsRetained$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly objectKey: string },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [retained] = await db
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.orgId, args.orgId),
          sql`${workflows.attachments}->>'objectKey' = ${args.objectKey}`,
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (retained) {
      return true;
    }
    const [pending] = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.orgId, args.orgId), eq(agentRuns.status, "pending")),
      )
      .limit(1);
    signal.throwIfAborted();
    if (pending) {
      return true;
    }
    const [consumer] = await db
      .select({ id: claimedWorkflowAttachments.runId })
      .from(claimedWorkflowAttachments)
      .where(
        and(
          eq(claimedWorkflowAttachments.orgId, args.orgId),
          eq(claimedWorkflowAttachments.objectKey, args.objectKey),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return consumer !== undefined;
  },
);

/**
 * Retired keys are never reactivated. A claim started before retirement has an
 * already committed pending Run, retained conservatively until its atomic claim
 * publishes exact references. A later claim cannot select the retired
 * descriptor. References survive cancellation, timeout and active-slot release.
 */
export const cleanupWorkflowAttachments$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    // An outgoing Stage 1 writer can still reuse a previously captured package.
    // Queue targets now; delete only after verified writer drain and rollback exclusion.
    if (env("WORKFLOW_ATTACHMENT_CLEANUP_ENABLED") !== "true") {
      return 0;
    }
    let processed = 0;
    for (let index = 0; index < 8; index += 1) {
      const job = await set(
        claimBackgroundJob$,
        { kind: WORKFLOW_ATTACHMENT_CLEANUP_KIND, handlerVersion: 1 },
        signal,
      );
      if (!job) {
        break;
      }
      const outcome = await settle(
        (async () => {
          const input = cleanupInputSchema.parse(job.input);
          assertWorkflowAttachmentOwner(
            job.orgId,
            input.workflowId,
            input.objectKey,
          );
          if (
            await set(
              attachmentIsRetained$,
              { orgId: job.orgId, objectKey: input.objectKey },
              signal,
            )
          ) {
            return await set(
              transitionBackgroundJob$,
              job,
              {
                kind: "defer",
                availableAt: new Date(nowDate().getTime() + 60_000),
              },
              signal,
            );
          }
          // This irreversible deletion checkpoint also fences late publication
          // after retries, lease expiry or a later retained-consumer deferral.
          if (
            job.checkpoint.deleting !== true &&
            !(await set(
              transitionBackgroundJob$,
              job,
              { kind: "checkpoint", checkpoint: { deleting: true } },
              signal,
            ))
          ) {
            return false;
          }
          const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
          if (input.uploadId !== undefined) {
            // Abort the exact upload before deleting the object. A late multipart
            // completion either precedes this abort/delete or fails after abort;
            // unlike a late PutObject it cannot recreate a deleted candidate.
            const aborted = await settle(
              get(
                abortMultipartS3Upload(
                  bucket,
                  input.objectKey,
                  input.uploadId,
                  signal,
                ),
              ),
              signal,
            );
            if (
              !aborted.ok &&
              !(
                aborted.error instanceof Error &&
                aborted.error.name === "NoSuchUpload"
              )
            ) {
              throw aborted.error;
            }
          }
          await get(deleteS3Objects(bucket, [input.objectKey], signal));
          signal.throwIfAborted();
          return await set(
            transitionBackgroundJob$,
            job,
            { kind: "complete", checkpoint: { deleted: true } },
            signal,
          );
        })(),
        signal,
      );
      if (!outcome.ok) {
        signal.throwIfAborted();
        await set(
          transitionBackgroundJob$,
          job,
          job.failureCount + 1 >= MAX_CLEANUP_FAILURES
            ? {
                kind: "fail",
                error: "Workflow attachment cleanup failed",
              }
            : {
                kind: "retry",
                error: "Workflow attachment cleanup failed",
                availableAt: new Date(nowDate().getTime() + 60_000),
              },
          signal,
        );
      }
      processed += 1;
    }
    return processed;
  },
);
