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
    CREATE TABLE ssh_connections (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      user_id text NOT NULL
    );
  `);
  await client.query(`
    CREATE TABLE agent_vnc_access (
      org_id text NOT NULL,
      user_id text NOT NULL,
      agent_id uuid NOT NULL,
      PRIMARY KEY (org_id,user_id,agent_id)
    );
    INSERT INTO vnc_credentials (id,org_id,user_id,name,auth_method,encrypted_password,revision)
      VALUES ('00000000-0000-4000-8000-000000000001','org','owner','Password','vnc_password','ciphertext',7),
             ('00000000-0000-4000-8000-000000000007','org','second-owner','Second password','vnc_password','second-ciphertext',11);
    INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,port,credential_id,security_type,trust_mode,ca_bundle,generation)
      VALUES ('00000000-0000-4000-8000-000000000003','org','owner','Desktop','desktop.example.com',5900,'00000000-0000-4000-8000-000000000001','x509_vnc','system',NULL,9),
             ('00000000-0000-4000-8000-000000000008','org','second-owner','Second desktop','second.example.com',5901,'00000000-0000-4000-8000-000000000007','x509_vnc','custom_ca','second-ca',13);
    INSERT INTO agent_vnc_access
      VALUES ('org','owner','00000000-0000-4000-8000-000000000004'),
             ('org','second-owner','00000000-0000-4000-8000-000000000009');
  `);

  const credentialsBefore = (
    await client.query(
      "SELECT id::text,org_id,user_id,name,auth_method,encrypted_password,revision,created_at,updated_at FROM vnc_credentials ORDER BY id",
    )
  ).rows;
  const connectionsBefore = (
    await client.query(
      "SELECT id::text,org_id,user_id,display_name,host,port,credential_id::text,security_type,trust_mode,ca_bundle,generation,created_at,updated_at FROM vnc_connections ORDER BY id",
    )
  ).rows;
  const grantsBefore = (
    await client.query(
      "SELECT org_id,user_id,agent_id::text FROM agent_vnc_access ORDER BY org_id,user_id,agent_id",
    )
  ).rows;

  for (const name of [
    "1182_wet_felicia_hardy.sql",
    "1183_wild_natasha_romanoff.sql",
    "1184_lovely_christian_walker.sql",
    "1196_dizzy_archangel.sql",
    "1197_puzzling_aaron_stack.sql",
    "1207_smart_oracle.sql",
    "1209_polite_sue_storm.sql",
  ]) {
    await client.query(
      (await migration(name)).replaceAll('"public".', `"${schema}".`),
    );
  }

  assert.deepEqual(
    (
      await client.query(
        "SELECT id::text,org_id,user_id,name,auth_method,encrypted_password,revision,created_at,updated_at FROM vnc_credentials ORDER BY id",
      )
    ).rows,
    credentialsBefore,
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT id::text,transport_type,ssh_connection_id::text,x509_server_name FROM vnc_connections ORDER BY id",
      )
    ).rows,
    [
      {
        id: "00000000-0000-4000-8000-000000000003",
        transport_type: "direct",
        ssh_connection_id: null,
        x509_server_name: null,
      },
      {
        id: "00000000-0000-4000-8000-000000000008",
        transport_type: "direct",
        ssh_connection_id: null,
        x509_server_name: null,
      },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT id::text,org_id,user_id,display_name,host,port,credential_id::text,security_type,trust_mode,ca_bundle,generation,created_at,updated_at FROM vnc_connections ORDER BY id",
      )
    ).rows,
    connectionsBefore,
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT org_id,user_id,agent_id::text FROM agent_vnc_access ORDER BY org_id,user_id,agent_id",
      )
    ).rows,
    grantsBefore,
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT id::text,username,auth_method FROM vnc_credentials ORDER BY id",
      )
    ).rows,
    [
      {
        id: "00000000-0000-4000-8000-000000000001",
        username: null,
        auth_method: "vnc_password",
      },
      {
        id: "00000000-0000-4000-8000-000000000007",
        username: null,
        auth_method: "vnc_password",
      },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT id::text,auth_method FROM vnc_connections ORDER BY id",
      )
    ).rows,
    [
      {
        id: "00000000-0000-4000-8000-000000000003",
        auth_method: "vnc_password",
      },
      {
        id: "00000000-0000-4000-8000-000000000008",
        auth_method: "vnc_password",
      },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name='vnc_connections' AND column_name='auth_method'",
        [schema],
      )
    ).rows,
    [{ column_default: null }],
  );
  assert.deepEqual(
    (await client.query("SELECT value FROM retained_owner_data")).rows,
    [{ value: "retained" }],
  );

  await client.query(`
    INSERT INTO vnc_credentials (id,org_id,user_id,name,username,auth_method,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000002','org','owner','Username password','operator','username_password','username-ciphertext'),
             ('00000000-0000-4000-8000-000000000005','org','other','Other',NULL,'vnc_password','other-ciphertext');
    INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,credential_id,auth_method,security_type,trust_mode)
      VALUES ('00000000-0000-4000-8000-000000000004','org','owner','Plain desktop','plain.example.com','00000000-0000-4000-8000-000000000002','username_password','x509_plain','system');
    INSERT INTO ssh_connections (id,org_id,user_id)
      VALUES ('00000000-0000-4000-8000-000000000010','org','owner'),
             ('00000000-0000-4000-8000-000000000011','org','other');
  `);

  assert.deepEqual(
    (
      await client.query(
        "SELECT transport_type,ssh_connection_id,x509_server_name FROM vnc_connections WHERE id='00000000-0000-4000-8000-000000000004'",
      )
    ).rows,
    [
      {
        transport_type: "direct",
        ssh_connection_id: null,
        x509_server_name: null,
      },
    ],
  );
  await client.query(
    "UPDATE vnc_connections SET transport_type='ssh',ssh_connection_id='00000000-0000-4000-8000-000000000010',x509_server_name='plain-tls.example.com' WHERE id='00000000-0000-4000-8000-000000000004'",
  );
  await rejects(
    "DELETE FROM ssh_connections WHERE id='00000000-0000-4000-8000-000000000010'",
    {
      code: /^(23503|23001)$/,
      constraint: "vnc_connections_ssh_owner_fk",
    },
  );
  for (const assignment of [
    "transport_type='direct'",
    "ssh_connection_id=NULL",
  ] as const) {
    await rejects(
      `UPDATE vnc_connections SET ${assignment} WHERE id='00000000-0000-4000-8000-000000000004'`,
      { code: "23514", constraint: "chk_vnc_connections_transport" },
    );
  }
  await rejects(
    "UPDATE vnc_connections SET ssh_connection_id='00000000-0000-4000-8000-000000000011' WHERE id='00000000-0000-4000-8000-000000000004'",
    { code: "23503", constraint: "vnc_connections_ssh_owner_fk" },
  );
  for (const serverName of [
    "TLS.EXAMPLE.COM",
    "tls.example.com/path",
    "",
  ] as const) {
    await rejects(
      `UPDATE vnc_connections SET x509_server_name='${serverName}' WHERE id='00000000-0000-4000-8000-000000000004'`,
      {
        code: "23514",
        constraint: "chk_vnc_connections_x509_server_name",
      },
    );
  }

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

  await client.query(`
    INSERT INTO vnc_credentials (id,org_id,user_id,name,username,auth_method,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000012','org','owner','Mac login','operator','apple_dh_username_password','apple-ciphertext');
    INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,transport_type,ssh_connection_id,credential_id,auth_method,security_type,trust_mode)
      VALUES ('00000000-0000-4000-8000-000000000013','org','owner','Mac Screen Sharing','127.0.0.1','ssh','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000012','apple_dh_username_password','apple_dh','none');
  `);
  for (const [assignment, constraint] of [
    ["host='mac.example.com'", "chk_vnc_connections_profile"],
    [
      "transport_type='direct',ssh_connection_id=NULL",
      "chk_vnc_connections_profile",
    ],
    ["x509_server_name='mac.example.com'", "chk_vnc_connections_profile"],
    ["trust_mode='system'", "chk_vnc_connections_trust"],
    ["ca_bundle='unexpected'", "chk_vnc_connections_trust"],
    ["security_type='x509_plain'", "chk_vnc_connections_profile"],
  ] as const) {
    await rejects(
      `UPDATE vnc_connections SET ${assignment} WHERE id='00000000-0000-4000-8000-000000000013'`,
      { code: "23514", constraint },
    );
  }
  await rejects(
    "UPDATE vnc_credentials SET username=repeat('é',32) WHERE id='00000000-0000-4000-8000-000000000012'",
    { code: "23514", constraint: "chk_vnc_credentials_auth" },
  );
  await client.query(
    "UPDATE vnc_credentials SET username=repeat('x',63) WHERE id='00000000-0000-4000-8000-000000000012'",
  );
  await client.query(
    "UPDATE vnc_connections SET host='::1' WHERE id='00000000-0000-4000-8000-000000000013'",
  );

  await client.query(`
    INSERT INTO vnc_credentials (id,org_id,user_id,name,username,auth_method,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000014','org','owner','Mac SRP login','operator','apple_srp_username_password','apple-srp-ciphertext');
    INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,transport_type,ssh_connection_id,credential_id,auth_method,security_type,trust_mode)
      VALUES ('00000000-0000-4000-8000-000000000015','org','owner','Mac Screen Sharing SRP','127.0.0.1','ssh','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000014','apple_srp_username_password','apple_srp','none');
  `);
  for (const [assignment, constraint] of [
    ["host='localhost'", "chk_vnc_connections_profile"],
    [
      "transport_type='direct',ssh_connection_id=NULL",
      "chk_vnc_connections_profile",
    ],
    ["security_type='apple_dh'", "chk_vnc_connections_profile"],
    ["trust_mode='system'", "chk_vnc_connections_trust"],
  ] as const) {
    await rejects(
      `UPDATE vnc_connections SET ${assignment} WHERE id='00000000-0000-4000-8000-000000000015'`,
      { code: "23514", constraint },
    );
  }
  await rejects(
    "UPDATE vnc_credentials SET username=repeat('é',128) WHERE id='00000000-0000-4000-8000-000000000014'",
    { code: "23514", constraint: "chk_vnc_credentials_auth" },
  );
  await client.query(
    "UPDATE vnc_credentials SET username=repeat('x',255) WHERE id='00000000-0000-4000-8000-000000000014'",
  );

  await client.query("DELETE FROM vnc_connections");
  await client.query("DELETE FROM ssh_connections");
  assert.deepEqual(
    (await client.query("SELECT count(*)::int AS count FROM vnc_credentials"))
      .rows,
    [{ count: 6 }],
  );
  await client.query("DELETE FROM vnc_credentials");
  console.log("VNC preservation migrations and storage constraints passed");
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
