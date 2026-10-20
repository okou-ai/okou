import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { applyFixtureMigrations } from "./fixtures/migrate-with-empty-instructions";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const journal = z
  .object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) })
  .parse(
    JSON.parse(
      await readFile(`${DRIZZLE_MIGRATE_OUT}/meta/_journal.json`, "utf8"),
    ),
  );
const migration = journal.entries.find((entry) => {
  return entry.tag === "1406_link_wallet_workspace_owner";
});
assert.ok(migration);
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const databaseName = `wallet_owner_${randomUUID().replaceAll("-", "")}`;
const ownedUrl = new URL(adminUrl);
ownedUrl.pathname = `/${databaseName}`;
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
await admin.query(`CREATE DATABASE "${databaseName}"`);
const migrations = postgres(ownedUrl.toString(), {
  max: 1,
  onnotice: () => {},
});
const client = new Client({ connectionString: ownedUrl.toString() });
const agentId = randomUUID();
const legacyAuthorization = randomUUID();
const sharedAuthorization = randomUUID();

try {
  await client.connect();
  await applyFixtureMigrations(migrations, { beforeMillis: migration.when });
  await client.query(
    "INSERT INTO agents (id, org_id, owner, name) VALUES ($1, 'wallet-org', 'wallet-user', 'wallet-agent')",
    [agentId],
  );
  await client.query(
    "INSERT INTO link_wallet_connections (org_id, user_id, agent_id, authorization_id, encrypted_credentials) VALUES ('wallet-org', 'wallet-user', $1, $2, 'legacy-fixture')",
    [agentId, legacyAuthorization],
  );
  await client.query(
    "INSERT INTO link_wallet_oauth_attempts (id, state_hash, org_id, user_id, agent_id, encrypted_verifier, expires_at) VALUES ($1, 'legacy-state', 'wallet-org', 'wallet-user', $2, 'legacy-verifier', now() + interval '30 minutes')",
    [legacyAuthorization, agentId],
  );
  await applyFixtureMigrations(migrations);
  const legacy = z
    .array(
      z.object({
        authorization_id: z.uuid(),
        encrypted_credentials: z.string(),
        oauth_requested_scopes: z.null(),
      }),
    )
    .parse(
      (
        await client.query(
          "SELECT authorization_id, encrypted_credentials, oauth_requested_scopes FROM link_wallet_connections WHERE agent_id = $1",
          [agentId],
        )
      ).rows,
    );
  assert.deepEqual(legacy, [
    {
      authorization_id: legacyAuthorization,
      encrypted_credentials: "legacy-fixture",
      oauth_requested_scopes: null,
    },
  ]);
  assert.deepEqual(
    (
      await client.query(
        "SELECT scope, oauth_requested_scopes FROM link_wallet_oauth_attempts WHERE id = $1",
        [legacyAuthorization],
      )
    ).rows,
    [{ scope: "agent", oauth_requested_scopes: null }],
  );
  // The outgoing API still uses this exact conflict target after the migration.
  await client.query(
    "INSERT INTO link_wallet_connections (org_id, user_id, agent_id, authorization_id) VALUES ('wallet-org', 'wallet-user', $1, $2) ON CONFLICT (org_id, user_id, agent_id) DO UPDATE SET authorization_id = EXCLUDED.authorization_id",
    [agentId, legacyAuthorization],
  );
  await client.query(
    "INSERT INTO link_wallet_connections (org_id, user_id, authorization_id, encrypted_credentials) VALUES ('wallet-org', 'wallet-user', $1, 'shared-fixture') ON CONFLICT (org_id, user_id) WHERE agent_id IS NULL DO UPDATE SET authorization_id = EXCLUDED.authorization_id",
    [sharedAuthorization],
  );
  await assert.rejects(
    client.query(
      "INSERT INTO link_wallet_connections (org_id, user_id, authorization_id) VALUES ('wallet-org', 'wallet-user', $1)",
      [randomUUID()],
    ),
    (error: unknown) => {
      return (
        error instanceof Error && "code" in error && error.code === "23505"
      );
    },
  );
  await client.query(
    "INSERT INTO link_wallet_connections (org_id, user_id, authorization_id) VALUES ('wallet-org', 'other-user', $1), ('other-org', 'wallet-user', $2)",
    [randomUUID(), randomUUID()],
  );
  await client.query(
    "INSERT INTO link_wallet_oauth_attempts (state_hash, org_id, user_id, scope, encrypted_verifier, expires_at) VALUES ('shared-state', 'wallet-org', 'wallet-user', 'workspace_user', 'shared-verifier', now() + interval '30 minutes')",
  );
  await client.query("DELETE FROM agents WHERE id = $1", [agentId]);
  const shared = z
    .array(z.object({ authorization_id: z.uuid() }))
    .parse(
      (
        await client.query(
          "SELECT authorization_id FROM link_wallet_connections WHERE org_id = 'wallet-org' AND user_id = 'wallet-user'",
        )
      ).rows,
    );
  assert.deepEqual(shared, [{ authorization_id: sharedAuthorization }]);
  assert.deepEqual(
    (
      await client.query(
        "SELECT scope FROM link_wallet_oauth_attempts WHERE state_hash = 'shared-state'",
      )
    ).rows,
    [{ scope: "workspace_user" }],
  );
  console.log(
    "Wallet migration preserves legacy consent and writers, enforces workspace/user uniqueness, and survives agent deletion",
  );
} finally {
  await client.end();
  await migrations.end();
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  await admin.end();
}
