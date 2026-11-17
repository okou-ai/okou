import {
  memberMemories,
  memoryVersions,
  memoryVersionLineage,
} from "@okouai/db/schema/member-memory";
import { SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

/** Pure SQL for the legacy-authoritative preparation release, never a read fallback. */
export function memberMemoryPreparationCtes(roots: SQL, versions: SQL) {
  const registered = new PgDialect().buildInsertQuery({
    table: memoryVersions,
    select: true,
    values: sql`SELECT v.id,v."storageId",v."s3Key",v.size,v."archiveSize",v."fileCount",v.message,v."createdBy",v."createdAt" FROM memory_source_versions AS v`,
    onConflict: sql`(id) DO UPDATE SET id=excluded.id WHERE
      (${memoryVersions.memoryId},${memoryVersions.objectPrefix},${memoryVersions.contentSize},
       ${memoryVersions.archiveSize},${memoryVersions.fileCount},${memoryVersions.message},
       ${memoryVersions.createdBy},${memoryVersions.createdAt}) IS NOT DISTINCT FROM
      (excluded.memory_id,excluded.object_prefix,excluded.content_size,excluded.archive_size,
       excluded.file_count,excluded.message,excluded.created_by,excluded.created_at)`,
    returning: [{ path: ["id"], field: memoryVersions.id }],
  });
  // The root's required prefix is selected only from a fully validated source.
  // A missing immutable match violates NOT NULL and rolls back the whole statement.
  const prepared = new PgDialect().buildInsertQuery({
    table: memberMemories,
    select: true,
    values: sql`SELECT r.id,r."orgId",r."userId",
      (SELECT r."s3Prefix" WHERE
        (SELECT count(*) FROM memory_registered_versions)=(SELECT count(*) FROM memory_source_versions)
        AND NOT EXISTS (SELECT 1 FROM ${memberMemories} AS m WHERE m.id=r.id AND
          (m.org_id,m.user_id,m.object_prefix,m.created_at) IS DISTINCT FROM
          (r."orgId",r."userId",r."s3Prefix",r."createdAt"))),
      r.size,r."fileCount",r."headVersionId",r."createdAt",r."updatedAt"
      FROM memory_source_roots AS r`,
    onConflict: sql`(id) DO UPDATE SET
      head_version_id=CASE WHEN excluded.head_version_id IS NOT NULL THEN excluded.head_version_id ELSE ${memberMemories.headVersionId} END,
      content_size=CASE WHEN excluded.head_version_id IS NOT NULL THEN excluded.content_size ELSE ${memberMemories.contentSize} END,
      file_count=CASE WHEN excluded.head_version_id IS NOT NULL THEN excluded.file_count ELSE ${memberMemories.fileCount} END,
      updated_at=CASE WHEN excluded.head_version_id IS NOT NULL THEN excluded.updated_at ELSE ${memberMemories.updatedAt} END
      WHERE (${memberMemories.orgId},${memberMemories.userId},${memberMemories.objectPrefix},${memberMemories.createdAt})
        IS NOT DISTINCT FROM (excluded.org_id,excluded.user_id,excluded.object_prefix,excluded.created_at)`,
    returning: [{ path: ["id"], field: memberMemories.id }],
  });
  return sql`memory_source_versions AS MATERIALIZED (${versions}),
    memory_registered_versions AS (${registered}),
    memory_source_roots AS MATERIALIZED (${roots}),
    memory_prepared_roots AS (${prepared})`;
}

/** Only newly accepted legacy lineage is mirrored; terminal acknowledgements add none. */
export function memberMemoryPreparationLineage(source: SQL) {
  return new PgDialect().buildInsertQuery({
    table: memoryVersionLineage,
    select: true,
    values: sql`SELECT l.id,l."storageId",l."versionId",l."parentVersionId",l."runId",l."createdAt"
      FROM (${source}) AS l INNER JOIN memory_prepared_roots AS m ON m.id=l."storageId"`,
    // New lineage IDs must be new in both representations. A conflict rejects
    // the statement rather than acknowledging a partially mirrored publication.
    returning: [{ path: ["id"], field: memoryVersionLineage.id }],
  });
}
