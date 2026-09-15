import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const schema = `ssh_credentials_${randomUUID().replaceAll("-", "")}`;
async function migrate(name: string) {
  const sql = await readFile(
    new URL(`../src/migrations/${name}.sql`, import.meta.url),
    "utf8",
  );
  await client.query(sql.replaceAll('"public".', `"${schema}".`));
}
async function rejects(query: string, code: string) {
  await client.query("SAVEPOINT invalid_write");
  await assert.rejects(client.query(query), { code });
  await client.query("ROLLBACK TO SAVEPOINT invalid_write");
}
try {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query(
    "CREATE TABLE agents (id uuid PRIMARY KEY, org_id text, owner text, description text)",
  );
  await migrate("1085_needy_nemesis");
  await migrate("1104_flawless_alex_power");
  await client.query(`
    INSERT INTO agents VALUES ('00000000-0000-4000-8000-000000000001', 'org', 'user', 'retained');
    INSERT INTO agent_ssh_access (org_id,user_id,agent_id) VALUES ('org','user','00000000-0000-4000-8000-000000000001');
    INSERT INTO ssh_connections (id,org_id,user_id,display_name,host,username,learned_host_key_algorithm,learned_host_key_fingerprint)
      VALUES ('00000000-0000-4000-8000-000000000002','org','user','Old host','ssh.example.com','deploy','ssh-ed25519','SHA256:old');
    INSERT INTO ssh_connection_credentials (connection_id,encrypted_private_key) VALUES ('00000000-0000-4000-8000-000000000002','old-ciphertext');
    INSERT INTO ssh_connection_observations VALUES ('00000000-0000-4000-8000-000000000002',1,now(),'authentication_failed');
  `);
  await migrate("1113_reusable_ssh_credentials");
  for (const table of [
    "ssh_connections",
    "ssh_credentials",
    "ssh_connection_observations",
  ]) {
    assert.deepEqual(
      (await client.query(`SELECT count(*)::int AS count FROM "${table}"`))
        .rows,
      [{ count: 0 }],
    );
  }
  assert.deepEqual(
    (await client.query("SELECT description FROM agents")).rows,
    [{ description: "retained" }],
  );
  assert.deepEqual(
    (await client.query("SELECT count(*)::int AS count FROM agent_ssh_access"))
      .rows,
    [{ count: 1 }],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT to_regclass('ssh_connection_credentials') AS old_table",
      )
    ).rows,
    [{ old_table: null }],
  );

  await client.query(`
    INSERT INTO ssh_credentials (id,org_id,user_id,name,username,auth_method,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000003','org','user','Shared','deploy','password','encrypted-password');
    INSERT INTO ssh_connections (org_id,user_id,display_name,host,credential_id)
      VALUES ('org','user','New host','new.example.com','00000000-0000-4000-8000-000000000003');
  `);
  await rejects("DELETE FROM ssh_credentials", "23503");
  await rejects("UPDATE ssh_connections SET user_id='foreign'", "23503");
  await rejects("UPDATE ssh_connections SET org_id='foreign'", "23503");
  await rejects("UPDATE ssh_connections SET credential_id=NULL", "23502");
  await rejects(
    "UPDATE ssh_credentials SET encrypted_private_key='key' WHERE auth_method='password'",
    "23514",
  );
  await rejects("UPDATE ssh_credentials SET encrypted_password=NULL", "23514");
  await rejects("UPDATE ssh_credentials SET encrypted_password=''", "23514");
  await rejects("UPDATE ssh_credentials SET revision=0", "23514");
  await client.query(
    "UPDATE ssh_credentials SET auth_method='private_key',encrypted_private_key='key',encrypted_password=NULL",
  );
  await rejects("UPDATE ssh_credentials SET encrypted_passphrase=''", "23514");
  await rejects(
    "UPDATE ssh_credentials SET encrypted_password='password'",
    "23514",
  );
  await client.query("DELETE FROM ssh_connections");
  assert.deepEqual(
    (await client.query("SELECT count(*)::int AS count FROM ssh_credentials"))
      .rows,
    [{ count: 1 }],
  );
  await client.query("DELETE FROM ssh_credentials");
  console.log(
    "Reusable SSH credential reset scope and storage invariants passed",
  );
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
