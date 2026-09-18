import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const schema = `vnc_configuration_${randomUUID().replaceAll("-", "")}`;

async function rejects(
  query: string,
  expected: { code: string | RegExp; constraint?: string },
) {
  await client.query("SAVEPOINT invalid_write");
  await assert.rejects(client.query(query), expected);
  await client.query("ROLLBACK TO SAVEPOINT invalid_write");
  await client.query("RELEASE SAVEPOINT invalid_write");
}

try {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query("CREATE TABLE retained_owner_data (value text NOT NULL)");
  await client.query("INSERT INTO retained_owner_data VALUES ('retained')");
  const migration = await readFile(
    new URL("../src/migrations/1158_vnc_configuration.sql", import.meta.url),
    "utf8",
  );
  await client.query(migration.replaceAll('"public".', `"${schema}".`));
  assert.deepEqual(
    (await client.query("SELECT value FROM retained_owner_data")).rows,
    [{ value: "retained" }],
  );
  await client.query(`
    INSERT INTO vnc_credentials (id,org_id,user_id,name,auth_method,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000001','org','owner','Password','vnc_password','ciphertext'),
             ('00000000-0000-4000-8000-000000000002','org','other','Other','vnc_password','other-ciphertext');
    INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,credential_id,security_type,trust_mode)
      VALUES ('00000000-0000-4000-8000-000000000003','org','owner','Desktop','desktop.example.com','00000000-0000-4000-8000-000000000001','x509_vnc','system');
  `);

  for (const assignment of [
    "org_id='foreign'",
    "user_id='other'",
    "credential_id='00000000-0000-4000-8000-000000000002'",
  ] as const) {
    await rejects(`UPDATE vnc_connections SET ${assignment}`, {
      code: "23503",
      constraint: "vnc_connections_credential_owner_fk",
    });
  }
  await rejects(
    "DELETE FROM vnc_credentials WHERE id='00000000-0000-4000-8000-000000000001'",
    {
      code: /^(23503|23001)$/,
      constraint: "vnc_connections_credential_owner_fk",
    },
  );
  // Independently saved configurations can share an endpoint and credential.
  await client.query(
    "INSERT INTO vnc_connections (org_id,user_id,display_name,host,credential_id,security_type,trust_mode) VALUES ('org','owner','Alternate configuration','desktop.example.com','00000000-0000-4000-8000-000000000001','x509_vnc','system')",
  );
  await client.query(
    "INSERT INTO vnc_connections (org_id,user_id,display_name,host,credential_id,security_type,trust_mode) VALUES ('org','other','Other desktop','desktop.example.com','00000000-0000-4000-8000-000000000002','x509_vnc','system')",
  );
  assert.deepEqual(
    (await client.query("SELECT count(*)::int AS count FROM vnc_connections"))
      .rows,
    [{ count: 3 }],
  );

  for (const [assignment, constraint] of [
    ["revision=0", "chk_vnc_credentials_revision"],
    ["auth_method='unsupported'", "chk_vnc_credentials_auth_method"],
    ["encrypted_password=''", "chk_vnc_credentials_password"],
    ["name=''", "chk_vnc_credentials_name"],
  ] as const) {
    await rejects(`UPDATE vnc_credentials SET ${assignment}`, {
      code: "23514",
      constraint,
    });
  }
  await rejects("UPDATE vnc_credentials SET encrypted_password=NULL", {
    code: "23502",
  });
  await rejects("UPDATE vnc_credentials SET auth_method=NULL", {
    code: "23502",
  });
  await rejects("UPDATE vnc_connections SET security_type=NULL", {
    code: "23502",
  });
  for (const [assignment, constraint] of [
    ["generation=0", "chk_vnc_connections_generation"],
    ["security_type='unsupported'", "chk_vnc_connections_security_type"],
    ["port=0", "chk_vnc_connections_port"],
    ["port=65536", "chk_vnc_connections_port"],
    ["display_name=''", "chk_vnc_connections_display_name"],
    ["host=''", "chk_vnc_connections_host"],
    ["host='DESKTOP.example.com'", "chk_vnc_connections_host"],
    ["host='desktop.example.com/path'", "chk_vnc_connections_host"],
    ["trust_mode='insecure'", "chk_vnc_connections_trust"],
    ["ca_bundle='unexpected'", "chk_vnc_connections_trust"],
    ["trust_mode='custom_ca'", "chk_vnc_connections_trust"],
    ["trust_mode='custom_ca',ca_bundle=''", "chk_vnc_connections_trust"],
    [
      "trust_mode='custom_ca',ca_bundle=repeat('x',65537)",
      "chk_vnc_connections_trust",
    ],
  ] as const) {
    await rejects(`UPDATE vnc_connections SET ${assignment}`, {
      code: "23514",
      constraint,
    });
  }
  // PEM parsing belongs to the API; storage enforces the discriminated shape.
  await client.query(
    "UPDATE vnc_connections SET trust_mode='custom_ca',ca_bundle='public-certificate',host='2001:db8::1'",
  );
  await client.query(
    "UPDATE vnc_connections SET trust_mode='system',ca_bundle=NULL,generation=2147483647",
  );
  await client.query("UPDATE vnc_credentials SET revision=2147483647");

  await client.query("DELETE FROM vnc_connections");
  assert.deepEqual(
    (await client.query("SELECT count(*)::int AS count FROM vnc_credentials"))
      .rows,
    [{ count: 2 }],
  );
  await client.query("DELETE FROM vnc_credentials");
  console.log("VNC additive migration and storage constraints passed");
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
