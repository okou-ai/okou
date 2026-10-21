import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { PI_MEMORY_SUMMARY_MAX_BYTES } from "@okouai/api-contracts/contracts/runners";
import {
  computeContentHashFromHashes,
  hashFileContent,
  type FileEntryWithHash,
} from "@okouai/api-contracts/contracts/storage-content-hash";
import {
  MAX_FILE_SIZE_BYTES,
  STORAGE_MANIFEST_MAX_FILES,
  STORAGE_MANIFEST_MAX_PATH_BYTES,
  storageManifestFilesSchema,
} from "@okouai/api-contracts/contracts/storages";
import {
  MEMORY_ARTIFACT_NAME,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import { memorySummaryProjections } from "@okouai/db/schema/memory-summary-projection";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { piMemorySummaryTokenCount } from "@okouai/pi-agent-runtime/api";
import { command, computed, type Computed } from "ccstate";
import { and, asc, count, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import { Parser } from "tar";
import { z } from "zod";

import { parseRawRows } from "../../lib/db-raw-rows";
import { pgIntegerDecoder } from "../../lib/db-structured-result";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import {
  downloadS3BufferWithMaxBytes$,
  S3ObjectSizeLimitError,
  isS3NotFoundError,
} from "../external/s3";
import { safeJsonParse, safeSync, settle } from "../utils";

const log = logger("MemorySummaryProjection");

const MEMORY_SUMMARY_FILENAME = "memory_summary.md";
const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
const ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
const TAR_MAX_OUTPUT_BYTES =
  MAX_FILE_SIZE_BYTES +
  STORAGE_MANIFEST_MAX_PATH_BYTES +
  STORAGE_MANIFEST_MAX_FILES * 1024 +
  1024;
const BACKFILL_BATCH_SIZE = 8;
const WORK_BATCH_SIZE = 4;
const WORK_LEASE_MS = 5 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 15 * 60 * 1000;

const manifestSchema = z
  .object({
    version: z.literal(1),
    files: storageManifestFilesSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();

interface CanonicalMemoryStorageIdentity {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}

interface MemorySummaryProjectionScope {
  readonly memoryStorageId: string;
  readonly storageVersionId: string;
}

interface MemorySummaryProjectionWorkerInput {
  readonly currentTime: Date;
}

interface ClaimedProjection extends MemorySummaryProjectionScope {
  readonly orgId: string;
  readonly userId: string;
  readonly s3Key: string;
  readonly storageSize: number;
  readonly archiveSize: number;
  readonly fileCount: number;
  readonly leaseId: string;
  readonly attemptCount: number;
}

type NoContentStatus = "missing" | "invalid" | "over_limit";

type ManifestValidationResult =
  | {
      readonly status: "valid";
      readonly summary: FileEntryWithHash;
    }
  | { readonly status: NoContentStatus };

type MaterializationResult =
  | {
      readonly status: "ready";
      readonly content: string;
      readonly sourceHash: string;
      readonly sourceSize: number;
      readonly tokenCount: number;
    }
  | { readonly status: NoContentStatus };

interface MemorySummaryProjectionWorkerResult {
  readonly backfilled: number;
  readonly claimed: number;
  readonly ready: number;
  readonly noContent: number;
  readonly retried: number;
  readonly stale: number;
}

interface ReadyMemorySummaryProjection {
  readonly content: string;
  readonly sourceHash: string;
  readonly sourceSize: number;
  readonly tokenCount: number;
}

interface ReadMemorySummaryProjectionArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly memoryStorageId: string;
  readonly storageVersionId: string;
}

function isCanonicalUserMemoryStorage(
  storage: CanonicalMemoryStorageIdentity,
): boolean {
  return (
    storage.name === MEMORY_ARTIFACT_NAME &&
    storage.userId !== VOLUME_ORG_USER_ID
  );
}

export function memorySummaryProjectionValues(args: {
  readonly storage: CanonicalMemoryStorageIdentity;
  readonly storageVersionId: string;
}) {
  return isCanonicalUserMemoryStorage(args.storage)
    ? {
        memoryStorageId: args.storage.id,
        storageVersionId: args.storageVersionId,
        orgId: args.storage.orgId,
        userId: args.storage.userId,
      }
    : undefined;
}

const backfillMissingProjections$ = command(
  async (
    { get, set },
    currentTime: Date,
    signal: AbortSignal,
  ): Promise<number> => {
    const db = set(writeDb$);
    const rows = await get(db$)
      .select({
        memoryStorageId: storages.id,
        storageVersionId: storageVersions.id,
        orgId: storages.orgId,
        userId: storages.userId,
      })
      .from(storageVersions)
      .innerJoin(storages, eq(storages.id, storageVersions.storageId))
      .leftJoin(
        memorySummaryProjections,
        and(
          eq(memorySummaryProjections.memoryStorageId, storages.id),
          eq(memorySummaryProjections.storageVersionId, storageVersions.id),
        ),
      )
      .where(
        and(
          eq(storages.name, MEMORY_ARTIFACT_NAME),
          ne(storages.userId, VOLUME_ORG_USER_ID),
          isNull(memorySummaryProjections.storageVersionId),
        ),
      )
      .orderBy(asc(storageVersions.createdAt), asc(storageVersions.id))
      .limit(BACKFILL_BATCH_SIZE);
    signal.throwIfAborted();
    if (rows.length === 0) {
      return 0;
    }

    const inserted = await db
      .insert(memorySummaryProjections)
      .values(
        rows.map((row) => {
          return { ...row, availableAt: currentTime };
        }),
      )
      .onConflictDoNothing()
      .returning({
        memoryStorageId: memorySummaryProjections.memoryStorageId,
      });
    signal.throwIfAborted();
    return inserted.length;
  },
);

function projectionClaimConditions(currentTime: Date) {
  return {
    storage: and(
      eq(storages.id, memorySummaryProjections.memoryStorageId),
      eq(storages.orgId, memorySummaryProjections.orgId),
      eq(storages.userId, memorySummaryProjections.userId),
      eq(storages.name, MEMORY_ARTIFACT_NAME),
      ne(storages.userId, VOLUME_ORG_USER_ID),
    ),
    version: and(
      eq(storageVersions.id, memorySummaryProjections.storageVersionId),
      eq(storageVersions.storageId, memorySummaryProjections.memoryStorageId),
    ),
    eligible: or(
      and(
        eq(memorySummaryProjections.status, "pending"),
        lte(memorySummaryProjections.availableAt, currentTime),
      ),
      and(
        eq(memorySummaryProjections.status, "running"),
        lte(memorySummaryProjections.leaseExpiresAt, currentTime),
      ),
    ),
  };
}

const claimedProjectionDriverRowSchema = z
  .object({
    memory_storage_id: z.string().uuid(),
    storage_version_id: z.string(),
    org_id: z.string(),
    user_id: z.string(),
    s3_key: z.string(),
    storage_size: z
      .string()
      .transform((value) => {
        return storageVersions.size.mapFromDriverValue(value);
      })
      .pipe(z.number()),
    archive_size: z
      .string()
      .transform((value) => {
        return storageVersions.archiveSize.mapFromDriverValue(value);
      })
      .pipe(z.number()),
    file_count: z.int(),
    lease_id: z.string().uuid(),
    attempt_count: z.int(),
  })
  .transform((row) => {
    return {
      memoryStorageId: row.memory_storage_id,
      storageVersionId: row.storage_version_id,
      orgId: row.org_id,
      userId: row.user_id,
      s3Key: row.s3_key,
      storageSize: row.storage_size,
      archiveSize: row.archive_size,
      fileCount: row.file_count,
      leaseId: row.lease_id,
      attemptCount: row.attempt_count,
    };
  });

const projectionClaimFields = Object.freeze({
  memoryStorageId: memorySummaryProjections.memoryStorageId,
  storageVersionId: memorySummaryProjections.storageVersionId,
  orgId: memorySummaryProjections.orgId,
  userId: memorySummaryProjections.userId,
  attemptCount: memorySummaryProjections.attemptCount,
  s3Key: storageVersions.s3Key,
  storageSize: sql`${storageVersions.size}`
    .mapWith(storageVersions.size)
    .as("storage_size"),
  archiveSize: storageVersions.archiveSize,
  fileCount: storageVersions.fileCount,
  availableAt: memorySummaryProjections.availableAt,
});

const claimProjectionWork$ = command(
  async (
    { set },
    currentTime: Date,
    signal: AbortSignal,
  ): Promise<readonly ClaimedProjection[]> => {
    const db = set(writeDb$);
    const conditions = projectionClaimConditions(currentTime);
    const eligible = db
      .select(projectionClaimFields)
      .from(memorySummaryProjections)
      .innerJoin(storages, conditions.storage)
      .innerJoin(storageVersions, conditions.version)
      .where(conditions.eligible)
      .orderBy(
        asc(memorySummaryProjections.availableAt),
        asc(memorySummaryProjections.memoryStorageId),
        asc(memorySummaryProjections.storageVersionId),
      )
      .limit(WORK_BATCH_SIZE);

    // This unlocked read owns only the prewrite cancellation checkpoint. The
    // locked statement re-evaluates eligibility and never uses this row count.
    const preflight = await eligible;
    signal.throwIfAborted();
    if (preflight.length === 0) {
      return [];
    }

    // At most four application UUIDs; contention can leave candidates unused.
    const leaseIds = Array.from({ length: WORK_BATCH_SIZE }, () => {
      return randomUUID();
    });
    const cohort = db.$with("projection_cohort").as(
      eligible.for("update", {
        of: memorySummaryProjections,
        skipLocked: true,
      }),
    );
    const assignments = db.$with("projection_assignments").as(
      db
        .select({
          memoryStorageId: cohort.memoryStorageId,
          storageVersionId: cohort.storageVersionId,
          orgId: cohort.orgId,
          userId: cohort.userId,
          attemptCount: cohort.attemptCount,
          s3Key: cohort.s3Key,
          storageSize: cohort.storageSize,
          archiveSize: cohort.archiveSize,
          fileCount: cohort.fileCount,
          ordinal: sql`row_number() over (order by ${asc(cohort.availableAt)},
            ${asc(cohort.memoryStorageId)}, ${asc(cohort.storageVersionId)})::int`
            .mapWith(pgIntegerDecoder)
            .as("ordinal"),
        })
        .from(cohort),
    );
    const cohortCount = db.select({ total: count() }).from(assignments);
    const updated = db.$with("projection_updated").as(
      db
        .update(memorySummaryProjections)
        .set({
          status: "running",
          leaseId: sql`case ${assignments.ordinal} ${sql.join(
            leaseIds.map((leaseId, index) => {
              return sql`when ${index + 1} then ${sql.param(leaseId, memorySummaryProjections.leaseId)}::uuid`;
            }),
            sql` `,
          )} end`,
          leaseExpiresAt: new Date(currentTime.getTime() + WORK_LEASE_MS),
          attemptCount: sql`${assignments.attemptCount} + 1`,
          updatedAt: currentTime,
        })
        .from(assignments)
        .where(
          and(
            eq(
              memorySummaryProjections.memoryStorageId,
              assignments.memoryStorageId,
            ),
            eq(
              memorySummaryProjections.storageVersionId,
              assignments.storageVersionId,
            ),
            // The scalar aggregate exhausts the locked, bounded cohort before
            // any lease update. MATERIALIZED alone permits lazy consumption.
            lte(sql`(${cohortCount})`, WORK_BATCH_SIZE),
          ),
        )
        .returning({
          memoryStorageId: memorySummaryProjections.memoryStorageId,
          storageVersionId: memorySummaryProjections.storageVersionId,
          leaseId: memorySummaryProjections.leaseId,
          attemptCount: memorySummaryProjections.attemptCount,
        }),
    );
    const updatedCount = db.select({ total: count() }).from(updated);
    const result = db
      .select({
        memoryStorageId: updated.memoryStorageId,
        storageVersionId: updated.storageVersionId,
        orgId: assignments.orgId,
        userId: assignments.userId,
        s3Key: assignments.s3Key,
        storageSize: assignments.storageSize,
        archiveSize: assignments.archiveSize,
        fileCount: assignments.fileCount,
        leaseId: updated.leaseId,
        attemptCount: updated.attemptCount,
      })
      .from(updated)
      .innerJoin(
        assignments,
        and(
          eq(updated.memoryStorageId, assignments.memoryStorageId),
          eq(updated.storageVersionId, assignments.storageVersionId),
        ),
      )
      // Exhaust actual UPDATE RETURNING before selecting winner-only work.
      .where(lte(sql`(${updatedCount})`, WORK_BATCH_SIZE))
      .orderBy(asc(assignments.ordinal));
    // The installed builder cannot mark SELECT CTEs MATERIALIZED. Keep the
    // envelope bound and schema-aware; parse the raw driver rows at this boundary.
    const claimed = parseRawRows(
      claimedProjectionDriverRowSchema,
      await db.execute(sql`with projection_cohort as materialized (${cohort._.sql}),
        projection_assignments as materialized (${assignments._.sql}),
        projection_updated as (${updated._.sql})
        ${result}`),
    );
    // Completed compound SQL has committed coherent leases before this check.
    // Execution errors (including PostgreSQL cancellation) remain primary.
    signal.throwIfAborted();
    return claimed;
  },
);

function isSafeArchivePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    return false;
  }
  const components = path.split("/");
  return components.every((component) => {
    return component.length > 0 && component !== "." && component !== "..";
  });
}

function validateManifest(args: {
  readonly raw: Buffer;
  readonly work: ClaimedProjection;
}): ManifestValidationResult {
  const decoded = safeSync(() => {
    return new TextDecoder("utf-8", { fatal: true }).decode(args.raw);
  });
  if (!("ok" in decoded)) {
    return { status: "invalid" };
  }
  const parsed = safeJsonParse(decoded.ok);
  const manifest = manifestSchema.safeParse(parsed);
  if (!manifest.success) {
    return { status: "invalid" };
  }

  const files = manifest.data.files;
  if (
    files.length !== args.work.fileCount ||
    !Number.isSafeInteger(args.work.storageSize) ||
    args.work.storageSize < 0 ||
    args.work.storageSize > MAX_FILE_SIZE_BYTES
  ) {
    return { status: "invalid" };
  }

  const seenPaths = new Set<string>();
  let totalSize = 0;
  let summary: FileEntryWithHash | undefined;
  for (const file of files) {
    if (!isSafeArchivePath(file.path) || seenPaths.has(file.path)) {
      return { status: "invalid" };
    }
    seenPaths.add(file.path);
    totalSize += file.size;
    if (!Number.isSafeInteger(totalSize) || totalSize > MAX_FILE_SIZE_BYTES) {
      return { status: "invalid" };
    }
    if (
      file.path !== MEMORY_SUMMARY_FILENAME &&
      file.path.endsWith(`/${MEMORY_SUMMARY_FILENAME}`)
    ) {
      return { status: "invalid" };
    }
    if (file.path === MEMORY_SUMMARY_FILENAME) {
      summary = file;
    }
  }
  if (
    totalSize !== args.work.storageSize ||
    computeContentHashFromHashes(args.work.memoryStorageId, files) !==
      args.work.storageVersionId
  ) {
    return { status: "invalid" };
  }
  if (!summary || summary.size === 0) {
    return { status: "missing" };
  }
  if (summary.size > PI_MEMORY_SUMMARY_MAX_BYTES) {
    return { status: "over_limit" };
  }
  return { status: "valid", summary };
}

function extractSummaryFromArchive(
  archive: Buffer,
):
  | { readonly status: "found"; readonly content: Buffer }
  | { readonly status: NoContentStatus } {
  const uncompressed = safeSync(() => {
    return gunzipSync(archive, { maxOutputLength: TAR_MAX_OUTPUT_BYTES });
  });
  if (!("ok" in uncompressed)) {
    return { status: "invalid" };
  }

  let invalid = false;
  let overLimit = false;
  let parseError: unknown;
  let summary: Buffer | undefined;
  let entryCount = 0;
  let pathBytes = 0;
  const seenPaths = new Set<string>();
  const parser = new Parser({
    strict: true,
    onReadEntry(entry) {
      const regular = ["File", "OldFile", "ContiguousFile"].includes(
        entry.type,
      );
      const directory = entry.type === "Directory";
      const safeDirectoryPath =
        directory && entry.path.endsWith("/")
          ? entry.path.slice(0, -1)
          : entry.path;
      entryCount++;
      pathBytes += Buffer.byteLength(safeDirectoryPath, "utf8");
      if (
        entryCount > STORAGE_MANIFEST_MAX_FILES ||
        pathBytes > STORAGE_MANIFEST_MAX_PATH_BYTES ||
        !isSafeArchivePath(safeDirectoryPath) ||
        seenPaths.has(safeDirectoryPath)
      ) {
        invalid = true;
        entry.resume();
        return;
      }
      seenPaths.add(safeDirectoryPath);
      if (!regular && !directory) {
        invalid = true;
        entry.resume();
        return;
      }
      if (
        safeDirectoryPath !== MEMORY_SUMMARY_FILENAME &&
        safeDirectoryPath.endsWith(`/${MEMORY_SUMMARY_FILENAME}`)
      ) {
        invalid = true;
      }
      if (!regular) {
        if (safeDirectoryPath === MEMORY_SUMMARY_FILENAME) {
          invalid = true;
        }
        entry.resume();
        return;
      }
      if (safeDirectoryPath !== MEMORY_SUMMARY_FILENAME) {
        entry.resume();
        return;
      }
      if (entry.size > PI_MEMORY_SUMMARY_MAX_BYTES) {
        overLimit = true;
        entry.resume();
        return;
      }
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      entry.on("end", () => {
        summary = Buffer.concat(chunks);
      });
    },
  });
  parser.on("error", (error) => {
    parseError = error;
  });
  const parsed = safeSync(() => {
    return parser.end(uncompressed.ok);
  });
  if (!("ok" in parsed) || parseError !== undefined || invalid) {
    return { status: "invalid" };
  }
  if (overLimit) {
    return { status: "over_limit" };
  }
  return summary
    ? { status: "found", content: summary }
    : { status: "missing" };
}

const downloadProjectionManifest$ = command(
  async (
    { set },
    work: ClaimedProjection,
    signal: AbortSignal,
  ): Promise<ManifestValidationResult> => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const manifestKey = `${work.s3Key}/manifest.json`;
    const manifestDownload = await settle(
      set(
        downloadS3BufferWithMaxBytes$,
        { bucket, key: manifestKey, maxBytes: MANIFEST_MAX_BYTES },
        signal,
      ),
      signal,
    );
    if (!manifestDownload.ok) {
      if (isS3NotFoundError(manifestDownload.error)) {
        return { status: "missing" };
      }
      if (manifestDownload.error instanceof S3ObjectSizeLimitError) {
        return { status: "over_limit" };
      }
      throw manifestDownload.error;
    }
    return validateManifest({ raw: manifestDownload.value, work });
  },
);

const downloadProjectionArchive$ = command(
  async (
    { set },
    args: {
      readonly work: ClaimedProjection;
      readonly summary: FileEntryWithHash;
    },
    signal: AbortSignal,
  ): Promise<MaterializationResult> => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const work = args.work;
    const archiveKey = `${work.s3Key}/archive.tar.gz`;
    // The registered archiveSize is a hint, not a physical identity. A
    // previously issued upload URL can leave a different gzip size for the
    // same logical version; enforce limits on the actual object instead.
    const archiveDownload = await settle(
      set(
        downloadS3BufferWithMaxBytes$,
        { bucket, key: archiveKey, maxBytes: ARCHIVE_MAX_BYTES },
        signal,
      ),
      signal,
    );
    if (!archiveDownload.ok) {
      if (isS3NotFoundError(archiveDownload.error)) {
        return { status: "missing" };
      }
      if (archiveDownload.error instanceof S3ObjectSizeLimitError) {
        return { status: "over_limit" };
      }
      throw archiveDownload.error;
    }
    const extracted = extractSummaryFromArchive(archiveDownload.value);
    if (extracted.status !== "found") {
      return extracted;
    }
    if (
      extracted.content.length !== args.summary.size ||
      hashFileContent(extracted.content) !== args.summary.hash
    ) {
      return { status: "invalid" };
    }
    const decoded = safeSync(() => {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        extracted.content,
      );
    });
    if (!("ok" in decoded)) {
      return { status: "invalid" };
    }
    if (decoded.ok.trim().length === 0) {
      return { status: "missing" };
    }
    const tokenCount = safeSync(() => {
      return piMemorySummaryTokenCount(decoded.ok);
    });
    if (!("ok" in tokenCount)) {
      return { status: "invalid" };
    }
    // `tokenCount` describes the full source. The prompt injection budget is
    // applied by the runtime renderer, so token-only excess is not over limit.
    return {
      status: "ready",
      content: decoded.ok,
      sourceHash: args.summary.hash,
      sourceSize: extracted.content.length,
      tokenCount: tokenCount.ok,
    };
  },
);

const materializeProjection$ = command(
  async (
    { set },
    work: ClaimedProjection,
    signal: AbortSignal,
  ): Promise<MaterializationResult> => {
    if (work.fileCount === 0) {
      return { status: "missing" };
    }

    const manifest = await set(downloadProjectionManifest$, work, signal);
    if (manifest.status !== "valid") {
      return manifest;
    }
    return await set(
      downloadProjectionArchive$,
      { work, summary: manifest.summary },
      signal,
    );
  },
);

function leaseCondition(work: ClaimedProjection) {
  return and(
    eq(memorySummaryProjections.memoryStorageId, work.memoryStorageId),
    eq(memorySummaryProjections.storageVersionId, work.storageVersionId),
    eq(memorySummaryProjections.status, "running"),
    eq(memorySummaryProjections.leaseId, work.leaseId),
  );
}

const finishProjection$ = command(
  async (
    { set },
    work: ClaimedProjection,
    result: MaterializationResult,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const [updated] = await db
      .update(memorySummaryProjections)
      .set({
        status: result.status,
        leaseId: null,
        leaseExpiresAt: null,
        lastErrorClass: null,
        content: result.status === "ready" ? result.content : null,
        sourceHash: result.status === "ready" ? result.sourceHash : null,
        sourceSize: result.status === "ready" ? result.sourceSize : null,
        tokenCount: result.status === "ready" ? result.tokenCount : null,
        updatedAt: nowDate(),
      })
      .where(leaseCondition(work))
      .returning({
        memoryStorageId: memorySummaryProjections.memoryStorageId,
      });
    signal.throwIfAborted();
    return updated !== undefined;
  },
);

function retryDelay(attemptCount: number): number {
  return Math.min(
    MAX_RETRY_DELAY_MS,
    1000 * 2 ** Math.min(Math.max(attemptCount - 1, 0), 9),
  );
}

function retryErrorClass(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "abort";
  }
  if (error instanceof Error && error.name.length > 0) {
    return error.name.slice(0, 128);
  }
  return "unknown";
}

const retryProjection$ = command(
  async (
    { set },
    work: ClaimedProjection,
    errorClass: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    const [updated] = await db
      .update(memorySummaryProjections)
      .set({
        status: "pending",
        leaseId: null,
        leaseExpiresAt: null,
        availableAt: new Date(
          currentTime.getTime() + retryDelay(work.attemptCount),
        ),
        lastErrorClass: errorClass,
        updatedAt: currentTime,
      })
      .where(leaseCondition(work))
      .returning({
        memoryStorageId: memorySummaryProjections.memoryStorageId,
      });
    signal.throwIfAborted();
    return updated !== undefined;
  },
);

function logProjectionOutcome(args: {
  readonly work: ClaimedProjection;
  readonly outcome: string;
  readonly durationMs: number;
  readonly errorClass?: string;
}): void {
  log.debug("Memory summary projection processed", {
    orgId: args.work.orgId,
    userId: args.work.userId,
    memoryStorageId: args.work.memoryStorageId,
    storageVersionId: args.work.storageVersionId,
    attemptCount: args.work.attemptCount,
    outcome: args.outcome,
    durationMs: Math.max(0, Math.round(args.durationMs)),
    ...(args.errorClass ? { errorClass: args.errorClass } : {}),
  });
}

export const executeMemorySummaryProjectionWork$ = command(
  async (
    { set },
    input: MemorySummaryProjectionWorkerInput,
    signal: AbortSignal,
  ): Promise<MemorySummaryProjectionWorkerResult> => {
    const backfilled = await set(
      backfillMissingProjections$,
      input.currentTime,
      signal,
    );
    const claimed = await set(claimProjectionWork$, input.currentTime, signal);
    let ready = 0;
    let noContent = 0;
    let retried = 0;
    let stale = 0;
    for (const work of claimed) {
      const startedAt = performance.now();
      const materialized = await settle(
        set(materializeProjection$, work, signal),
        signal,
      );
      if (!materialized.ok) {
        const errorClass = retryErrorClass(materialized.error);
        const retriedCurrent = await set(
          retryProjection$,
          work,
          errorClass,
          signal,
        );
        if (retriedCurrent) {
          retried++;
          logProjectionOutcome({
            work,
            outcome: "retry",
            durationMs: performance.now() - startedAt,
            errorClass,
          });
        } else {
          stale++;
        }
        continue;
      }

      const finished = await set(
        finishProjection$,
        work,
        materialized.value,
        signal,
      );
      if (!finished) {
        stale++;
        continue;
      }
      if (materialized.value.status === "ready") {
        ready++;
      } else {
        noContent++;
      }
      logProjectionOutcome({
        work,
        outcome: materialized.value.status,
        durationMs: performance.now() - startedAt,
      });
    }
    return {
      backfilled,
      claimed: claimed.length,
      ready,
      noContent,
      retried,
      stale,
    };
  },
);

function readyProjectionIsAuthentic(
  projection: ReadyMemorySummaryProjection,
): boolean {
  const content = Buffer.from(projection.content, "utf8");
  const tokenCount = safeSync(() => {
    return piMemorySummaryTokenCount(projection.content);
  });
  // `tokenCount` describes the full stored source. The prompt budget is applied
  // by the runtime renderer, so a larger authentic source is not corrupt here.
  return (
    "ok" in tokenCount &&
    projection.content.trim().length > 0 &&
    content.length === projection.sourceSize &&
    hashFileContent(content) === projection.sourceHash &&
    content.length <= PI_MEMORY_SUMMARY_MAX_BYTES &&
    tokenCount.ok === projection.tokenCount
  );
}

export interface MemorySummaryProjectionReadInput {
  readonly args: ReadMemorySummaryProjectionArgs;
}

interface MemorySummaryProjectionReadRow {
  readonly storageId: string;
  readonly storageOrgId: string;
  readonly storageUserId: string;
  readonly storageName: string;
  readonly projectionStatus: string | null;
  readonly content: string | null;
  readonly sourceHash: string | null;
  readonly sourceSize: number | null;
  readonly tokenCount: number | null;
}

export interface MemorySummaryProjectionReadResult {
  readonly input: MemorySummaryProjectionReadInput;
  readonly ready: ReadyMemorySummaryProjection | null;
  readonly unavailableReason?: "missing" | "invalid";
}

/** The memory summary projection for one exact memory storage version. */
export function createMemorySummaryProjectionRead(
  input$: Computed<Promise<MemorySummaryProjectionReadInput | undefined>>,
) {
  return computed(
    async (get): Promise<MemorySummaryProjectionReadResult | null> => {
      const input = await get(input$);
      if (!input) {
        return null;
      }
      const { args } = input;
      const [row] = await get(db$)
        .select({
          storageId: storages.id,
          storageOrgId: storages.orgId,
          storageUserId: storages.userId,
          storageName: storages.name,
          projectionStatus: memorySummaryProjections.status,
          content: memorySummaryProjections.content,
          sourceHash: memorySummaryProjections.sourceHash,
          sourceSize: memorySummaryProjections.sourceSize,
          tokenCount: memorySummaryProjections.tokenCount,
        })
        .from(storages)
        .innerJoin(
          storageVersions,
          and(
            eq(storageVersions.storageId, storages.id),
            eq(storageVersions.id, args.storageVersionId),
          ),
        )
        .leftJoin(
          memorySummaryProjections,
          and(
            eq(memorySummaryProjections.memoryStorageId, storages.id),
            eq(memorySummaryProjections.storageVersionId, storageVersions.id),
            eq(memorySummaryProjections.orgId, args.orgId),
            eq(memorySummaryProjections.userId, args.userId),
          ),
        )
        .where(
          and(
            eq(storages.id, args.memoryStorageId),
            eq(storages.orgId, args.orgId),
            eq(storages.userId, args.userId),
            eq(storages.name, MEMORY_ARTIFACT_NAME),
            ne(storages.userId, VOLUME_ORG_USER_ID),
          ),
        )
        .limit(1);
      return memorySummaryProjectionReadResult(input, row);
    },
  );
}

export function memorySummaryProjectionReadResult(
  input: MemorySummaryProjectionReadInput,
  row: MemorySummaryProjectionReadRow | undefined,
): MemorySummaryProjectionReadResult {
  if (!row) {
    return { input, ready: null, unavailableReason: "missing" };
  }
  if (row.projectionStatus === null) {
    return {
      input,
      ready: null,
      unavailableReason: "missing",
    };
  }
  if (
    row.projectionStatus !== "ready" ||
    row.content === null ||
    row.sourceHash === null ||
    row.sourceSize === null ||
    row.tokenCount === null
  ) {
    return {
      input,
      ready: null,
      ...(row.projectionStatus === "ready"
        ? { unavailableReason: "invalid" as const }
        : {}),
    };
  }
  const ready = {
    content: row.content,
    sourceHash: row.sourceHash,
    sourceSize: row.sourceSize,
    tokenCount: row.tokenCount,
  };
  return readyProjectionIsAuthentic(ready)
    ? { input, ready }
    : { input, ready: null, unavailableReason: "invalid" };
}
