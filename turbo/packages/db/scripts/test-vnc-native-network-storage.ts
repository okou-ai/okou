import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";

import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { applyFixtureMigrations } from "./fixtures/migrate-with-empty-instructions";
import { validatePermanentNativeVncStorage } from "./test-vnc-native-storage-permanent";
import outgoing from "./fixtures/vnc-native-outgoing-sql.json";

const configuredUrl = process.env.DATABASE_URL;
assert.ok(configuredUrl, "DATABASE_URL is required");
const journal = z
  .object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) })
  .parse(
    JSON.parse(
      await readFile(`${DRIZZLE_MIGRATE_OUT}/meta/_journal.json`, "utf8"),
    ),
  );
const migration = journal.entries.find((entry) => {
  return entry.tag.endsWith("_vnc_native_network_storage");
});
assert.ok(
  migration,
  "Native VNC preparation migration must remain in the journal",
);
const adminUrl = new URL(configuredUrl);
adminUrl.pathname = "/postgres";
const name = `vnc_native_${randomUUID().replaceAll("-", "")}`;
const ownedUrl = new URL(adminUrl);
ownedUrl.pathname = `/${name}`;
const admin = new Client({ connectionString: adminUrl.toString() });
const client = new Client({ connectionString: ownedUrl.toString() });
const migrationSql = postgres(ownedUrl.toString(), {
  max: 1,
  onnotice: () => {},
});
const vncId = "00000000-0000-4000-8000-000000000015";
const credentialId = "00000000-0000-4000-8000-000000000016";
const sshId = randomUUID();
const sshCredentialId = randomUUID();
const sshVncId = randomUUID();
const threadId = randomUUID();
const addedColumns = [
  "cloudflare_access_id",
  "tailscale_id",
  "origin_tls_server_name",
  "origin_tls_trust_mode",
  "origin_tls_ca_bundle",
  "kdc_cloudflare_access_id",
  "kdc_tailscale_id",
];
const jsonRows = z.array(
  z.strictObject({ value: z.record(z.string(), z.unknown()) }),
);
let created = false;

async function retainedState() {
  const rows = [];
  for (const table of [
    "vnc_credentials",
    "ssh_credentials",
    "ssh_connections",
    "vnc_connection_observations",
    "chat_thread_vnc_access_overrides",
  ]) {
    rows.push(
      jsonRows.parse(
        (
          await client.query(
            `SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`,
          )
        ).rows,
      ),
    );
  }
  rows.push(
    jsonRows.parse(
      (
        await client.query(
          "SELECT to_jsonb(t) - $1::text[] AS value FROM vnc_connections t ORDER BY id",
          [addedColumns],
        )
      ).rows,
    ),
  );
  return rows;
}

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  await client.connect();
  await applyFixtureMigrations(migrationSql, { beforeMillis: migration.when });
  await client.query(
    `INSERT INTO vnc_credentials (id, org_id, user_id, name, auth_method, encrypted_password)
    VALUES ($1, 'vnc-native-outgoing', 'owner', 'Retained credential', 'vnc_password', 'retained-ciphertext')`,
    [credentialId],
  );
  await client.query(
    `INSERT INTO ssh_credentials (id, org_id, user_id, name, username, auth_method, encrypted_password)
    VALUES ($1, 'vnc-native-outgoing', 'owner', 'Retained SSH', 'deploy', 'password', 'retained-ssh-ciphertext')`,
    [sshCredentialId],
  );
  await client.query(
    `INSERT INTO ssh_connections (id, org_id, user_id, display_name, host, port, credential_id, transport)
    VALUES ($1, 'vnc-native-outgoing', 'owner', 'SSH', 'ssh.example.test', 22, $2, 'direct')`,
    [sshId, sshCredentialId],
  );
  const originalInsert = await client.query(
    outgoing.insert.sql,
    outgoing.insert.params,
  );
  const originalRead = await client.query(
    outgoing.select.sql,
    outgoing.select.params,
  );
  assert.deepEqual(originalInsert.rows, originalRead.rows);
  await client.query(
    `INSERT INTO vnc_connections (id, org_id, user_id, display_name, host, transport_type,
    ssh_connection_id, credential_id, auth_method, security_type, trust_mode, generation, created_at)
    VALUES ($1, 'vnc-native-outgoing', 'owner', 'Retained SSH VNC', '127.0.0.1', 'ssh', $2, $3,
      'vnc_password', 'x509_vnc', 'system', 9, '2026-10-01T01:02:03.123456'::timestamp)`,
    [sshVncId, sshId, credentialId],
  );
  await client.query(
    "INSERT INTO chat_threads (id, user_id) VALUES ($1, 'owner')",
    [threadId],
  );
  await client.query(
    "INSERT INTO chat_thread_vnc_access_overrides (chat_thread_id, connection_id, enabled) VALUES ($1, $2, false)",
    [threadId, vncId],
  );
  await client.query(
    `INSERT INTO vnc_connection_observations
    (connection_id, generation, connection_created_at, observed_at, failure_reason, ssh_generation)
    VALUES ($1, 9, '2026-10-01T01:02:03.123456'::timestamp, '2026-10-02T01:02:03Z', 'network_failure', 1)`,
    [sshVncId],
  );
  const before = await retainedState();
  await applyFixtureMigrations(migrationSql);
  assert.deepEqual(
    await retainedState(),
    before,
    "Preparation preserves legacy identities, ciphertext, trust, preferences and microsecond observation identity",
  );
  assert.deepEqual(
    (await client.query(outgoing.select.sql, outgoing.select.params)).rows,
    originalRead.rows,
  );

  // These are exact ORM-generated statements from the preceding API source,
  // including every old default INSERT column and full RETURNING projection.
  assert.equal(
    outgoing.sourceCommit,
    "6200b48be7656528b1d76ce39ac468488d49fbfd",
  );
  await client.query("DELETE FROM vnc_connections WHERE id = $1", [vncId]);
  const outgoingInsert = await client.query(
    outgoing.insert.sql,
    outgoing.insert.params,
  );
  assert.deepEqual(outgoingInsert.rows, originalInsert.rows);
  const updated = await client.query(
    outgoing.update.sql,
    outgoing.update.params,
  );
  assert.deepEqual(
    updated.rows,
    originalRead.rows.map((row: unknown) => {
      return {
        ...z.record(z.string(), z.unknown()).parse(row),
        display_name: "Renamed by outgoing API",
      };
    }),
  );
  const nativeDefaults = z.array(z.record(z.string(), z.null())).parse(
    (
      await client.query(
        `SELECT
    cloudflare_access_id, tailscale_id, origin_tls_server_name, origin_tls_trust_mode,
    origin_tls_ca_bundle, kdc_cloudflare_access_id, kdc_tailscale_id FROM vnc_connections WHERE id = $1`,
        [vncId],
      )
    ).rows,
  );
  assert.deepEqual(nativeDefaults, [
    Object.fromEntries(
      addedColumns.map((column) => {
        return [column, null];
      }),
    ),
  ]);
  await validatePermanentNativeVncStorage(ownedUrl.toString());
  console.log(
    "Native VNC additive migration, outgoing ORM statements, preserved data and storage constraints passed",
  );
} finally {
  await migrationSql.end();
  await client.end();
  if (created) {
    await admin.query(`DROP DATABASE "${name}"`);
  }
  await admin.end();
}
