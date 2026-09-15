import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { PI_MEMORY_SUMMARY_MAX_BYTES } from "@okouai/api-contracts/contracts/runners";
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
import { command } from "ccstate";
import { and, asc, eq, isNull, lte, ne, or } from "drizzle-orm";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { Parser } from "tar";
import { z } from "zod";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  downloadS3BufferWithMaxBytes,
  S3ObjectSizeLimitError,
  s3ObjectHead,
} from "../external/s3";
import { safeJsonParse, safeSync, settle } from "../utils";
import {
  computeContentHashFromHashes,
  hashFileContent,
  type FileEntryWithHash,
} from "./storage-content-hash.service";

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

type ProjectionDb = Pick<Db, "insert">;

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
  readonly scope: MemorySummaryProjectionScope | undefined;
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

export async function enqueueMemorySummaryProjection(
  args: {
    readonly db: ProjectionDb;
    readonly storage: CanonicalMemoryStorageIdentity;
    readonly storageVersionId: string;
  },
  signal?: AbortSignal,
): Promise<boolean> {
  if (!isCanonicalUserMemoryStorage(args.storage)) {
    return false;
  }

  const [inserted] = await args.db
    .insert(memorySummaryProjections)
    .values({
      memoryStorageId: args.storage.id,
      storageVersionId: args.storageVersionId,
      orgId: args.storage.orgId,
      userId: args.storage.userId,
    })
    .onConflictDoNothing()
    .returning({
      memoryStorageId: memorySummaryProjections.memoryStorageId,
    });
  signal?.throwIfAborted();
  return inserted !== undefined;
}

function projectionScopeCondition(
  scope: MemorySummaryProjectionScope | undefined,
) {
  return scope
    ? and(
        eq(memorySummaryProjections.memoryStorageId, scope.memoryStorageId),
        eq(memorySummaryProjections.storageVersionId, scope.storageVersionId),
      )
    : undefined;
}

async function backfillMissingProjections(
  db: Db,
  scope: MemorySummaryProjectionScope | undefined,
  currentTime: Date,
  signal: AbortSignal,
): Promise<number> {
  const rows = await db
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
        scope ? eq(storages.id, scope.memoryStorageId) : undefined,
        scope ? eq(storageVersions.id, scope.storageVersionId) : undefined,
      ),
    )
    .orderBy(asc(storageVersions.createdAt), asc(storageVersions.id))
    .limit(scope ? 1 : BACKFILL_BATCH_SIZE);
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
}

async function claimProjectionWork(
  db: Db,
  scope: MemorySummaryProjectionScope | undefined,
  currentTime: Date,
  signal: AbortSignal,
): Promise<readonly ClaimedProjection[]> {
  return await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        memoryStorageId: memorySummaryProjections.memoryStorageId,
        storageVersionId: memorySummaryProjections.storageVersionId,
        orgId: memorySummaryProjections.orgId,
        userId: memorySummaryProjections.userId,
        attemptCount: memorySummaryProjections.attemptCount,
        s3Key: storageVersions.s3Key,
        storageSize: storageVersions.size,
        archiveSize: storageVersions.archiveSize,
        fileCount: storageVersions.fileCount,
      })
      .from(memorySummaryProjections)
      .innerJoin(
        storages,
        and(
          eq(storages.id, memorySummaryProjections.memoryStorageId),
          eq(storages.orgId, memorySummaryProjections.orgId),
          eq(storages.userId, memorySummaryProjections.userId),
          eq(storages.name, MEMORY_ARTIFACT_NAME),
          ne(storages.userId, VOLUME_ORG_USER_ID),
        ),
      )
      .innerJoin(
        storageVersions,
        and(
          eq(storageVersions.id, memorySummaryProjections.storageVersionId),
          eq(
            storageVersions.storageId,
            memorySummaryProjections.memoryStorageId,
          ),
        ),
      )
      .where(
        and(
          or(
            and(
              eq(memorySummaryProjections.status, "pending"),
              lte(memorySummaryProjections.availableAt, currentTime),
            ),
            and(
              eq(memorySummaryProjections.status, "running"),
              lte(memorySummaryProjections.leaseExpiresAt, currentTime),
            ),
          ),
          projectionScopeCondition(scope),
        ),
      )
      .orderBy(
        asc(memorySummaryProjections.availableAt),
        asc(memorySummaryProjections.memoryStorageId),
        asc(memorySummaryProjections.storageVersionId),
      )
      .limit(scope ? 1 : WORK_BATCH_SIZE)
      .for("update", { of: memorySummaryProjections, skipLocked: true });
    signal.throwIfAborted();

    const claimed: ClaimedProjection[] = [];
    for (const row of rows) {
      const leaseId = randomUUID();
      const attemptCount = row.attemptCount + 1;
      const [updated] = await tx
        .update(memorySummaryProjections)
        .set({
          status: "running",
          leaseId,
          leaseExpiresAt: new Date(currentTime.getTime() + WORK_LEASE_MS),
          attemptCount,
          updatedAt: currentTime,
        })
        .where(
          and(
            eq(memorySummaryProjections.memoryStorageId, row.memoryStorageId),
            eq(memorySummaryProjections.storageVersionId, row.storageVersionId),
          ),
        )
        .returning({
          memoryStorageId: memorySummaryProjections.memoryStorageId,
        });
      if (updated) {
        claimed.push({ ...row, leaseId, attemptCount });
      }
    }
    signal.throwIfAborted();
    return claimed;
  });
}

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
    { get },
    work: ClaimedProjection,
    signal: AbortSignal,
  ): Promise<ManifestValidationResult> => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const manifestKey = `${work.s3Key}/manifest.json`;
    const manifestHead = await get(s3ObjectHead(bucket, manifestKey));
    signal.throwIfAborted();
    if (manifestHead.kind === "missing") {
      return { status: "missing" };
    }
    if (
      manifestHead.contentLength !== undefined &&
      manifestHead.contentLength > MANIFEST_MAX_BYTES
    ) {
      return { status: "over_limit" };
    }

    const manifestDownload = await settle(
      get(
        downloadS3BufferWithMaxBytes(
          bucket,
          manifestKey,
          MANIFEST_MAX_BYTES,
          signal,
        ),
      ),
      signal,
    );
    if (!manifestDownload.ok) {
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
    { get },
    args: {
      readonly work: ClaimedProjection;
      readonly summary: FileEntryWithHash;
    },
    signal: AbortSignal,
  ): Promise<MaterializationResult> => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const work = args.work;
    const archiveKey = `${work.s3Key}/archive.tar.gz`;
    if (
      !Number.isSafeInteger(work.archiveSize) ||
      work.archiveSize <= 0 ||
      work.archiveSize > ARCHIVE_MAX_BYTES
    ) {
      return { status: "over_limit" };
    }
    const archiveHead = await get(s3ObjectHead(bucket, archiveKey));
    signal.throwIfAborted();
    if (archiveHead.kind === "missing") {
      return { status: "missing" };
    }
    if (archiveHead.contentLength !== work.archiveSize) {
      return { status: "invalid" };
    }

    const archiveDownload = await settle(
      get(
        downloadS3BufferWithMaxBytes(
          bucket,
          archiveKey,
          ARCHIVE_MAX_BYTES,
          signal,
        ),
      ),
      signal,
    );
    if (!archiveDownload.ok) {
      if (archiveDownload.error instanceof S3ObjectSizeLimitError) {
        return { status: "over_limit" };
      }
      throw archiveDownload.error;
    }
    if (archiveDownload.value.length !== work.archiveSize) {
      return { status: "invalid" };
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
      return encode(decoded.ok).length;
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

async function finishProjection(
  db: Db,
  work: ClaimedProjection,
  result: MaterializationResult,
  signal: AbortSignal,
): Promise<boolean> {
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
}

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

async function retryProjection(
  db: Db,
  work: ClaimedProjection,
  errorClass: string,
  signal: AbortSignal,
): Promise<boolean> {
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
}

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
    const db = set(writeDb$);
    const backfilled = await backfillMissingProjections(
      db,
      input.scope,
      input.currentTime,
      signal,
    );
    const claimed = await claimProjectionWork(
      db,
      input.scope,
      input.currentTime,
      signal,
    );
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
        const retriedCurrent = await retryProjection(
          db,
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

      const finished = await finishProjection(
        db,
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
    return encode(projection.content).length;
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

async function requeueInvalidReadyProjection(
  db: Db,
  scope: MemorySummaryProjectionScope,
  signal: AbortSignal,
): Promise<void> {
  await db
    .update(memorySummaryProjections)
    .set({
      status: "pending",
      leaseId: null,
      leaseExpiresAt: null,
      availableAt: nowDate(),
      lastErrorClass: "read_integrity_mismatch",
      content: null,
      sourceHash: null,
      sourceSize: null,
      tokenCount: null,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(memorySummaryProjections.memoryStorageId, scope.memoryStorageId),
        eq(memorySummaryProjections.storageVersionId, scope.storageVersionId),
        eq(memorySummaryProjections.status, "ready"),
      ),
    );
  signal.throwIfAborted();
}

export async function readMemorySummaryProjection(
  db: Db,
  args: ReadMemorySummaryProjectionArgs,
  signal: AbortSignal,
): Promise<ReadyMemorySummaryProjection | null> {
  const [row] = await db
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
  signal.throwIfAborted();
  if (!row) {
    return null;
  }
  if (row.projectionStatus === null) {
    const enqueued = await settle(
      enqueueMemorySummaryProjection(
        {
          db,
          storage: {
            id: row.storageId,
            orgId: row.storageOrgId,
            userId: row.storageUserId,
            name: row.storageName,
          },
          storageVersionId: args.storageVersionId,
        },
        signal,
      ),
      signal,
    );
    if (!enqueued.ok) {
      log.warn("Memory summary projection read enqueue failed", {
        orgId: args.orgId,
        userId: args.userId,
        memoryStorageId: args.memoryStorageId,
        storageVersionId: args.storageVersionId,
        errorClass: retryErrorClass(enqueued.error),
      });
    }
    return null;
  }
  if (
    row.projectionStatus !== "ready" ||
    row.content === null ||
    row.sourceHash === null ||
    row.sourceSize === null ||
    row.tokenCount === null
  ) {
    return null;
  }

  const ready = {
    content: row.content,
    sourceHash: row.sourceHash,
    sourceSize: row.sourceSize,
    tokenCount: row.tokenCount,
  };
  if (!readyProjectionIsAuthentic(ready)) {
    const requeued = await settle(
      requeueInvalidReadyProjection(
        db,
        {
          memoryStorageId: args.memoryStorageId,
          storageVersionId: args.storageVersionId,
        },
        signal,
      ),
      signal,
    );
    log.warn("Memory summary projection failed read integrity", {
      orgId: args.orgId,
      userId: args.userId,
      memoryStorageId: args.memoryStorageId,
      storageVersionId: args.storageVersionId,
      errorClass: "read_integrity_mismatch",
      requeueErrorClass: requeued.ok
        ? undefined
        : retryErrorClass(requeued.error),
    });
    return null;
  }
  return ready;
}

export const readMemorySummaryProjection$ = command(
  async (
    { set },
    args: ReadMemorySummaryProjectionArgs,
    signal: AbortSignal,
  ): Promise<ReadyMemorySummaryProjection | null> => {
    return await readMemorySummaryProjection(set(writeDb$), args, signal);
  },
);
