import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const schema = `tailscale_${randomUUID().replaceAll("-", "")}`;
async function migrate(name: string) {
  const sql = await readFile(
    new URL(`../src/migrations/${name}.sql`, import.meta.url),
    "utf8",
  );
  await client.query(sql.replaceAll('"public".', `"${schema}".`));
}
async function rejects(query: string, constraint: string, code = "23514") {
  await client.query("SAVEPOINT invalid_write");
  await assert.rejects(client.query(query), { code, constraint });
  await client.query("ROLLBACK TO SAVEPOINT invalid_write");
}
async function assertCarrier(
  id: string,
  transport: string,
  needsRebind: boolean,
) {
  assert.deepEqual(
    (
      await client.query(
        "SELECT transport,needs_rebind,(transport='cloudflare_access' AND cloudflare_access_id IS NULL) OR (transport='tailscale' AND tailscale_id IS NULL) AS derived FROM ssh_connections WHERE id=$1",
        [id],
      )
    ).rows,
    [{ transport, needs_rebind: needsRebind, derived: needsRebind }],
  );
}
try {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query(
    "CREATE TABLE agents (id uuid PRIMARY KEY, org_id text, owner text)",
  );
  for (const migration of [
    "1085_needy_nemesis",
    "1104_flawless_alex_power",
    "1113_reusable_ssh_credentials",
    "1128_cloudflare_access_authority",
    "1203_cloudflare_access_org_scope",
    "1210_cloudflare_access_conversion",
    "1222_cloudflare_access_personal_promotion",
    "1290_retire_cloudflare_access_triggers",
  ])
    await migrate(migration);
  const credentialId = randomUUID();
  const directId = randomUUID();
  const accessId = randomUUID();
  const accessHostId = randomUUID();
  const retainedId = randomUUID();
  await client.query(
    "INSERT INTO ssh_credentials (id,org_id,user_id,name,username,auth_method,encrypted_password) VALUES ($1,'org','user','Login','deploy','password','encrypted-password')",
    [credentialId],
  );
  await client.query(
    "INSERT INTO cloudflare_access_configs (id,org_id,user_id,name,encrypted_client_id,encrypted_client_secret) VALUES ($1,'org','user','Access','encrypted-id','encrypted-secret')",
    [accessId],
  );
  await client.query(
    "INSERT INTO ssh_connections (id,org_id,user_id,display_name,host,port,credential_id,cloudflare_access_id,generation,learned_host_key_algorithm,learned_host_key_fingerprint) VALUES ($1,'org','user','Direct','direct.example.com',22,$2,NULL,7,'ssh-ed25519','SHA256:pin'),($3,'org','user','Access','access.example.com',443,$2,$4,8,NULL,NULL)",
    [directId, credentialId, accessHostId, accessId],
  );
  await client.query(
    "INSERT INTO ssh_connections (id,org_id,user_id,display_name,host,port,credential_id,needs_rebind,generation,learned_host_key_algorithm,learned_host_key_fingerprint) VALUES ($1,'org','user','Retained','retained.example.com',443,$2,true,9,'ssh-ed25519','SHA256:retained')",
    [retainedId, credentialId],
  );
  await client.query(
    "INSERT INTO ssh_connection_observations (connection_id,generation,observed_at,failure_reason) VALUES ($1,7,now(),NULL)",
    [directId],
  );
  const beforeHosts = await client.query(
    "SELECT to_jsonb(ssh_connections) AS value FROM ssh_connections ORDER BY id",
  );
  const beforeObservations = await client.query(
    "SELECT to_jsonb(ssh_connection_observations) AS value FROM ssh_connection_observations",
  );
  await migrate("1356_tailscale_private_ssh");
  assert.deepEqual(
    (
      await client.query(
        "SELECT to_jsonb(ssh_connections) - 'tailscale_id' - 'transport' AS value FROM ssh_connections ORDER BY id",
      )
    ).rows,
    beforeHosts.rows,
  );
  await assertCarrier(directId, "direct", false);
  await assertCarrier(accessHostId, "cloudflare_access", false);
  await assertCarrier(retainedId, "cloudflare_access", true);
  assert.deepEqual(
    (
      await client.query(
        "SELECT is_nullable,column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name='ssh_connections' AND column_name='transport'",
        [schema],
      )
    ).rows,
    [{ is_nullable: "NO", column_default: null }],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT to_jsonb(ssh_connection_observations) AS value FROM ssh_connection_observations",
      )
    ).rows,
    beforeObservations.rows,
  );
  assert.deepEqual(
    (await client.query("SELECT encrypted_password FROM ssh_credentials")).rows,
    [{ encrypted_password: "encrypted-password" }],
  );

  // Outgoing writers must drain: omission fails rather than inventing a carrier.
  await client.query("SAVEPOINT outgoing_writer");
  await assert.rejects(
    client.query(
      "INSERT INTO ssh_connections (org_id,user_id,display_name,host,port,credential_id) VALUES ('org','user','Old Direct','old-direct.example.com',22,$1)",
      [credentialId],
    ),
    { code: "23502", column: "transport" },
  );
  await client.query("ROLLBACK TO SAVEPOINT outgoing_writer");
  await rejects(
    `UPDATE ssh_connections SET cloudflare_access_id='${accessId}' WHERE id='${directId}'`,
    "chk_ssh_connections_transport_binding",
  );
  await client.query(
    "UPDATE ssh_connections SET transport='cloudflare_access',cloudflare_access_id=NULL,needs_rebind=true WHERE id=$1",
    [accessHostId],
  );
  await assertCarrier(accessHostId, "cloudflare_access", true);
  await client.query(
    "UPDATE ssh_connections SET transport='direct',cloudflare_access_id=NULL,needs_rebind=false,port=22 WHERE id=$1",
    [accessHostId],
  );
  await assertCarrier(accessHostId, "direct", false);
  await client.query(
    "UPDATE ssh_connections SET transport='cloudflare_access',cloudflare_access_id=$1,needs_rebind=false,port=443 WHERE id=$2",
    [accessId, accessHostId],
  );
  await assertCarrier(accessHostId, "cloudflare_access", false);

  const configId = randomUUID();
  const foreignId = randomUUID();
  await client.query(
    "INSERT INTO tailscale_configs (id,org_id,user_id,name,encrypted_client_id,encrypted_client_secret,tags) VALUES ($1,'org','user','Network','ciphertext-id','ciphertext-secret',ARRAY['tag:okou']), ($2,'foreign','user','Foreign','ciphertext-id','ciphertext-secret',ARRAY['tag:okou'])",
    [configId, foreignId],
  );
  await rejects(
    `UPDATE tailscale_configs SET generation=0 WHERE id='${configId}'`,
    "chk_tailscale_configs_revision",
  );
  await rejects(
    `UPDATE tailscale_configs SET revision=0 WHERE id='${configId}'`,
    "chk_tailscale_configs_revision",
  );
  for (const assignment of [
    "scope='organization'",
    "user_id=NULL",
    "scope='invalid'",
  ]) {
    await rejects(
      `UPDATE tailscale_configs SET ${assignment} WHERE id='${configId}'`,
      "chk_tailscale_configs_scope_owner",
    );
  }
  for (const assignment of [
    "tags=ARRAY[]::text[]",
    "tags=ARRAY[NULL]::text[]",
    "tags=array_fill('tag:x'::text,ARRAY[17])",
  ]) {
    await rejects(
      `UPDATE tailscale_configs SET ${assignment} WHERE id='${configId}'`,
      "chk_tailscale_configs_tags",
    );
  }
  await rejects(
    `UPDATE tailscale_configs SET encrypted_client_secret='' WHERE id='${configId}'`,
    "chk_tailscale_configs_credentials",
  );
  await rejects(
    `UPDATE tailscale_configs SET name='' WHERE id='${configId}'`,
    "chk_tailscale_configs_name",
  );
  await rejects(
    `UPDATE ssh_connections SET transport='tailscale',tailscale_id='${foreignId}' WHERE id='${directId}'`,
    "ssh_connections_tailscale_org_fk",
    "23503",
  );
  await rejects(
    `UPDATE ssh_connections SET transport='tailscale',tailscale_id='${configId}' WHERE id='${accessHostId}'`,
    "chk_ssh_connections_transport_binding",
  );
  await rejects(
    `UPDATE ssh_connections SET transport='direct' WHERE id='${accessHostId}'`,
    "chk_ssh_connections_transport_binding",
  );
  await rejects(
    `UPDATE ssh_connections SET transport='unsupported' WHERE id='${directId}'`,
    "chk_ssh_connections_transport",
  );
  await client.query("SAVEPOINT null_transport");
  await assert.rejects(
    client.query(
      `UPDATE ssh_connections SET transport=NULL WHERE id='${directId}'`,
    ),
    { code: "23502", column: "transport" },
  );
  await client.query("ROLLBACK TO SAVEPOINT null_transport");
  await client.query(
    "UPDATE ssh_connections SET transport='tailscale',tailscale_id=$1,host='100.64.0.1',port=65535 WHERE id=$2",
    [configId, directId],
  );
  await assertCarrier(directId, "tailscale", false);
  await client.query("SAVEPOINT referenced_delete");
  await assert.rejects(
    client.query("DELETE FROM tailscale_configs WHERE id=$1", [configId]),
    { code: /^(23503|23001)$/, constraint: "ssh_connections_tailscale_org_fk" },
  );
  await client.query("ROLLBACK TO SAVEPOINT referenced_delete");
  await client.query(
    "UPDATE tailscale_configs SET tags=ARRAY['tag:next'],generation=generation+1,revision=revision+1 WHERE id=$1",
    [configId],
  );
  // Generation ownership remains entirely with the API, without DB triggers.
  await client.query(
    "UPDATE ssh_connections SET generation=generation+1 WHERE tailscale_id=$1",
    [configId],
  );
  await client.query(
    "UPDATE ssh_connections SET transport='tailscale',tailscale_id=NULL,needs_rebind=true WHERE id=$1",
    [directId],
  );
  await client.query("DELETE FROM tailscale_configs WHERE id=$1", [configId]);
  await assertCarrier(directId, "tailscale", true);
  // The shadow cannot disagree with canonical state or authorize Direct.
  await rejects(
    `UPDATE ssh_connections SET needs_rebind=false WHERE id='${directId}'`,
    "chk_ssh_connections_legacy_needs_rebind",
  );
  await assertCarrier(directId, "tailscale", true);
  assert.deepEqual(
    (
      await client.query(
        "SELECT generation,transport,port,learned_host_key_fingerprint,credential_id FROM ssh_connections WHERE id=$1",
        [directId],
      )
    ).rows,
    [
      {
        generation: 8,
        transport: "tailscale",
        port: 65535,
        learned_host_key_fingerprint: "SHA256:pin",
        credential_id: credentialId,
      },
    ],
  );
  await rejects(
    `UPDATE ssh_connections SET transport='cloudflare_access' WHERE id='${directId}'`,
    "chk_ssh_connections_cloudflare_access_destination",
  );
  assert.deepEqual(
    (await client.query("SELECT generation FROM ssh_connection_observations"))
      .rows,
    [{ generation: 7 }],
  );
  console.log(
    "Tailscale migration, canonical carriers, reader shadow and writer-floor guards passed",
  );
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
