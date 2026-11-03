import type postgres from "postgres";
import { number, object, string } from "zod";
import { InventoryError, loadSource } from "./source";
import {
  archiveMetadata,
  bindingFor,
  digestSchema,
  headSchema,
  type InventoryRow,
  type PlanRow,
} from "./backfill-plan";

const archiveSchema = object({
  sha256: digestSchema,
  archiveBytes: number().int(),
  versionId: string(),
  fileCount: number().int(),
  totalBytes: number().int(),
});

export class BackfillIndex {
  constructor(private readonly sql: postgres.Sql) {}

  async sourceUnchanged(row: InventoryRow): Promise<void> {
    const current = await loadSource(this.sql, bindingFor(row), row.selection);
    if (JSON.stringify(current) !== JSON.stringify(row.source)) {
      throw new InventoryError("SourceChangedSinceInventory");
    }
  }

  async head(resourceId: string) {
    const rows = await this
      .sql`SELECT sha256, xmin::text FROM registry_resource_heads WHERE resource_id = ${resourceId}`;
    return rows.length ? headSchema.parse(rows[0]) : null;
  }

  async archive(row: InventoryRow): Promise<boolean> {
    const rows = await this.sql`
      SELECT sha256, archive_bytes::float8 AS "archiveBytes", version_id AS "versionId",
        file_count AS "fileCount", total_bytes::float8 AS "totalBytes"
      FROM registry_resource_archives
      WHERE resource_id = ${row.resourceId} AND sha256 = ${row.archive.sha256}
    `;
    if (!rows.length) return false;
    if (
      JSON.stringify(archiveSchema.parse(rows[0])) !==
      JSON.stringify(archiveMetadata(row))
    ) {
      throw new InventoryError("ImmutableArchiveMetadataConflict");
    }
    return true;
  }

  private sourceExists(row: InventoryRow) {
    const s = row.source;
    const binding = bindingFor(row);
    return this.sql`EXISTS (
      SELECT 1 FROM storage_versions anchor
      JOIN storages s ON s.id = anchor.storage_id
      JOIN storage_versions v ON v.storage_id = s.id
      WHERE anchor.id = ${binding.versionId} AND s.name = ${binding.storageName}
        AND s.id = ${s.storageId} AND s.xmin::text = ${s.storageXmin}
        AND v.xmin::text = ${s.versionXmin} AND v.id = ${s.versionId}
        AND s.head_version_id IS NOT DISTINCT FROM ${s.headVersionId}::text
        AND v.id = CASE WHEN ${row.selection} = 'latest' THEN s.head_version_id ELSE anchor.id END
        AND s.s3_prefix = ${s.s3Prefix} AND v.s3_key = ${s.s3Key}
        AND v.archive_size = ${s.archiveBytes} AND v.size = ${s.totalBytes}
        AND v.file_count = ${s.fileCount}
    )`;
  }

  private archiveExists(row: InventoryRow) {
    const metadata = archiveMetadata(row);
    return this.sql`EXISTS (
      SELECT 1 FROM registry_resource_archives
      WHERE resource_id = ${row.resourceId} AND sha256 = ${metadata.sha256}
        AND archive_bytes = ${metadata.archiveBytes} AND version_id = ${metadata.versionId}
        AND file_count = ${metadata.fileCount} AND total_bytes = ${metadata.totalBytes}
    )`;
  }

  async verify(row: InventoryRow): Promise<void> {
    if (!(await this.archive(row)))
      throw new InventoryError("ArchiveIndexMissing");
    if (
      row.selection === "latest" &&
      (await this.head(row.resourceId))?.sha256 !== row.archive.sha256
    ) {
      throw new InventoryError("TargetHeadConflict");
    }
    await this.sourceUnchanged(row);
  }

  async publish(row: PlanRow): Promise<void> {
    const metadata = archiveMetadata(row);
    // Unique identity and source predicates make each statement independently
    // safe. No transaction, advisory lock, row lock or coordination field.
    try {
      await this.sql`
        INSERT INTO registry_resource_archives
          (resource_id, sha256, archive_bytes, version_id, file_count, total_bytes)
        SELECT ${row.resourceId}, ${metadata.sha256}, ${metadata.archiveBytes},
          ${metadata.versionId}, ${metadata.fileCount}, ${metadata.totalBytes}
        WHERE ${this.sourceExists(row)}
        ON CONFLICT (resource_id, sha256) DO NOTHING
      `;
    } catch {
      // A connection loss can conceal a committed INSERT. Read once, without
      // retrying the mutation; conflicting metadata is never repaired in place.
      if (!(await this.archive(row)))
        throw new InventoryError("ArchivePublicationUnresolved");
    }
    if (!(await this.archive(row)))
      throw new InventoryError("SourceChangedBeforeArchivePublication");
    await this.sourceUnchanged(row);
    if (row.selection === "latest") {
      const current = await this.head(row.resourceId);
      if (current?.sha256 !== metadata.sha256) {
        const expectedSha = row.expectedHead?.sha256 ?? null;
        const expectedXmin = row.expectedHead?.xmin ?? null;
        try {
          if (row.expectedHead === null) {
            await this.sql`
              INSERT INTO registry_resource_heads (resource_id, sha256)
              SELECT ${row.resourceId}, ${metadata.sha256}
              WHERE ${this.sourceExists(row)} AND ${this.archiveExists(row)}
              ON CONFLICT (resource_id) DO NOTHING
            `;
          } else {
            await this.sql`
              UPDATE registry_resource_heads SET sha256 = ${metadata.sha256}, updated_at = now()
              WHERE resource_id = ${row.resourceId} AND sha256 = ${expectedSha}
                AND xmin::text = ${expectedXmin} AND ${this.sourceExists(row)} AND ${this.archiveExists(row)}
            `;
          }
        } catch {
          if ((await this.head(row.resourceId))?.sha256 !== metadata.sha256) {
            throw new InventoryError("HeadPublicationUnresolved");
          }
        }
      }
      if ((await this.head(row.resourceId))?.sha256 !== metadata.sha256) {
        throw new InventoryError("TargetHeadConflict");
      }
    }
    await this.sourceUnchanged(row);
  }
}
