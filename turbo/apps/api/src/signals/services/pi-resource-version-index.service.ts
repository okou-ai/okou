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
import { writeDb$, type Db } from "../external/db";
import { downloadS3BufferWithMaxBytes } from "../external/s3";
import { safeSync, settle } from "../utils";

const tracer = trace.getTracer("pi-resource-index");
const WORK_BATCH_SIZE = 32;
const WORK_LEASE_MS = 5 * 60 * 1000;

export async function enqueuePiResourceVersionIndexes(
  db: Pick<Db, "insert" | "select">,
  versionIds: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const unique = [...new Set(versionIds)];
  if (unique.length === 0) {
    return;
  }
  const versions = await db
    .select({
      id: storageVersions.id,
      archiveSize: storageVersions.archiveSize,
    })
    .from(storageVersions)
    .where(inArray(storageVersions.id, unique));
  signal?.throwIfAborted();
  const sizes = new Map(
    versions.map((version) => {
      return [version.id, version.archiveSize] as const;
    }),
  );
  await db
    .insert(piResourceVersionIndexes)
    .values(
      unique.map((storageVersionId) => {
        const archiveSize = sizes.get(storageVersionId);
        if (archiveSize === undefined) {
          throw new Error("Cannot index an unregistered Storage version");
        }
        return {
          storageVersionId,
          extractorVersion: PI_RESOURCE_EXTRACTOR_VERSION,
          sourceArchiveSize: archiveSize,
        };
      }),
    )
    .onConflictDoUpdate({
      target: [
        piResourceVersionIndexes.storageVersionId,
        piResourceVersionIndexes.extractorVersion,
      ],
      // Storage repair can replace an archive encoding under the same logical
      // version. Invalidate the old projection/lease before acknowledging repair.
      set: {
        status: "pending",
        projection: null,
        projectionHash: null,
        sourceArchiveSize: sql`excluded.source_archive_size`,
        leaseId: null,
        leaseExpiresAt: null,
        availableAt: nowDate(),
        updatedAt: nowDate(),
      },
      setWhere: sql`${piResourceVersionIndexes.sourceArchiveSize} IS DISTINCT FROM excluded.source_archive_size`,
    });
  signal?.throwIfAborted();
}

function projectionValues(
  projection: PiResourceVersionIndex | undefined,
  archiveSize: number,
) {
  const ready =
    projection !== undefined &&
    archiveSize <= RESOURCE_ARCHIVE_MAX_BYTES &&
    piResourceIndexFits(projection);
  return {
    status: ready ? ("ready" as const) : ("unindexable" as const),
    projection: ready ? projection : null,
    projectionHash: ready ? piResourceIndexHash(projection) : null,
    sourceArchiveSize: archiveSize,
    leaseId: null,
    leaseExpiresAt: null,
    updatedAt: nowDate(),
  };
}

export async function publishPiResourceVersionIndex(
  args: {
    readonly db: Pick<Db, "insert">;
    readonly versionId: string;
    readonly projection: PiResourceVersionIndex | undefined;
    readonly archiveSize: number;
    readonly source?: "publication" | "captured-read";
  },
  signal?: AbortSignal,
): Promise<void> {
  const { db, versionId, projection, archiveSize, source } = args;
  const values = projectionValues(projection, archiveSize);
  await db
    .insert(piResourceVersionIndexes)
    .values({
      storageVersionId: versionId,
      extractorVersion: PI_RESOURCE_EXTRACTOR_VERSION,
      ...values,
    })
    .onConflictDoUpdate({
      target: [
        piResourceVersionIndexes.storageVersionId,
        piResourceVersionIndexes.extractorVersion,
      ],
      set: values,
      // A launch captured before a Storage encoding repair must not overwrite
      // the newly enqueued source size or the replacement worker's lease.
      setWhere:
        source === "captured-read"
          ? or(
              eq(piResourceVersionIndexes.sourceArchiveSize, archiveSize),
              sql`${piResourceVersionIndexes.sourceArchiveSize} IS NULL`,
            )
          : undefined,
    });
  signal?.throwIfAborted();
}

export async function readPiResourceVersionIndexes(
  db: Pick<Db, "select">,
  versionIds: readonly string[],
  signal?: AbortSignal,
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
  if (unique.length === 0) {
    return { indexes, misses };
  }
  const rows = await db
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
  signal?.throwIfAborted();
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

async function claimWork(
  db: Db,
  versionIds: readonly string[] | undefined,
  signal: AbortSignal,
) {
  const currentTime = nowDate();
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
}

export const executePiResourceIndexWork$ = command(
  async (
    { get, set },
    versionIds: readonly string[] | undefined,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const work = await claimWork(db, versionIds, signal);
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
      const materialize = async () => {
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
        } else if (
          item.archiveSize > 0 &&
          item.archiveSize <= RESOURCE_ARCHIVE_MAX_BYTES
        ) {
          const downloaded = await settle(
            get(
              downloadS3BufferWithMaxBytes(
                env("R2_USER_STORAGES_BUCKET_NAME"),
                `${item.s3Key}/archive.tar.gz`,
                RESOURCE_ARCHIVE_MAX_BYTES,
                signal,
              ),
            ),
            signal,
          );
          if (!downloaded.ok) {
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
            span.setAttribute("pi.outcome", updated.length ? "retry" : "stale");
            if (updated.length) {
              retried++;
            } else {
              stale++;
            }
            return;
          }
          const archive = downloaded.value;
          if (archive.length === item.archiveSize) {
            const parsed = safeSync(() => {
              return indexPiResourceArchive(archive);
            });
            if ("ok" in parsed) {
              projection = parsed.ok;
            }
          }
        }
        const values = projectionValues(projection, item.archiveSize);
        const updated = await db
          .update(piResourceVersionIndexes)
          .set(values)
          .where(ownership)
          .returning({ versionId: piResourceVersionIndexes.storageVersionId });
        signal.throwIfAborted();
        if (!updated.length) {
          span.setAttribute("pi.outcome", "stale");
          stale++;
          return;
        }
        if (values.status === "ready") {
          ready++;
        } else {
          unindexable++;
        }
        span.setAttributes({
          "pi.outcome": values.status,
          ...(values.status === "ready"
            ? { "pi.ready_lag_ms": now() - item.createdAt.getTime() }
            : {}),
        });
      };
      await materialize().finally(() => {
        span.end();
      });
      signal.throwIfAborted();
    }
    return { claimed: work.length, ready, unindexable, retried, stale };
  },
);
