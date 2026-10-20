import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { applyFixtureMigrations } from "./fixtures/migrate-with-empty-instructions";

const journal = z
  .object({
    entries: z.array(z.object({ tag: z.string(), when: z.number() })),
  })
  .parse(
    JSON.parse(
      await readFile(`${DRIZZLE_MIGRATE_OUT}/meta/_journal.json`, "utf8"),
    ),
  );
const migration = journal.entries.find((entry) => {
  return entry.tag.endsWith("_remote_connection_observation_instances");
});
assert.ok(migration);
const configuredUrl = process.env.DATABASE_URL;
assert.ok(configuredUrl, "DATABASE_URL is required");
const adminUrl = new URL(configuredUrl);
adminUrl.pathname = "/postgres";
const name = `remote_observation_${randomUUID().replaceAll("-", "")}`;
const ownedUrl = new URL(adminUrl);
ownedUrl.pathname = `/${name}`;
const admin = new Client({ connectionString: adminUrl.toString() });
const client = new Client({ connectionString: ownedUrl.toString() });
const migrationSql = postgres(ownedUrl.toString(), {
  max: 1,
  onnotice: () => {},
});
let created = false;
const credential = randomUUID();
const ssh = randomUUID();
const vnc = randomUUID();
const createdAt = "2026-09-01T00:00:00.123456";
const inventory = async () => {
  const tables = [
    "ssh_connections",
    "ssh_credentials",
    "vnc_connections",
  ] as const;
  const rows: unknown[] = [];
  for (const table of tables) {
    rows.push(
      (
        await client.query(
          `SELECT to_jsonb(${table}) AS value FROM ${table} ORDER BY id`,
        )
      ).rows,
    );
  }
  return rows;
};

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  await client.connect();
  await applyFixtureMigrations(migrationSql, { beforeMillis: migration.when });
  await client.query(
    `INSERT INTO ssh_credentials (id,org_id,user_id,name,username,auth_method,encrypted_password)
     VALUES ($1,'org-observation','owner','Login','deploy','password','synthetic-ciphertext')`,
    [credential],
  );
  await client.query(
    `INSERT INTO ssh_connections (id,org_id,user_id,display_name,host,credential_id,transport,generation,created_at)
     VALUES ($1,'org-observation','owner','SSH','ssh.example.test',$2,'direct',7,$3::timestamp)`,
    [ssh, credential, createdAt],
  );
  await client.query(
    `INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,auth_method,security_type,trust_mode,generation,created_at)
     VALUES ($1,'org-observation','owner','VNC','vnc.example.test','none','x509_none','system',11,$2::timestamp)`,
    [vnc, createdAt],
  );
  await client.query(
    `INSERT INTO ssh_connection_observations (connection_id,generation,observed_at,failure_reason)
     VALUES ($1,7,now(),'authentication_failed')`,
    [ssh],
  );
  const retainedInventory = await inventory();
  await applyFixtureMigrations(migrationSql, {
    beforeMillis: migration.when + 1,
  });
  assert.deepEqual(await inventory(), retainedInventory);
  await applyFixtureMigrations(migrationSql);
  assert.deepEqual(
    (
      await client.query(
        "SELECT connection_id FROM ssh_connection_observations",
      )
    ).rows,
    [],
  );

  for (const [table, id, generation] of [
    ["ssh_connection_observations", ssh, 7],
    ["vnc_connection_observations", vnc, 11],
  ] as const) {
    await assert.rejects(
      client.query(
        `INSERT INTO ${table} (connection_id,generation,observed_at) VALUES ($1,$2,now())`,
        [id, generation],
      ),
      { code: "23502", column: "connection_created_at" },
    );
    await client.query(
      `INSERT INTO ${table} (connection_id,generation,connection_created_at,observed_at,failure_reason)
       VALUES ($1,$2,$3::timestamp,now(),NULL)`,
      [id, generation, createdAt],
    );
    assert.deepEqual(
      (
        await client.query(
          `SELECT to_char(connection_created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at FROM ${table}`,
        )
      ).rows,
      [{ created_at: createdAt }],
    );
    await assert.rejects(
      client.query(`UPDATE ${table} SET generation=0 WHERE connection_id=$1`, [
        id,
      ]),
      { code: "23514" },
    );
    await assert.rejects(
      client.query(
        `UPDATE ${table} SET failure_reason='secret-protocol-error' WHERE connection_id=$1`,
        [id],
      ),
      { code: "23514" },
    );
  }
  await client.query("DELETE FROM ssh_connections WHERE id=$1", [ssh]);
  await client.query("DELETE FROM vnc_connections WHERE id=$1", [vnc]);
  assert.deepEqual(
    (
      await client.query(
        "SELECT connection_id FROM ssh_connection_observations UNION ALL SELECT connection_id FROM vnc_connection_observations",
      )
    ).rows,
    [],
  );
  assert.deepEqual(
    (await client.query("SELECT id FROM ssh_credentials")).rows,
    [{ id: credential }],
  );
  console.log(
    "Remote observation migration preserves inventory, clears old diagnostics, requires microsecond identity and cascades only diagnostic rows",
  );
} finally {
  await client.end();
  await migrationSql.end();
  if (created) {
    await admin.query(`DROP DATABASE "${name}"`);
  }
  await admin.end();
}
