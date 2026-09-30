import { exportJobs } from "@okouai/db/schema/export-job";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { command } from "ccstate";
import { eq, or, sql } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { deleteS3Objects, listS3ObjectsPage } from "../external/s3";
import { settleIncludingAbort } from "../utils";
import {
  claimBackgroundJob,
  completeBackgroundJob,
  enqueueBackgroundJob,
  retryBackgroundJob,
  yieldBackgroundJob,
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

/** The caller deletes the corresponding DB references in this same transaction.
 * The inventory has no owner FK, so removing the owner cannot lose R2 work. */
export async function enqueueStorageObjectCleanup(
  tx: Tx,
  args: CleanupInput & { readonly userId: string; readonly orgId: string },
  signal: AbortSignal,
): Promise<string> {
  const input = inputSchema.parse({ bucket: args.bucket, target: args.target });
  const id = uuidv5(
    `${input.bucket}\0${input.target.kind}\0${input.target.value}\0${args.userId}\0${args.orgId}`,
    JOB_NAMESPACE,
  );
  await enqueueBackgroundJob(
    tx,
    {
      id,
      kind: STORAGE_OBJECT_CLEANUP_JOB_KIND,
      handlerVersion: HANDLER_VERSION,
      userId: args.userId,
      orgId: args.orgId,
      input,
    },
    signal,
  );
  return id;
}

async function assertUnreferenced(
  db: Db,
  target: CleanupInput["target"],
  signal: AbortSignal,
): Promise<void> {
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
}

const cleanPage$ = command(
  async (
    { get },
    args: { readonly db: Db; readonly input: CleanupInput },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { bucket, target } = args.input;
    await assertUnreferenced(args.db, target, signal);
    if (target.kind === "key") {
      await get(deleteS3Objects(bucket, [target.value], signal));
      return true;
    }
    const prefix = `${target.value.replace(/\/+$/, "")}/`;
    const page = await get(
      listS3ObjectsPage(bucket, prefix, PAGE_SIZE, signal),
    );
    signal.throwIfAborted();
    if (page.objects.some((object) => !object.key.startsWith(prefix))) {
      throw new Error("Storage cleanup listing escaped its captured prefix");
    }
    if (page.objects.length > 0) {
      await get(
        deleteS3Objects(
          bucket,
          page.objects.map((object) => object.key),
          signal,
        ),
      );
    }
    // Delete-first pagination needs no continuation token. A retry lists only
    // remaining objects, including after a partial delete or a lost response.
    return !page.isTruncated;
  },
);

export const executeStorageObjectCleanupWork$ = command(
  async (
    { set },
    args: { readonly jobIds?: readonly string[] },
    signal: AbortSignal,
  ): Promise<{ readonly processed: number }> => {
    const db = set(writeDb$);
    const workSignal = AbortSignal.any([signal, AbortSignal.timeout(40_000)]);
    const count = Math.min(
      args.jobIds?.length ?? WORK_BATCH_SIZE,
      WORK_BATCH_SIZE,
    );
    let processed = 0;
    for (let index = 0; index < count; index++) {
      const job = await claimBackgroundJob(
        db,
        {
          jobId: args.jobIds?.[index],
          kind: STORAGE_OBJECT_CLEANUP_JOB_KIND,
          handlerVersion: HANDLER_VERSION,
        },
        workSignal,
      );
      if (!job) {
        continue;
      }
      const attempt = await settleIncludingAbort(
        (async () => {
          const input = inputSchema.parse(job.input);
          return await set(cleanPage$, { db, input }, workSignal);
        })(),
      );
      // A cancelled attempt still releases its lease when possible. A crashed
      // worker is reclaimed by the ordinary expired-lease path instead.
      const persistenceSignal = AbortSignal.timeout(5000);
      const saved = attempt.ok
        ? attempt.value
          ? await completeBackgroundJob(db, { job }, persistenceSignal)
          : await yieldBackgroundJob(
              db,
              { job, checkpoint: {} },
              persistenceSignal,
            )
        : await retryBackgroundJob(
            db,
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
      processed++;
      workSignal.throwIfAborted();
    }
    return { processed };
  },
);
