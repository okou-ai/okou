import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/** Native PostgreSQL checks for the prepared reader and independent account owner. */
export async function validateTeamsIdentityRetirement(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  const fixture = `teams-retirement-${randomUUID()}`;
  await client.connect();
  try {
    const columns = await client.query(`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'teams_org_connections'
        AND column_name IN ('org_id', 'legacy_installation_tenant_id')
    `);
    assert.deepEqual(columns.rows, [
      { column_name: "org_id", is_nullable: "NO" },
    ]);
    await client.query(
      "INSERT INTO teams_org_installations (teams_tenant_id) VALUES ($1)",
      [fixture],
    );
    await client.query(
      "INSERT INTO teams_org_connections (teams_tenant_id, user_id, org_id) VALUES ($1, $2, $3)",
      [fixture, fixture, fixture],
    );
    // Frozen projection from the preparation API, independent of current schema exports.
    const preparedColumns =
      "id, teams_user_id, teams_aad_object_id, teams_tenant_id, org_id, user_id, teams_user_display_name, teams_user_principal_name, dm_welcome_sent, created_at, updated_at";
    const selected = await client.query(
      `SELECT ${preparedColumns} FROM teams_org_connections WHERE user_id = $1`,
      [fixture],
    );
    assert.equal(selected.rows[0].org_id, fixture);
    const updated = await client.query(
      `UPDATE teams_org_connections SET teams_user_display_name = 'Prepared API' WHERE user_id = $1 RETURNING ${preparedColumns}`,
      [fixture],
    );
    assert.equal(updated.rowCount, 1);
    await client.query(
      "DELETE FROM teams_org_installations WHERE teams_tenant_id = $1",
      [fixture],
    );
    const retained = await client.query(
      "SELECT org_id FROM teams_org_connections WHERE user_id = $1",
      [fixture],
    );
    assert.deepEqual(retained.rows, [{ org_id: fixture }]);
    await assert.rejects(
      client.query(
        "INSERT INTO teams_org_connections (teams_tenant_id, user_id, org_id) VALUES ($1, $2, NULL)",
        [fixture, `${fixture}-unowned`],
      ),
      { code: "23502" },
    );
  } finally {
    await client.query(
      "DELETE FROM teams_org_connections WHERE user_id IN ($1, $2)",
      [fixture, `${fixture}-unowned`],
    );
    await client.query(
      "DELETE FROM teams_org_installations WHERE teams_tenant_id = $1",
      [fixture],
    );
    await client.end();
  }
}
