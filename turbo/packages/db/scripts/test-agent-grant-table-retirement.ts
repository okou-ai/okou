import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const testSchema = `agent_grant_retirement_${randomUUID().replaceAll("-", "")}`;

async function migration(name: string) {
  return (
    await readFile(
      new URL(`../src/migrations/${name}.sql`, import.meta.url),
      "utf8",
    )
  ).replaceAll('"public".', `"${testSchema}".`);
}

try {
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0368; new non-billing transactions are prohibited.
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${testSchema}"`);
  await client.query(`SET LOCAL search_path TO "${testSchema}"`);
  await client.query(
    "CREATE TABLE agents (id uuid PRIMARY KEY, org_id text, owner text, description text)",
  );
  for (const name of [
    "1085_needy_nemesis",
    "1104_flawless_alex_power",
    "1113_reusable_ssh_credentials",
    "1158_vnc_configuration",
    "1160_vnc_runner_authority",
  ]) {
    await client.query(await migration(name));
  }

  // These rows model grants retained from the earlier API alongside live hosts.
  await client.query(`
    INSERT INTO agents VALUES ('00000000-0000-4000-8000-000000000001','org','owner','retained');
    INSERT INTO agent_ssh_access (org_id,user_id,agent_id)
      VALUES ('org','owner','00000000-0000-4000-8000-000000000001');
    INSERT INTO agent_vnc_access (org_id,user_id,agent_id)
      VALUES ('org','owner','00000000-0000-4000-8000-000000000001');
    INSERT INTO ssh_credentials (id,org_id,user_id,name,username,auth_method,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000002','org','owner','Key','deploy','password','ssh-ciphertext');
    INSERT INTO ssh_connections (id,org_id,user_id,display_name,host,credential_id)
      VALUES ('00000000-0000-4000-8000-000000000003','org','owner','Server','server.example.com','00000000-0000-4000-8000-000000000002');
    INSERT INTO vnc_credentials (id,org_id,user_id,name,auth_method,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000004','org','owner','VNC','vnc_password','vnc-ciphertext');
    INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,credential_id,security_type,trust_mode)
      VALUES ('00000000-0000-4000-8000-000000000005','org','owner','Desktop','desktop.example.com','00000000-0000-4000-8000-000000000004','x509_vnc','system');
  `);

  const retainedTables = [
    "agents",
    "ssh_credentials",
    "ssh_connections",
    "vnc_credentials",
    "vnc_connections",
  ];
  const before = [];
  for (const table of retainedTables) {
    before.push(
      (await client.query(`SELECT * FROM "${table}" ORDER BY id`)).rows,
    );
  }
  for (const table of ["agent_ssh_access", "agent_vnc_access"]) {
    assert.deepEqual(
      (await client.query(`SELECT count(*)::int AS count FROM "${table}"`))
        .rows,
      [{ count: 1 }],
    );
  }

  const dropSql = await migration("1288_drop_retired_agent_grant_tables");
  assert.match(dropSql, /DROP TABLE "agent_ssh_access";/);
  assert.match(dropSql, /DROP TABLE "agent_vnc_access";/);
  assert.doesNotMatch(dropSql, /\bCASCADE\b/i);
  await client.query("SET LOCAL lock_timeout = '1s'");
  await client.query("SET LOCAL statement_timeout = '10s'");
  await client.query(dropSql);

  for (const table of ["agent_ssh_access", "agent_vnc_access"]) {
    assert.deepEqual(
      (
        await client.query("SELECT to_regclass($1) AS retired", [
          `${testSchema}.${table}`,
        ])
      ).rows,
      [{ retired: null }],
    );
  }
  for (const [index, table] of retainedTables.entries()) {
    assert.deepEqual(
      (await client.query(`SELECT * FROM "${table}" ORDER BY id`)).rows,
      before[index],
      `${table} must be unchanged by the grant table drop`,
    );
  }
  console.log(
    "Retired Agent grants dropped; SSH/VNC hosts and credentials retained",
  );
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
