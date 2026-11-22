import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { applyPendingMigrations } from "./migration-runner";

export async function validateRetiredStorageSchema(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [row] = await sql`SELECT
      to_regclass('public.storages') IS NULL AND
      to_regclass('public.storage_versions') IS NULL AND
      to_regclass('public.storage_version_lineage') IS NULL AS retired,
      to_regclass('public.member_memories') IS NOT NULL AND
      to_regclass('public.memory_versions') IS NOT NULL AND
      to_regclass('public.memory_version_lineage') IS NOT NULL AND
      to_regclass('public.org_custom_connector_skill_publications') IS NOT NULL AND
      to_regclass('public.artifacts') IS NOT NULL AND
      to_regclass('public.claimed_workflow_attachments') IS NOT NULL AND
      to_regclass('public.export_jobs') IS NOT NULL AS retained`;
    assert.deepEqual(row, { retired: true, retained: true });
  } finally {
    await sql.end();
  }
}

export async function validateLegacyStorageRetirement(
  databaseUrl: string,
  migrationMillis: number,
) {
  const sql = postgres(databaseUrl, { max: 1 });
  const root = randomUUID();
  const version = randomUUID();
  const retire = () => {
    return applyPendingMigrations(sql, { beforeMillis: migrationMillis + 1 });
  };
  try {
    await applyPendingMigrations(sql, { beforeMillis: migrationMillis });
    await sql`INSERT INTO storages (id, org_id, user_id, name, s3_prefix)
      VALUES (${root}, 'retirement', 'user', 'fixture', 'fixture')`;
    await sql`INSERT INTO storage_versions (id, storage_id, s3_key, archive_size, created_by)
      VALUES (${version}, ${root}, 'fixture/archive', 1, 'user')`;
    await sql`UPDATE storages SET head_version_id = ${version} WHERE id = ${root}`;
    await sql`INSERT INTO storage_version_lineage (storage_id, version_id, parent_version_id, run_id)
      VALUES (${root}, ${version}, ${version}, ${randomUUID()})`;
    await sql`CREATE VIEW storage_retirement_dependency_fixture AS SELECT id FROM public.storages`;
    await assert.rejects(retire, { code: "2BP01" });
    const [rolledBack] = await sql`SELECT
      EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.storages'::regclass
        AND conname = 'storages_head_version_id_storage_versions_id_fk') AS head_fk,
      EXISTS (SELECT 1 FROM storages s JOIN storage_versions v ON s.head_version_id = v.id
        JOIN storage_version_lineage l ON l.storage_id = s.id AND l.version_id = v.id
        WHERE s.id = ${root}) AS retained,
      EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = ${migrationMillis}) AS journaled`;
    assert.deepEqual(rolledBack, {
      head_fk: true,
      retained: true,
      journaled: false,
    });
    await sql`DROP VIEW storage_retirement_dependency_fixture`;
    await retire();
    await validateRetiredStorageSchema(databaseUrl);
  } finally {
    await sql.end();
  }
}
