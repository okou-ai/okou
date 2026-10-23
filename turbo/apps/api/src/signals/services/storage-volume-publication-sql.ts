import { storages, storageVersions } from "@okouai/db/schema/storage";
import type { PreparedServerSideVolume } from "./storage-volume-publication.service";
import { piResourceProjectionValues } from "./pi-resource-version-index.service";
import { eq, exists, inArray, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { piResourceVersionIndexes } from "@okouai/db/schema/pi-resource-version-index";
import { PI_RESOURCE_EXTRACTOR_VERSION } from "../../lib/pi-resource-index";
import type { PreparedStorageVersion } from "./storage-version-registration.service";

/** One immutable version per publication; insert-first distinguishes new work from encoding repair. */
export function repairVolumeIndexSql(
  version: PreparedStorageVersion,
  updatedAt: Date,
) {
  const at = updatedAt.toISOString();
  return sql`UPDATE ${piResourceVersionIndexes} SET status = 'pending', projection = NULL, projection_hash = NULL,
      source_archive_size = ${version.archiveSize}, lease_id = NULL, lease_expires_at = NULL,
      available_at = ${at}::timestamp, attempt_count = 0, updated_at = ${at}::timestamp
    WHERE storage_version_id = ${version.versionId} AND extractor_version = ${PI_RESOURCE_EXTRACTOR_VERSION}
      AND source_archive_size IS DISTINCT FROM ${version.archiveSize}`;
}

/** Pure CTE plan so an owning publication can include its dependent writes. */
export function preparedVolumePublicationPlan(
  volume: PreparedServerSideVolume,
  publishedAt: Date,
) {
  if (!volume.piResourceIndex) {
    throw new Error(
      "Atomic source publication requires its prepared resource index",
    );
  }
  const query = new QueryBuilder();
  const version = volume.version;
  const retained = query
    .$with("retained_storage")
    .as(
      query
        .select({ id: storages.id })
        .from(storages)
        .where(eq(storages.id, version.storageId)),
    );
  const registered = query.$with("registered", {
    id: storageVersions.id,
    storageId: storageVersions.storageId,
  }).as(sql`INSERT INTO ${storageVersions}
      (id, storage_id, s3_key, size, archive_size, file_count, message, created_by)
    SELECT ${version.versionId}, id, ${version.s3Key}, ${version.size},
      ${version.archiveSize}, ${version.fileCount}, ${version.message}, ${version.createdBy}
    FROM ${retained}
    ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
    WHERE storage_versions.storage_id = EXCLUDED.storage_id
      AND storage_versions.s3_key = EXCLUDED.s3_key
      AND storage_versions.size = EXCLUDED.size
      AND storage_versions.archive_size = EXCLUDED.archive_size
      AND storage_versions.file_count = EXCLUDED.file_count
      AND storage_versions.message IS NOT DISTINCT FROM EXCLUDED.message
      AND storage_versions.created_by = EXCLUDED.created_by
    RETURNING id, storage_id`);
  const published = query.$with("published", { id: storages.id }).as(
    sql`UPDATE ${storages} SET head_version_id = ${version.versionId},
      size = ${version.size}, file_count = ${version.fileCount},
      updated_at = ${volume.updatedAt.toISOString()}::timestamp
    WHERE ${inArray(storages.id, query.select({ storageId: registered.storageId }).from(registered))}
    RETURNING id`,
  );
  if (volume.piResourceIndex.kind === "reused") {
    return { ctes: [retained, registered, published], published };
  }
  const projection = piResourceProjectionValues(
    volume.piResourceIndex.projection,
    version.archiveSize,
    publishedAt,
  );
  const indexed = query.$with("indexed", {
    storageVersionId: piResourceVersionIndexes.storageVersionId,
  }).as(sql`INSERT INTO ${piResourceVersionIndexes}
      (storage_version_id, extractor_version, status, projection,
       projection_hash, source_archive_size, lease_id, lease_expires_at, updated_at)
    SELECT ${version.versionId}, ${PI_RESOURCE_EXTRACTOR_VERSION}, ${projection.status},
      ${sql.param(projection.projection, piResourceVersionIndexes.projection)},
      ${projection.projectionHash}, ${version.archiveSize}, NULL, NULL,
      ${publishedAt.toISOString()}::timestamp
    FROM ${published}
    ON CONFLICT (storage_version_id, extractor_version) DO UPDATE SET
      status = EXCLUDED.status, projection = EXCLUDED.projection,
      projection_hash = EXCLUDED.projection_hash, source_archive_size = EXCLUDED.source_archive_size,
      lease_id = NULL, lease_expires_at = NULL, updated_at = EXCLUDED.updated_at
    RETURNING storage_version_id`);
  const ready = query.$with("published_volume").as(
    query
      .select({ id: published.id })
      .from(published)
      .where(
        exists(query.select({ id: indexed.storageVersionId }).from(indexed)),
      ),
  );
  return {
    ctes: [retained, registered, published, indexed, ready],
    published: ready,
  };
}

/** Register one immutable version and Storage HEAD, preserving a reused ready index. */
export function preparedVolumePublicationSql(
  volume: PreparedServerSideVolume,
  publishedAt: Date,
) {
  const plan = preparedVolumePublicationPlan(volume, publishedAt);
  return new QueryBuilder()
    .with(...plan.ctes)
    .select({ id: plan.published.id })
    .from(plan.published)
    .getSQL();
}
