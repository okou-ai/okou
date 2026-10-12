import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/** Validate Discord ownership cascades against both replayed and freshly generated schema. */
export async function validatePermanentDiscordChat(
  databaseUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const suffix = randomUUID();
  const guild = `chat-guild-${suffix.slice(0, 8)}`;
  const org = `discord-chat-org-${suffix}`;
  const user = `discord-chat-user-${suffix}`;
  const connection = randomUUID();
  const installationGrant = randomUUID();
  const thread = randomUUID();
  const route = randomUUID();
  const ingress = randomUUID();
  const receiptDigest = suffix.replaceAll("-", "").repeat(2);

  try {
    await client.query(
      `WITH consent AS (
         INSERT INTO discord_org_grants (id, org_id, initiated_by_user_id, verified_guild_id, verified_bot_user_id, approved_at, expires_at)
         VALUES ($3, $2, $4, $1, 'bot', now(), now() + interval '10 minutes')
         RETURNING id, org_id, initiated_by_user_id, verified_guild_id, verified_bot_user_id, approved_at
       ) INSERT INTO discord_org_installations (guild_id, org_id, bot_user_id, installed_by_user_id, org_grant_id, created_at)
         SELECT verified_guild_id, org_id, verified_bot_user_id, initiated_by_user_id, id, approved_at FROM consent`,
      [guild, org, installationGrant, user],
    );
    await client.query(
      `WITH consent AS (
         INSERT INTO discord_oauth_states (id, state_hash, completion_token_hash, phase, user_id, org_id, flow, redirect_uri, verified_guild_id, verified_guild_name, verified_discord_user_id, verified_bot_user_id, expires_at)
         VALUES ($1::uuid, $1::text, NULL, 'approved', $3, $4, 'connect', 'https://example.test/callback', $2, 'guild', 'sender', 'bot', now() + interval '10 minutes')
         RETURNING id, user_id, verified_guild_id, verified_discord_user_id
       ) INSERT INTO discord_org_connections (id, guild_id, discord_user_id, user_id, oauth_grant_id)
         SELECT id, verified_guild_id, verified_discord_user_id, user_id, id FROM consent`,
      [connection, guild, user, org],
    );
    await client.query(
      "INSERT INTO chat_threads (id, user_id) VALUES ($1, $2)",
      [thread, user],
    );
    await client.query(
      `INSERT INTO discord_chat_thread_routes
       (id, connection_id, channel_id, session_key, user_id, chat_thread_id)
       VALUES ($1, $2, 'channel', 'thread', $3, $4)`,
      [route, connection, user, thread],
    );
    await client.query(
      `INSERT INTO discord_chat_ingress
       (id, connection_id, event_id, message_id, payload)
       VALUES ($1, $2, $3, $3, '{}')`,
      [ingress, connection, `event-${suffix}`],
    );
    await client.query(
      "INSERT INTO discord_gateway_receipts (event_digest) VALUES ($1)",
      [receiptDigest],
    );
    await client.query(
      "DELETE FROM discord_org_installations WHERE guild_id = $1",
      [guild],
    );
    assert.deepEqual(
      (
        await client.query(
          `SELECT id FROM discord_chat_thread_routes WHERE id = $1
           UNION ALL
           SELECT id FROM discord_chat_ingress WHERE id = $2`,
          [route, ingress],
        )
      ).rows,
      [],
    );
    assert.deepEqual(
      (
        await client.query(
          "SELECT event_digest FROM discord_gateway_receipts WHERE event_digest = $1",
          [receiptDigest],
        )
      ).rows,
      [{ event_digest: receiptDigest }],
    );
    console.log("Discord ownership cascades and durable receipts passed");
  } finally {
    try {
      await client.query("DELETE FROM discord_oauth_states WHERE id = $1", [
        connection,
      ]);
      await client.query("DELETE FROM discord_org_grants WHERE id = $1", [
        installationGrant,
      ]);
      await client.query("DELETE FROM chat_threads WHERE id = $1", [thread]);
      await client.query(
        "DELETE FROM discord_gateway_receipts WHERE event_digest = $1",
        [receiptDigest],
      );
    } finally {
      await client.end();
    }
  }
}
