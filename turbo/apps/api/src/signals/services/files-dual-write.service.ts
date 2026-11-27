/**
 * Release 1 rollout dual-write helpers mirroring binary file mutations from
 * `run_uploaded_files` into the new `files` table.
 * Surface: DB vs API (old code after migration & zero-loss rollback safety).
 * Remove in Release 2 once readers/writers switch to `files` and
 * `run_uploaded_files` retires.
 */
import { command } from "ccstate";
import { and, eq, isNull, sql } from "drizzle-orm";
import { files, type FileOrigin } from "@okouai/db/schema/file";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { writeDb$ } from "../external/db";

function isHostedSitePseudoMetadata(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  if (!metadata) {
    return false;
  }
  return (
    "siteId" in metadata || metadata.generatedBy === "zero-official-website"
  );
}

export interface DualWriteFileRecordArgs {
  readonly id: string;
  readonly orgId: string | null | undefined;
  readonly ownerUserId: string;
  readonly storageKey?: string | null;
  readonly filename?: string | null;
  readonly contentType?: string | null;
  readonly sizeBytes?: number | null;
  readonly checksumSha256?: string | null;
  readonly origin: FileOrigin;
  readonly createdAt?: Date;
  readonly metadata?: Record<string, unknown> | null;
}

/**
 * Idempotent same-UUID dual-write into `files` (File Storage domain).
 * Enforces Release 1 invariants:
 * - Never writes rows with missing/empty `orgId`.
 * - Never writes hosted-site placeholder pseudo-rows.
 */
export const dualWriteFileRecord$ = command(
  async (
    { set },
    args: DualWriteFileRecordArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const orgId = args.orgId?.trim();
    if (!orgId || isHostedSitePseudoMetadata(args.metadata)) {
      return;
    }
    await set(writeDb$)
      .insert(files)
      .values({
        id: args.id,
        orgId,
        ownerUserId: args.ownerUserId,
        storageKey: args.storageKey ?? null,
        filename: args.filename ?? null,
        contentType: args.contentType ?? null,
        sizeBytes: args.sizeBytes ?? null,
        checksumSha256: args.checksumSha256 ?? null,
        origin: args.origin,
        ...(args.createdAt ? { createdAt: args.createdAt } : {}),
      })
      .onConflictDoUpdate({
        target: files.id,
        set: {
          storageKey: sql`COALESCE(excluded.storage_key, ${files.storageKey})`,
          filename: sql`COALESCE(excluded.filename, ${files.filename})`,
          contentType: sql`COALESCE(excluded.content_type, ${files.contentType})`,
          sizeBytes: sql`COALESCE(excluded.size_bytes, ${files.sizeBytes})`,
          checksumSha256: sql`COALESCE(excluded.checksum_sha256, ${files.checksumSha256})`,
        },
      });
    signal.throwIfAborted();
  },
);

/**
 * Dual-write finalized file metadata (size, contentType, checksumSha256, storageKey)
 * onto an existing `files` row.
 */
export const dualWriteFileUpdate$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      readonly storageKey?: string | null;
      readonly contentType?: string | null;
      readonly sizeBytes?: number | null;
      readonly checksumSha256?: string | null;
      readonly origin?: FileOrigin;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const patch: Partial<typeof files.$inferInsert> = {};
    if (args.storageKey !== undefined) {
      patch.storageKey = args.storageKey;
    }
    if (args.contentType !== undefined) {
      patch.contentType = args.contentType;
    }
    if (args.sizeBytes !== undefined) {
      patch.sizeBytes = args.sizeBytes;
    }
    if (args.checksumSha256 !== undefined) {
      patch.checksumSha256 = args.checksumSha256;
    }
    if (args.origin !== undefined) {
      patch.origin = args.origin;
    }
    if (Object.keys(patch).length === 0) {
      return;
    }
    await set(writeDb$).update(files).set(patch).where(eq(files.id, args.id));
    signal.throwIfAborted();
  },
);

/**
 * Soft-delete a file row in `files` when the underlying storage object itself
 * is retired (e.g. unreferenced browser screenshot cleanup).
 *
 * NOTE: Library artifact deletion MUST NOT call this helper — per End-State
 * Principle 4, deleting a file-backed artifact in Library only soft-deletes
 * `artifacts.deleted_at` so chat history retains access for `(ownerUserId, orgId)`.
 */
export const dualWriteFileSoftDelete$ = command(
  async (
    { set },
    args: { readonly id: string; readonly deletedAt: Date },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(writeDb$)
      .update(files)
      .set({ deletedAt: args.deletedAt })
      .where(and(eq(files.id, args.id), isNull(files.deletedAt)));
    signal.throwIfAborted();
  },
);

/**
 * Read a committed `run_uploaded_files` row by ID and mirror it into `files`
 * (used when `org_id` was resolved dynamically inside a SQL CTE).
 */
export const syncFileFromRunUploadedFileRow$ = command(
  async (
    { set },
    args: { readonly fileId: string; readonly origin: FileOrigin },
    signal: AbortSignal,
  ): Promise<void> => {
    const [row] = await set(writeDb$)
      .select({
        id: runUploadedFiles.id,
        orgId: runUploadedFiles.orgId,
        userId: runUploadedFiles.userId,
        storageKey: runUploadedFiles.storageKey,
        filename: runUploadedFiles.filename,
        contentType: runUploadedFiles.contentType,
        sizeBytes: runUploadedFiles.sizeBytes,
        checksumSha256: runUploadedFiles.checksumSha256,
        metadata: runUploadedFiles.metadata,
        createdAt: runUploadedFiles.createdAt,
      })
      .from(runUploadedFiles)
      .where(eq(runUploadedFiles.id, args.fileId))
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return;
    }
    const metadataS3Key =
      typeof row.metadata?.s3Key === "string" && row.metadata.s3Key.length > 0
        ? row.metadata.s3Key
        : null;
    await set(
      dualWriteFileRecord$,
      {
        id: row.id,
        orgId: row.orgId,
        ownerUserId: row.userId,
        storageKey:
          row.storageKey && row.storageKey.length > 0
            ? row.storageKey
            : metadataS3Key,
        filename: row.filename,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        checksumSha256: row.checksumSha256,
        origin: args.origin,
        createdAt: row.createdAt,
        metadata: row.metadata,
      },
      signal,
    );
  },
);
