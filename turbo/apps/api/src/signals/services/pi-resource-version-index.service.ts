import { trace } from "@opentelemetry/api";
import { randomUUID } from "node:crypto";

import type { PiResourceVersionIndex } from "@okouai/db/jsonb-contracts/pi-resource-version-index";
import { piResourceVersionIndexes } from "@okouai/db/schema/pi-resource-version-index";
import { storageVersions } from "@okouai/db/schema/storage";
import { command } from "ccstate";
import { and, asc, count, eq, gte, inArray, lte, or, sql } from "drizzle-orm";

import { pgInt8ToSafeIntegerDecoder } from "../../lib/db-structured-result";
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
    // The unlocked read keeps the first SQL error and read Abort checkpoint.
    // It is not claim authority: the statement below selects its own full cohort.
    const eligible = db
      .select({
        versionId: piResourceVersionIndexes.storageVersionId,
        attemptCount: piResourceVersionIndexes.attemptCount,
        createdAt: piResourceVersionIndexes.createdAt,
        availableAt: piResourceVersionIndexes.availableAt,
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
      .limit(WORK_BATCH_SIZE);
    const preflight = await eligible;
    signal.throwIfAborted();
    if (preflight.length === 0) {
      return [];
    }

    // At most 32 application UUIDs are generated after the read checkpoint.
    // Some may be unused when locks or a later snapshot change the cohort.
    const leaseIds = Array.from({ length: WORK_BATCH_SIZE }, () => {
      return randomUUID();
    });
    const selected = db.$with("selected").as(
      eligible.for("update", {
        of: piResourceVersionIndexes,
        skipLocked: true,
      }),
    );
    const ordinal = sql`row_number() OVER (ORDER BY ${asc(selected.availableAt)}, ${asc(selected.versionId)})`;
    const planned = db.$with("planned").as(
      db
        .select({
          versionId: selected.versionId,
          createdAt: selected.createdAt,
          s3Key: selected.s3Key,
          archiveSize: selected.archiveSize,
          fileCount: selected.fileCount,
          ordinal: ordinal.mapWith(pgInt8ToSafeIntegerDecoder).as("ordinal"),
          leaseId: sql`(${sql.param(leaseIds)}::uuid[])[${ordinal}]`
            .mapWith(piResourceVersionIndexes.leaseId)
            .as("planned_lease_id"),
          attemptCount: sql`${selected.attemptCount} + 1`
            .mapWith(piResourceVersionIndexes.attemptCount)
            .as("planned_attempt_count"),
        })
        .from(selected),
    );
    const updated = db.$with("updated").as(
      db
        .update(piResourceVersionIndexes)
        .set({
          status: "running",
          leaseId: sql`${planned.leaseId}`,
          attemptCount: sql`${planned.attemptCount}`,
          leaseExpiresAt: new Date(currentTime.getTime() + WORK_LEASE_MS),
          updatedAt: currentTime,
        })
        .from(planned)
        .where(
          and(
            eq(piResourceVersionIndexes.storageVersionId, planned.versionId),
            eq(
              piResourceVersionIndexes.extractorVersion,
              PI_RESOURCE_EXTRACTOR_VERSION,
            ),
          ),
        )
        .returning({ versionId: piResourceVersionIndexes.storageVersionId }),
    );
    const completed = db
      .$with("completed")
      .as(db.select({ count: count().as("count") }).from(updated));
    // Consume actual RETURNING to completion without filtering planned work by
    // update count. The original command returned every selected work item.
    const work = await db
      .with(selected, planned, updated, completed)
      .select({
        versionId: planned.versionId,
        createdAt: planned.createdAt,
        s3Key: planned.s3Key,
        archiveSize: planned.archiveSize,
        fileCount: planned.fileCount,
        leaseId: planned.leaseId,
        attemptCount: planned.attemptCount,
      })
      .from(planned)
      .innerJoin(completed, gte(completed.count, 0))
      .orderBy(asc(planned.ordinal));
    // The completed statement has committed before this Abort checkpoint;
    // SQL failures still roll back the whole batch and remain the primary error.
    signal.throwIfAborted();
    return work;
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
