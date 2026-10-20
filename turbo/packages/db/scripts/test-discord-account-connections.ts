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
  .object({
    entries: z.array(z.object({ tag: z.string(), when: z.number() })),
  })
  .parse(
    JSON.parse(
      await readFile(`${DRIZZLE_MIGRATE_OUT}/meta/_journal.json`, "utf8"),
    ),
  );
const migration = journal.entries.find((entry) => {
  return entry.tag.endsWith("_discord_account_connections");
});
assert.ok(migration, "Account connection migration must be present");
const databaseName = `discord_accounts_${randomUUID().replaceAll("-", "")}`;
const admin = new Client({ connectionString: databaseUrl });
await admin.connect();
await admin.query(`CREATE DATABASE "${databaseName}"`);
const ownedUrl = new URL(databaseUrl);
ownedUrl.pathname = `/${databaseName}`;
const sql = postgres(ownedUrl.toString(), { max: 1, onnotice: () => {} });
const client = new Client({ connectionString: ownedUrl.toString() });
const org = `org-${randomUUID()}`;
const user = `user-${randomUUID()}`;
const guild = "700000000000000011";
const sender = "700000000000000012";
const bot = "700000000000000013";
const grant = randomUUID();
const connection = randomUUID();
const thread = randomUUID();
const route = randomUUID();
try {
  await client.connect();
  await applyFixtureMigrations(sql, { beforeMillis: migration.when });
  await client.query(
    `INSERT INTO discord_org_grants
    (id, org_id, initiated_by_user_id, verified_guild_id, verified_bot_user_id, approved_at, expires_at)
    VALUES ($1, $2, $3, $4, $5, now(), now() + interval '10 minutes')`,
    [grant, org, user, guild, bot],
  );
  await client.query(
    `INSERT INTO discord_org_installations
    (guild_id, org_id, bot_user_id, installed_by_user_id, org_grant_id, created_at)
    SELECT verified_guild_id, org_id, verified_bot_user_id, initiated_by_user_id, id, approved_at
    FROM discord_org_grants WHERE id = $1`,
    [grant],
  );
  await client.query(
    `INSERT INTO discord_oauth_states
    (id, state_hash, completion_token_hash, phase, user_id, org_id, flow, redirect_uri,
      verified_guild_id, verified_guild_name, verified_discord_user_id, verified_bot_user_id, expires_at)
    VALUES ($1::uuid, $1::text, NULL, 'approved', $2, $3, 'connect', 'https://example.test/callback',
      $4, 'Shared server', $5, $6, now() + interval '10 minutes')`,
    [grant, user, org, guild, sender, bot],
  );
  await client.query(
    `INSERT INTO discord_org_connections
    (id, guild_id, discord_user_id, user_id, oauth_grant_id) VALUES ($1, $2, $3, $4, $5)`,
    [connection, guild, sender, user, grant],
  );
  await client.query("INSERT INTO chat_threads (id, user_id) VALUES ($1, $2)", [
    thread,
    user,
  ]);
  await client.query(
    `INSERT INTO discord_chat_thread_routes
    (id, connection_id, channel_id, session_key, user_id, chat_thread_id)
    VALUES ($1, $2, 'channel', 'thread', $3, $4)`,
    [route, connection, user, thread],
  );
  await client.query(
    `INSERT INTO discord_user_dm_preferences (discord_user_id, connection_id, user_id)
    VALUES ($1, $2, $3)`,
    [sender, connection, user],
  );

  await applyFixtureMigrations(sql);
  assert.deepEqual(
    (
      await client.query(
        `SELECT id, org_id, guild_id, oauth_grant_id
    FROM discord_org_connections WHERE id = $1`,
        [connection],
      )
    ).rows,
    [{ id: connection, org_id: org, guild_id: guild, oauth_grant_id: grant }],
  );
  assert.deepEqual(
    (
      await client.query(
        `SELECT connection_id FROM discord_user_dm_preferences
    WHERE discord_user_id = $1`,
        [sender],
      )
    ).rows,
    [{ connection_id: connection }],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT id FROM discord_chat_thread_routes WHERE id = $1",
        [route],
      )
    ).rows,
    [{ id: route }],
  );

  // New account connections require canonical organization ownership.
  const peerGrant = randomUUID();
  const peer = `peer-${user}`;
  const peerSender = "700000000000000014";
  await client.query(
    `INSERT INTO discord_oauth_states
    (id, state_hash, completion_token_hash, phase, user_id, org_id, flow, redirect_uri,
      verified_guild_id, verified_guild_name, verified_discord_user_id, verified_bot_user_id, expires_at)
    VALUES ($1::uuid, $1::text, NULL, 'approved', $2, $3, 'connect', 'https://example.test/callback',
      $4, 'Shared server', $5, $6, now() + interval '10 minutes')`,
    [peerGrant, peer, org, guild, peerSender, bot],
  );
  await client.query(
    `INSERT INTO discord_org_connections
    (org_id, discord_user_id, user_id, oauth_grant_id) VALUES ($1, $2, $3, $4)`,
    [org, peerSender, peer, peerGrant],
  );
  assert.deepEqual(
    (
      await client.query(
        `SELECT g.org_id FROM discord_org_connections c
    JOIN discord_oauth_states g ON g.id = c.oauth_grant_id WHERE c.user_id = $1`,
        [peer],
      )
    ).rows,
    [{ org_id: org }],
  );
  await assert.rejects(
    client.query(
      `INSERT INTO discord_org_connections
    (discord_user_id, user_id, oauth_grant_id) VALUES ('unowned', 'unowned', $1)`,
      [randomUUID()],
    ),
    { code: "23502", column: "org_id" },
  );
  await client.query(
    "DELETE FROM discord_org_installations WHERE guild_id = $1",
    [guild],
  );
  assert.equal(
    (
      await client.query(
        "SELECT id FROM discord_org_connections WHERE id = $1",
        [connection],
      )
    ).rowCount,
    1,
  );
  await client.query("DELETE FROM discord_oauth_states WHERE id = $1", [grant]);
  assert.equal(
    (
      await client.query(
        "SELECT id FROM discord_org_connections WHERE id = $1",
        [connection],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await client.query(
        "SELECT id FROM discord_chat_thread_routes WHERE id = $1",
        [route],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    (
      await client.query(
        "SELECT id FROM discord_org_connections WHERE user_id = $1",
        [peer],
      )
    ).rowCount,
    1,
  );
  console.log(
    "Discord account backfill, preserved routes/preferences, required org ownership and scoped revocation passed",
  );
} finally {
  await client.end();
  await sql.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
