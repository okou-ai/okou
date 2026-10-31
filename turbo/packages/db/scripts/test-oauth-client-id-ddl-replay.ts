import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import postgres from "postgres";
import { array, boolean, number, object, string } from "zod";
import { applyPendingMigrations } from "./migration-runner";

const execFileAsync = promisify(execFile);
const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const tables = [
  "custom_connector_account_oauth_bindings",
  "org_custom_connector_dcr_registrations",
];

/** Exercise atomic DDL and independently committed journal recovery via the CLI. */
export async function validateOAuthClientIdDdlReplay(databaseUrl: string) {
  const journal = object({
    entries: array(
      object({
        idx: number(),
        version: string(),
        when: number(),
        tag: string(),
        breakpoints: boolean(),
      }),
    ),
  }).parse(
    JSON.parse(
      await readFile(
        path.join(packageDirectory, "src/migrations/meta/_journal.json"),
        "utf8",
      ),
    ),
  );
  const migration = journal.entries.find((entry) => {
    return entry.tag === "1496_slippery_sheva_callister";
  });
  assert(migration);
  const migrationWhen = migration.when;
  const originalSql = await readFile(
    path.join(packageDirectory, `src/migrations/${migration.tag}.sql`),
    "utf8",
  );
  const directory = await mkdtemp(path.join(tmpdir(), "oauth-client-id-ddl-"));
  const database = `oauth_ddl_${randomUUID().replaceAll("-", "")}`;
  const role = `oauth_ddl_${randomUUID().replaceAll("-", "")}`;
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = `/${database}`;
  const writerUrl = new URL(testUrl);
  writerUrl.username = role;
  writerUrl.password = randomUUID();
  const admin = new Client({ connectionString: databaseUrl });
  const client = new Client({ connectionString: testUrl.href });
  const sql = postgres(testUrl.href, { max: 1 });
  let databaseCreated = false;
  let roleCreated = false;

  async function migrate(url = writerUrl.href) {
    await execFileAsync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL("./migrate.ts", import.meta.url)),
      ],
      {
        cwd: directory,
        env: { ...process.env, DATABASE_URL: url },
        timeout: 30_000,
      },
    );
  }

  async function columns() {
    return (
      await client.query(
        `SELECT table_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'client_id'
           AND table_name = ANY($1) ORDER BY table_name`,
        [tables],
      )
    ).rows;
  }

  async function rows() {
    const result = [];
    for (const table of tables) {
      result.push((await client.query(`SELECT * FROM "${table}"`)).rows);
    }
    return result;
  }

  async function migrationRows() {
    return (
      await client.query(
        "SELECT hash, created_at::text FROM drizzle.__drizzle_migrations WHERE created_at = $1",
        [migrationWhen],
      )
    ).rows;
  }

  async function writeClientId(clientId: string) {
    for (const table of tables) {
      const updated = await sql`
        UPDATE ${sql(table)} SET client_id = ${clientId} RETURNING client_id
      `;
      assert.deepEqual(Array.from(updated), [{ client_id: clientId }]);
      const selected = await sql`SELECT client_id FROM ${sql(table)}`;
      assert.deepEqual(Array.from(selected), [{ client_id: clientId }]);
    }
  }

  try {
    const migrations = path.join(directory, "src/migrations");
    await mkdir(path.join(migrations, "meta"), { recursive: true });
    await writeFile(path.join(migrations, `${migration.tag}.sql`), originalSql);
    await writeFile(
      path.join(migrations, "meta/_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [migration],
      }),
    );
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    databaseCreated = true;
    await applyPendingMigrations(sql, { beforeMillis: migrationWhen });
    await client.connect();
    const connectorId = randomUUID();
    const accountId = randomUUID();
    const registrationId = randomUUID();
    await client.query(
      `INSERT INTO org_custom_connectors
         (id, org_id, slug, display_name, created_by, auth_mode, mcp_endpoint, mcp_transport)
       VALUES ($1, 'oauth-ddl-org', '_oauth_ddl', 'OAuth DDL', 'oauth-ddl-user',
         'automatic', 'https://mcp.example.test', 'streamable-http')`,
      [connectorId],
    );
    await client.query(
      `INSERT INTO connectors (id, custom_connector_id, auth_method, storage_version, user_id, org_id)
       VALUES ($1, $2, 'oauth', 1, 'oauth-ddl-user', 'oauth-ddl-org')`,
      [accountId, connectorId],
    );
    await client.query(
      `INSERT INTO org_custom_connector_dcr_registrations
         (id, org_id, custom_connector_id, issuer, client_id, token_endpoint_auth_method, redirect_uri, issued_at)
       VALUES ($1, 'oauth-ddl-org', $2, 'https://issuer.example.test', 'existing-client',
         'none', 'https://app.example.test/callback', now())`,
      [registrationId, connectorId],
    );
    await client.query(
      `INSERT INTO custom_connector_account_oauth_bindings
         (connector_account_id, custom_connector_id, issuer, resource, token_endpoint,
          client_id, token_endpoint_auth_method, registration_method, dcr_registration_id)
       VALUES ($1, $2, 'https://issuer.example.test', 'https://mcp.example.test',
         'https://issuer.example.test/token', 'existing-client', 'none', 'dcr', $3)`,
      [accountId, connectorId, registrationId],
    );
    // Keep prepared string queries alive across the type change, as in the API.
    await writeClientId("existing-client");
    const originalRows = await rows();
    const varcharColumns = tables.map((table) => {
      return { table_name: table, data_type: "character varying" };
    });
    const textColumns = tables.map((table) => {
      return { table_name: table, data_type: "text" };
    });
    assert.deepEqual(await columns(), varcharColumns);

    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD '${writerUrl.password}'`,
    );
    roleCreated = true;
    await admin.query(`GRANT CREATE ON DATABASE "${database}" TO "${role}"`);
    await client.query(
      `GRANT USAGE, CREATE ON SCHEMA public, drizzle TO "${role}"`,
    );
    await client.query(
      `GRANT SELECT ON drizzle.__drizzle_migrations TO "${role}"`,
    );
    await client.query(`ALTER TABLE "${tables[0]}" OWNER TO "${role}"`);

    // The first ALTER must roll back when the second table's owner rejects DDL.
    await assert.rejects(
      migrate(),
      /must be owner of table org_custom_connector_dcr_registrations/u,
    );
    assert.deepEqual(await columns(), varcharColumns);
    assert.deepEqual(await rows(), originalRows);
    assert.deepEqual(await migrationRows(), []);

    await client.query(`ALTER TABLE "${tables[1]}" OWNER TO "${role}"`);
    await assert.rejects(
      migrate(),
      /permission denied for table __drizzle_migrations/u,
    );
    // DDL survives journal failure: it did not execute in a surrounding transaction.
    assert.deepEqual(await columns(), textColumns);
    assert.deepEqual(await rows(), originalRows);
    assert.deepEqual(await migrationRows(), []);
    await client.query(
      `GRANT INSERT ON drizzle.__drizzle_migrations TO "${role}"`,
    );
    await client.query(
      `GRANT USAGE ON SEQUENCE drizzle.__drizzle_migrations_id_seq TO "${role}"`,
    );
    await migrate();
    const expectedJournal = [
      {
        hash: createHash("sha256").update(originalSql).digest("hex"),
        created_at: String(migrationWhen),
      },
    ];
    assert.deepEqual(await migrationRows(), expectedJournal);
    assert.deepEqual(await rows(), originalRows);

    // Both prior short-ID and current long-ID SQL retain the string contract.
    for (const clientId of [
      "old-writer-client",
      "opaque-client-".repeat(100),
    ]) {
      await writeClientId(clientId);
    }
    for (const table of tables) {
      await assert.rejects(
        client.query(`UPDATE "${table}" SET client_id = ' '`),
        { code: "23514" },
      );
    }
    await assert.rejects(
      client.query(
        "UPDATE custom_connector_account_oauth_bindings SET dcr_registration_id = $1",
        [randomUUID()],
      ),
      { code: "23503" },
    );
    // A journaled migration skips DDL even when the caller no longer owns tables.
    for (const table of tables) {
      await client.query(`ALTER TABLE "${table}" OWNER TO CURRENT_USER`);
    }
    const committedRows = await rows();
    await migrate();
    assert.deepEqual(await rows(), committedRows);
    assert.deepEqual(await migrationRows(), expectedJournal);
    console.log(
      "   ✅ OAuth client-ID DDL: atomic failure, journal recovery, string I/O and applied replay",
    );
  } finally {
    try {
      await sql.end();
    } finally {
      try {
        await client.end();
      } finally {
        try {
          if (databaseCreated) await admin.query(`DROP DATABASE "${database}"`);
          if (roleCreated) await admin.query(`DROP ROLE "${role}"`);
        } finally {
          try {
            await admin.end();
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        }
      }
    }
  }
}
