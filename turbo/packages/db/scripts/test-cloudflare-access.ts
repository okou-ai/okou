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
  await migrate("1203_cloudflare_access_org_scope");
  assert.deepEqual(
    (
      await client.query(
        "SELECT scope, user_id FROM cloudflare_access_configs ORDER BY id",
      )
    ).rows,
    [
      { scope: "personal", user_id: "user" },
      { scope: "personal", user_id: "foreign" },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT cloudflare_access_id, needs_rebind FROM ssh_connections",
      )
    ).rows,
    [
      {
        cloudflare_access_id: "00000000-0000-4000-8000-000000000004",
        needs_rebind: false,
      },
    ],
  );
  await client.query(`
    INSERT INTO cloudflare_access_configs (id,org_id,user_id,scope,name,encrypted_client_id,encrypted_client_secret)
      VALUES ('00000000-0000-4000-8000-000000000006','org',NULL,'organization','Shared','encrypted-id','encrypted-secret'),
        ('00000000-0000-4000-8000-000000000007','other',NULL,'organization','Outside','encrypted-id','encrypted-secret');
  `);
  assert.deepEqual(
    (
      await client.query(
        "SELECT scope, user_id FROM cloudflare_access_configs WHERE id='00000000-0000-4000-8000-000000000004'",
      )
    ).rows,
    [{ scope: "personal", user_id: "user" }],
  );
  await rejects(
    "UPDATE ssh_connections SET cloudflare_access_id='00000000-0000-4000-8000-000000000005',port=443",
    {
      code: "23514",
      constraint: "ssh_connections_cloudflare_access_personal_owner_guard",
    },
  );
  await rejects(
    "UPDATE ssh_connections SET cloudflare_access_id='00000000-0000-4000-8000-000000000007',port=443",
    { code: "23503", constraint: "ssh_connections_cloudflare_access_org_fk" },
  );
  await client.query(
    "UPDATE ssh_connections SET cloudflare_access_id='00000000-0000-4000-8000-000000000004',port=443",
  );
  assert.deepEqual(
    (await client.query("SELECT needs_rebind FROM ssh_connections")).rows,
    [{ needs_rebind: false }],
  );
  await client.query(
    "UPDATE ssh_connections SET cloudflare_access_id='00000000-0000-4000-8000-000000000006'",
  );
  await rejects(
    "DELETE FROM cloudflare_access_configs WHERE id='00000000-0000-4000-8000-000000000006'",
    {
      code: /^(23503|23001)$/,
      constraint: "ssh_connections_cloudflare_access_org_fk",
    },
  );
  await rejects("UPDATE ssh_connections SET needs_rebind=true", {
    code: "23514",
    constraint: "chk_ssh_connections_needs_rebind_unbound",
  });
  await client.query(
    "UPDATE ssh_connections SET cloudflare_access_id=NULL,needs_rebind=true",
  );
  await rejects("UPDATE ssh_connections SET port=22", {
    code: "23514",
    constraint: "chk_ssh_connections_cloudflare_access_destination",
  });
  await client.query("UPDATE ssh_connections SET needs_rebind=false,port=22");
  await rejects(
    "UPDATE cloudflare_access_configs SET scope='organization',user_id=NULL WHERE id='00000000-0000-4000-8000-000000000004'",
    { code: "23514", constraint: "cloudflare_access_scope_change_guard" },
  );
  await rejects(
    "INSERT INTO cloudflare_access_configs (id,org_id,user_id,scope,name,encrypted_client_id,encrypted_client_secret) VALUES ('00000000-0000-4000-8000-000000000008','org',NULL,'personal','Invalid','encrypted-id','encrypted-secret')",
    { code: "23514", constraint: "chk_cloudflare_access_configs_scope_owner" },
  );
  // Outgoing API binaries omit the new columns and use INSERT ... RETURNING.
  assert.deepEqual(
    (
      await client.query(`
        INSERT INTO cloudflare_access_configs (id,org_id,user_id,name,encrypted_client_id,encrypted_client_secret)
          VALUES ('00000000-0000-4000-8000-000000000011','org','user','Old Personal','encrypted-id','encrypted-secret')
          RETURNING id,org_id,user_id,name,revision,generation;
      `)
    ).rows,
    [
      {
        id: "00000000-0000-4000-8000-000000000011",
        org_id: "org",
        user_id: "user",
        name: "Old Personal",
        revision: 1,
        generation: 1,
      },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT scope FROM cloudflare_access_configs WHERE id='00000000-0000-4000-8000-000000000011'",
      )
    ).rows,
    [{ scope: "personal" }],
  );
  assert.deepEqual(
    (
      await client.query(`
        UPDATE cloudflare_access_configs SET name='Renamed Personal',revision=revision+1
          WHERE id='00000000-0000-4000-8000-000000000011'
          RETURNING id,name,revision;
      `)
    ).rows,
    [
      {
        id: "00000000-0000-4000-8000-000000000011",
        name: "Renamed Personal",
        revision: 2,
      },
    ],
  );
  const oldDirect = await client.query(`
    INSERT INTO ssh_connections (id,org_id,user_id,display_name,host,credential_id)
      VALUES ('00000000-0000-4000-8000-000000000009','org','user','Old Direct','legacy-direct.example.com','00000000-0000-4000-8000-000000000002')
      RETURNING id,org_id,user_id,cloudflare_access_id,port,generation;
  `);
  const oldAccess = await client.query(`
    INSERT INTO ssh_connections (id,org_id,user_id,display_name,host,port,credential_id,cloudflare_access_id)
      VALUES ('00000000-0000-4000-8000-000000000010','org','user','Old Access','legacy-access.example.com',443,'00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000011')
      RETURNING id,org_id,user_id,cloudflare_access_id,port,generation;
  `);
  assert.deepEqual(oldDirect.rows, [
    {
      id: "00000000-0000-4000-8000-000000000009",
      org_id: "org",
      user_id: "user",
      cloudflare_access_id: null,
      port: 22,
      generation: 1,
    },
  ]);
  assert.deepEqual(oldAccess.rows, [
    {
      id: "00000000-0000-4000-8000-000000000010",
      org_id: "org",
      user_id: "user",
      cloudflare_access_id: "00000000-0000-4000-8000-000000000011",
      port: 443,
      generation: 1,
    },
  ]);
  assert.deepEqual(
    (
      await client.query(
        "SELECT cloudflare_access_id,needs_rebind FROM ssh_connections WHERE id IN ('00000000-0000-4000-8000-000000000009','00000000-0000-4000-8000-000000000010') ORDER BY id",
      )
    ).rows,
    [
      { cloudflare_access_id: null, needs_rebind: false },
      {
        cloudflare_access_id: "00000000-0000-4000-8000-000000000011",
        needs_rebind: false,
      },
    ],
  );
  await client.query(`
    INSERT INTO ssh_credentials (id,org_id,user_id,name,username,auth_method,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000012','org','foreign','Foreign login','deploy','password','ciphertext');
    INSERT INTO ssh_connections (id,org_id,user_id,display_name,host,port,credential_id,cloudflare_access_id,generation)
      VALUES ('00000000-0000-4000-8000-000000000013','org','foreign','Shared host','shared.example.com',443,'00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000006',7);
  `);
  await migrate("1210_cloudflare_access_conversion");
  await rejects(
    "UPDATE cloudflare_access_configs SET scope='personal',user_id='user' WHERE id='00000000-0000-4000-8000-000000000006'",
    { code: "23514", constraint: "cloudflare_access_scope_change_guard" },
  );
  await client.query(
    "UPDATE ssh_connections SET cloudflare_access_id=NULL,needs_rebind=true,generation=generation+1 WHERE id='00000000-0000-4000-8000-000000000013'",
  );
  await client.query(
    "UPDATE cloudflare_access_configs SET scope='personal',user_id='user' WHERE id='00000000-0000-4000-8000-000000000006'",
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT scope,user_id,encrypted_client_id,encrypted_client_secret FROM cloudflare_access_configs WHERE id='00000000-0000-4000-8000-000000000006'",
      )
    ).rows,
    [
      {
        scope: "personal",
        user_id: "user",
        encrypted_client_id: "encrypted-id",
        encrypted_client_secret: "encrypted-secret",
      },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT cloudflare_access_id,needs_rebind,generation,credential_id FROM ssh_connections WHERE id='00000000-0000-4000-8000-000000000013'",
      )
    ).rows,
    [
      {
        cloudflare_access_id: null,
        needs_rebind: true,
        generation: 8,
        credential_id: "00000000-0000-4000-8000-000000000012",
      },
    ],
  );
  await rejects(
    "UPDATE cloudflare_access_configs SET scope='organization',user_id=NULL WHERE id='00000000-0000-4000-8000-000000000006'",
    { code: "23514", constraint: "cloudflare_access_scope_change_guard" },
  );
  await rejects(
    "UPDATE cloudflare_access_configs SET user_id='foreign' WHERE id='00000000-0000-4000-8000-000000000006'",
    { code: "23514", constraint: "cloudflare_access_scope_change_guard" },
  );
  await client.query(
    "UPDATE ssh_connections SET learned_host_key_algorithm='ssh-ed25519',learned_host_key_fingerprint='SHA256:pin' WHERE id='00000000-0000-4000-8000-000000000010'",
  );
  await migrate("1215_cloudflare_access_personal_promotion");
  await rejects(
    "UPDATE cloudflare_access_configs SET user_id='foreign' WHERE id='00000000-0000-4000-8000-000000000004'",
    { code: "23514", constraint: "cloudflare_access_scope_change_guard" },
  );
  await rejects(
    "UPDATE cloudflare_access_configs SET scope='organization',user_id=NULL,org_id='other' WHERE id='00000000-0000-4000-8000-000000000004'",
    { code: "23514", constraint: "cloudflare_access_scope_change_guard" },
  );
  await client.query(
    "UPDATE cloudflare_access_configs SET scope='organization',user_id=NULL WHERE id='00000000-0000-4000-8000-000000000011'",
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT scope,user_id,encrypted_client_id,encrypted_client_secret FROM cloudflare_access_configs WHERE id='00000000-0000-4000-8000-000000000011'",
      )
    ).rows,
    [
      {
        scope: "organization",
        user_id: null,
        encrypted_client_id: "encrypted-id",
        encrypted_client_secret: "encrypted-secret",
      },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT cloudflare_access_id,needs_rebind,credential_id,learned_host_key_algorithm,learned_host_key_fingerprint FROM ssh_connections WHERE id='00000000-0000-4000-8000-000000000010'",
      )
    ).rows,
    [
      {
        cloudflare_access_id: "00000000-0000-4000-8000-000000000011",
        needs_rebind: false,
        credential_id: "00000000-0000-4000-8000-000000000002",
        learned_host_key_algorithm: "ssh-ed25519",
        learned_host_key_fingerprint: "SHA256:pin",
      },
    ],
  );
  await rejects(
    "UPDATE cloudflare_access_configs SET scope='personal',user_id='foreign' WHERE id='00000000-0000-4000-8000-000000000011'",
    { code: "23514", constraint: "cloudflare_access_scope_change_guard" },
  );
  await client.query("ROLLBACK");
  console.log("Cloudflare Access migrations and scoped constraints passed");
} finally {
  await client.end();
}
