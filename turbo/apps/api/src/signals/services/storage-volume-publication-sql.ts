import { storages, storageVersions } from "@okouai/db/schema/storage";
import type { PreparedServerSideVolume } from "./storage-volume-publication.service";
import { piResourceProjectionValues } from "./pi-resource-version-index.service";
import { sql } from "drizzle-orm";
import { piResourceVersionIndexes } from "@okouai/db/schema/pi-resource-version-index";
import {
  piStableContextArtifactResources,
  piStableContextHeads,
} from "@okouai/db/schema/pi-stable-context";
import { PI_RESOURCE_EXTRACTOR_VERSION } from "../../lib/pi-resource-index";
import { nowDate } from "../../lib/time";
import type { PreparedStorageVersion } from "./storage-version-registration.service";

/** One immutable version per publication; insert-first distinguishes new work from encoding repair.
 * The head invalidation predicate lives in the UPDATE itself, so a concurrently
 * changed head is rechecked against its committed row version instead of being
 * pre-locked. */
export function repairVolumeIndexSql(version: PreparedStorageVersion) {
  const at = nowDate().toISOString();
  return sql`WITH repaired AS (
    UPDATE ${piResourceVersionIndexes} SET status = 'pending', projection = NULL, projection_hash = NULL,
      source_archive_size = ${version.archiveSize}, lease_id = NULL, lease_expires_at = NULL,
      available_at = ${at}::timestamp, attempt_count = 0, updated_at = ${at}::timestamp
    WHERE storage_version_id = ${version.versionId} AND extractor_version = ${PI_RESOURCE_EXTRACTOR_VERSION}
      AND source_archive_size IS DISTINCT FROM ${version.archiveSize}
    RETURNING storage_version_id
  ) UPDATE ${piStableContextHeads} SET generation = generation + 1, status = 'missing', input = NULL,
    input_digest = NULL, artifact_digest = NULL, validity_horizon = NULL, lease_id = NULL,
    lease_expires_at = NULL, available_at = ${at}::timestamp, attempt_count = 0, last_error_class = NULL, updated_at = ${at}::timestamp
    WHERE EXISTS (SELECT 1 FROM repaired) AND (
      EXISTS (SELECT 1 FROM ${piStableContextArtifactResources}
        WHERE ${piStableContextArtifactResources.artifactDigest} = ${piStableContextHeads.artifactDigest}
          AND ${piStableContextArtifactResources.storageVersionId} = ${version.versionId})
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(${piStableContextHeads.input}->'storageMounts', '[]'::jsonb)) AS mount
        WHERE mount->>'versionId' = ${version.versionId})
    )`;
}

/** Register one immutable version and Storage HEAD, preserving a reused ready index.
 * This builds SQL only; each owning command executes it in its local transaction.
 * The version insert's FK check and the HEAD UPDATE take the Storage row's
 * implicit locks; a missing Storage publishes no row and the caller rejects it.
 */
export function preparedVolumePublicationSql(
  volume: PreparedServerSideVolume,
  publishedAt: Date,
) {
  if (!volume.piResourceIndex) {
    throw new Error(
      "Atomic source publication requires its prepared resource index",
    );
  }
  const version = volume.version;
  const publication = sql`WITH retained_storage AS MATERIALIZED (
    SELECT id FROM ${storages} WHERE id = ${version.storageId}::uuid
  ), registered AS (
    INSERT INTO ${storageVersions}
      (id, storage_id, s3_key, size, archive_size, file_count, message, created_by)
    SELECT ${version.versionId}, id, ${version.s3Key}, ${version.size},
      ${version.archiveSize}, ${version.fileCount}, ${version.message}, ${version.createdBy}
    FROM retained_storage
    ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
    WHERE storage_versions.storage_id = EXCLUDED.storage_id
      AND storage_versions.s3_key = EXCLUDED.s3_key
      AND storage_versions.size = EXCLUDED.size
      AND storage_versions.archive_size = EXCLUDED.archive_size
      AND storage_versions.file_count = EXCLUDED.file_count
      AND storage_versions.message IS NOT DISTINCT FROM EXCLUDED.message
      AND storage_versions.created_by = EXCLUDED.created_by
    RETURNING id, storage_id
  ), published AS (
    UPDATE ${storages} SET head_version_id = ${version.versionId},
      size = ${version.size}, file_count = ${version.fileCount},
      updated_at = ${volume.updatedAt.toISOString()}::timestamp
    WHERE id IN (SELECT storage_id FROM registered)
    RETURNING id
  )`;
  if (volume.piResourceIndex.kind === "reused") {
    return sql`${publication} SELECT id FROM published`;
  }
  const projection = piResourceProjectionValues(
    volume.piResourceIndex.projection,
    version.archiveSize,
    publishedAt,
  );
  return sql`${publication}, indexed AS (
    INSERT INTO ${piResourceVersionIndexes}
      (storage_version_id, extractor_version, status, projection,
       projection_hash, source_archive_size, lease_id, lease_expires_at, updated_at)
    SELECT ${version.versionId}, ${PI_RESOURCE_EXTRACTOR_VERSION}, ${projection.status},
      ${sql.param(projection.projection, piResourceVersionIndexes.projection)},
      ${projection.projectionHash}, ${version.archiveSize}, NULL, NULL,
      ${publishedAt.toISOString()}::timestamp
    FROM published
    ON CONFLICT (storage_version_id, extractor_version) DO UPDATE SET
      status = EXCLUDED.status, projection = EXCLUDED.projection,
      projection_hash = EXCLUDED.projection_hash, source_archive_size = EXCLUDED.source_archive_size,
      lease_id = NULL, lease_expires_at = NULL, updated_at = EXCLUDED.updated_at
    RETURNING storage_version_id
  ) SELECT id FROM published WHERE EXISTS (SELECT 1 FROM indexed)`;
}
