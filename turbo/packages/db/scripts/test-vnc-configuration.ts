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

async function migration(name: string) {
  return await readFile(
    new URL(`../src/migrations/${name}`, import.meta.url),
    "utf8",
  );
}

try {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query("CREATE TABLE retained_owner_data (value text NOT NULL)");
  await client.query("INSERT INTO retained_owner_data VALUES ('retained')");
  await client.query(
    (await migration("1158_vnc_configuration.sql")).replaceAll(
      '"public".',
      `"${schema}".`,
    ),
  );
  await client.query(`
    CREATE TABLE agent_vnc_access (
      org_id text NOT NULL,
      user_id text NOT NULL,
      agent_id uuid NOT NULL,
      PRIMARY KEY (org_id,user_id,agent_id)
    );
    INSERT INTO vnc_credentials (id,org_id,user_id,name,auth_method,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000001','org','owner','Password','vnc_password','ciphertext');
    INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,credential_id,security_type,trust_mode)
      VALUES ('00000000-0000-4000-8000-000000000003','org','owner','Desktop','desktop.example.com','00000000-0000-4000-8000-000000000001','x509_vnc','system');
    INSERT INTO agent_vnc_access VALUES ('org','owner','00000000-0000-4000-8000-000000000004');
  `);

  await client.query(await migration("1181_reset_vnc_configuration.sql"));
  for (const table of [
    "agent_vnc_access",
    "vnc_connections",
    "vnc_credentials",
  ]) {
    assert.deepEqual(
      (await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows,
      [{ count: 0 }],
      `${table} must be empty after the pre-launch VNC reset`,
    );
  }
  assert.deepEqual(
    (await client.query("SELECT value FROM retained_owner_data")).rows,
    [{ value: "retained" }],
  );

  await client.query(
    (await migration("1182_motionless_ares.sql")).replaceAll(
      '"public".',
      `"${schema}".`,
    ),
  );
  await client.query(`
    INSERT INTO vnc_credentials (id,org_id,user_id,name,username,auth_method,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000001','org','owner','Password',NULL,'vnc_password','ciphertext'),
             ('00000000-0000-4000-8000-000000000002','org','owner','Username password','operator','username_password','username-ciphertext'),
             ('00000000-0000-4000-8000-000000000005','org','other','Other',NULL,'vnc_password','other-ciphertext');
    INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,credential_id,auth_method,security_type,trust_mode)
      VALUES ('00000000-0000-4000-8000-000000000003','org','owner','Desktop','desktop.example.com','00000000-0000-4000-8000-000000000001','vnc_password','x509_vnc','system'),
             ('00000000-0000-4000-8000-000000000004','org','owner','Plain desktop','plain.example.com','00000000-0000-4000-8000-000000000002','username_password','x509_plain','system');
  `);

  for (const assignment of [
    "org_id='foreign'",
    "user_id='other'",
    "credential_id='00000000-0000-4000-8000-000000000005'",
  ] as const) {
    await rejects(
      `UPDATE vnc_connections SET ${assignment} WHERE id='00000000-0000-4000-8000-000000000003'`,
      { code: "23503", constraint: "vnc_connections_credential_owner_fk" },
    );
  }

  for (const [authMethod, securityType, credentialId, constraint] of [
    [
      "username_password",
      "x509_plain",
      "00000000-0000-4000-8000-000000000001",
      "vnc_connections_credential_profile_fk",
    ],
    [
      "vnc_password",
      "x509_vnc",
      "00000000-0000-4000-8000-000000000002",
      "vnc_connections_credential_profile_fk",
    ],
    [
      "username_password",
      "x509_vnc",
      "00000000-0000-4000-8000-000000000002",
      "chk_vnc_connections_profile",
    ],
    [
      "vnc_password",
      "x509_plain",
      "00000000-0000-4000-8000-000000000001",
      "chk_vnc_connections_profile",
    ],
  ] as const) {
    await rejects(
      `INSERT INTO vnc_connections (org_id,user_id,display_name,host,credential_id,auth_method,security_type,trust_mode) VALUES ('org','owner','Mismatch','mismatch.example.com','${credentialId}','${authMethod}','${securityType}','system')`,
      {
        code: constraint.endsWith("_fk") ? "23503" : "23514",
        constraint,
      },
    );
  }

  await rejects(
    "UPDATE vnc_credentials SET username='operator',auth_method='username_password' WHERE id='00000000-0000-4000-8000-000000000001'",
    { code: "23503", constraint: "vnc_connections_credential_profile_fk" },
  );
  await rejects(
    "DELETE FROM vnc_credentials WHERE id='00000000-0000-4000-8000-000000000001'",
    { code: /^(23503|23001)$/ },
  );

  for (const [assignment, constraint] of [
    ["revision=0", "chk_vnc_credentials_revision"],
    ["auth_method='unsupported'", "chk_vnc_credentials_auth"],
    ["encrypted_password=''", "chk_vnc_credentials_password"],
    ["name=''", "chk_vnc_credentials_name"],
    ["username='unexpected'", "chk_vnc_credentials_auth"],
  ] as const) {
    await rejects(
      `UPDATE vnc_credentials SET ${assignment} WHERE id='00000000-0000-4000-8000-000000000001'`,
      { code: "23514", constraint },
    );
  }
  for (const [assignment, expected] of [
    [
      "username=NULL",
      { code: "23514", constraint: "chk_vnc_credentials_auth" },
    ],
    ["username=''", { code: "23514", constraint: "chk_vnc_credentials_auth" }],
    [
      "username=repeat('é',128)",
      { code: "23514", constraint: "chk_vnc_credentials_auth" },
    ],
    ["username=repeat('x',256)", { code: "22001" }],
  ] as const) {
    await rejects(
      `UPDATE vnc_credentials SET ${assignment} WHERE id='00000000-0000-4000-8000-000000000002'`,
      expected,
    );
  }
  await rejects(
    "UPDATE vnc_credentials SET encrypted_password=NULL WHERE id='00000000-0000-4000-8000-000000000001'",
    { code: "23502" },
  );
  await rejects(
    "UPDATE vnc_credentials SET auth_method=NULL WHERE id='00000000-0000-4000-8000-000000000001'",
    { code: "23502" },
  );
  await rejects(
    "UPDATE vnc_connections SET auth_method=NULL WHERE id='00000000-0000-4000-8000-000000000003'",
    { code: "23502" },
  );
  await rejects(
    "UPDATE vnc_connections SET security_type=NULL WHERE id='00000000-0000-4000-8000-000000000003'",
    { code: "23502" },
  );
  for (const [assignment, constraint] of [
    ["generation=0", "chk_vnc_connections_generation"],
    ["security_type='unsupported'", "chk_vnc_connections_profile"],
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
    await rejects(
      `UPDATE vnc_connections SET ${assignment} WHERE id='00000000-0000-4000-8000-000000000003'`,
      { code: "23514", constraint },
    );
  }

  // PEM parsing belongs to the API; storage enforces the discriminated shape.
  await client.query(
    "UPDATE vnc_connections SET trust_mode='custom_ca',ca_bundle='public-certificate',host='2001:db8::1' WHERE id='00000000-0000-4000-8000-000000000003'",
  );
  await client.query(
    "UPDATE vnc_connections SET trust_mode='system',ca_bundle=NULL,generation=2147483647 WHERE id='00000000-0000-4000-8000-000000000003'",
  );
  await client.query(
    "UPDATE vnc_credentials SET revision=2147483647 WHERE id='00000000-0000-4000-8000-000000000001'",
  );

  await client.query("DELETE FROM vnc_connections");
  assert.deepEqual(
    (await client.query("SELECT count(*)::int AS count FROM vnc_credentials"))
      .rows,
    [{ count: 3 }],
  );
  await client.query("DELETE FROM vnc_credentials");
  console.log("VNC reset, schema migration and storage constraints passed");
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
