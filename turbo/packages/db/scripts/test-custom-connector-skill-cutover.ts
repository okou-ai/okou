import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { applyPendingMigrations } from "./migration-runner";

export async function validateCustomConnectorSkillCutover(
  databaseUrl: string,
  migrationMillis: number,
  retirementMillis: number,
): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  const id = randomUUID();
  const source = "a".repeat(64);
  const bundle = { sha256: "b".repeat(64), archiveBytes: 123 };
  const migrate = () => {
    return applyPendingMigrations(sql, { beforeMillis: migrationMillis + 1 });
  };
  try {
    await applyPendingMigrations(sql, { beforeMillis: migrationMillis });
    await sql`INSERT INTO org_custom_connectors
      (id, org_id, slug, display_name, auth_mode, prefix_templates, fields, header_injections,
       query_injections, created_by, skill_markdown, skill_storage_version_id,
       skill_content_bundle, skill_content_bundle_source_version_id)
      VALUES (${id}, 'cutover-org', '_cutover', 'Cutover', 'none', '["https://example.test/"]',
       '[]', '[]', '[]', 'cutover-user', 'Skill instructions', ${"c".repeat(64)}, ${sql.json(bundle)}, ${source})`;

    // The old view hides this stale publication. A failed migration must keep it hidden.
    await assert.rejects(migrate, {
      code: "23514",
      constraint_name: "chk_custom_connector_skill_cutover_sources",
    });
    assert.equal(
      (
        await sql`SELECT id FROM public.org_custom_connector_skill_publications WHERE id = ${id}`
      ).length,
      0,
    );
    assert.equal(
      (
        await sql`SELECT id FROM drizzle.__drizzle_migrations WHERE created_at = ${migrationMillis}`
      ).length,
      0,
    );

    await sql`UPDATE org_custom_connectors SET skill_storage_version_id = ${source} WHERE id = ${id}`;
    const readPublication = () => {
      return sql`SELECT 'public.org_custom_connector_skill_publications'::regclass::oid AS view_id,
        skill_content_bundle, skill_content_bundle_source_version_id
      FROM public.org_custom_connector_skill_publications WHERE id = ${id}`;
    };
    const before = await readPublication();
    assert.equal(before.length, 1);
    await migrate();
    assert.deepEqual(Array.from(await readPublication()), Array.from(before));

    // The deployed API can clear and republish a historical Skill after the migration.
    await sql`UPDATE org_custom_connectors SET skill_markdown = NULL,
      skill_storage_version_id = NULL, skill_content_bundle = NULL,
      skill_content_bundle_source_version_id = NULL WHERE id = ${id}`;
    assert.equal((await readPublication()).length, 0);
    await sql`UPDATE org_custom_connectors SET skill_markdown = 'Skill instructions',
      skill_storage_version_id = ${source}, skill_content_bundle = ${sql.json(bundle)},
      skill_content_bundle_source_version_id = ${source} WHERE id = ${id}`;
    assert.deepEqual(Array.from(await readPublication()), Array.from(before));

    // Native edits after 1608 can leave the obsolete mirror behind.
    await sql`UPDATE org_custom_connectors SET skill_storage_version_id = ${"c".repeat(64)} WHERE id = ${id}`;
    await applyPendingMigrations(sql, { beforeMillis: retirementMillis + 1 });
    assert.deepEqual(Array.from(await readPublication()), Array.from(before));
  } finally {
    await sql.end();
  }
}

export async function validateCustomConnectorSkillPublicationViewRetirement(
  databaseUrl: string,
  migrationMillis: number,
): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });
  const id = randomUUID();
  const source = "a".repeat(64);
  const bundle = { sha256: "b".repeat(64), archiveBytes: 123 };
  const readConnector = () => {
    return sql`SELECT * FROM public.org_custom_connectors WHERE id = ${id}`;
  };
  const retire = () => {
    return applyPendingMigrations(sql, { beforeMillis: migrationMillis + 1 });
  };
  try {
    await applyPendingMigrations(sql, { beforeMillis: migrationMillis });
    await sql`INSERT INTO public.org_custom_connectors
      (id, org_id, slug, display_name, auth_mode, prefix_templates, fields, header_injections,
       query_injections, created_by, skill_markdown, skill_content_bundle,
       skill_content_bundle_source_version_id)
      VALUES (${id}, 'publication-org', '_publication', 'Publication', 'none',
       '["https://example.test/"]', '[]', '[]', '[]', 'publication-user',
       'Skill instructions', ${sql.json(bundle)}, ${source})`;
    const before = Array.from(await readConnector());
    assert.equal(before.length, 1);

    await sql`CREATE VIEW publication_retirement_dependency_fixture AS
      SELECT id FROM public.org_custom_connector_skill_publications`;
    await assert.rejects(retire, { code: "2BP01" });
    const [pending] = await sql`SELECT
      to_regclass('public.org_custom_connector_skill_publications') IS NOT NULL AS view_exists,
      EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = ${migrationMillis}) AS journaled`;
    assert.deepEqual(pending, { view_exists: true, journaled: false });

    await sql`DROP VIEW publication_retirement_dependency_fixture`;
    await retire();
    const [retired] = await sql`SELECT
      to_regclass('public.org_custom_connector_skill_publications') IS NULL AS view_absent`;
    assert.deepEqual(retired, { view_absent: true });
    assert.deepEqual(Array.from(await readConnector()), before);
  } finally {
    await sql.end();
  }
}
