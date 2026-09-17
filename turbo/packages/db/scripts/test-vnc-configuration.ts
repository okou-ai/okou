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
    INSERT INTO vnc_credentials (id,org_id,user_id,membership_id,name,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000001','org','owner','membership','Password','ciphertext'),
             ('00000000-0000-4000-8000-000000000002','org','other','other-membership','Other','other-ciphertext');
    INSERT INTO vnc_connections (id,org_id,user_id,membership_id,display_name,host,credential_id,trust_mode)
      VALUES ('00000000-0000-4000-8000-000000000003','org','owner','membership','Desktop','desktop.example.com','00000000-0000-4000-8000-000000000001','system');
  `);

  for (const assignment of [
    "org_id='foreign'",
    "user_id='other'",
    "membership_id='new-membership'",
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
  await rejects(
    "INSERT INTO vnc_connections (org_id,user_id,membership_id,display_name,host,credential_id,trust_mode) VALUES ('org','owner','membership','Duplicate','desktop.example.com','00000000-0000-4000-8000-000000000001','system')",
    { code: "23505", constraint: "uq_vnc_connections_owner_endpoint" },
  );
  // Endpoint uniqueness is scoped to the owning user and organization.
  await client.query(
    "INSERT INTO vnc_connections (org_id,user_id,membership_id,display_name,host,credential_id,trust_mode) VALUES ('org','other','other-membership','Other desktop','desktop.example.com','00000000-0000-4000-8000-000000000002','system')",
  );

  for (const [assignment, constraint] of [
    ["revision=0", "chk_vnc_credentials_revision"],
    ["encrypted_password=''", "chk_vnc_credentials_password"],
    ["membership_id=''", "chk_vnc_credentials_membership"],
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
  for (const [assignment, constraint] of [
    ["generation=0", "chk_vnc_connections_generation"],
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

  await rejects(
    "INSERT INTO vnc_authority_revisions (scope_key,revision) VALUES ('raw-owner-id','00000000-0000-4000-8000-000000000004')",
    { code: "23514", constraint: "chk_vnc_authority_revisions_scope_key" },
  );
  await client.query(
    "INSERT INTO vnc_authority_revisions (scope_key,revision) VALUES (repeat('a',64),'00000000-0000-4000-8000-000000000004')",
  );
  await rejects(
    "UPDATE vnc_authority_revisions SET membership_id_hash='raw-membership-id'",
    {
      code: "23514",
      constraint: "chk_vnc_authority_revisions_membership_hash",
    },
  );
  await client.query(
    "UPDATE vnc_authority_revisions SET membership_id_hash=repeat('b',64)",
  );
  await client.query(`
    INSERT INTO vnc_creation_receipts (resource_kind,resource_id,owner_key)
      VALUES ('vnc_credentials','00000000-0000-4000-8000-000000000001',repeat('a',64)),
             ('vnc_connections','00000000-0000-4000-8000-000000000003',repeat('a',64));
  `);
  await rejects(
    "INSERT INTO vnc_creation_receipts (resource_kind,resource_id,owner_key) VALUES ('vnc_credentials','00000000-0000-4000-8000-000000000001',repeat('b',64))",
    { code: "23505", constraint: "vnc_creation_receipts_pk" },
  );
  // Creation identities are global within a kind, with separate namespaces.
  await client.query(
    "INSERT INTO vnc_creation_receipts (resource_kind,resource_id,owner_key) VALUES ('vnc_connections','00000000-0000-4000-8000-000000000001',repeat('b',64))",
  );
  await rejects("UPDATE vnc_creation_receipts SET resource_kind='unknown'", {
    code: "23514",
    constraint: "chk_vnc_creation_receipts_kind",
  });
  for (const ownerKey of ["raw-owner-id", "a".repeat(63), "A".repeat(64)]) {
    await rejects(`UPDATE vnc_creation_receipts SET owner_key='${ownerKey}'`, {
      code: "23514",
      constraint: "chk_vnc_creation_receipts_owner_key",
    });
  }
  await client.query("DELETE FROM vnc_connections");
  assert.deepEqual(
    (await client.query("SELECT count(*)::int AS count FROM vnc_credentials"))
      .rows,
    [{ count: 2 }],
  );
  await client.query("DELETE FROM vnc_credentials");
  assert.deepEqual(
    (
      await client.query(
        "SELECT count(*)::int AS count FROM vnc_creation_receipts",
      )
    ).rows,
    [{ count: 3 }],
    "Creation receipts must survive business-row deletion",
  );
  await rejects(
    "INSERT INTO vnc_creation_receipts (resource_kind,resource_id,owner_key) VALUES ('vnc_connections','00000000-0000-4000-8000-000000000003',repeat('a',64))",
    { code: "23505", constraint: "vnc_creation_receipts_pk" },
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT count(*)::int AS count FROM vnc_authority_revisions",
      )
    ).rows,
    [{ count: 1 }],
  );
  console.log("VNC additive migration and storage constraints passed");
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
