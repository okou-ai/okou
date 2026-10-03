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
    "INSERT INTO ssh_connection_observations (connection_id,generation,observed_at,failure_reason) VALUES ($1,7,now(),NULL)",
    [directId],
  );
  const beforeHosts = await client.query(
    "SELECT to_jsonb(ssh_connections) AS value FROM ssh_connections ORDER BY id",
  );
  const beforeObservations = await client.query(
    "SELECT to_jsonb(ssh_connection_observations) AS value FROM ssh_connection_observations",
  );
  await migrate("1319_tailscale_private_ssh");
  assert.deepEqual(
    (
      await client.query(
        "SELECT to_jsonb(ssh_connections) - 'tailscale_config_id' AS value FROM ssh_connections ORDER BY id",
      )
    ).rows,
    beforeHosts.rows,
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT to_jsonb(ssh_connection_observations) - 'tailscale_config_id' - 'tailscale_config_generation' AS value FROM ssh_connection_observations",
      )
    ).rows,
    beforeObservations.rows,
  );
  assert.deepEqual(
    (await client.query("SELECT encrypted_password FROM ssh_credentials")).rows,
    [{ encrypted_password: "encrypted-password" }],
  );
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
  await rejects(
    `UPDATE tailscale_configs SET scope='organization' WHERE id='${configId}'`,
    "chk_tailscale_configs_scope_owner",
  );
  await rejects(
    `UPDATE tailscale_configs SET user_id=NULL WHERE id='${configId}'`,
    "chk_tailscale_configs_scope_owner",
  );
  await rejects(
    `UPDATE tailscale_configs SET scope='invalid' WHERE id='${configId}'`,
    "chk_tailscale_configs_scope_owner",
  );
  await rejects(
    `UPDATE tailscale_configs SET tags=ARRAY[]::text[] WHERE id='${configId}'`,
    "chk_tailscale_configs_tags",
  );
  await rejects(
    `UPDATE tailscale_configs SET tags=ARRAY[NULL]::text[] WHERE id='${configId}'`,
    "chk_tailscale_configs_tags",
  );
  await rejects(
    `UPDATE tailscale_configs SET tags=array_fill('tag:x'::text,ARRAY[17]) WHERE id='${configId}'`,
    "chk_tailscale_configs_tags",
  );
  await rejects(
    `UPDATE tailscale_configs SET encrypted_client_secret='' WHERE id='${configId}'`,
    "chk_tailscale_configs_credentials",
  );
  await rejects(
    `UPDATE tailscale_configs SET name='' WHERE id='${configId}'`,
    "chk_tailscale_configs_name",
  );
  await rejects(
    `UPDATE ssh_connections SET tailscale_config_id='${foreignId}' WHERE id='${directId}'`,
    "ssh_connections_tailscale_org_fk",
    "23503",
  );
  await rejects(
    `UPDATE ssh_connections SET tailscale_config_id='${configId}' WHERE id='${accessHostId}'`,
    "chk_ssh_connections_tailscale_exclusive",
  );
  await client.query(
    "UPDATE ssh_connections SET tailscale_config_id=$1,host='100.64.0.1',port=65535 WHERE id=$2",
    [configId, directId],
  );
  await rejects(
    `UPDATE ssh_connections SET needs_rebind=true,host='peer.tail-test.ts.net',port=443 WHERE id='${directId}'`,
    "chk_ssh_connections_tailscale_exclusive",
  );
  await client.query("SAVEPOINT referenced_delete");
  await assert.rejects(
    client.query("DELETE FROM tailscale_configs WHERE id=$1", [configId]),
    { code: /^(23503|23001)$/, constraint: "ssh_connections_tailscale_org_fk" },
  );
  await client.query("ROLLBACK TO SAVEPOINT referenced_delete");
  await rejects(
    `UPDATE ssh_connection_observations SET tailscale_config_id='${configId}'`,
    "chk_ssh_connection_observation_tailscale_pair",
  );
  await rejects(
    "UPDATE ssh_connection_observations SET tailscale_config_generation=1",
    "chk_ssh_connection_observation_tailscale_pair",
  );
  await rejects(
    `UPDATE ssh_connection_observations SET tailscale_config_id='${configId}',tailscale_config_generation=0`,
    "chk_ssh_connection_observation_tailscale_pair",
  );
  await client.query(
    "UPDATE ssh_connection_observations SET tailscale_config_id=$1,tailscale_config_generation=1",
    [configId],
  );
  await client.query(
    "UPDATE tailscale_configs SET enabled=false,generation=generation+1,revision=revision+1 WHERE id=$1",
    [configId],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT generation,learned_host_key_fingerprint,credential_id FROM ssh_connections WHERE id=$1",
        [directId],
      )
    ).rows,
    [
      {
        generation: 7,
        learned_host_key_fingerprint: "SHA256:pin",
        credential_id: credentialId,
      },
    ],
  );
  await client.query(
    "UPDATE ssh_connections SET tailscale_config_id=NULL WHERE id=$1",
    [directId],
  );
  await client.query("DELETE FROM tailscale_configs WHERE id=$1", [configId]);
  // Historical snapshot is evidence, not a cascading config FK or fresh authority.
  assert.deepEqual(
    (
      await client.query(
        "SELECT tailscale_config_id,tailscale_config_generation FROM ssh_connection_observations",
      )
    ).rows,
    [{ tailscale_config_id: configId, tailscale_config_generation: 1 }],
  );
  console.log(
    "Tailscale additive migration and permanent schema constraints passed",
  );
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
