import assert from "node:assert/strict";
import postgres from "postgres";
import { applyPendingMigrations } from "./migration-runner";

export async function validateLegacyAgentApiProfileRetirement(
  databaseUrl: string,
  migrationMillis: number,
) {
  const sql = postgres(databaseUrl, { max: 1 });
  const retire = () => {
    return applyPendingMigrations(sql, { beforeMillis: migrationMillis + 1 });
  };
  try {
    await applyPendingMigrations(sql, { beforeMillis: migrationMillis });
    await sql`CREATE VIEW legacy_agent_api_retirement_dependency_fixture AS
      SELECT id FROM public.legacy_agent_api_profiles`;
    await assert.rejects(retire, { code: "2BP01" });
    const [rolledBack] = await sql`SELECT
      to_regproc('public.update_legacy_agent_api_metadata') IS NOT NULL AS metadata_function,
      to_regclass('public.legacy_agent_api_profiles') IS NOT NULL AS profiles,
      EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = ${migrationMillis}) AS journaled`;
    assert.deepEqual(rolledBack, {
      metadata_function: true,
      profiles: true,
      journaled: false,
    });
    await sql`DROP VIEW legacy_agent_api_retirement_dependency_fixture`;
    await retire();
    const [retired] = await sql`SELECT
      to_regproc('public.update_legacy_agent_api_metadata') IS NULL AND
      to_regclass('public.legacy_agent_api_profiles') IS NULL AS retired`;
    assert.deepEqual(retired, { retired: true });
  } finally {
    await sql.end();
  }
}
