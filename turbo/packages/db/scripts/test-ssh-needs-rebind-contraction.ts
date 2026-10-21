import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";

import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { applyFixtureMigrations } from "./fixtures/migrate-with-empty-instructions";

const journal = z
  .object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) })
  .parse(
    JSON.parse(
      await readFile(`${DRIZZLE_MIGRATE_OUT}/meta/_journal.json`, "utf8"),
    ),
  );
const contraction = journal.entries.find((entry) => {
  return entry.tag.endsWith("_drop_ssh_needs_rebind");
});
assert.ok(contraction);
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const name = `ssh_contraction_${randomUUID().replaceAll("-", "")}`;
const ownedUrl = new URL(adminUrl);
ownedUrl.pathname = `/${name}`;
const admin = new Client({ connectionString: adminUrl.toString() });
let created = false;
const migrationSql = postgres(ownedUrl.toString(), {
  max: 1,
  onnotice: () => {},
});
const client = new Client({ connectionString: ownedUrl.toString() });
const readHosts = async () => {
  const result = await client.query<Record<string, unknown>>(
    "SELECT * FROM ssh_connections ORDER BY id",
  );
  return result.rows;
};
const readJournal = async () => {
  const result = await client.query<{
    id: number;
    hash: string;
    created_at: string;
  }>("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id");
  return result.rows;
};

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  await client.connect();
  await applyFixtureMigrations(migrationSql, {
    beforeMillis: contraction.when,
  });
  const credentialId = randomUUID();
  const tailscaleId = randomUUID();
  // Minimal historical SQL inputs avoid recreating the outgoing API's ORM.
  await client.query(
    `INSERT INTO ssh_credentials
       (id, org_id, user_id, name, username, auth_method, encrypted_password)
     VALUES ($1, $2, $3, 'Login', 'deploy', 'password', 'synthetic-ciphertext')`,
    [credentialId, "ssh-contraction-org", "ssh-owner"],
  );
  await client.query(
    `INSERT INTO tailscale_configs
       (id, org_id, user_id, name, encrypted_client_id, encrypted_client_secret, tags)
     VALUES ($1, $2, $3, 'Tailscale', 'synthetic-id', 'synthetic-secret', ARRAY['tag:ssh'])`,
    [tailscaleId, "ssh-contraction-org", "ssh-owner"],
  );
  await client.query(
    `INSERT INTO ssh_connections
       (org_id, user_id, display_name, host, port, credential_id, transport,
        tailscale_id, needs_rebind, generation, learned_host_key_algorithm,
        learned_host_key_fingerprint)
     VALUES
       ($1, $2, 'Retained Access', 'retained.example.com', 443, $3,
        'cloudflare_access', NULL, true, 7, 'ssh-ed25519', 'SHA256:retained'),
       ($1, $2, 'Bound Tailscale', '100.64.0.1', 22, $3,
        'tailscale', $4, false, 9, 'ssh-ed25519', 'SHA256:tailnet'),
       ($1, $2, 'Direct', 'direct.example.com', 22, $3,
        'direct', NULL, false, 11, 'ssh-ed25519', 'SHA256:direct')`,
    ["ssh-contraction-org", "ssh-owner", credentialId, tailscaleId],
  );
  const historical = await readHosts();
  const journalBefore = await readJournal();

  // Local indexes/checks auto-drop under RESTRICT; text routines have no
  // column dependency. The actual migration must refuse every consumer.
  for (const dependency of [
    {
      create:
        "CREATE INDEX ssh_rebind_unexpected_index ON ssh_connections (needs_rebind)",
      drop: "DROP INDEX ssh_rebind_unexpected_index",
    },
    {
      create:
        "ALTER TABLE ssh_connections ADD CONSTRAINT ssh_rebind_unexpected_check CHECK (NOT needs_rebind OR transport <> 'direct')",
      drop: "ALTER TABLE ssh_connections DROP CONSTRAINT ssh_rebind_unexpected_check",
    },
    {
      create:
        "CREATE VIEW ssh_rebind_unexpected_view AS SELECT needs_rebind FROM ssh_connections",
      drop: "DROP VIEW ssh_rebind_unexpected_view",
    },
    {
      create:
        "CREATE FUNCTION ssh_rebind_unexpected_routine() RETURNS boolean LANGUAGE sql AS $$ SELECT needs_rebind FROM ssh_connections LIMIT 1 $$",
      drop: "DROP FUNCTION ssh_rebind_unexpected_routine()",
    },
    {
      create:
        "CREATE FUNCTION ssh_rebind_parsed_routine() RETURNS boolean LANGUAGE sql RETURN (SELECT needs_rebind FROM ssh_connections LIMIT 1)",
      drop: "DROP FUNCTION ssh_rebind_parsed_routine()",
    },
    {
      create:
        "CREATE VIEW ssh_rebind_whole_row_view AS SELECT ssh_connections AS host FROM ssh_connections",
      drop: "DROP VIEW ssh_rebind_whole_row_view",
    },
    {
      create:
        "CREATE FUNCTION ssh_rebind_row_type(host ssh_connections) RETURNS text LANGUAGE sql AS $$ SELECT host.host $$",
      drop: "DROP FUNCTION ssh_rebind_row_type(ssh_connections)",
    },
    {
      create:
        "CREATE TABLE ssh_rebind_row_storage AS SELECT ssh_connections AS host FROM ssh_connections",
      drop: "DROP TABLE ssh_rebind_row_storage",
    },
    {
      create:
        "CREATE TABLE ssh_rebind_row_array_storage AS SELECT ARRAY[ssh_connections] AS hosts FROM ssh_connections",
      drop: "DROP TABLE ssh_rebind_row_array_storage",
    },
    {
      create:
        "CREATE FUNCTION ssh_rebind_row_array_type(hosts ssh_connections[]) RETURNS text LANGUAGE sql AS $$ SELECT (hosts[1]).host $$",
      drop: "DROP FUNCTION ssh_rebind_row_array_type(ssh_connections[])",
    },
    {
      create: "CREATE DOMAIN ssh_rebind_row_domain AS ssh_connections",
      drop: "DROP DOMAIN ssh_rebind_row_domain",
    },
    {
      create:
        "ALTER TABLE ssh_connections ALTER COLUMN needs_rebind SET DEFAULT true",
      drop: "ALTER TABLE ssh_connections ALTER COLUMN needs_rebind SET DEFAULT false",
    },
  ]) {
    await client.query(dependency.create);
    try {
      await assert.rejects(
        applyFixtureMigrations(migrationSql, {
          beforeMillis: contraction.when + 1,
        }),
        (error: unknown) => {
          return (
            error instanceof Error &&
            "code" in error &&
            error.code === "2BP01" &&
            error.message.includes("Unexpected SSH needs_rebind dependencies")
          );
        },
      );
      assert.deepEqual(
        await readJournal(),
        journalBefore,
        "Rejected contraction must not advance the migration journal",
      );
      assert.deepEqual(
        await readHosts(),
        historical,
        "Rejected contraction must retain every stored host field",
      );
    } finally {
      await client.query(dependency.drop);
    }
  }
  await applyFixtureMigrations(migrationSql, {
    beforeMillis: contraction.when + 1,
  });
  assert.deepEqual(
    (
      await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='ssh_connections' AND column_name='needs_rebind'",
      )
    ).rows,
    [],
    "The actual contraction must remove physical compatibility storage",
  );
  const canonical = historical.map((host) => {
    const retained = { ...host };
    delete retained.needs_rebind;
    return retained;
  });
  assert.deepEqual(
    await readHosts(),
    canonical,
    "Contraction must preserve every surviving host field",
  );
  const contractedJournal = await readJournal();
  await applyFixtureMigrations(migrationSql, {
    beforeMillis: contraction.when + 1,
  });
  assert.deepEqual(
    await readHosts(),
    canonical,
    "Replaying contraction must leave hosts unchanged",
  );
  assert.deepEqual(
    await readJournal(),
    contractedJournal,
    "Replaying contraction must not advance the migration journal",
  );
  console.log(
    "SSH contraction preserves hosts, rejects unexpected catalog consumers, and replays without effects",
  );
} finally {
  try {
    await client.end();
  } finally {
    try {
      await migrationSql.end();
    } finally {
      try {
        if (created) {
          await admin.query(`DROP DATABASE "${name}"`);
        }
      } finally {
        await admin.end();
      }
    }
  }
}
