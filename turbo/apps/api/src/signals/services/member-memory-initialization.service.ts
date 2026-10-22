import { computeContentHashFromHashes } from "@okouai/api-contracts/contracts/storage-content-hash";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { command } from "ccstate";
import { isNull, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { piResourceProjectionValues } from "./pi-resource-version-index.service";
import { piResourceVersionIndexes } from "@okouai/db/schema/pi-resource-version-index";
import { PI_RESOURCE_EXTRACTOR_VERSION } from "../../lib/pi-resource-index";
import { newStorageS3Location } from "./storage-s3-prefix.utils";

/** Establish the member's memory before any run can require its mount. */
export const initializeMemberMemory$ = command(
  async (
    { set },
    identity: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const location = newStorageS3Location(identity.orgId);
    const candidateVersionId = computeContentHashFromHashes(
      location.storageId,
      [],
    );
    const projection = piResourceProjectionValues(
      { schemaVersion: 1, files: [] },
      0,
      nowDate(),
    );
    const updatedAt = nowDate();
    // The conflict branch hashes the incumbent UUID and retains its prefix.
    // A published HEAD accepts no row, so every dependent write is a no-op.
    const initialized = db
      .insert(storages)
      .values({
        id: location.storageId,
        orgId: identity.orgId,
        userId: identity.userId,
        name: MEMORY_ARTIFACT_NAME,
        s3Prefix: location.s3Prefix,
        headVersionId: candidateVersionId,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [storages.orgId, storages.userId, storages.name],
        set: {
          headVersionId: sql`encode(sha256(convert_to('storage:' || ${storages.id}::text || chr(10), 'UTF8')), 'hex')`,
          size: 0,
          fileCount: 0,
          updatedAt,
        },
        setWhere: isNull(storages.headVersionId),
      })
      .returning({
        id: storages.id,
        s3Prefix: storages.s3Prefix,
        headVersionId: storages.headVersionId,
      })
      .getSQL();
    // Drizzle INSERT SELECT requires every table column; these dependent partial
    // inserts keep omitted fields on their database defaults. Index rows
    // depend on accepted initialization even when the immutable version exists.
    const statement = sql`WITH initialized AS (${initialized}), registered AS (
      INSERT INTO ${storageVersions}
        (id, storage_id, s3_key, size, archive_size, file_count, message, created_by)
      SELECT initialized.head_version_id, initialized.id,
        initialized.s3_prefix || '/' || initialized.head_version_id,
        ${sql.param(0, storageVersions.size)},
        ${sql.param(0, storageVersions.archiveSize)},
        ${sql.param(0, storageVersions.fileCount)},
        ${sql.param("Initial empty artifact", storageVersions.message)},
        ${sql.param(identity.userId, storageVersions.createdBy)} FROM initialized
      ON CONFLICT DO NOTHING
    ) INSERT INTO ${piResourceVersionIndexes}
        (storage_version_id, extractor_version, status, projection,
         projection_hash, source_archive_size, lease_id, lease_expires_at, updated_at)
      SELECT initialized.head_version_id,
        ${sql.param(PI_RESOURCE_EXTRACTOR_VERSION, piResourceVersionIndexes.extractorVersion)},
        ${sql.param(projection.status, piResourceVersionIndexes.status)},
        ${sql.param(projection.projection, piResourceVersionIndexes.projection)},
        ${sql.param(projection.projectionHash, piResourceVersionIndexes.projectionHash)},
        ${sql.param(projection.sourceArchiveSize, piResourceVersionIndexes.sourceArchiveSize)},
        ${sql.param(projection.leaseId, piResourceVersionIndexes.leaseId)},
        ${sql.param(projection.leaseExpiresAt, piResourceVersionIndexes.leaseExpiresAt)},
        ${sql.param(projection.updatedAt, piResourceVersionIndexes.updatedAt)} FROM initialized
      ON CONFLICT (storage_version_id, extractor_version) DO UPDATE SET
        status = EXCLUDED.status, projection = EXCLUDED.projection,
        projection_hash = EXCLUDED.projection_hash,
        source_archive_size = EXCLUDED.source_archive_size,
        lease_id = EXCLUDED.lease_id, lease_expires_at = EXCLUDED.lease_expires_at,
        updated_at = EXCLUDED.updated_at
`;
    signal.throwIfAborted();
    await db.execute(statement);
    // A completed statement can remain committed when cancellation skips the
    // caller's subsequent work; this is not transport cancellation or rollback.
    signal.throwIfAborted();
  },
);
