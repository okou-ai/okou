import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const schema = `vnc_runner_authority_${randomUUID().replaceAll("-", "")}`;

async function rejects(
  query: string,
  expected: { code: string; constraint?: string },
) {
  await client.query("SAVEPOINT invalid_write");
  await assert.rejects(client.query(query), expected);
  await client.query("ROLLBACK TO SAVEPOINT invalid_write");
  await client.query("RELEASE SAVEPOINT invalid_write");
}

async function migrate(name: string) {
  const migration = await readFile(
    new URL(`../src/migrations/${name}.sql`, import.meta.url),
    "utf8",
  );
  await client.query(migration.replaceAll('"public".', `"${schema}".`));
}

const legacyConnectionInsert = `
  INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,credential_id,security_type,trust_mode)
    VALUES ('00000000-0000-4000-8000-000000000002','org','owner','Desktop','desktop.example.com','00000000-0000-4000-8000-000000000001','x509_vnc','system')
`;

try {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query("CREATE TABLE agents (id uuid PRIMARY KEY)");
  await migrate("1158_vnc_configuration");
  await client.query(`
    INSERT INTO agents VALUES ('00000000-0000-4000-8000-000000000003');
    INSERT INTO vnc_credentials (id,org_id,user_id,name,auth_method,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000001','org','owner','Password','vnc_password','retained-ciphertext');
  `);
  await client.query(legacyConnectionInsert);
  await migrate("1160_vnc_runner_authority");

  assert.deepEqual(
    (await client.query("SELECT encrypted_password FROM vnc_credentials")).rows,
    [{ encrypted_password: "retained-ciphertext" }],
  );
  assert.deepEqual(
    (await client.query("SELECT host, generation FROM vnc_connections")).rows,
    [{ host: "desktop.example.com", generation: 1 }],
  );

  await client.query(`
    INSERT INTO agent_vnc_access (org_id,user_id,agent_id)
      VALUES ('org','owner','00000000-0000-4000-8000-000000000003');
  `);
  await rejects(
    "INSERT INTO agent_vnc_access (org_id,user_id,agent_id) VALUES ('org','owner','00000000-0000-4000-8000-000000000003')",
    { code: "23505", constraint: "agent_vnc_access_pkey" },
  );
  await client.query(
    "INSERT INTO agent_vnc_access (org_id,user_id,agent_id) VALUES ('org','other','00000000-0000-4000-8000-000000000003')",
  );
  await client.query(
    "INSERT INTO agent_vnc_access (org_id,user_id,agent_id) VALUES ('other-org','owner','00000000-0000-4000-8000-000000000003')",
  );
  await rejects(
    "INSERT INTO agent_vnc_access (org_id,user_id,agent_id) VALUES ('org','owner','00000000-0000-4000-8000-000000000099')",
    { code: "23503", constraint: "agent_vnc_access_agent_id_agents_id_fk" },
  );
  await client.query("DELETE FROM agents");
  assert.deepEqual(
    (await client.query("SELECT count(*)::int AS count FROM agent_vnc_access"))
      .rows,
    [{ count: 0 }],
  );

  console.log(
    "VNC Runner authority migration and grant ownership constraints passed",
  );
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
