import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const schema = `access_${randomUUID().replaceAll("-", "")}`;
async function migrate(name: string) {
  const sql = await readFile(
    new URL(`../src/migrations/${name}.sql`, import.meta.url),
    "utf8",
  );
  await client.query(sql.replaceAll('"public".', `"${schema}".`));
}
async function rejects(
  query: string,
  expected: { code: string | RegExp; constraint?: string },
) {
  await client.query("SAVEPOINT invalid_write");
  await assert.rejects(client.query(query), expected);
  await client.query("ROLLBACK TO SAVEPOINT invalid_write");
}
try {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query(
    "CREATE TABLE agents (id uuid PRIMARY KEY, org_id text, owner text)",
  );
  await migrate("1085_needy_nemesis");
  await migrate("1104_flawless_alex_power");
  await migrate("1113_reusable_ssh_credentials");
  await client.query(`
    INSERT INTO agents VALUES ('00000000-0000-4000-8000-000000000001','org','user');
    INSERT INTO agent_ssh_access (org_id,user_id,agent_id) VALUES ('org','user','00000000-0000-4000-8000-000000000001');
    INSERT INTO ssh_credentials (id,org_id,user_id,name,username,auth_method,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000002','org','user','Password','deploy','password','ciphertext');
    INSERT INTO ssh_connections (id,org_id,user_id,display_name,host,credential_id,learned_host_key_algorithm,learned_host_key_fingerprint,generation)
      VALUES ('00000000-0000-4000-8000-000000000003','org','user','Direct','ssh.example.com','00000000-0000-4000-8000-000000000002','ssh-ed25519','SHA256:pin',7);
    INSERT INTO ssh_connection_observations VALUES ('00000000-0000-4000-8000-000000000003',7,now(),'authentication_failed');
  `);
  const before = await client.query(
    "SELECT row_to_json(ssh_connections) AS value FROM ssh_connections",
  );
  await migrate("1128_cloudflare_access_authority");
  assert.deepEqual(
    (
      await client.query(
        "SELECT to_jsonb(ssh_connections) - 'cloudflare_access_id' AS value FROM ssh_connections",
      )
    ).rows,
    before.rows,
  );
  assert.deepEqual(
    (await client.query("SELECT cloudflare_access_id FROM ssh_connections"))
      .rows,
    [{ cloudflare_access_id: null }],
  );
  assert.deepEqual(
    (await client.query("SELECT encrypted_password FROM ssh_credentials")).rows,
    [{ encrypted_password: "ciphertext" }],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT generation, failure_reason FROM ssh_connection_observations",
      )
    ).rows,
    [{ generation: 7, failure_reason: "authentication_failed" }],
  );
  assert.deepEqual(
    (await client.query("SELECT count(*)::int AS count FROM agent_ssh_access"))
      .rows,
    [{ count: 1 }],
  );
  await client.query(`INSERT INTO cloudflare_access_configs (id,org_id,user_id,name,encrypted_client_id,encrypted_client_secret)
    VALUES ('00000000-0000-4000-8000-000000000004','org','user','Token','encrypted-id','encrypted-secret'),
      ('00000000-0000-4000-8000-000000000005','org','foreign','Foreign','encrypted-id','encrypted-secret')`);
  await rejects(
    "UPDATE ssh_connections SET cloudflare_access_id='00000000-0000-4000-8000-000000000004'",
    { code: "23514" },
  );
  await rejects(
    "UPDATE ssh_connections SET cloudflare_access_id='00000000-0000-4000-8000-000000000005',port=443",
    {
      code: "23503",
      constraint: "ssh_connections_cloudflare_access_owner_fk",
    },
  );
  await client.query(
    "UPDATE ssh_connections SET cloudflare_access_id='00000000-0000-4000-8000-000000000004',port=443",
  );
  for (const host of [
    "1.2.3.4",
    "localhost",
    "::1",
    "*.example.com",
    "https://ssh.example.com",
    "ssh..example.com",
  ]) {
    await rejects(`UPDATE ssh_connections SET host='${host}'`, {
      code: "23514",
    });
  }
  // PostgreSQL 18 reports RESTRICT violations as 23001 instead of 23503.
  await rejects(
    "DELETE FROM cloudflare_access_configs WHERE id='00000000-0000-4000-8000-000000000004'",
    {
      code: /^(23503|23001)$/,
      constraint: "ssh_connections_cloudflare_access_owner_fk",
    },
  );
  await rejects("UPDATE cloudflare_access_configs SET generation=0", {
    code: "23514",
  });
  await rejects("UPDATE cloudflare_access_configs SET revision=0", {
    code: "23514",
  });
  await rejects(
    "UPDATE cloudflare_access_configs SET encrypted_client_secret=''",
    { code: "23514" },
  );
  await client.query(
    "UPDATE ssh_connections SET cloudflare_access_id=NULL,port=22",
  );
  await client.query("DELETE FROM cloudflare_access_configs");
  await client.query("ROLLBACK");
  console.log("Cloudflare Access additive migration and constraints passed");
} finally {
  await client.end();
}
