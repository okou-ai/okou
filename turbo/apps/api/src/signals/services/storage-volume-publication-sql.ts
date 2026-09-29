import { sql } from "drizzle-orm";
import { piResourceVersionIndexes } from "@okouai/db/schema/pi-resource-version-index";
import {
  piStableContextArtifactResources,
  piStableContextHeads,
} from "@okouai/db/schema/pi-stable-context";
import { PI_RESOURCE_EXTRACTOR_VERSION } from "../../lib/pi-resource-index";
import { nowDate } from "../../lib/time";
import type { PreparedStorageVersion } from "./storage-version-registration.service";

/** One immutable version per publication; insert-first distinguishes new work from encoding repair. */
export function repairVolumeIndexSql(version: PreparedStorageVersion) {
  const at = nowDate().toISOString();
  return sql`WITH repaired AS (
    UPDATE ${piResourceVersionIndexes} SET status = 'pending', projection = NULL, projection_hash = NULL,
      source_archive_size = ${version.archiveSize}, lease_id = NULL, lease_expires_at = NULL,
      available_at = ${at}::timestamp, attempt_count = 0, updated_at = ${at}::timestamp
    WHERE storage_version_id = ${version.versionId} AND extractor_version = ${PI_RESOURCE_EXTRACTOR_VERSION}
      AND source_archive_size IS DISTINCT FROM ${version.archiveSize}
    RETURNING storage_version_id
  ), locked_heads AS MATERIALIZED (
    SELECT id FROM ${piStableContextHeads} WHERE EXISTS (SELECT 1 FROM repaired) AND (
      EXISTS (SELECT 1 FROM ${piStableContextArtifactResources}
        WHERE ${piStableContextArtifactResources.artifactDigest} = ${piStableContextHeads.artifactDigest}
          AND ${piStableContextArtifactResources.storageVersionId} = ${version.versionId})
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(${piStableContextHeads.input}->'storageMounts', '[]'::jsonb)) AS mount
        WHERE mount->>'versionId' = ${version.versionId})
    ) ORDER BY id FOR UPDATE
  ) UPDATE ${piStableContextHeads} SET generation = generation + 1, status = 'missing', input = NULL,
    input_digest = NULL, artifact_digest = NULL, validity_horizon = NULL, lease_id = NULL,
    lease_expires_at = NULL, available_at = ${at}::timestamp, attempt_count = 0, last_error_class = NULL, updated_at = ${at}::timestamp
    WHERE id IN (SELECT id FROM locked_heads)`;
}
