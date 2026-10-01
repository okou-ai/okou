import { backgroundJobs } from "@okouai/db/schema/background-job";
import { exportJobs } from "@okouai/db/schema/export-job";
import {
  userExportEntries,
  userExportParts,
} from "@okouai/db/schema/user-export-entry";
import { command } from "ccstate";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  or,
  sql,
  getTableColumns,
} from "drizzle-orm";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  abortMultipartS3Upload,
  deleteS3Objects,
  isS3NotFoundError,
  listMultipartS3UploadsPage,
  listUserExportStagingPage,
} from "../external/s3";
import { settle, settleIncludingAbort } from "../utils";

const CLEANUP_GRACE_MS = 2 * 60_000;
const CLEANUP_JOB_LIMIT = 10;
const CLEANUP_BUDGET_MS = 20_000;
const terminalStatuses = ["completed", "failed", "cancelled"] as const;

interface CleanupJob {
  readonly job: typeof backgroundJobs.$inferSelect;
  readonly preserveArchive: boolean;
  readonly claimedAt: Date;
}

function cleanupEligibility(cutoff: Date) {
  return and(
    eq(backgroundJobs.kind, "user-export"),
    eq(backgroundJobs.handlerVersion, 1),
    lte(backgroundJobs.updatedAt, cutoff),
    or(
      inArray(backgroundJobs.status, terminalStatuses),
      and(
        isNull(exportJobs.id),
        or(
          isNull(backgroundJobs.leaseExpiresAt),
          lte(backgroundJobs.leaseExpiresAt, cutoff),
        ),
      ),
    ),
  );
}

const claimCleanupJob$ = command(
  async (
    { set },
    jobId: string,
    signal: AbortSignal,
  ): Promise<CleanupJob | null> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const current = nowDate();
    const cutoff = new Date(current.getTime() - CLEANUP_GRACE_MS);
    const candidate = db.$with("export_cleanup_candidate").as(
      db
        .select({
          id: backgroundJobs.id,
          ownerId: exportJobs.id,
          ownerStatus: exportJobs.status,
          ownerExpiresAt: exportJobs.expiresAt,
        })
        .from(backgroundJobs)
        .leftJoin(exportJobs, eq(exportJobs.id, backgroundJobs.id))
        .where(and(eq(backgroundJobs.id, jobId), cleanupEligibility(cutoff)))
        .limit(1)
        .for("update", { of: backgroundJobs, skipLocked: true }),
    );
    const [claimed] = await db
      .with(candidate)
      .update(backgroundJobs)
      .set({
        status: sql`case when ${candidate.ownerId} is null then 'cancelled' else ${backgroundJobs.status} end`,
        leaseId: null,
        leaseExpiresAt: null,
        completedAt: sql`coalesce(${backgroundJobs.completedAt}, ${current})`,
        updatedAt: current,
      })
      .from(candidate)
      .where(eq(backgroundJobs.id, candidate.id))
      .returning({
        ...getTableColumns(backgroundJobs),
        ownerStatus: candidate.ownerStatus,
        ownerExpiresAt: candidate.ownerExpiresAt,
      });
    signal.throwIfAborted();
    if (!claimed) {
      return null;
    }
    const { ownerStatus, ownerExpiresAt, ...job } = claimed;
    if (ownerStatus === "completed" && ownerExpiresAt === null) {
      throw new Error("Completed durable export is missing its expiry");
    }
    return {
      job,
      claimedAt: current,
      preserveArchive:
        ownerStatus === "completed" &&
        ownerExpiresAt !== null &&
        ownerExpiresAt > current,
    };
  },
);

const cleanupJobResources$ = command(
  async (
    { get, set },
    args: { readonly cleanup: CleanupJob },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const { cleanup } = args;
    const { job } = cleanup;
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const resultKey = `exports/${job.userId}/${job.id}.zip`;
    const stagingPrefix = `exports/${job.userId}/${job.id}/staging/`;
    const uploads = await get(
      listMultipartS3UploadsPage(bucket, resultKey, signal),
    );
    signal.throwIfAborted();
    const cutoff = new Date(cleanup.claimedAt.getTime() - CLEANUP_GRACE_MS);
    let uploadDeferred = uploads.isTruncated;
    for (const upload of uploads.uploads) {
      // A prefix listing may contain another key, and a newly initiated upload
      // can still belong to a provider request that outlived its worker lease.
      if (upload.key !== resultKey || upload.initiated > cutoff) {
        uploadDeferred = true;
        continue;
      }
      await set(
        abortCleanupUpload$,
        { bucket, key: resultKey, uploadId: upload.uploadId },
        signal,
      );
      signal.throwIfAborted();
    }

    const knownUploadId = job.checkpoint.uploadId;
    if (typeof knownUploadId === "string" && knownUploadId.length > 0) {
      const observed = uploads.uploads.find((upload) => {
        return upload.key === resultKey && upload.uploadId === knownUploadId;
      });
      if (!observed) {
        await set(
          abortCleanupUpload$,
          { bucket, key: resultKey, uploadId: knownUploadId },
          signal,
        );
        signal.throwIfAborted();
      }
    }

    const staged = await get(
      listUserExportStagingPage(bucket, stagingPrefix, signal),
    );
    signal.throwIfAborted();
    await get(deleteS3Objects(bucket, staged.keys, signal));
    signal.throwIfAborted();
    if (staged.isTruncated || uploadDeferred) {
      return;
    }
    if (!cleanup.preserveArchive) {
      await get(deleteS3Objects(bucket, [resultKey], signal));
      signal.throwIfAborted();
    }
    const owned = db
      .select({ id: backgroundJobs.id })
      .from(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.id, job.id),
          eq(backgroundJobs.updatedAt, cleanup.claimedAt),
          inArray(backgroundJobs.status, terminalStatuses),
        ),
      )
      .limit(1)
      .for("update", { skipLocked: true });
    const admitted = sql`exists (select 1 from export_cleanup_owner)`;
    // Original snapshot/memory keys are references, not deletion targets.
    // Release their GC pins only after every external cleanup page succeeded.
    const entries = db
      .delete(userExportEntries)
      .where(and(eq(userExportEntries.jobId, job.id), admitted))
      .returning({ ordinal: userExportEntries.ordinal });
    const parts = db
      .delete(userExportParts)
      .where(and(eq(userExportParts.jobId, job.id), admitted))
      .returning({ partNumber: userExportParts.partNumber });
    const removed = db
      .delete(backgroundJobs)
      .where(and(eq(backgroundJobs.id, job.id), admitted))
      .returning({ id: backgroundJobs.id });
    await db.execute(sql`with export_cleanup_owner as materialized (${owned}),
      export_cleanup_entries as (${entries}), export_cleanup_parts as (${parts}) ${removed}`);
    signal.throwIfAborted();
  },
);

const abortCleanupUpload$ = command(
  async (
    { get },
    args: {
      readonly bucket: string;
      readonly key: string;
      readonly uploadId: string;
    },
    signal: AbortSignal,
  ) => {
    const aborted = await settle(
      get(abortMultipartS3Upload(args.bucket, args.key, args.uploadId, signal)),
      signal,
    );
    signal.throwIfAborted();
    if (!aborted.ok && !isS3NotFoundError(aborted.error)) {
      throw aborted.error;
    }
  },
);

/** Bounded, delete-first retries retain the durable row until cleanup succeeds. */
export const cleanupDurableUserExports$ = command(
  async (
    { set },
    args: { readonly jobId?: string },
    signal: AbortSignal,
  ): Promise<{ readonly processed: number }> => {
    const db = set(writeDb$);
    const started = performance.now();
    const cutoff = new Date(nowDate().getTime() - CLEANUP_GRACE_MS);
    const candidates = await db
      .select({ id: backgroundJobs.id })
      .from(backgroundJobs)
      .leftJoin(exportJobs, eq(exportJobs.id, backgroundJobs.id))
      .where(
        and(
          cleanupEligibility(cutoff),
          args.jobId === undefined
            ? undefined
            : eq(backgroundJobs.id, args.jobId),
        ),
      )
      .orderBy(asc(backgroundJobs.updatedAt), asc(backgroundJobs.id))
      .limit(CLEANUP_JOB_LIMIT);
    signal.throwIfAborted();
    let processed = 0;
    for (const candidate of candidates) {
      if (performance.now() - started >= CLEANUP_BUDGET_MS) {
        break;
      }
      const cleanup = await set(claimCleanupJob$, candidate.id, signal);
      signal.throwIfAborted();
      if (!cleanup) {
        continue;
      }
      const attemptSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(
          Math.max(
            1,
            Math.ceil(CLEANUP_BUDGET_MS - (performance.now() - started)),
          ),
        ),
      ]);
      // A failed page remains durable; another invocation starts from its first
      // remaining object after the cleanup lease expires.
      await settleIncludingAbort(
        set(cleanupJobResources$, { cleanup }, attemptSignal),
      );
      signal.throwIfAborted();
      processed += 1;
    }
    return { processed };
  },
);
