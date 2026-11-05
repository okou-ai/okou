import { isDeepStrictEqual } from "node:util";
import type postgres from "postgres";
import { getCustomConnectorSkillStorageName } from "@okouai/core/storage-names";
import {
  BackfillError,
  sourceSchema,
  type Source,
  type PlanRow,
} from "./command";

export async function loadSource(
  sql: postgres.Sql,
  connectorId: string,
): Promise<Source> {
  const rows = await sql`
    SELECT c.id AS "connectorId", c.org_id AS "orgId", c.xmin::text AS "ownerXmin",
      c.skill_storage_version_id AS "sourceVersionId", s.id AS "storageId",
      s.xmin::text AS "storageXmin", v.xmin::text AS "versionXmin",
      v.s3_key AS "s3Key", v.archive_size::float8 AS "archiveBytes",
      v.size::float8 AS "contentBytes", v.file_count AS "fileCount",
      c.skill_content_bundle AS bundle, c.skill_content_bundle_source_version_id AS "bundleSource"
    FROM org_custom_connectors c
    JOIN storage_versions v ON v.id = c.skill_storage_version_id
    JOIN storages s ON s.id = v.storage_id
    WHERE c.id = ${connectorId} AND s.org_id = c.org_id
      AND s.name = ${getCustomConnectorSkillStorageName(connectorId)}
      AND v.s3_key = s.s3_prefix || '/' || v.id
  `;
  if (rows.length !== 1)
    throw new BackfillError("LegacySkillSourceUnavailable");
  return sourceSchema.parse(rows[0]);
}

function identity(source: Source) {
  const { ownerXmin, bundle, bundleSource, ...stable } = source;
  return { stable, ownerXmin, bundle, bundleSource };
}

export function sourceUnchanged(
  current: Source,
  row: PlanRow,
): "pending" | "verified" {
  const now = identity(current),
    before = identity(row.source);
  if (!isDeepStrictEqual(now.stable, before.stable))
    throw new BackfillError("SourceChanged");
  if (
    current.bundleSource === current.sourceVersionId &&
    isDeepStrictEqual(current.bundle, row.target)
  )
    return "verified";
  if (
    current.ownerXmin !== row.source.ownerXmin ||
    !isDeepStrictEqual(current.bundle, row.source.bundle) ||
    current.bundleSource !== row.source.bundleSource
  )
    throw new BackfillError("OwnerChanged");
  return "pending";
}

export async function publishReference(sql: postgres.Sql, row: PlanRow) {
  const source = row.source;
  const expectedBundle =
    source.bundle === null
      ? sql`c.skill_content_bundle IS NULL`
      : sql`c.skill_content_bundle = ${sql.json(source.bundle)}`;
  const updated = await sql`
    UPDATE org_custom_connectors c
    SET skill_content_bundle = ${sql.json(row.target)},
      skill_content_bundle_source_version_id = ${source.sourceVersionId}
    WHERE c.id = ${source.connectorId} AND c.org_id = ${source.orgId}
      AND c.skill_storage_version_id = ${source.sourceVersionId}
      AND c.xmin::text = ${source.ownerXmin} AND ${expectedBundle}
      AND c.skill_content_bundle_source_version_id IS NOT DISTINCT FROM ${source.bundleSource}
      AND EXISTS (
        SELECT 1 FROM storage_versions v JOIN storages s ON s.id = v.storage_id
        WHERE v.id = c.skill_storage_version_id AND s.id = ${source.storageId}
          AND s.org_id = c.org_id AND s.name = ${getCustomConnectorSkillStorageName(source.connectorId)}
          AND s.xmin::text = ${source.storageXmin} AND v.xmin::text = ${source.versionXmin}
          AND v.s3_key = ${source.s3Key} AND v.s3_key = s.s3_prefix || '/' || v.id
      ) RETURNING c.id
  `;
  if (updated.length !== 1) throw new BackfillError("PublicationConflict");
}
