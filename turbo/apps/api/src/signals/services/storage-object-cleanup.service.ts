import { exportJobs } from "@okouai/db/schema/export-job";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { command } from "ccstate";
import { eq, or, sql } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";
import { deleteS3Objects, listS3ObjectsPage } from "../external/s3";
import { settleIncludingAbort } from "../utils";
import {
  claimBackgroundJob$,
  completeBackgroundJob$,
  retryBackgroundJob$,
  yieldBackgroundJob$,
  type ClaimedBackgroundJob,
  backgroundJobDatabaseNow,
} from "./background-job.service";

export const STORAGE_OBJECT_CLEANUP_JOB_KIND = "storage-object-cleanup";
const HANDLER_VERSION = 1;
const JOB_NAMESPACE = "4dffb9a7-4137-4f5e-9213-8939a99fce2c";
const PAGE_SIZE = 1000;
const WORK_BATCH_SIZE = 8;
const inputSchema = z.object({
  bucket: z.string().min(1),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("prefix"), value: z.string().min(1) }),
    z.object({ kind: z.literal("key"), value: z.string().min(1) }),
  ]),
});
type CleanupInput = z.infer<typeof inputSchema>;

/** Pure admission values; the reference-deletion owner writes this durable receipt. */
export function storageObjectCleanupJobValues(
  args: CleanupInput & { readonly userId: string; readonly orgId: string },
) {
  const input = inputSchema.parse({ bucket: args.bucket, target: args.target });
  const id = uuidv5(
    `${input.bucket}\0${input.target.kind}\0${input.target.value}\0${args.userId}\0${args.orgId}`,
    JOB_NAMESPACE,
  );
  return {
    id,
    kind: STORAGE_OBJECT_CLEANUP_JOB_KIND,
    handlerVersion: HANDLER_VERSION,
    userId: args.userId,
    orgId: args.orgId,
    input,
    availableAt: backgroundJobDatabaseNow,
    createdAt: backgroundJobDatabaseNow,
    updatedAt: backgroundJobDatabaseNow,
  };
}

const assertUnreferenced$ = command(
  async (
    { get },
    target: CleanupInput["target"],
    signal: AbortSignal,
  ): Promise<void> => {
    const db = get(db$);
    if (target.kind === "prefix") {
      const prefix = target.value.replace(/\/+$/, "");
      if (!prefix) {
        throw new Error("Storage cleanup cannot erase an empty prefix");
      }
      const [storage] = await db
        .select({ id: storages.id })
        .from(storages)
        .where(
          or(
            eq(storages.s3Prefix, prefix),
            sql`starts_with(${storages.s3Prefix}, ${`${prefix}/`})`,
            sql`starts_with(${prefix}, ${storages.s3Prefix} || '/')`,
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      const [exportJob] = await db
        .select({ id: exportJobs.id })
        .from(exportJobs)
        .where(sql`starts_with(${exportJobs.s3Key}, ${`${prefix}/`})`)
        .limit(1);
      signal.throwIfAborted();
      if (storage || exportJob) {
        throw new Error("Storage cleanup prefix still has a live DB reference");
      }
      return;
    }
    const [exportJob] = await db
      .select({ id: exportJobs.id })
      .from(exportJobs)
      .where(eq(exportJobs.s3Key, target.value))
      .limit(1);
    signal.throwIfAborted();
    const [version] = await db
      .select({ id: storageVersions.id })
      .from(storageVersions)
      .where(
        or(
          eq(sql`${storageVersions.s3Key} || '/archive.tar.gz'`, target.value),
          eq(sql`${storageVersions.s3Key} || '/manifest.json'`, target.value),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (exportJob || version) {
      throw new Error("Storage cleanup key still has a live DB reference");
    }
  },
);

const cleanPage$ = command(
  async (
    { get, set },
    args: { readonly input: CleanupInput },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { bucket, target } = args.input;
    await set(assertUnreferenced$, target, signal);
    if (target.kind === "key") {
      await get(deleteS3Objects(bucket, [target.value], signal));
      signal.throwIfAborted();
      return true;
    }
    const prefix = `${target.value.replace(/\/+$/, "")}/`;
    const page = await get(
      listS3ObjectsPage(bucket, prefix, PAGE_SIZE, undefined, signal),
    );
    signal.throwIfAborted();
    if (
      page.objects.some((object) => {
        return !object.key.startsWith(prefix);
      })
    ) {
      throw new Error("Storage cleanup listing escaped its captured prefix");
    }
    if (page.objects.length > 0) {
      await get(
        deleteS3Objects(
          bucket,
          page.objects.map((object) => {
            return object.key;
          }),
          signal,
        ),
      );
      signal.throwIfAborted();
    }
    // Delete-first pagination needs no continuation token. A retry lists only
    // remaining objects, including after a partial delete or a lost response.
    return !page.isTruncated;
  },
);

const settleCleanupAttempt$ = command(
  async (
    { set },
    job: ClaimedBackgroundJob,
    attempt: Awaited<ReturnType<typeof settleIncludingAbort<boolean>>>,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    // Cancellation ends the external work, not its persistence obligation.
    // A crashed worker is reclaimed by the ordinary expired-lease path.
    const persistenceSignal = signal;
    const saved = attempt.ok
      ? attempt.value
        ? await set(completeBackgroundJob$, { job }, persistenceSignal)
        : await set(
            yieldBackgroundJob$,
            { job, checkpoint: {} },
            persistenceSignal,
          )
      : await set(
          retryBackgroundJob$,
          {
            job,
            error:
              attempt.error instanceof Error
                ? attempt.error.message
                : "Storage object cleanup failed",
            availableAt: new Date(
              nowDate().getTime() +
                Math.min(
                  15 * 60_000,
                  60_000 * 2 ** Math.min(job.failureCount, 4),
                ),
            ),
          },
          persistenceSignal,
        );
    if (!saved) {
      throw new Error("Storage object cleanup lost its job lease");
    }
  },
);

export const executeStorageObjectCleanupWork$ = command(
  async (
    { set },
    args: { readonly jobIds?: readonly string[] },
    signal: AbortSignal,
  ): Promise<{ readonly processed: number }> => {
    const workSignal = AbortSignal.any([signal, AbortSignal.timeout(40_000)]);
    const count = Math.min(
      args.jobIds?.length ?? WORK_BATCH_SIZE,
      WORK_BATCH_SIZE,
    );
    let processed = 0;
    for (let index = 0; index < count; index++) {
      const job = await set(
        claimBackgroundJob$,
        {
          jobId: args.jobIds?.[index],
          kind: STORAGE_OBJECT_CLEANUP_JOB_KIND,
          handlerVersion: HANDLER_VERSION,
        },
        workSignal,
      );
      signal.throwIfAborted();
      if (!job) {
        continue;
      }
      const work = async () => {
        const input = inputSchema.parse(job.input);
        return await set(cleanPage$, { input }, workSignal);
      };
      await set(
        settleCleanupAttempt$,
        job,
        await settleIncludingAbort(work()),
        AbortSignal.timeout(5000),
      );
      signal.throwIfAborted();
      processed++;
      workSignal.throwIfAborted();
    }
    return { processed };
  },
);
