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
  isNotNull,
  lt,
  lte,
  or,
  sql,
  getTableColumns,
} from "drizzle-orm";

import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
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
          ownerId: sql`${exportJobs.id}`
            .mapWith(nullableDriverValueDecoder(exportJobs.id))
            .as("owner_id"),
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
      claimedAt: job.updatedAt,
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
    const removed = db
      .delete(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.id, job.id),
          eq(backgroundJobs.updatedAt, cleanup.claimedAt),
          inArray(backgroundJobs.status, terminalStatuses),
        ),
      )
      .returning({ id: backgroundJobs.id });
    // The actual owner DELETE, rather than a preceding locked read, gates all
    // inventory deletion. A changed owner deletes nothing; successful ownership
    // removal and pin release commit together in this one statement.
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
    await db.execute(sql`with export_cleanup_owner as (${removed.getSQL()}),
      export_cleanup_entries as (${entries.getSQL()}) ${parts.getSQL()}`);
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
    signal: AbortSignal,
  ): Promise<{ readonly processed: number }> => {
    const db = set(writeDb$);
    const started = performance.now();
    const cutoff = new Date(nowDate().getTime() - CLEANUP_GRACE_MS);
    const candidates = await db
      .select({ id: backgroundJobs.id })
      .from(backgroundJobs)
      .leftJoin(exportJobs, eq(exportJobs.id, backgroundJobs.id))
      .where(cleanupEligibility(cutoff))
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

const L = logger("CronCleanupSandboxes");
const EXPORT_JOB_TIMEOUT_MS = 10 * 60 * 1000;

export const cleanupExpiredExportJobs$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<{
    readonly exportJobsCleaned: number;
    readonly exportJobsStuck: number;
  }> => {
    const db = set(writeDb$);
    let exportJobsCleaned = 0;
    let exportJobsStuck = 0;
    const currentTime = nowDate();

    const expiredExports = await db
      .select({ id: exportJobs.id, s3Key: exportJobs.s3Key })
      .from(exportJobs)
      .where(
        and(
          eq(exportJobs.status, "completed"),
          isNotNull(exportJobs.expiresAt),
          lt(exportJobs.expiresAt, currentTime),
        ),
      );
    signal.throwIfAborted();

    if (expiredExports.length > 0) {
      const s3Keys = expiredExports
        .map((entry) => {
          return entry.s3Key;
        })
        .filter((key): key is string => {
          return key !== null;
        });
      if (s3Keys.length > 0) {
        await get(deleteS3Objects(env("R2_USER_STORAGES_BUCKET_NAME"), s3Keys));
        signal.throwIfAborted();
      }

      await db.delete(exportJobs).where(
        inArray(
          exportJobs.id,
          expiredExports.map((entry) => {
            return entry.id;
          }),
        ),
      );
      signal.throwIfAborted();

      exportJobsCleaned = expiredExports.length;
      L.debug("Cleaned up expired export jobs", { count: exportJobsCleaned });
    }

    const stuckCutoffTime = new Date(now() - EXPORT_JOB_TIMEOUT_MS);
    const stuckExportJobs = await db
      .select({ id: exportJobs.id })
      .from(exportJobs)
      .where(
        and(
          inArray(exportJobs.status, ["pending", "running"]),
          lt(exportJobs.createdAt, stuckCutoffTime),
          isNull(exportJobs.executionMode),
        ),
      );
    signal.throwIfAborted();

    for (const job of stuckExportJobs) {
      await db
        .update(exportJobs)
        .set({
          status: "failed",
          completedAt: currentTime,
          error: "Export job timed out",
        })
        .where(
          and(
            eq(exportJobs.id, job.id),
            inArray(exportJobs.status, ["pending", "running"]),
          ),
        );
      signal.throwIfAborted();
      exportJobsStuck++;
    }

    if (exportJobsStuck > 0) {
      L.debug("Failed stuck export jobs", { count: exportJobsStuck });
    }

    return { exportJobsCleaned, exportJobsStuck };
  },
);
