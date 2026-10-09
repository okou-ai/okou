import { trace } from "@opentelemetry/api";
import { randomUUID } from "node:crypto";

import type { PiResourceVersionIndex } from "@okouai/db/jsonb-contracts/pi-resource-version-index";
import { piResourceVersionIndexes } from "@okouai/db/schema/pi-resource-version-index";
import { storageVersions } from "@okouai/db/schema/storage";
import { command } from "ccstate";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import {
  indexPiResourceArchive,
  PI_RESOURCE_EXTRACTOR_VERSION,
  piResourceIndexFits,
  piResourceIndexHash,
  piResourceVersionIndexSchema,
  RESOURCE_ARCHIVE_MAX_BYTES,
} from "../../lib/pi-resource-index";
import { now, nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import {
  downloadS3BufferWithMaxBytes$,
  S3ObjectSizeLimitError,
} from "../external/s3";
import { safeSync, settle, settleIncludingAbort } from "../utils";

const tracer = trace.getTracer("pi-resource-index");
const WORK_BATCH_SIZE = 32;
const WORK_LEASE_MS = 5 * 60 * 1000;

export function piResourceIndexQueueValues(
  versionIds: readonly string[],
  archiveSizes: ReadonlyMap<string, number>,
) {
  return versionIds.map((storageVersionId) => {
    const sourceArchiveSize = archiveSizes.get(storageVersionId);
    if (sourceArchiveSize === undefined) {
      throw new Error("Cannot index an unregistered Storage version");
    }
    return {
      storageVersionId,
      extractorVersion: PI_RESOURCE_EXTRACTOR_VERSION,
      sourceArchiveSize,
    };
  });
}

export const enqueuePiResourceVersionIndexes$ = command(
  async (
    { get, set },
    versionIds: readonly string[],
    signal: AbortSignal,
  ): Promise<void> => {
    const unique = [...new Set(versionIds)].sort();
    if (unique.length === 0) {
      return;
    }
    const versions = await get(db$)
      .select({
        id: storageVersions.id,
        archiveSize: storageVersions.archiveSize,
      })
      .from(storageVersions)
      .where(inArray(storageVersions.id, unique));
    signal.throwIfAborted();
    const sizes = new Map(
      versions.map((version) => {
        return [version.id, version.archiveSize] as const;
      }),
    );
    const values = piResourceIndexQueueValues(unique, sizes);
    const db = set(writeDb$);
    const inserted = await db
      .insert(piResourceVersionIndexes)
      .values(values)
      .onConflictDoNothing()
      .returning({
        storageVersionId: piResourceVersionIndexes.storageVersionId,
      });
    signal.throwIfAborted();
    const insertedVersionIds = new Set(
      inserted.map((row) => {
        return row.storageVersionId;
      }),
    );
    // A first insert establishes indexing work but is not an encoding repair.
    // Only a pre-existing row whose immutable archive encoding changed is reset.
    // Insert-first also serializes concurrent enqueues without relying on
    // PostgreSQL's internal tuple metadata.
    for (const value of values) {
      if (insertedVersionIds.has(value.storageVersionId)) {
        continue;
      }
      await db
        .update(piResourceVersionIndexes)
        .set(piResourceIndexRepairValues(value.sourceArchiveSize, nowDate()))
        .where(
          piResourceIndexRepairCondition(
            value.storageVersionId,
            value.sourceArchiveSize,
          ),
        );
    }
    signal.throwIfAborted();
  },
);

export function piResourceIndexRepairValues(
  sourceArchiveSize: number,
  enqueuedAt: Date,
) {
  return {
    status: "pending" as const,
    projection: null,
    projectionHash: null,
    sourceArchiveSize,
    leaseId: null,
    leaseExpiresAt: null,
    availableAt: enqueuedAt,
    attemptCount: 0,
    updatedAt: enqueuedAt,
  };
}
export function piResourceIndexRepairCondition(
  storageVersionId: string,
  sourceArchiveSize: number,
) {
  return and(
    eq(piResourceVersionIndexes.storageVersionId, storageVersionId),
    eq(
      piResourceVersionIndexes.extractorVersion,
      PI_RESOURCE_EXTRACTOR_VERSION,
    ),
    sql`${piResourceVersionIndexes.sourceArchiveSize} IS DISTINCT FROM ${sourceArchiveSize}`,
  );
}

export function piResourceProjectionValues(
  projection: PiResourceVersionIndex | undefined,
  archiveSize: number,
  updatedAt: Date,
) {
  // Only a materialized archive's actual bytes determine its size limit.
  // archiveSize is the registered source revision, not a byte identity.
  const ready = projection !== undefined && piResourceIndexFits(projection);
  return {
    status: ready ? ("ready" as const) : ("unindexable" as const),
    projection: ready ? projection : null,
    projectionHash: ready ? piResourceIndexHash(projection) : null,
    sourceArchiveSize: archiveSize,
    leaseId: null,
    leaseExpiresAt: null,
    updatedAt,
  };
}

interface PiResourceIndexReadRow {
  readonly versionId: string;
  readonly status: typeof piResourceVersionIndexes.$inferSelect.status;
  readonly storageId: string;
  readonly archiveSize: number | null;
  readonly projection: typeof piResourceVersionIndexes.$inferSelect.projection;
  readonly projectionHash: string | null;
}

export function piResourceVersionIndexesResult(
  versionIds: readonly string[],
  rows: readonly PiResourceIndexReadRow[],
) {
  const unique = [...new Set(versionIds)];
  const indexes = new Map<
    string,
    {
      readonly storageId: string;
      readonly archiveSize: number;
      readonly projection: PiResourceVersionIndex;
    }
  >();
  const misses = { pending: 0, running: 0, unindexable: 0, missing: 0 };
  misses.missing = unique.length - rows.length;
  for (const row of rows) {
    if (row.status !== "ready") {
      misses[row.status]++;
      continue;
    }
    const projection = piResourceVersionIndexSchema.parse(row.projection);
    if (
      row.archiveSize === null ||
      piResourceIndexHash(projection) !== row.projectionHash
    ) {
      throw new Error("Pi resource version index failed integrity validation");
    }
    indexes.set(row.versionId, {
      storageId: row.storageId,
      archiveSize: row.archiveSize,
      projection,
    });
  }
  return { indexes, misses };
}

export const readPiResourceVersionIndexes$ = command(
  async ({ get }, versionIds: readonly string[], signal: AbortSignal) => {
    const unique = [...new Set(versionIds)];
    if (unique.length === 0) {
      return piResourceVersionIndexesResult(unique, []);
    }
    const rows = await get(db$)
      .select({
        versionId: piResourceVersionIndexes.storageVersionId,
        status: piResourceVersionIndexes.status,
        storageId: storageVersions.storageId,
        archiveSize: piResourceVersionIndexes.sourceArchiveSize,
        projection: piResourceVersionIndexes.projection,
        projectionHash: piResourceVersionIndexes.projectionHash,
      })
      .from(piResourceVersionIndexes)
      .innerJoin(
        storageVersions,
        eq(storageVersions.id, piResourceVersionIndexes.storageVersionId),
      )
      .where(
        and(
          inArray(piResourceVersionIndexes.storageVersionId, unique),
          eq(
            piResourceVersionIndexes.extractorVersion,
            PI_RESOURCE_EXTRACTOR_VERSION,
          ),
        ),
      );
    signal.throwIfAborted();
    return piResourceVersionIndexesResult(unique, rows);
  },
);

const claimWork$ = command(
  async (
    { set },
    versionIds: readonly string[] | undefined,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    // Candidate selection and lease assignment must commit together so parallel
    // workers cannot materialize the same lease. Keep the existing claim locks.
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0233; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      const rows = await tx
        .select({
          versionId: piResourceVersionIndexes.storageVersionId,
          attemptCount: piResourceVersionIndexes.attemptCount,
          createdAt: piResourceVersionIndexes.createdAt,
          s3Key: storageVersions.s3Key,
          archiveSize: storageVersions.archiveSize,
          fileCount: storageVersions.fileCount,
        })
        .from(piResourceVersionIndexes)
        .innerJoin(
          storageVersions,
          eq(storageVersions.id, piResourceVersionIndexes.storageVersionId),
        )
        .where(
          and(
            eq(
              piResourceVersionIndexes.extractorVersion,
              PI_RESOURCE_EXTRACTOR_VERSION,
            ),
            versionIds === undefined
              ? undefined
              : inArray(piResourceVersionIndexes.storageVersionId, [
                  ...versionIds,
                ]),
            or(
              and(
                eq(piResourceVersionIndexes.status, "pending"),
                lte(piResourceVersionIndexes.availableAt, currentTime),
              ),
              and(
                eq(piResourceVersionIndexes.status, "running"),
                lte(piResourceVersionIndexes.leaseExpiresAt, currentTime),
              ),
            ),
          ),
        )
        .orderBy(
          asc(piResourceVersionIndexes.availableAt),
          asc(piResourceVersionIndexes.storageVersionId),
        )
        .limit(WORK_BATCH_SIZE)
        .for("update", { of: piResourceVersionIndexes, skipLocked: true });
      signal.throwIfAborted();
      const work = [];
      for (const row of rows) {
        const leaseId = randomUUID();
        const attemptCount = row.attemptCount + 1;
        await tx
          .update(piResourceVersionIndexes)
          .set({
            status: "running",
            leaseId,
            attemptCount,
            leaseExpiresAt: new Date(currentTime.getTime() + WORK_LEASE_MS),
            updatedAt: currentTime,
          })
          .where(
            and(
              eq(piResourceVersionIndexes.storageVersionId, row.versionId),
              eq(
                piResourceVersionIndexes.extractorVersion,
                PI_RESOURCE_EXTRACTOR_VERSION,
              ),
            ),
          );
        work.push({ ...row, leaseId, attemptCount });
      }
      signal.throwIfAborted();
      return work;
    });
  },
);

interface ResourceIndexWork {
  readonly versionId: string;
  readonly archiveSize: number;
  readonly fileCount: number;
  readonly s3Key: string;
  readonly leaseId: string;
  readonly attemptCount: number;
}
type ResourceIndexOutcome = "ready" | "unindexable" | "retry" | "stale";
const materializeResourceIndexWork$ = command(
  async (
    { set },
    item: ResourceIndexWork,
    signal: AbortSignal,
  ): Promise<ResourceIndexOutcome> => {
    const db = set(writeDb$);
    const ownership = and(
      eq(piResourceVersionIndexes.storageVersionId, item.versionId),
      eq(
        piResourceVersionIndexes.extractorVersion,
        PI_RESOURCE_EXTRACTOR_VERSION,
      ),
      eq(piResourceVersionIndexes.leaseId, item.leaseId),
      eq(piResourceVersionIndexes.status, "running"),
    );
    let projection: PiResourceVersionIndex | undefined;
    if (item.archiveSize === 0 && item.fileCount === 0) {
      projection = { schemaVersion: 1, files: [] };
    } else {
      const downloaded = await settle(
        set(
          downloadS3BufferWithMaxBytes$,
          {
            bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
            key: `${item.s3Key}/archive.tar.gz`,
            maxBytes: RESOURCE_ARCHIVE_MAX_BYTES,
          },
          signal,
        ),
        signal,
      );
      if (
        !downloaded.ok &&
        !(downloaded.error instanceof S3ObjectSizeLimitError)
      ) {
        const currentTime = nowDate();
        const updated = await db
          .update(piResourceVersionIndexes)
          .set({
            status: "pending",
            leaseId: null,
            leaseExpiresAt: null,
            availableAt: new Date(
              currentTime.getTime() +
                Math.min(
                  15 * 60_000,
                  5000 * 2 ** Math.min(item.attemptCount, 8),
                ),
            ),
            updatedAt: currentTime,
          })
          .where(ownership)
          .returning({
            versionId: piResourceVersionIndexes.storageVersionId,
          });
        signal.throwIfAborted();
        return updated.length ? "retry" : "stale";
      }
      if (downloaded.ok) {
        const parsed = safeSync(() => {
          return indexPiResourceArchive(downloaded.value);
        });
        if ("ok" in parsed) {
          projection = parsed.ok;
        }
      }
    }
    const values = piResourceProjectionValues(
      projection,
      item.archiveSize,
      nowDate(),
    );
    const updated = await db
      .update(piResourceVersionIndexes)
      .set(values)
      .where(ownership)
      .returning({ versionId: piResourceVersionIndexes.storageVersionId });
    signal.throwIfAborted();
    return updated.length ? values.status : "stale";
  },
);

const settleResourceIndexWork$ = command(
  async ({ set }, item: ResourceIndexWork, signal: AbortSignal) => {
    // Keep the original rejection as data until the batch closes its span.
    return await settleIncludingAbort(
      set(materializeResourceIndexWork$, item, signal),
    );
  },
);

export const executePiResourceIndexWork$ = command(
  async (
    { set },
    versionIds: readonly string[] | undefined,
    signal: AbortSignal,
  ) => {
    const work = await set(claimWork$, versionIds, signal);
    let ready = 0;
    let unindexable = 0;
    let retried = 0;
    let stale = 0;
    for (const item of work) {
      const span = tracer.startSpan("pi.resource_index.materialize", {
        attributes: {
          "pi.archive_bytes": item.archiveSize,
          "pi.storage_version_id": item.versionId,
          "pi.extractor_version": PI_RESOURCE_EXTRACTOR_VERSION,
          "pi.attempt_count": item.attemptCount,
        },
      });
      const outcome = await set(settleResourceIndexWork$, item, signal);
      const reported = safeSync(() => {
        if (!outcome.ok) {
          return;
        }
        span.setAttributes({
          "pi.outcome": outcome.value,
          ...(outcome.value === "ready"
            ? { "pi.ready_lag_ms": now() - item.createdAt.getTime() }
            : {}),
        });
        switch (outcome.value) {
          case "ready": {
            ready++;
            break;
          }
          case "unindexable": {
            unindexable++;
            break;
          }
          case "retry": {
            retried++;
            break;
          }
          case "stale": {
            stale++;
            break;
          }
        }
      });
      span.end();
      if ("error" in reported) {
        throw reported.error;
      }
      if (!outcome.ok) {
        throw outcome.error;
      }
      signal.throwIfAborted();
    }
    return { claimed: work.length, ready, unindexable, retried, stale };
  },
);
