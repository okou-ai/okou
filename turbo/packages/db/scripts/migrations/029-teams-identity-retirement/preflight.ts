import { Client } from "pg";
import { boolean, date, literal, object, string } from "zod";

async function main(): Promise<number> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required for the read-only Teams preflight",
    );
  }
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '5s'");
    const result = await client.query(`
      WITH legacy_column AS (
        SELECT attrelid, attnum FROM pg_attribute
        WHERE attrelid = 'public.teams_org_connections'::regclass
          AND attname = 'legacy_installation_tenant_id' AND NOT attisdropped
      ), dependencies AS (
        SELECT
          COALESCE(d.classid = 'pg_attrdef'::regclass
            AND a.adrelid = l.attrelid AND a.adnum = l.attnum
            AND d.deptype = 'i', false) AS own_expression,
          COALESCE(d.classid = 'pg_constraint'::regclass
            AND c.conrelid = l.attrelid AND c.conkey = ARRAY[l.attnum]
            AND c.contype = 'f' AND c.confdeltype = 'a' AND c.confupdtype = 'a'
            AND c.confrelid = 'public.teams_org_installations'::regclass
            AND c.conname =
              'teams_org_connections_teams_tenant_id_teams_org_installations_teams_tenant_id_fk'::name,
            false) AS expected_foreign_key
        FROM legacy_column l
        JOIN pg_depend d ON d.refclassid = 'pg_class'::regclass
          AND d.refobjid = l.attrelid AND d.refobjsubid = l.attnum
        LEFT JOIN pg_constraint c
          ON d.classid = 'pg_constraint'::regclass AND c.oid = d.objid
        LEFT JOIN pg_attrdef a
          ON d.classid = 'pg_attrdef'::regclass AND a.oid = d.objid
      ), dependency_census AS (
        SELECT count(*) FILTER (WHERE expected_foreign_key)::text AS legacy_fks,
          count(*) FILTER (WHERE NOT own_expression AND NOT expected_foreign_key)::text
            AS unexpected_dependencies
        FROM dependencies
      )
      SELECT count(*)::text AS connections,
        count(*) FILTER (WHERE org_id IS NULL)::text AS unowned,
        count(*) FILTER (WHERE teams_aad_object_id IS NULL)::text AS unverified,
        statement_timestamp() AS query_time,
        current_setting('transaction_read_only') AS read_only,
        EXISTS (SELECT 1 FROM legacy_column) AS legacy_column_present,
        (SELECT legacy_fks FROM dependency_census) AS legacy_fks,
        (SELECT unexpected_dependencies FROM dependency_census) AS unexpected_dependencies
      FROM teams_org_connections
    `);
    const count = string().regex(/^\d+$/u);
    const rows = object({
      connections: count,
      unowned: count,
      unverified: count,
      query_time: date(),
      read_only: literal("on"),
      legacy_column_present: boolean(),
      legacy_fks: count,
      unexpected_dependencies: count,
    }).parse(result.rows[0]);
    const dependencyReady =
      rows.unexpected_dependencies === "0" &&
      (!rows.legacy_column_present || rows.legacy_fks === "1");
    console.log(
      JSON.stringify(
        {
          queriedAt: rows.query_time.toISOString(),
          transactionReadOnly: rows.read_only,
          connectionRows: rows.connections,
          unownedConnectionRows: rows.unowned,
          missingAadIdentityRows: rows.unverified,
          ownerConstraintReady: rows.unowned === "0",
          legacyColumnPresent: rows.legacy_column_present,
          legacyForeignKeyDependencies: rows.legacy_fks,
          unexpectedLegacyColumnDependencies: rows.unexpected_dependencies,
          legacyDependencyReady: dependencyReady,
        },
        null,
        2,
      ),
    );
    return rows.unowned === "0" && dependencyReady ? 0 : 1;
  } finally {
    await client.end();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  const parsed = object({
    code: string()
      .regex(/^[A-Z0-9]{5}$/u)
      .optional(),
  }).safeParse(error);
  console.error(
    JSON.stringify({
      error: "Teams ownership preflight failed",
      ...(parsed.success && parsed.data.code
        ? { sqlstate: parsed.data.code }
        : {}),
    }),
  );
  process.exitCode = 1;
}
